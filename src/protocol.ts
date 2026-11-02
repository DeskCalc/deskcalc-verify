// File protocol between this server and DeskCalc (/verify, DeskCalc 11.3+).
// Job:    v-<id>.xml          <VERIFY id title> <LINE .../>...
//           amount:   <LINE value="35" label=".."/>
//           qty:      <LINE value="42.01" qty="3" label=".."/>     (unit price x quantity)
//           tax:      <LINE type="tax" rate="19" incl="0|1" label=".."/>
//                     A real DeskCalc tax line: DeskCalc computes the amount from the
//                     subtotal above and recomputes it whenever a line above changes.
// Ack:    v-<id>.ack.xml      status="opened"   (DeskCalc shows the tape + Confirm bar)
// Result: v-<id>.result.xml   status="confirmed|cancelled|superseded|no_free_tab|
//                                     limit_reached|too_many_digits|bad_request"
// Values always use '.' as decimal separator, no grouping - independent of the
// user's number format in DeskCalc.

import { encodeCp1252, decodeCp1252, type Encoded } from './cp1252.js';

export const MAX_LINES = 500;
export const MAX_LABEL = 60;

export type ItemKind = 'amount' | 'qty' | 'tax';

export interface Item {
  kind: ItemKind;
  label: string;
  value: string;         // amount; for qty the product qty*price; '' for tax (DeskCalc computes it)
  qty?: string;
  price?: string;
  rate?: string;         // tax rate in %
  included?: boolean;    // tax contained in the gross amounts above ("inkl.")
  printed?: string;      // what the document says (line total or tax amount), for the check
}

export interface ResultLine {
  value: string;
  label: string;
  op?: string;
  qty?: string;
  price?: string;
  type?: 'tax';
  rate?: string;
  included?: boolean;
  base?: string;
}

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

// ---------------------------------------------------------------- exact decimals

const SCALE = 10;
function toUnits(v: string): bigint {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`bad value ${v}`);
  const n = BigInt(m[2] + (m[3] ?? '').padEnd(SCALE, '0').slice(0, SCALE));
  return m[1] === '-' ? -n : n;
}
function fromUnits(u: bigint, scale = SCALE): string {
  const neg = u < 0n;
  const abs = (neg ? -u : u).toString().padStart(scale + 1, '0');
  const int = abs.slice(0, -scale) || '0';
  const frac = abs.slice(-scale).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}
/** DeskCalc writes up to 15 significant digits, sometimes in exponent form. */
function plain(v: string): string {
  return /e/i.test(v) ? Number(v).toFixed(SCALE).replace(/\.?0+$/, '') : v;
}

export function decimalSum(values: string[]): string {
  return fromUnits(values.reduce((acc, v) => acc + toUnits(plain(v)), 0n));
}

export function decimalMul(a: string, b: string): string {
  const p = toUnits(plain(a)) * toUnits(plain(b));          // scale 2*SCALE
  const half = 10n ** BigInt(SCALE) / 2n;
  const q = (p + (p < 0n ? -half : half)) / 10n ** BigInt(SCALE);
  return fromUnits(q);
}

/** Round to cents, half away from zero, always two decimals ("348.1107" -> "348.11"). */
export function roundCents(v: string): string {
  const u = toUnits(plain(v));
  const step = 10n ** BigInt(SCALE - 2);
  const r = (u + (u < 0n ? -step / 2n : step / 2n)) / step;
  const neg = r < 0n;
  const abs = (neg ? -r : r).toString().padStart(3, '0');
  return (neg ? '-' : '') + abs.slice(0, -2) + '.' + abs.slice(-2);
}

