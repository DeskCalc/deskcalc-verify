// File protocol between this server and DeskCalc (/verify, DeskCalc 11.3+).
// Job:    v-<id>.xml          <VERIFY id title> <LINE .../>...
//           amount:   <LINE value="35" label=".."/>
//           qty:      <LINE value="42.01" qty="3" label=".."/>     (unit price x quantity)
//           tax:      <LINE type="tax" rate="19" incl="0|1" label=".."/>
//           subtotal: <LINE type="subtotal" label="Übertrag S.1"/>  checkpoint: a "#" line that
//                     shows the running total; DeskCalc returns it with the running value
//           group:    <LINE type="group" label="20 %"/>  starts a block (own calculation on the
//                     tape; tax/percent apply within the block; several blocks -> GT line)
//           percent:  <LINE type="percent" rate="-3" label=".."/>  (discount -, surcharge +,
//                     on the subtotal above; recomputed like tax)
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

export type ItemKind = 'amount' | 'qty' | 'tax' | 'percent' | 'group' | 'subtotal';

export interface Item {
  kind: ItemKind;
  label: string;
  value: string;         // amount; for qty the product qty*price; '' for tax/percent (DeskCalc computes it)
  qty?: string;
  price?: string;
  rate?: string;         // tax rate in %, or percent (negative = discount)
  included?: boolean;    // tax contained in the gross amounts above ("inkl.")
  printed?: string;      // what the document says (line total, tax or discount amount), for the check
  net?: string;          // cross-footing input: printed net and tax of this row (value = gross)
  tax?: string;
  row?: 'group' | 'net' | 'tax' | 'gross';   // part of a cross-footed row (one block per row)
}

export interface ResultLine {
  value: string;
  label: string;
  op?: string;
  qty?: string;
  price?: string;
  type?: 'tax' | 'percent' | 'subtotal';   // subtotal: value = running total there, not added
  rate?: string;
  included?: boolean;
  base?: string;
  block?: number;
}

export interface DeskCalcResult {
  status: string;
  lang?: 'de' | 'en';      // DeskCalc's UI language (DeskCalc 11.3+)
  total?: string;
  calculations?: number;
  lines: ResultLine[];
  problem?: { line?: number; value?: string };
  notes: string[];
  blocks?: { index: number; label: string; total: string }[];
  gt?: { value: string; fresh: string; outdated: boolean };
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

export function buildJob(id: string, title: string, items: Item[], replace?: string): Encoded {
  let xml = '<?xml version="1.0" encoding="windows-1252"?>\r\n';
  const rep = replace ? ` replace="${xmlEscape(replace)}"` : '';
  xml += `<VERIFY version="1" id="${xmlEscape(id)}"${rep} decimal=".">\r\n`;
  xml += `<TITLE>${xmlEscape(cleanLabel(title) || 'Verify')}</TITLE>\r\n`;
  for (const it of items) {
    const label = `label="${xmlEscape(it.label)}"`;
    if (it.kind === 'group') xml += `<LINE type="group" ${label}/>\r\n`;
    else if (it.kind === 'subtotal') xml += `<LINE type="subtotal" ${label}/>\r\n`;
    else if (it.kind === 'tax') xml += `<LINE type="tax" rate="${it.rate}" incl="${it.included ? 1 : 0}" ${label}/>\r\n`;
    else if (it.kind === 'percent') xml += `<LINE type="percent" rate="${it.rate}" ${label}/>\r\n`;
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
  const lang = attr(root[0], 'lang');
  if (lang === 'de' || lang === 'en') res.lang = lang;
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
    const block = attr(t, 'block');
    if (block !== undefined) line.block = Number(block);
    if (attr(t, 'type') === 'tax') { line.type = 'tax'; line.included = attr(t, 'incl') === '1'; }
    else if (attr(t, 'type') === 'percent') line.type = 'percent';
    else if (attr(t, 'type') === 'subtotal') line.type = 'subtotal';
    res.lines.push(line);
  }
  const prob = /<PROBLEM\b[^>]*\/>/.exec(xml);
  if (prob) {
    const line = attr(prob[0], 'line');
    res.problem = { line: line ? Number(line) : undefined, value: attr(prob[0], 'value') || undefined };
  }
  for (const m of xml.matchAll(/<NOTE>([^<]*)<\/NOTE>/g)) res.notes.push(m[1]);
  for (const m of xml.matchAll(/<BLOCK\b[^>]*\/>/g)) {
    (res.blocks ??= []).push({ index: Number(attr(m[0], 'index')), label: attr(m[0], 'label') ?? '', total: plain(attr(m[0], 'total') ?? '0') });
  }
  const gt = /<GT\b[^>]*\/>/.exec(xml);
  if (gt) res.gt = { value: plain(attr(gt[0], 'value') ?? '0'), fresh: plain(attr(gt[0], 'fresh') ?? '0'), outdated: attr(gt[0], 'outdated') === '1' };
  return res;
}

// ---------------------------------------------------------------- corrections

export type Correction =
  | { type: 'changed'; line: number; label: string; before: string; after: string }
  | { type: 'relabelled'; line: number; value: string; before: string; after: string }
  | { type: 'added'; line: number; label: string; value: string }
  | { type: 'removed'; label: string; value: string }
  | { type: 'tax_changed'; line: number; label: string; before: string; after: string }
  | { type: 'percent_changed'; line: number; label: string; before: string; after: string };

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
  for (const kind of ['tax', 'percent'] as const) {
    const s0 = sent.filter(s => s.kind === kind);
    got.map((g, j) => ({ g, j })).filter(x => x.g.type === kind).forEach(({ g, j }, k) => {
      const s = s0[k];
      if (s && Number(s.rate) !== Number(g.rate))
        out.push({ type: kind === 'tax' ? 'tax_changed' : 'percent_changed', line: j + 1, label: g.label, before: `${s.rate} %`, after: `${g.rate} %` });
    });
  }

