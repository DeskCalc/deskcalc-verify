// One verification at a time: write the job, start DeskCalc, wait for the
// acknowledgement and then (in slices) for the human to press Confirm.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findDeskCalc, exchangeDir, launchVerify } from './deskcalc.js';
import { reconcile, type Reconciliation } from './compare.js';
import { buildAuditPdf, auditFileName, type Lang } from './audit.js';
import {
  buildJob, parseResult, diffLines, decimalSum, decimalMul, sameAmount, normaliseValue, cleanLabel,
  checkDocument, rowParts, MAX_LINES, type ColumnTotals, type Item, type Correction, type DeskCalcResult, type ResultLine, type Check,
} from './protocol.js';

export const ACK_TIMEOUT_MS = Number(process.env.DESKCALC_ACK_TIMEOUT_MS ?? 15000);
export const DEFAULT_WAIT_S = 45;
export const MAX_WAIT_S = 120;
const EXPIRE_MS = 2 * 60 * 60 * 1000;
const POLL_MS = 300;

export const PRICING_URL = 'https://www.deskcalc.com/pricing.html?from=verify';
export const DOWNLOAD_URL = 'https://www.deskcalc.com/download-windows-tape-calculator.html?from=verify';

export interface Outcome {
  status: string;
  review_id?: string;
  message: string;
  total?: string;
  lines?: ResultLine[];
  corrections?: Correction[];
  document_check?: { ok: boolean; checks: Check[] };
  gt_outdated?: boolean;
  rerun?: { title: string; items: VerifyItemInput[]; expected_total?: string; expected_net_total?: string; expected_tax_total?: string; row_labels?: RowLabels; replace_review_id: string };
  confirmed_by_user?: boolean;
  problem?: { line?: number; value?: string };
  warnings?: string[];
}

interface Review {
  id: string;
  base: string;
  title: string;
  sent: Item[];
  expectedTotal?: string;
  columns: ColumnTotals;
  rowLabels?: RowLabels;
  lang?: Lang;                   // DeskCalc's language for this tape
  inputTitle: string;
  started: number;
  acked: boolean;
  final?: Outcome;
  confirmedAt?: Date;
  blocks?: string[];
}

const reviews = new Map<string, Review>();
let active: Review | undefined;
// Last confirmed review whose GT line was outdated: its second pass reuses the tab even
// when the agent forgets replace_review_id (hand test 03.11.: Claude did, new tab "(2)").
let lastOutdated: Review | undefined;
// DeskCalc's UI language, as its last acknowledgement/result said; before that the Windows language.
let deskcalcLang: Lang | undefined;
export function currentLang(): Lang {
  if (deskcalcLang) return deskcalcLang;
  try { return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('de') ? 'de' : 'en'; } catch { return 'en'; }
}
function langOf(file: string): Lang | undefined {
  try { return parseResult(readFileSync(file)).lang; } catch { return undefined; }
}

