// Stand-in for `deskcalc.exe /verify <job.xml>` in tests.
// FAKE_MODE: confirm | edit | cancel | silent | no_free_tab | limit
// FAKE_DELAY_MS: delay between acknowledgement and result (the "human").
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const job = process.argv[process.argv.indexOf('/verify') + 1];
const base = job.replace(/\.xml$/i, '');
const mode = process.env.FAKE_MODE ?? 'confirm';
const delay = Number(process.env.FAKE_DELAY_MS ?? 100);

const dec = new TextDecoder('windows-1252');
const xml = dec.decode(readFileSync(job));
const id = /id="([^"]*)"/.exec(xml)[1];
const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let lines = [...xml.matchAll(/<LINE value="([^"]*)" label="([^"]*)"\/>/g)].map(m => ({ value: m[1], label: unesc(m[2]) }));

// Latin-1 range is enough for the test labels (€ is tested via the server's encoder).
const enc = s => Buffer.from([...s].map(c => { const cp = c.codePointAt(0); return cp === 0x20ac ? 0x80 : cp < 256 ? cp : 0x3f; }));
const write = (suffix, body) => {
  const text = `<?xml version="1.0" encoding="windows-1252"?>\r\n<VERIFY_RESULT version="1" id="${id}" ${body}</VERIFY_RESULT>\r\n`;
  writeFileSync(base + suffix + '.tmp', enc(text));
  renameSync(base + suffix + '.tmp', base + suffix);
};
const status = (s, extra = '') => write('.result.xml', `status="${s}" decimal=".">\r\n${extra}`);

if (mode === 'silent') process.exit(0);
if (mode === 'no_free_tab') { status('no_free_tab'); process.exit(0); }
if (mode === 'limit') { status('limit_reached', '<PROBLEM line="2" value="1500000"/>\r\n'); process.exit(0); }

write('.ack.xml', 'status="opened" decimal=".">\r\n<TABS count="2" slot="1"/>\r\n');
setTimeout(() => {
  if (mode === 'cancel') { status('cancelled'); return; }
  if (mode === 'edit') {
    lines[1] = { ...lines[1], value: '5' };                 // changed
    lines.splice(2, 0, { value: '78', label: 'inserted' }); // added
    lines.pop();                                            // removed (last)
  }
  const total = lines.reduce((a, l) => a + Number(l.value), 0);
  const body = lines.map(l => `<LINE value="${l.value}" label="${esc(l.label)}"/>`).join('\r\n');
  status('confirmed', `<TOTAL>${Number(total.toPrecision(15))}</TOTAL>\r\n<CALCULATIONS>1</CALCULATIONS>\r\n${body}\r\n`);
}, delay);