  const sp = sent.filter(s => s.kind === 'amount' || s.kind === 'qty');
  const gp = got.map((g, j) => ({ g, j })).filter(x => !x.g.type);
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
  rounding?: string;        // set when the document matches only after rounding tax/discounts to the cent
  follows?: boolean;        // subtotal: same difference as the checkpoint before - not a new error
}

/** a * b / c on exact decimals (for included tax: base * r / (100 + r)). */
function mulDiv(a: string, b: string, c: string): string {
  const scale = 10n ** BigInt(SCALE);
  const num = toUnits(plain(a)) * toUnits(plain(b)) * scale;
  const den = toUnits(plain(c)) * scale;
  const q = num / den;                                  // still scaled by 1e10 once
  return fromUnits(q);
}

/**
 * How invoices usually compute: each tax and discount amount is rounded to the
 * cent and the next line works with the rounded running total. Returns the
 * rounded amount per line (by index) and the resulting total.
 */
export function roundedModel(got: ResultLine[], perLine = false): { amounts: Map<number, string>; total: string } {
  const amounts = new Map<number, string>();          // tax/percent: rounded amount; subtotal: running total
  const runs = new Map<number, string>();             // running total per block
  let run = '0';
  let lines: string[] = [];                           // position amounts of the block so far
  let onlyPositions = true;                           // no tax/percent above in this block
  let block = got.length ? (got[0].block ?? 1) : 1;
  got.forEach((g, i) => {
    if ((g.block ?? 1) !== block) { runs.set(block, run); block = g.block ?? 1; run = '0'; lines = []; onlyPositions = true; }
    if (g.type === 'subtotal') { amounts.set(i, run); return; }
    if (g.type === 'tax' || g.type === 'percent') {
      const rate = g.rate ?? '0';
      const one = (base: string) => {
        const a = g.type === 'tax' && g.included ? '-' + mulDiv(base, rate, decimalSum(['100', rate])) : mulDiv(base, rate, '100');
        return roundCents(a.replace(/^--/, ''));
      };
      // perLine: the tax is computed and rounded per position, then added up - what many
      // billing programs do (Warenwirtschaft). Only defined directly on the positions.
      const amt = perLine && g.type === 'tax' && onlyPositions ? decimalSum(lines.map(one)) : one(run);
      onlyPositions = false;
      amounts.set(i, amt);
      run = decimalSum([run, amt]);
    } else {
      // Invoices round each line total to the cent (2.25 x 153.75 = 345.9375 -> 345.94).
      // Found by the fuzz test (fuzz/fuzz_verify.py, seed 1, cases 6 and 7).
      const v = g.qty !== undefined ? roundCents(g.value) : g.value;
      lines.push(v);
      run = decimalSum([run, v]);
    }
  });
  runs.set(block, run);
  // Several blocks (one per tax rate): the document total is the sum of the blocks.
  return { amounts, total: decimalSum([...runs.values()]) };
}