/** DeskCalc writes %.15g; compare numerically with a small tolerance. */
export function sameAmount(a: string, b: string): boolean {
  return Math.abs(Number(a) - Number(b)) < 1e-6 * Math.max(1, Math.abs(Number(a)));
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
  for (const it of items) {
    const label = `label="${xmlEscape(it.label)}"`;
    if (it.kind === 'tax') xml += `<LINE type="tax" rate="${it.rate}" incl="${it.included ? 1 : 0}" ${label}/>\r\n`;
    else if (it.kind === 'qty') xml += `<LINE value="${it.price}" qty="${it.qty}" ${label}/>\r\n`;
    else xml += `<LINE value="${it.value}" ${label}/>\r\n`;
  }
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
  if (total) res.total = plain(total[1].trim());
  const calcs = /<CALCULATIONS>(\d+)<\/CALCULATIONS>/.exec(xml);
  if (calcs) res.calculations = Number(calcs[1]);
  for (const m of xml.matchAll(/<LINE\b[^>]*\/>/g)) {
    const t = m[0];
    const line: ResultLine = { value: plain(attr(t, 'value') ?? ''), label: attr(t, 'label') ?? '' };
    for (const k of ['op', 'qty', 'price', 'rate', 'base'] as const) {
      const v = attr(t, k);
      if (v !== undefined) (line as any)[k] = k === 'op' ? v : plain(v);
    }
    if (attr(t, 'type') === 'tax') { line.type = 'tax'; line.included = attr(t, 'incl') === '1'; }
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

// ---------------------------------------------------------------- corrections

export type Correction =
  | { type: 'changed'; line: number; label: string; before: string; after: string }
  | { type: 'relabelled'; line: number; value: string; before: string; after: string }
  | { type: 'added'; line: number; label: string; value: string }
  | { type: 'removed'; label: string; value: string }
  | { type: 'tax_changed'; line: number; label: string; before: string; after: string };

/**
 * Compare sent and confirmed lines. Tax lines are not compared by amount -
 * DeskCalc recomputes them from the lines above, so a different tax amount is
 * a consequence, not a correction; only a changed rate counts.
 * Positions: unchanged lines are the longest common subsequence of
 * (label, value); among the rest, same label = value changed, same value =
 * label changed; leftovers are added / removed. Line numbers refer to the
 * confirmed tape as returned (1-based).
 */
export function diffLines(sent: Item[], got: ResultLine[]): Correction[] {
  const out: Correction[] = [];
  const sentTax = sent.filter(s => s.kind === 'tax');
  const gotTax = got.map((g, j) => ({ g, j })).filter(x => x.g.type === 'tax');
  gotTax.forEach(({ g, j }, k) => {
    const s = sentTax[k];
    if (s && Number(s.rate) !== Number(g.rate))
      out.push({ type: 'tax_changed', line: j + 1, label: g.label, before: `${s.rate} %`, after: `${g.rate} %` });
  });

  const sp = sent.filter(s => s.kind !== 'tax');
  const gp = got.map((g, j) => ({ g, j })).filter(x => x.g.type !== 'tax');
  const key = (label: string, value: string) => `${label}\u0000${Number(value)}`;
  const a = sp.map(s => key(s.label, s.value)), b = gp.map(x => key(x.g.label, x.g.value));
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
  const restA = [...sp.keys()].filter(i => !usedA.has(i));
  const restB = [...gp.keys()].filter(j => !usedB.has(j));
  const pair = (match: (s: Item, g: ResultLine) => boolean, make: (s: Item, g: ResultLine, line: number) => Correction) => {
    for (const j of [...restB]) {
      const k = restA.findIndex(i => match(sp[i], gp[j].g));
      if (k < 0) continue;
      out.push(make(sp[restA[k]], gp[j].g, gp[j].j + 1));
      restA.splice(k, 1);
      restB.splice(restB.indexOf(j), 1);
    }
  };
  pair((s, g) => s.label !== '' && s.label === g.label,
       (s, g, line) => ({ type: 'changed', line, label: g.label, before: s.value, after: g.value }));
  pair((s, g) => Number(s.value) === Number(g.value),
       (s, g, line) => ({ type: 'relabelled', line, value: g.value, before: s.label, after: g.label }));
  for (const j of restB) out.push({ type: 'added', line: gp[j].j + 1, label: gp[j].g.label, value: gp[j].g.value });
  for (const i of restA) out.push({ type: 'removed', label: sp[i].label, value: sp[i].value });
  const pos = (c: Correction) => ('line' in c ? c.line : Number.MAX_SAFE_INTEGER);
  return out.sort((x, y) => pos(x) - pos(y));
}

// ---------------------------------------------------------------- document check

export interface Check {
  check: string;            // e.g. "line 1: 3 x 42.01", "tax 19 %", "total"
  document: string;         // what the document says
  deskcalc: string;         // what the confirmed tape gives (rounded to cents)
  ok: boolean;
  difference?: string;
}

/**
 * Compare the printed figures the agent supplied (line totals, tax amounts,
 * expected total) with the confirmed tape, to the cent. Line checks use the
 * document's own arithmetic (qty x price); tax and total use DeskCalc's result
 * after the user's corrections.
 */
export function checkDocument(sent: Item[], got: ResultLine[], total: string | undefined, expectedTotal?: string): Check[] {
  const checks: Check[] = [];
  const mk = (check: string, document: string, computed: string): Check => {
    const d = roundCents(document), c = roundCents(computed);
    const ok = d === c;
    return { check, document: d, deskcalc: c, ok, ...(ok ? {} : { difference: roundCents(decimalSum([c, d.startsWith('-') ? d.slice(1) : '-' + d])) }) };
  };
  sent.forEach((s, i) => {
    if (s.kind === 'qty' && s.printed !== undefined)
      checks.push(mk(`line ${i + 1} "${s.label}": ${s.qty} x ${s.price}`, s.printed, s.value));
  });
  const sentTax = sent.filter(s => s.kind === 'tax');
  got.filter(g => g.type === 'tax').forEach((g, k) => {
    const s = sentTax[k];
    if (s?.printed !== undefined) {
      // printed tax is a positive amount; an included tax comes back negative (subtracted)
      const computed = g.value.replace(/^-/, '');
      checks.push(mk(`tax ${g.rate} %${g.included ? ' (included)' : ''} on ${roundCents(g.base ?? '0')}`, s.printed.replace(/^-/, ''), computed));
    }
  });
  if (expectedTotal !== undefined && total !== undefined) {
    // With included tax the document's total is the gross amount: DeskCalc total + included tax.
    const incl = got.filter(g => g.type === 'tax' && g.included).map(g => g.value.replace(/^-/, ''));
    checks.push(mk('total', expectedTotal, decimalSum([total, ...incl])));
  }
  return checks;
}