export interface WaitHooks {
  signal?: AbortSignal;
  onTick?: (elapsedS: number) => void | Promise<void>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function cleanup(r: Review) {
  for (const s of ['.xml', '.ack.xml', '.result.xml']) rmSync(r.base + s, { force: true });
}

function finish(r: Review, o: Outcome): Outcome {
  r.final = { ...o, review_id: r.id };
  if (o.status === 'confirmed') r.confirmedAt = new Date();
  if (active === r) active = undefined;
  cleanup(r);
  return r.final;
}

const MESSAGES: Record<string, string> = {
  cancelled: 'The user cancelled the check in DeskCalc. Do not use these numbers; ask the user how to proceed.',
  superseded: 'A newer verification replaced this one in DeskCalc. Do not use these numbers.',
  no_free_tab: 'DeskCalc already has 10 tapes open. Ask the user to close one tape, then call verify_numbers again.',
  limit_reached: `The DeskCalc free version does not show results above 1,000,000 after the 31-day trial. Nothing was shown to the user. A licence removes the limit: ${PRICING_URL}`,
  too_many_digits: 'A number has more digits than DeskCalc can show. Nothing was shown to the user. Check the value named in "problem".',
  bad_request: 'DeskCalc could not read a line (see "problem"). Values must be plain numbers with "." as decimal separator.',
};

const NEWER_KINDS = new Set<string>(['group', 'subtotal']);

function fromResult(r: Review, res: DeskCalcResult): Outcome {
  if (res.lang) r.lang = deskcalcLang = res.lang;
  if (res.status === 'confirmed') {
    const warnings: string[] = [];
    if (res.notes.includes('labels_truncated')) warnings.push('Some labels were longer than 60 characters and were shortened.');
    if ((res.calculations ?? 1) > 1) warnings.push('The user split the tape into several calculations; total is the last calculation shown by DeskCalc.');
    const counted = res.lines.filter(l => l.type !== 'subtotal');   // checkpoints only show the running total
    const plain = counted.every(l => !l.op);   // tax and qty lines carry their signed amount
    if (plain && res.total !== undefined && counted.length > 0) {
      const sum = decimalSum(counted.map(l => l.value));
      if (!sameAmount(sum, res.total)) warnings.push(`Sum of the confirmed lines (${sum}) differs from the DeskCalc total (${res.total}). Ask the user before relying on it.`);
    }
    const corrections = diffLines(r.sent, res.lines);
    const checks = checkDocument(r.sent, res.lines, res.total, r.expectedTotal, r.columns);
    const bad = checks.filter(c => !c.ok);
    let message = corrections.length
      ? `The user checked the tape in DeskCalc, made ${corrections.length} correction(s) and pressed Confirm. Use the total below.`
      : 'The user checked every line in DeskCalc and pressed Confirm without changes. Use the total below.';
    if (checks.length) {
      message += bad.length
        ? ` Document check: ${bad.length} of ${checks.length} figure(s) do NOT match the confirmed tape - report them to the user: ` +
          bad.map(c => `${c.check}: document ${c.document}, DeskCalc ${c.deskcalc} (difference ${c.difference})${c.follows ? ' - follows from the difference above, not a new error' : ''}`).join('; ') + '.' +
          (bad.some(c => c.follows)
            ? ` Only ${bad.filter(c => !c.follows).length} of these are errors of their own; the other ${bad.filter(c => c.follows).length} are computed correctly by the document from a wrong figure above - say so, and give the effect on the amount payable.`
            : '')
        : ` Document check: all ${checks.length} printed figure(s) match the confirmed tape to the cent.`;
      const rounded = checks.filter(c => c.ok && c.rounding);
      if (rounded.length)
        message += ` ${rounded.length} of them differ from DeskCalc's exact result by a rounding amount only (` +
          rounded.map(c => `${c.check}: ${c.difference}`).join('; ') +
          ') - the document rounds tax/discounts to the cent before adding. This is not an error.';
    }
    // Several blocks: the GT line on the tape is a snapshot (like the GT key). If the
    // user corrected a block, it is outdated - offer a second pass with the
    // confirmed lines so the user sees and confirms the corrected invoice.
    let rerun: Outcome['rerun'];
    lastOutdated = res.gt?.outdated ? r : undefined;
    if (res.gt?.outdated) {
      rerun = { title: r.inputTitle, items: rerunItems(r.sent, res.lines), replace_review_id: r.id,
                ...(r.expectedTotal !== undefined ? { expected_total: r.expectedTotal } : {}),
                ...(r.columns.net !== undefined ? { expected_net_total: r.columns.net } : {}),
                ...(r.columns.tax !== undefined ? { expected_tax_total: r.columns.tax } : {}),
                ...(r.rowLabels ? { row_labels: r.rowLabels } : {}) };
      message += ' IMPORTANT: the user corrected the tape, so the GT (grand total) line in DeskCalc is outdated - ' +
        `the total above (${res.total}) is the correct sum of the corrected blocks. Call verify_numbers again with ` +
        'the arguments in "rerun" (same tab in DeskCalc) so the user can confirm the corrected invoice, then use that result.';
    }
    return {
      status: 'confirmed',
      message,
      total: res.total,
      ...(rerun ? { gt_outdated: true, rerun } : {}),
      lines: res.lines,
      corrections,
      ...(checks.length ? { document_check: { ok: bad.length === 0, checks } } : {}),
      confirmed_by_user: true,
      ...(warnings.length ? { warnings } : {}),
    };
  }
  // A DeskCalc started before an update does not know newer line kinds (group, subtotal).
  const pl = res.problem?.line;
  if (res.status === 'bad_request' && pl !== undefined && r.sent[pl - 1] && NEWER_KINDS.has(r.sent[pl - 1].kind)) {
    return {
      status: 'deskcalc_update_required',
      message: `The running DeskCalc does not know "${r.sent[pl - 1].kind}" lines - it is older than this server. Ask the user to close DeskCalc completely (it may still run from before an update) and try again; if it persists, DeskCalc must be updated: ${DOWNLOAD_URL}`,
      problem: res.problem,
    };
  }
  return {
    status: res.status,
    message: MESSAGES[res.status] ?? `DeskCalc reported status "${res.status}".`,
    ...(res.problem ? { problem: res.problem } : {}),
  };
}

function pending(r: Review): Outcome {
  return {
    status: 'pending',
    review_id: r.id,
    message: `The tape "${r.title}" is open in DeskCalc and waiting for the user. Ask them to check the lines, correct anything that is wrong and press Confirm in DeskCalc; then call get_verification with review_id "${r.id}". Do not use the numbers before that.`,
  };
}

async function waitFor(r: Review, waitS: number, hooks: WaitHooks): Promise<Outcome> {
  const start = Date.now();
  const limit = Math.min(Math.max(waitS, 0), MAX_WAIT_S) * 1000;
  let lastTick = -1;
  for (;;) {
    if (r.final) return r.final;
    const resultFile = r.base + '.result.xml';
    if (existsSync(resultFile)) {
      let res: DeskCalcResult | undefined;
      try { res = parseResult(readFileSync(resultFile)); } catch { /* partially written - retry */ }
      if (res) {
        if (res.blocks?.length) r.blocks = res.blocks.map(b => b.label.replace(/\s*\(\d+ \S+\)$/, ''));
        return finish(r, fromResult(r, res));
      }
    }
    if (!r.acked && existsSync(r.base + '.ack.xml')) {
      r.acked = true;
      const l = langOf(r.base + '.ack.xml');
      if (l) r.lang = deskcalcLang = l;
    }
    if (!r.acked && Date.now() - r.started > ACK_TIMEOUT_MS) {
      return finish(r, {
        status: 'deskcalc_update_required',
        message: `DeskCalc did not respond to the verification request. DeskCalc 11.3 or later is required (and it must not be blocked by an open dialog). Download: ${DOWNLOAD_URL}`,
      });
    }
    if (Date.now() - r.started > EXPIRE_MS) {
      return finish(r, { status: 'expired', message: 'The verification was not confirmed within 2 hours and has expired.' });
    }
    const elapsed = Date.now() - start;
    if (r.acked && elapsed >= limit) return pending(r);
    if (hooks.signal?.aborted) return pending(r);
    const sec = Math.floor(elapsed / 5000);
    if (hooks.onTick && sec !== lastTick) { lastTick = sec; await hooks.onTick(Math.round(elapsed / 1000)); }
    await sleep(POLL_MS);
  }
}

export interface VerifyItemInput {
  type?: 'amount' | 'tax' | 'percent' | 'group' | 'subtotal';
  label?: string;
  value?: number | string;      // amount; with qty/price: the printed line total; tax: the printed tax amount
  qty?: number | string;
  price?: number | string;
  rate?: number | string;       // tax rate in %; percent: negative = discount, positive = surcharge
  included?: boolean;           // tax contained in the amounts above (gross prices)
  net?: number | string;        // cross-footing: printed net of the row (value = printed gross)
  tax?: number | string;        // cross-footing: printed tax of the row
  foreign?: number | string;    // foreign currency amount (with fx_rate)
  currency?: string;            // e.g. "USD"
  fx_rate?: number | string;    // home currency per 1 unit of the foreign currency
}

export interface RowLabels { net?: string; tax?: string; gross?: string }

export interface VerifyInput {
  title: string;
  row_labels?: RowLabels;       // cross-footing: tape labels of the net/tax/gross lines (user's language)
  items: VerifyItemInput[];
  expected_total?: number | string;
  expected_net_total?: number | string;
  expected_tax_total?: number | string;
  wait_seconds?: number;
  replace_review_id?: string;
}

/** Confirmed lines back into tool arguments (second pass); printed figures carried over. */
function rerunItems(sent: Item[], got: ResultLine[]): VerifyItemInput[] {
  const rows = rowParts(sent, got);   // a cross-footed table: back to one line per row
  if (rows.length) return rows.map(r => ({ label: r.label, value: r.printed, net: r.net, tax: r.tax }));
  const groups = sent.filter(s => s.kind === 'group');
  const used = new Set<Item>();
  const printedFor = (kind: string, label: string) => {
    const s = sent.find(x => !used.has(x) && x.kind === kind && x.label === label);
    if (s) used.add(s);
    return s?.printed;
  };
  const out: VerifyItemInput[] = [];
  let block = 0;
  for (const g of got) {
    if (groups.length && (g.block ?? 1) !== block) {
      block = g.block ?? 1;
      out.push({ type: 'group', label: groups[block - 1]?.label ?? '' });
    }
    if (g.type === 'subtotal') {
      const p = printedFor('subtotal', g.label);
      out.push({ type: 'subtotal', label: g.label, ...(p !== undefined ? { value: p } : {}) });
    } else if (g.type === 'tax') {
      const p = printedFor('tax', g.label);
      out.push({ type: 'tax', rate: g.rate, included: !!g.included, label: g.label, ...(p !== undefined ? { value: p } : {}) });
    } else if (g.type === 'percent') {
      const p = printedFor('percent', g.label);
      out.push({ type: 'percent', rate: g.rate, label: g.label, ...(p !== undefined ? { value: p } : {}) });
    } else if (g.qty !== undefined) {
      const p = printedFor('qty', g.label);
      out.push({ label: g.label, qty: g.qty, price: g.price, ...(p !== undefined ? { value: p } : {}) });
    } else {
      out.push({ label: g.label, value: g.value });
    }
  }
  return out;
}

function toItem(x: VerifyItemInput, line: number): Item | { error: string } {
  const label = cleanLabel(x.label);
  const num = (v: unknown, what: string) => {
    const n = normaliseValue(v);
    return n.ok ? n.value : { error: `Line ${line}: ${what} ${n.error}` };
  };
  if (x.type === 'group') return { kind: 'group', label, value: '' };
  if (x.type === 'subtotal') {
    let printed: string | undefined;
    if (x.value !== undefined) { const p = num(x.value, 'value'); if (typeof p !== 'string') return p; printed = p; }
    return { kind: 'subtotal', label, value: '', printed };
  }
  if (x.type === 'percent') {
    const rate = num(x.rate, 'rate');
    if (typeof rate !== 'string') return rate;
    if (!(Number(rate) !== 0 && Math.abs(Number(rate)) < 100)) return { error: `Line ${line}: percent must be between -100 and 100 (negative = discount).` };
    let printed: string | undefined;
    if (x.value !== undefined) { const p = num(x.value, 'value'); if (typeof p !== 'string') return p; printed = p; }
    return { kind: 'percent', label, value: '', rate, printed };
  }
  if (x.type === 'tax' || x.rate !== undefined) {
    const rate = num(x.rate, 'rate');
    if (typeof rate !== 'string') return rate;
    if (!(Number(rate) > 0 && Number(rate) < 100)) return { error: `Line ${line}: tax rate must be between 0 and 100 (percent).` };
    let printed: string | undefined;
    if (x.value !== undefined) { const p = num(x.value, 'value'); if (typeof p !== 'string') return p; printed = p; }
    return { kind: 'tax', label, value: '', rate, included: !!x.included, printed };
  }
  if (x.fx_rate !== undefined || x.foreign !== undefined) {
    // Foreign currency: foreign amount x rate, shown like qty x price; value = printed home amount.
    const rate = num(x.fx_rate, 'fx_rate'); if (typeof rate !== 'string') return rate;
    const foreign = num(x.foreign, 'foreign'); if (typeof foreign !== 'string') return foreign;
    if (!(Number(rate) > 0)) return { error: `Line ${line}: fx_rate must be greater than 0 (home currency per 1 ${x.currency ?? 'unit'}).` };
    let printed: string | undefined;
    if (x.value !== undefined) { const p = num(x.value, 'value'); if (typeof p !== 'string') return p; printed = p; }
    const cur = cleanLabel(x.currency).slice(0, 4);
    return { kind: 'qty', label: label || `${cur} ${foreign}`.trim(), qty: rate, price: foreign, value: decimalMul(rate, foreign), printed };
  }
  if (x.qty !== undefined || x.price !== undefined) {
    const qty = num(x.qty, 'qty'); if (typeof qty !== 'string') return qty;
    const price = num(x.price, 'price'); if (typeof price !== 'string') return price;
    if (!(Number(qty) > 0)) return { error: `Line ${line}: qty must be greater than 0.` };
    let printed: string | undefined;
    if (x.value !== undefined) { const p = num(x.value, 'value'); if (typeof p !== 'string') return p; printed = p; }
    return { kind: 'qty', label, qty, price, value: decimalMul(qty, price), printed };
  }
  const value = num(x.value, 'value'); if (typeof value !== 'string') return value;
  if ((x.net === undefined) !== (x.tax === undefined)) return { error: `Line ${line}: cross-footing needs both net and tax (value = gross).` };
  if (x.net !== undefined) {
    const net = num(x.net, 'net'); if (typeof net !== 'string') return net;
    const tax = num(x.tax, 'tax'); if (typeof tax !== 'string') return tax;
    return { kind: 'amount', label, value, net, tax };
  }
  return { kind: 'amount', label, value };
}

export async function verifyNumbers(input: VerifyInput, hooks: WaitHooks = {}): Promise<Outcome> {
  // The previous check may already be finished in DeskCalc without anyone asking.
  if (active && !active.final) await waitFor(active, 0, {});
  if (active && !active.final) {
    return {
      status: 'busy',
      review_id: active.id,
      message: `Another verification ("${active.title}") is still open in DeskCalc. Ask the user to confirm or cancel it, then call get_verification with review_id "${active.id}" before starting a new one.`,
    };
  }
  if (!input.items?.length) return { status: 'bad_request', message: 'items must contain at least one line.' };
  if (input.items.length > MAX_LINES) return { status: 'bad_request', message: `At most ${MAX_LINES} lines per verification.` };

  const items: Item[] = [];
  let inBlock = 0;                                     // positions in the current block
  // Cross-footing: each table row becomes its own block - net, tax and the printed gross as a
  // checkpoint - so the user sees all three figures and DeskCalc computes net + tax.
  const de = currentLang() === 'de';            // tape labels in DeskCalc's language
  const RL = { net: cleanLabel(input.row_labels?.net) || (de ? 'Netto' : 'Net'), tax: cleanLabel(input.row_labels?.tax) || (de ? 'USt' : 'Tax'),
               gross: cleanLabel(input.row_labels?.gross) || (de ? 'Brutto lt. Beleg' : 'Gross per document') };
  let rowCount = 0, other = 0;
  for (let i = 0; i < input.items.length; i++) {
    const it = toItem(input.items[i], i + 1);
    if ('error' in it) return { status: 'bad_request', message: it.error, problem: { line: i + 1 } };
    if (it.kind === 'amount' && it.net !== undefined) {
      rowCount++;
      items.push({ kind: 'group', label: it.label || `Row ${rowCount}`, value: '', row: 'group' },
                 { kind: 'amount', label: RL.net, value: it.net, row: 'net' },
                 { kind: 'amount', label: RL.tax, value: it.tax!, row: 'tax' },
                 { kind: 'subtotal', label: RL.gross, value: '', printed: it.value, row: 'gross' });
      inBlock = 2;
      continue;
    }
    other++;
    if (it.kind === 'group') {
      if (i > 0 && inBlock === 0)
        return { status: 'bad_request', message: `Line ${i + 1}: the group above has no positions.`, problem: { line: i + 1 } };
      inBlock = 0;
    } else if (it.kind === 'tax' || it.kind === 'percent' || it.kind === 'subtotal') {
      if (inBlock === 0)
        return { status: 'bad_request', message: `Line ${i + 1}: a ${it.kind} line needs the positions it applies to above it (in the same group).`, problem: { line: i + 1 } };
    } else inBlock++;
    items.push(it);
  }
  if (items.length && inBlock === 0)
    return { status: 'bad_request', message: 'The last group has no positions.', problem: { line: items.length } };
  if (rowCount && other)
    return { status: 'bad_request', message: 'A cross-footed table takes only rows {label, value: gross, net, tax}. Check other lines in a separate verification.' };
  if (items.length > MAX_LINES)
    return { status: 'bad_request', message: `Too many lines for one tape (each cross-footed row takes 4, at most ${Math.floor(MAX_LINES / 4)} rows). Split the table, e.g. per page.` };
  let expectedTotal: string | undefined;
  if (input.expected_total !== undefined) {
    const e = normaliseValue(input.expected_total);
    if (!e.ok) return { status: 'bad_request', message: `expected_total: ${e.error}` };
    expectedTotal = e.value;
  }
  const columns: ColumnTotals = {};
  for (const [k, v] of [['net', input.expected_net_total], ['tax', input.expected_tax_total]] as const) {
    if (v === undefined) continue;
    const e = normaliseValue(v);
    if (!e.ok) return { status: 'bad_request', message: `expected_${k}_total: ${e.error}` };
    columns[k] = e.value;
  }

  const dc = findDeskCalc();
  if (!dc.found || !dc.path) {
    return { status: 'deskcalc_not_found', message: `DeskCalc is not installed (or not found). It is a Windows app with a free 31-day trial: ${DOWNLOAD_URL}` };
  }

  const id = randomBytes(4).toString('hex');
  const base = join(exchangeDir(), `v-${id}`);
  // Second pass: reuse the tab of the confirmed review it replaces.
  const auto = !input.replace_review_id && lastOutdated?.inputTitle === input.title ? lastOutdated : undefined;
  const prev = input.replace_review_id ? reviews.get(input.replace_review_id) : auto;
  lastOutdated = undefined;
  const replace = prev?.final?.status === 'confirmed' ? prev.id : undefined;
  const job = buildJob(id, input.title, items, replace);
  writeFileSync(base + '.xml.tmp', job.bytes);
  renameSync(base + '.xml.tmp', base + '.xml');

  const r: Review = { id, base, title: cleanLabel(input.title) || 'Verify', inputTitle: input.title, sent: items, expectedTotal, columns, ...(rowCount ? { rowLabels: input.row_labels ?? {} } : {}), started: Date.now(), acked: false };
  reviews.set(id, r);
  active = r;
  launchVerify(dc.path, base + '.xml');

  const out = await waitFor(r, input.wait_seconds ?? DEFAULT_WAIT_S, hooks);
  if (job.replaced && out.status === 'confirmed') {
    out.warnings = [...(out.warnings ?? []), `${job.replaced} character(s) in the labels have no Windows-1252 form and were replaced by "?".`];
  }
  return out;
}

export async function getVerification(reviewId: string, waitS = DEFAULT_WAIT_S, hooks: WaitHooks = {}): Promise<Outcome> {
  const r = reviews.get(reviewId);
  if (!r) return { status: 'unknown_review', message: `No verification with review_id "${reviewId}" in this session.` };
  return waitFor(r, waitS, hooks);
}

export function status() {
  const dc = findDeskCalc();
  return {
    found: dc.found,
    kind: dc.kind ?? null,
    path: dc.path ?? null,
    exchange_dir: exchangeDir(),
    open_review: active && !active.final ? active.id : null,
    download: dc.found ? undefined : DOWNLOAD_URL,
  };
}

function confirmedReview(id: string): Review | Outcome {
  const r = reviews.get(id);
  if (!r) return { status: 'unknown_review', message: `No verification with review_id "${id}" in this session.` };
  if (r.final?.status !== 'confirmed') return { status: 'not_confirmed', message: `Verification "${id}" is not confirmed (yet). Only confirmed tapes can be used.` };
  return r;
}

/** V7: reconcile two confirmed tapes (invoice <-> delivery note / order / payment). */
export function compareVerifications(a: string, b: string, ignoreSign = false): Outcome & { reconciliation?: Reconciliation } {
  const ra = confirmedReview(a), rb = confirmedReview(b);
  if (!('base' in ra)) return ra;
  if (!('base' in rb)) return rb;
  const rec = reconcile(ra.final!.lines ?? [], rb.final!.lines ?? [], ignoreSign);
  const open = rec.amount_differs.length + rec.only_in_a.length + rec.only_in_b.length;
  const message = open === 0 && rec.difference === '0.00'
    ? `All ${rec.matched.length} position(s) of "${ra.title}" and "${rb.title}" match to the cent.`
    : `"${ra.title}" vs "${rb.title}": ${rec.matched.length} matched, ${rec.amount_differs.length} with a different amount, ` +
      `${rec.only_in_a.length} only in "${ra.title}", ${rec.only_in_b.length} only in "${rb.title}". Total difference ${rec.difference}. ` +
      'Report the open items to the user; both sides were confirmed by the user in DeskCalc.';
  return { status: 'compared', message, reconciliation: rec };
}

/** V9: write the audit record (PDF) of a confirmed verification. */
export function saveAuditRecord(id: string, opts: { source?: string; note?: string; language?: Lang; version: string }): Outcome & { file?: string } {
  const r = confirmedReview(id);
  if (!('base' in r)) return r;
  const lang: Lang = opts.language ?? r.lang ?? currentLang();   // DeskCalc's language unless the user asks otherwise
  const dir = join(exchangeDir(), lang === 'de' ? 'Prüfnachweise' : 'Audit records');
  mkdirSync(dir, { recursive: true });
  const at = r.confirmedAt ?? new Date();
  const file = join(dir, auditFileName(r.title, at, r.id));
  const pdf = buildAuditPdf({
    reviewId: r.id, title: r.title, source: opts.source, note: opts.note, confirmedAt: at,
    total: r.final!.total ?? '0', expectedTotal: r.expectedTotal, lines: r.final!.lines ?? [], blocks: r.blocks,
    corrections: r.final!.corrections ?? [], checks: r.final!.document_check?.checks ?? [], version: opts.version, lang,
  });
  writeFileSync(file, pdf);
  return { status: 'saved', file, message: `Audit record saved as PDF: ${file}. Tell the user where it is; it belongs in the working papers.` };
}
