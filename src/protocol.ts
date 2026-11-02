// File protocol between this server and DeskCalc (/verify, DeskCalc 11.3+).
// Job:    v-<id>.xml          <VERIFY id title> <LINE value label/>...
// Ack:    v-<id>.ack.xml      status="opened"   (DeskCalc shows the tape + Confirm bar)
// Result: v-<id>.result.xml   status="confirmed|cancelled|superseded|no_free_tab|
//                                     limit_reached|too_many_digits|bad_request"
// Values always use '.' as decimal separator, no grouping - independent of the
// user's number format in DeskCalc.

import { encodeCp1252, decodeCp1252, type Encoded } from './cp1252.js';

export const MAX_LINES = 500;
export const MAX_LABEL = 60;

export interface Item { value: string; label: string; }
export interface ResultLine { value: string; label: string; op?: string; }
export interface DeskCalcResult {
  status: string;
  total?: string;
  calculations?: number;
  lines: ResultLine[];
  problem?: { line?: number; value?: string };
  notes: string[];
}

// ---------------------------------------------------------------- values

const VALUE_RE = /^[+-]?\d+(\.\d+)?$/;

/** Normalise an agent-supplied value to DeskCalc's job format, or explain why not. */
export function normaliseValue(v: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { ok: false, error: 'not a finite number' };
    if (Math.abs(v) >= 1e15) return { ok: false, error: 'too large (max 15 digits)' };
    let s = String(v);
    if (/e/i.test(s)) s = v.toFixed(10).replace(/\.?0+$/, '');
    return { ok: true, value: s };
  }
  if (typeof v === 'string') {
    const s = v.trim().replace(/^\+/, '');
    if (VALUE_RE.test(s)) return { ok: true, value: s };
    if (/[,\s']/.test(s)) return { ok: false, error: `"${v}": use a plain number with '.' as decimal separator and no thousands separators, e.g. 1234.56` };
    return { ok: false, error: `"${v}" is not a number` };
  }
  return { ok: false, error: 'value must be a number or a numeric string' };
}

// ---------------------------------------------------------------- job

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function xmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Label as DeskCalc will store it: single line, trimmed, max length. */
export function cleanLabel(label: string | undefined): string {
  return (label ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LABEL);
}

export function buildJob(id: string, title: string, items: Item[]): Encoded {
  let xml = '<?xml version="1.0" encoding="windows-1252"?>\r\n';
  xml += `<VERIFY version="1" id="${xmlEscape(id)}" decimal=".">\r\n`;
  xml += `<TITLE>${xmlEscape(cleanLabel(title) || 'Verify')}</TITLE>\r\n`;
  for (const it of items) xml += `<LINE value="${it.value}" label="${xmlEscape(it.label)}"/>\r\n`;
  xml += '</VERIFY>\r\n';
  return encodeCp1252(xml);
}

// ---------------------------------------------------------------- result

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]) : undefined;
}

export function parseResult(bytes: Uint8Array): DeskCalcResult {
  const xml = decodeCp1252(bytes);
  const root = /<VERIFY_RESULT\b[^>]*>/.exec(xml);
  if (!root) throw new Error('not a DeskCalc result file');
  const res: DeskCalcResult = { status: attr(root[0], 'status') ?? 'unknown', lines: [], notes: [] };
  const total = /<TOTAL>([^<]*)<\/TOTAL>/.exec(xml);
  if (total) res.total = total[1].trim();
  const calcs = /<CALCULATIONS>(\d+)<\/CALCULATIONS>/.exec(xml);
  if (calcs) res.calculations = Number(calcs[1]);
  for (const m of xml.matchAll(/<LINE\b[^>]*\/>/g)) {
    const line: ResultLine = { value: attr(m[0], 'value') ?? '', label: attr(m[0], 'label') ?? '' };
    const op = attr(m[0], 'op');
    if (op) line.op = op;
    res.lines.push(line);
  }
  const prob = /<PROBLEM\b[^>]*\/>/.exec(xml);
  if (prob) {
    const line = attr(prob[0], 'line');
    res.problem = { line: line ? Number(line) : undefined, value: attr(prob[0], 'value') || undefined };
  }
  for (const m of xml.matchAll(/<NOTE>([^<]*)<\/NOTE>/g)) res.notes.push(m[1]);
  return res;
}

// ---------------------------------------------------------------- arithmetic

/** Exact decimal sum (BigInt in 1e-10 units) - for the plausibility check only. */
export function decimalSum(values: string[]): string {
  const SCALE = 10;
  let acc = 0n;
  for (const v of values) {
    const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
    if (!m) throw new Error(`bad value ${v}`);
    const frac = (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
    const n = BigInt(m[2] + frac);
    acc += m[1] === '-' ? -n : n;
  }
  const neg = acc < 0n;
  const abs = (neg ? -acc : acc).toString().padStart(SCALE + 1, '0');
  const int = abs.slice(0, -SCALE);
  const frac = abs.slice(-SCALE).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

/** DeskCalc writes %.15g; compare numerically with a small tolerance. */
export function sameAmount(a: string, b: string): boolean {
  return Math.abs(Number(a) - Number(b)) < 1e-6 * Math.max(1, Math.abs(Number(a)));
}

// ---------------------------------------------------------------- corrections

export type Correction =
  | { type: 'changed'; line: number; label: string; before: string; after: string }
  | { type: 'relabelled'; line: number; value: string; before: string; after: string }
  | { type: 'added'; line: number; label: string; value: string }
  | { type: 'removed'; label: string; value: string };

/**
 * Compare sent and confirmed lines. Unchanged lines are found as the longest
 * common subsequence of (label, value); among the rest, same label = value
 * changed, same value = label changed; leftovers are added / removed.
 * Line numbers refer to the confirmed tape (1-based).
 */
export function diffLines(sent: Item[], got: ResultLine[]): Correction[] {
  const key = (l: { label: string; value: string }) => `${l.label}\u0000${Number(l.value)}`;
  const a = sent.map(key), b = got.map(key);
  const n = a.length, m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const usedA = new Set<number>(), usedB = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { usedA.add(i); usedB.add(j); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  const restA = [...sent.keys()].filter(i => !usedA.has(i));
  const restB = [...got.keys()].filter(j => !usedB.has(j));
  const out: Correction[] = [];
  const pair = (match: (s: Item, g: ResultLine) => boolean, make: (i: number, j: number) => Correction) => {
    for (const j of [...restB]) {
      const k = restA.findIndex(i => match(sent[i], got[j]));
      if (k < 0) continue;
      const i = restA[k];
      out.push(make(i, j));
      restA.splice(k, 1);
      restB.splice(restB.indexOf(j), 1);
    }
  };
  pair((s, g) => s.label !== '' && s.label === g.label,
       (i, j) => ({ type: 'changed', line: j + 1, label: got[j].label, before: sent[i].value, after: got[j].value }));
  pair((s, g) => Number(s.value) === Number(g.value),
       (i, j) => ({ type: 'relabelled', line: j + 1, value: got[j].value, before: sent[i].label, after: got[j].label }));
  for (const j of restB) out.push({ type: 'added', line: j + 1, label: got[j].label, value: got[j].value });
  for (const i of restA) out.push({ type: 'removed', label: sent[i].label, value: sent[i].value });
  const pos = (c: Correction) => ('line' in c ? c.line : Number.MAX_SAFE_INTEGER);
  return out.sort((x, y) => pos(x) - pos(y));
}
