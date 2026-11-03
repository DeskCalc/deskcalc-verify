// Stand-in for `deskcalc.exe /verify <job.xml>` in tests.
// FAKE_MODE: confirm | edit | edit_qty | cancel | silent | no_free_tab | limit
// FAKE_DELAY_MS: delay between acknowledgement and result (the "human").
// Tax lines are computed like DeskCalc: from the subtotal of everything above.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const job = process.argv[process.argv.indexOf('/verify') + 1];
const base = job.replace(/\.xml$/i, '');
const mode = process.env.FAKE_MODE ?? 'confirm';
const delay = Number(process.env.FAKE_DELAY_MS ?? 100);

const xml = new TextDecoder('windows-1252').decode(readFileSync(job));
const id = /id="([^"]*)"/.exec(xml)[1];
const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const at = (t, n) => { const m = new RegExp(`\\b${n}="([^"]*)"`).exec(t); return m ? unesc(m[1]) : undefined; };
let lines = [...xml.matchAll(/<LINE\b[^>]*\/>/g)].map(m => {
  const t = m[0];
  if (at(t, 'type') === 'tax') return { tax: true, rate: Number(at(t, 'rate')), incl: at(t, 'incl') === '1', label: at(t, 'label') ?? '' };
  if (at(t, 'type') === 'percent') return { perc: true, rate: Number(at(t, 'rate')), label: at(t, 'label') ?? '' };
  const qty = at(t, 'qty');
  return { value: Number(at(t, 'value')), qty: qty ? Number(qty) : undefined, label: at(t, 'label') ?? '' };
});

const enc = s => Buffer.from([...s].map(c => { const cp = c.codePointAt(0); return cp === 0x20ac ? 0x80 : cp < 256 ? cp : 0x3f; }));
const write = (suffix, body) => {
  const text = `<?xml version="1.0" encoding="windows-1252"?>\r\n<VERIFY_RESULT version="1" id="${id}" ${body}</VERIFY_RESULT>\r\n`;
  writeFileSync(base + suffix + '.tmp', enc(text));
  renameSync(base + suffix + '.tmp', base + suffix);
};
const status = (s, extra = '') => write('.result.xml', `status="${s}" decimal=".">\r\n${extra}`);
const g = n => String(Number(n.toPrecision(15)));

if (mode === 'silent') process.exit(0);
if (mode === 'no_free_tab') { status('no_free_tab'); process.exit(0); }
if (mode === 'limit') { status('limit_reached', '<PROBLEM line="2" value="1500000"/>\r\n'); process.exit(0); }

write('.ack.xml', 'status="opened" decimal=".">\r\n<TABS count="2" slot="1"/>\r\n');
setTimeout(() => {
  if (mode === 'cancel') { status('cancelled'); return; }
  const pos = lines.filter(l => !l.tax && !l.perc);
  if (mode === 'edit') {
    pos[1].value = 5;                                        // changed
    lines.splice(lines.indexOf(pos[1]) + 1, 0, { value: 78, label: 'inserted' }); // added
    lines.splice(lines.indexOf(pos[pos.length - 1]), 1);     // removed (last position)
  }
  if (mode === 'edit_qty') pos.find(l => l.qty).qty += 1;   // user corrects a quantity
  let run = 0;
  const out = [];
  for (const l of lines) {
    if (l.perc) {
      const p = run * l.rate / 100;
      out.push(`<LINE value="${g(p)}" label="${esc(l.label)}" type="percent" rate="${l.rate}" base="${g(run)}"/>`);
      run += p;
    } else if (l.tax) {
      const t = l.incl ? -(run - run / (1 + l.rate / 100)) : run * l.rate / 100;
      out.push(`<LINE value="${g(t)}" label="${esc(l.label)}" type="tax" rate="${l.rate}" incl="${l.incl ? 1 : 0}" base="${g(run)}"/>`);
      run += t;
    } else if (l.qty) {
      const v = l.value * l.qty;
      out.push(`<LINE value="${g(v)}" label="${esc(l.label)}" qty="${l.qty}" price="${l.value}"/>`);
      run += v;
    } else {
      out.push(`<LINE value="${g(l.value)}" label="${esc(l.label)}"/>`);
      run += l.value;
    }
  }
  status('confirmed', `<TOTAL>${g(run)}</TOTAL>\r\n<CALCULATIONS>1</CALCULATIONS>\r\n${out.join('\r\n')}\r\n`);
}, delay);