const ROUNDING_NOTE = 'matches when tax/discounts are rounded to the cent before adding (as invoices do); DeskCalc adds the exact amounts';
const PER_LINE_NOTE = 'matches when the tax is rounded to the cent per position and then added up (as many billing programs do); DeskCalc computes the tax on the subtotal';

/**
 * Compare the printed figures the agent supplied (line totals, tax amounts,
 * expected total) with the confirmed tape, to the cent. Line checks use the
 * document's own arithmetic (qty x price); tax and total use DeskCalc's result
 * after the user's corrections. A tax/discount/total figure that matches only
 * the rounded model (each amount rounded to the cent) counts as correct and is
 * marked as a rounding difference - any other deviation is reported.
 */
export interface ColumnTotals { net?: string; tax?: string }

/** A cross-footed table row as confirmed: one block per row (net, tax, checkpoint "gross"). */
export interface RowPart { label: string; printed: string; net: string; tax: string; computed: string }

export function rowParts(sent: Item[], got: ResultLine[]): RowPart[] {
  const groups = sent.filter(s => s.kind === 'group' && s.row === 'group');
  const gross = sent.filter(s => s.row === 'gross');
  const netLabel = sent.find(s => s.row === 'net')?.label, taxLabel = sent.find(s => s.row === 'tax')?.label;
  return groups.map((grp, b) => {
    const inB = got.filter(g => (g.block ?? 1) === b + 1);
    const plain = inB.filter(g => !g.type);
    const net = plain.find(g => g.label === netLabel) ?? plain[0];
    const tax = plain.find(g => g !== net && g.label === taxLabel) ?? plain.find(g => g !== net);
    const sub = inB.find(g => g.type === 'subtotal');
    return { label: grp.label, printed: gross[b]?.printed ?? '0', net: net?.value ?? '0', tax: tax?.value ?? '0',
             computed: sub?.value ?? decimalSum(plain.map(g => g.value)) };
  });
}

