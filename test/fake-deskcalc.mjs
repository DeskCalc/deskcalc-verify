// Stand-in for `deskcalc.exe /verify <job.xml>` in tests.
// FAKE_MODE: confirm | edit | edit_qty | edit_qty_once | cancel | silent | no_free_tab | limit | old
//   old: a DeskCalc before groups - rejects the first group line.
// FAKE_LOG: file that gets one line per job: "<id> replace=<id|->".
//   edit_qty_once: corrects a quantity on the first pass only (job without replace=).
// FAKE_DELAY_MS: delay between acknowledgement and result (the "human").
// Like DeskCalc: tax/percent from the subtotal of the block above; several blocks
// (type="group") get a GT snapshot taken BEFORE the user's correction.
import { readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';

const job = process.argv[process.argv.indexOf('/verify') + 1];
const base = job.replace(/\.xml$/i, '');
let mode = process.env.FAKE_MODE ?? 'confirm';
const delay = Number(process.env.FAKE_DELAY_MS ?? 100);

const xml = new TextDecoder('windows-1252').decode(readFileSync(job));
const id = /\bid="([^"]*)"/.exec(xml)[1];
const isReplace = /\breplace="/.test(xml);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${id} replace=${/\breplace="([^"]*)"/.exec(xml)?.[1] ?? '-'}\n`);
if (mode === 'edit_qty_once') mode = isReplace ? 'confirm' : 'edit_qty';
const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const at = (t, n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(t); return m ? unesc(m[1]) : undefined; };

// lines grouped into blocks
const blocks = [{ label: '', lines: [] }];
for (const m of xml.matchAll(/<LINE\b[^>]*\/>/g)) {
  const t = m[0];
  const type = at(t, 'type');
  if (type === 'group') {
    if (blocks[blocks.length - 1].lines.length) blocks.push({ label: at(t, 'label') ?? '', lines: [] });
    else blocks[blocks.length - 1].label = at(t, 'label') ?? '';
    continue;
  }
  const L = blocks[blocks.length - 1].lines;
  if (type === 'subtotal') { L.push({ sub: true, label: at(t, 'label') ?? '' }); continue; }
  if (type === 'tax') L.push({ tax: true, rate: Number(at(t, 'rate')), incl: at(t, 'incl') === '1', label: at(t, 'label') ?? '' });
  else if (type === 'percent') L.push({ perc: true, rate: Number(at(t, 'rate')), label: at(t, 'label') ?? '' });
  else { const q = at(t, 'qty'); L.push({ value: Number(at(t, 'value')), qty: q ? Number(q) : undefined, label: at(t, 'label') ?? '' }); }
}

const enc = s => Buffer.from([...s].map(c => { const cp = c.codePointAt(0); return cp === 0x20ac ? 0x80 : cp < 256 ? cp : 0x3f; }));
const write = (suffix, body) => {
  const lang = process.env.FAKE_LANG ? ` lang="${process.env.FAKE_LANG}"` : '';
  const text = `<?xml version="1.0" encoding="windows-1252"?>\r\n<VERIFY_RESULT version="1" id="${id}"${lang} ${body}</VERIFY_RESULT>\r\n`;
  writeFileSync(base + suffix + '.tmp', enc(text));
  renameSync(base + suffix + '.tmp', base + suffix);
};
const status = (s, extra = '') => write('.result.xml', `status="${s}" decimal=".">\r\n${extra}`);
const g = n => String(Number(n.toPrecision(15)));
const r2 = n => Math.round(n * 100) / 100;

function evaluate(lines) {
  let run = 0; const out = [];
  for (const l of lines) {
    if (l.sub) { out.push({ ...l, amount: run }); continue; }
    if (l.perc) { const p = run * l.rate / 100; out.push({ ...l, amount: p, base: run }); run += p; }
    else if (l.tax) { const t = l.incl ? -(run - run / (1 + l.rate / 100)) : run * l.rate / 100; out.push({ ...l, amount: t, base: run }); run += t; }
    else { const v = l.qty ? l.value * l.qty : l.value; out.push({ ...l, amount: v }); run += v; }
  }
  return { out, total: run };
}

if (mode === 'silent') process.exit(0);
if (mode === 'old') {
  const k = [...xml.matchAll(/<LINE\b[^>]*\/>/g)].findIndex(m => /type="group"/.test(m[0]));
  if (k >= 0) { status('bad_request', `<PROBLEM line="${k + 1}" value=""/>\r\n`); process.exit(0); }
  mode = 'confirm';
}
if (mode === 'no_free_tab') { status('no_free_tab'); process.exit(0); }
if (mode === 'limit') { status('limit_reached', '<PROBLEM line="2" value="1500000"/>\r\n'); process.exit(0); }

const multi = blocks.length > 1;
const gtSnapshot = blocks.reduce((a, b) => a + r2(evaluate(b.lines).total), 0);   // taken when the tape opens

write('.ack.xml', 'status="opened" decimal=".">\r\n<TABS count="2" slot="1"/>\r\n');
setTimeout(() => {
  if (mode === 'cancel') { status('cancelled'); return; }
  const pos = blocks.flatMap(b => b.lines.filter(l => !l.tax && !l.perc && !l.sub));
  if (mode === 'edit') {
    const L = blocks[0].lines;
    pos[1].value = 5;
    L.splice(L.indexOf(pos[1]) + 1, 0, { value: 78, label: 'inserted' });
    const last = pos[pos.length - 1];
    for (const b of blocks) { const k = b.lines.indexOf(last); if (k >= 0) b.lines.splice(k, 1); }
  }
  if (mode === 'edit_qty') pos.find(l => l.qty).qty += 1;
  let total = 0, gtFresh = 0;
  const out = [], bx = [];
  blocks.forEach((b, i) => {
    const e = evaluate(b.lines);
    total += e.total; gtFresh += r2(e.total);
    const battr = multi ? ` block="${i + 1}"` : '';
    bx.push(`<BLOCK index="${i + 1}" label="${esc(b.label)}" total="${g(e.total)}"/>`);
    for (const l of e.out) {
      if (l.sub) out.push(`<LINE value="${g(l.amount)}" label="${esc(l.label)}" type="subtotal"${battr}/>`);
      else if (l.perc) out.push(`<LINE value="${g(l.amount)}" label="${esc(l.label)}" type="percent" rate="${l.rate}" base="${g(l.base)}"${battr}/>`);
      else if (l.tax) out.push(`<LINE value="${g(l.amount)}" label="${esc(l.label)}" type="tax" rate="${l.rate}" incl="${l.incl ? 1 : 0}" base="${g(l.base)}"${battr}/>`);
      else if (l.qty) out.push(`<LINE value="${g(l.amount)}" label="${esc(l.label)}" qty="${l.qty}" price="${l.value}"${battr}/>`);
      else out.push(`<LINE value="${g(l.amount)}" label="${esc(l.label)}"${battr}/>`);
    }
  });
  const gt = multi ? `<GT value="${g(gtSnapshot)}" fresh="${g(gtFresh)}" outdated="${Math.abs(gtSnapshot - gtFresh) > 1e-9 ? 1 : 0}"/>\r\n` : '';
  status('confirmed', `<TOTAL>${g(total)}</TOTAL>\r\n<CALCULATIONS>${blocks.length}</CALCULATIONS>\r\n` +
    (multi ? bx.join('\r\n') + '\r\n' : '') + gt + out.join('\r\n') + '\r\n');
}, delay);