export function checkDocument(sent: Item[], got: ResultLine[], total: string | undefined, expectedTotal?: string, columns: ColumnTotals = {}): Check[] {
  const checks: Check[] = [];
  const model = roundedModel(got);
  const lineModel = roundedModel(got, true);
  const neg = (x: string) => (x.startsWith('-') ? x.slice(1) : '-' + x);
  const mk = (check: string, document: string, computed: string, alt?: string, alt2?: string): Check => {
    const d = roundCents(document), c = roundCents(computed);
    if (d === c) return { check, document: d, deskcalc: c, ok: true };
    const diff = roundCents(decimalSum([c, neg(d)]));
    if (alt !== undefined && roundCents(alt) === d) return { check, document: d, deskcalc: c, ok: true, difference: diff, rounding: ROUNDING_NOTE };
    if (alt2 !== undefined && roundCents(alt2) === d) return { check, document: d, deskcalc: c, ok: true, difference: diff, rounding: PER_LINE_NOTE };
    return { check, document: d, deskcalc: c, ok: false, difference: diff };
  };
  const abs = (x: string) => x.replace(/^-/, '');

  sent.forEach((s, i) => {
    if (s.kind === 'qty' && s.printed !== undefined)
      checks.push(mk(`line ${i + 1} "${s.label}": ${s.qty} x ${s.price}`, s.printed, s.value));
  });
  // Cross-footing (Querfußen): each row is a block on the tape - net, tax and the printed
  // gross as a checkpoint, so DeskCalc itself shows net + tax. Net and tax are the values
  // the user confirmed (corrections count).
  const rows = rowParts(sent, got);
  let rowDiff: string | undefined;          // a wrong row also makes the gross total differ
  if (rows.length) {
    const rc = rows.map(r => mk(`row "${r.label}": net ${roundCents(r.net)} + tax ${roundCents(r.tax)}`, r.printed, r.computed));
    checks.push(...rc);
    const wrong = rc.filter(c => !c.ok);
    if (wrong.length) rowDiff = roundCents(decimalSum(wrong.map(c => c.difference!)));
    // Footing of the net and tax columns against the printed column totals.
    if (columns.net !== undefined) checks.push(mk('net column', columns.net, decimalSum(rows.map(r => r.net))));
    if (columns.tax !== undefined) checks.push(mk('tax column', columns.tax, decimalSum(rows.map(r => r.tax))));
  }
  const idx = (type: 'tax' | 'percent') => got.map((g, i) => ({ g, i })).filter(x => x.g.type === type);
  const sentTax = sent.filter(s => s.kind === 'tax');
  idx('tax').forEach(({ g, i }, k) => {
    const s = sentTax[k];
    if (s?.printed !== undefined)   // printed tax is positive; an included tax comes back negative (subtracted)
      checks.push(mk(`tax ${g.rate} %${g.included ? ' (included)' : ''} on ${roundCents(g.base ?? '0')}`,
        abs(s.printed), abs(g.value), abs(model.amounts.get(i) ?? g.value), abs(lineModel.amounts.get(i) ?? g.value)));
  });
  const sentPerc = sent.filter(s => s.kind === 'percent');
  idx('percent').forEach(({ g, i }, k) => {
    const s = sentPerc[k];
    if (s?.printed !== undefined)   // documents print discounts as "-7.50" or "7.50": compare magnitudes
      checks.push(mk(`${Number(g.rate) < 0 ? 'discount' : 'surcharge'} ${abs(g.rate ?? '')} % on ${roundCents(g.base ?? '0')}`,
        abs(s.printed), abs(g.value), abs(model.amounts.get(i) ?? g.value)));
  });
  // Checkpoints (printed subtotal / carry-over): compared with the running total of the
  // confirmed tape at that point. The first wrong one locates the error; later ones with
  // the same difference only follow from it.
  const sentSub = sent.filter(s => s.kind === 'subtotal');
  let lastDiff: string | undefined;
  got.map((g, i) => ({ g, i })).filter(x => x.g.type === 'subtotal').forEach(({ g, i }, k) => {
    const s = sentSub[k];
    if (s?.printed === undefined || s.row) return;          // row checkpoints: checked above
    const c = mk(`subtotal "${g.label}"`, s.printed, g.value, model.amounts.get(i), lineModel.amounts.get(i));
    if (!c.ok && lastDiff !== undefined && c.difference === lastDiff) c.follows = true;
    if (!c.ok) lastDiff = c.difference; else lastDiff = undefined;
    checks.push(c);
  });
  if (expectedTotal !== undefined && total !== undefined) {
    // With included tax the document's total is the gross amount: the tape subtracts the
    // included tax, so gross = total - (signed tax line). Not "+ |tax|": for a credit note
    // (negative base) the tax line is positive (found by the fuzz test, seed 2, case 22).
    const inclExact = got.filter(g => g.type === 'tax' && g.included).map(g => neg(g.value));
    const inclOf = (m: ReturnType<typeof roundedModel>) => got.map((g, i) => ({ g, i }))
      .filter(x => x.g.type === 'tax' && x.g.included).map(x => neg(m.amounts.get(x.i) ?? x.g.value));
    const c = mk('total', expectedTotal, decimalSum([total, ...inclExact]),
      decimalSum([model.total, ...inclOf(model)]), decimalSum([lineModel.total, ...inclOf(lineModel)]));
    if (!c.ok && lastDiff !== undefined && c.difference === lastDiff) c.follows = true;
    if (!c.ok && rowDiff !== undefined && c.difference === rowDiff) c.follows = true;
    checks.push(c);
  }
  return checks;
}
