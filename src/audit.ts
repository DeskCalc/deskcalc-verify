// Audit record (Prüfnachweis) of a confirmed verification as a PDF for the working
// papers: document, who confirmed when, every line with its arithmetic, the user's
// corrections and the document check. A short fingerprint lets a reviewer see that
// the record was not edited by hand.

import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { buildPdf, PDF_COLS, type PdfLine } from './pdf.js';
import { roundCents, type Check, type Correction, type ResultLine } from './protocol.js';

export type Lang = 'de' | 'en';

export interface AuditInput {
  reviewId: string;
  title: string;
  source?: string;               // the checked document, e.g. "RE-2026-0001.pdf"
  note?: string;
  confirmedAt: Date;
  total: string;
  expectedTotal?: string;
  lines: ResultLine[];
  blocks?: string[];             // block labels (mixed tax rates)
  corrections: Correction[];
  checks: Check[];
  version: string;
  lang: Lang;
}

const T = {
  de: {
    head: 'DeskCalc Verify - Prüfnachweis', doc: 'Beleg', tab: 'Streifen', at: 'Geprüft am', by: 'von',
    id: 'Prüfungs-ID', confirmed: 'In DeskCalc Zeile für Zeile geprüft und bestätigt durch den Anwender.',
    cols: ['Nr.', 'Text', 'Rechnung', 'Betrag'], total: 'Summe (bestätigt)', expected: 'Gesamtbetrag lt. Beleg',
    corr: 'Korrekturen des Anwenders', none: 'keine', check: 'Belegprüfung (auf den Cent)', noCheck: 'keine gedruckten Werte übergeben',
    tax: 'USt', incl: 'inkl.', of: 'von', disc: 'Rabatt', sur: 'Aufschlag', sub: 'Zwischensumme lt. Beleg', block: 'Block',
    doc_: 'Beleg', dc: 'DeskCalc', gross: 'Brutto', colSum: 'Summe der Zeilen', diff: 'Differenz', follows: 'Folgefehler', round: 'Rundungsdifferenz, kein Fehler',
    note: 'Notiz', fp: 'Fingerabdruck', page: 'Seite', made: 'Erstellt mit DeskCalc Verify',
    c: {
      changed: (l: string, a: string, b: string) => `geändert ${l}: ${a} -> ${b}`,
      relabelled: (v: string, a: string, b: string) => `Text geändert (${v}): "${a}" -> "${b}"`,
      added: (l: string, v: string) => `hinzugefügt ${l}: ${v}`,
      removed: (l: string, v: string) => `entfernt ${l}: ${v}`,
      rate: (l: string, a: string, b: string) => `Satz geändert ${l}: ${a} -> ${b}`,
    },
  },
  en: {
    head: 'DeskCalc Verify - Audit record', doc: 'Document', tab: 'Tape', at: 'Checked on', by: 'by',
    id: 'Review ID', confirmed: 'Checked line by line and confirmed by the user in DeskCalc.',
    cols: ['No.', 'Text', 'Calculation', 'Amount'], total: 'Total (confirmed)', expected: 'Total per document',
    corr: 'Corrections by the user', none: 'none', check: 'Document check (to the cent)', noCheck: 'no printed figures given',
    tax: 'Tax', incl: 'incl.', of: 'of', disc: 'Discount', sur: 'Surcharge', sub: 'Subtotal per document', block: 'Block',
    doc_: 'document', dc: 'DeskCalc', gross: 'gross', colSum: 'sum of rows', diff: 'difference', follows: 'follows from above', round: 'rounding difference, not an error',
    note: 'Note', fp: 'Fingerprint', page: 'Page', made: 'Created with DeskCalc Verify',
    c: {
      changed: (l: string, a: string, b: string) => `changed ${l}: ${a} -> ${b}`,
      relabelled: (v: string, a: string, b: string) => `text changed (${v}): "${a}" -> "${b}"`,
      added: (l: string, v: string) => `added ${l}: ${v}`,
      removed: (l: string, v: string) => `removed ${l}: ${v}`,
      rate: (l: string, a: string, b: string) => `rate changed ${l}: ${a} -> ${b}`,
    },
  },
};

export function fmtAmount(v: string, lang: Lang): string {
  const r = roundCents(v);
  const neg = r.startsWith('-');
  const [i, f] = r.replace('-', '').split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, lang === 'de' ? '.' : ',');
  return (neg ? '-' : '') + g + (lang === 'de' ? ',' : '.') + f;
}
const fmtNum = (v: string, lang: Lang) => (lang === 'de' ? v.replace('.', ',') : v);

/** "2026-11-03 1945 Rechnung gemischt.pdf" - no characters Windows forbids. */
export function auditFileName(title: string, at: Date, id: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ${p(at.getHours())}${p(at.getMinutes())}`;
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'Verify';
  return `${stamp} ${safe} ${id}.pdf`;
}

/** The check names come from checkDocument (English, for the agent) - readable in the record. */
export function checkName(check: string, lang: Lang): string {
  const n = (v: string) => fmtNum(v, lang);
  const A = (v: string) => fmtAmount(v, lang);
  const de = lang === 'de';
  let m: RegExpExecArray | null;
  if ((m = /^line \d+ "(.*)": (\S+) x (\S+)$/.exec(check))) return `"${m[1]}": ${n(m[2])} x ${n(m[3])}`;
  if ((m = /^tax (\S+) %( \(included\))? on (\S+)$/.exec(check)))
    return de ? `USt ${n(m[1])} %${m[2] ? ' inkl.' : ''} von ${A(m[3])}` : `tax ${m[1]} %${m[2] ? ' incl.' : ''} on ${A(m[3])}`;
  if ((m = /^(discount|surcharge) (\S+) % on (\S+)$/.exec(check)))
    return de ? `${m[1] === 'discount' ? 'Rabatt' : 'Aufschlag'} ${n(m[2])} % von ${A(m[3])}` : `${m[1]} ${m[2]} % on ${A(m[3])}`;
  if ((m = /^subtotal "(.*)"$/.exec(check))) return de ? `Zwischensumme "${m[1]}"` : check;
  if ((m = /^row "(.*)": net (\S+) \+ tax (\S+)$/.exec(check)))
    return de ? `Zeile "${m[1]}": Netto ${A(m[2])} + USt ${A(m[3])}` : `row "${m[1]}": net ${A(m[2])} + tax ${A(m[3])}`;
  if (de && check === 'net column') return 'Netto-Spalte';
  if (de && check === 'tax column') return 'USt-Spalte';
  if (de && check === 'total') return 'Gesamtbetrag';
  return check;
}

export function buildAuditPdf(a: AuditInput): Buffer {
  const t = T[a.lang];
  const L: PdfLine[] = [];
  // Long lines wrap at a space; continuation lines are indented.
  const add = (text = '', bold = false) => {
    let rest = text, first = true;
    while (true) {
      const lim = first ? PDF_COLS : PDF_COLS - 8;
      if (rest.length <= lim) { L.push({ text: (first ? '' : ' '.repeat(8)) + rest, bold }); return; }
      let cut = rest.lastIndexOf(' ', lim);
      if (cut < lim / 2) cut = lim;
      L.push({ text: (first ? '' : ' '.repeat(8)) + rest.slice(0, cut), bold });
      rest = rest.slice(cut).trimStart(); first = false;
    }
  };
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '.' : s.padEnd(n));
  const row = (no: string, text: string, calc: string, amount: string, bold = false) =>
    add(pad(no, 5) + pad(text, 34) + pad(calc, PDF_COLS - 5 - 34 - 16) + amount.padStart(16), bold);
  const p = (n: number) => String(n).padStart(2, '0');
  const d = a.confirmedAt;
  const when = a.lang === 'de'
    ? `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  let user = '';
  try { user = `${userInfo().username} (${hostname()})`; } catch { user = hostname(); }

  add(t.head, true);
  add('='.repeat(PDF_COLS));
  if (a.source) add(`${t.doc}: ${a.source}`);
  add(`${t.tab}: ${a.title}`);
  add(`${t.at}: ${when}   ${t.by}: ${user}`);
  add(`${t.id}: ${a.reviewId}`);
  add(t.confirmed);
  if (a.note) add(`${t.note}: ${a.note}`);
  add();
  row(t.cols[0], t.cols[1], t.cols[2], t.cols[3], true);
  add('-'.repeat(PDF_COLS));
  let block = 0, n = 0;
  for (const g of a.lines) {
    if (a.blocks && a.blocks.length > 1 && (g.block ?? 1) !== block) {
      block = g.block ?? 1;
      if (block > 1) add();
      add(`${t.block} ${block}: ${a.blocks[block - 1] ?? ''}`, true);
    }
    let calc = '';
    if (g.type === 'tax') calc = `${t.tax} ${fmtNum(g.rate ?? '', a.lang)} %${g.included ? ' ' + t.incl : ''} ${t.of} ${fmtAmount(g.base ?? '0', a.lang)}`;
    else if (g.type === 'percent') calc = `${Number(g.rate) < 0 ? t.disc : t.sur} ${fmtNum((g.rate ?? '').replace('-', ''), a.lang)} % ${t.of} ${fmtAmount(g.base ?? '0', a.lang)}`;
    else if (g.type === 'subtotal') calc = t.sub;
    else if (g.qty !== undefined) calc = `${fmtNum(g.qty, a.lang)} x ${fmtNum(g.price ?? '', a.lang)}`;
    const amount = fmtAmount(g.value, a.lang);
    row(g.type === 'subtotal' ? '' : String(++n), g.label, calc, g.type === 'subtotal' ? `(${amount})` : amount);
  }
  add('-'.repeat(PDF_COLS));
  row('', t.total, '', fmtAmount(a.total, a.lang), true);
  if (a.expectedTotal !== undefined) row('', t.expected, '', fmtAmount(a.expectedTotal, a.lang));
  add();
  add(t.corr, true);
  if (!a.corrections.length) add(`  ${t.none}`);
  for (const c of a.corrections) {
    const lab = 'line' in c ? `#${c.line} "${c.type === 'relabelled' ? '' : c.label}"` : `"${c.label}"`;
    if (c.type === 'changed') add('  ' + t.c.changed(lab, fmtAmount(c.before, a.lang), fmtAmount(c.after, a.lang)));
    else if (c.type === 'relabelled') add('  ' + t.c.relabelled(fmtAmount(c.value, a.lang), c.before, c.after));
    else if (c.type === 'added') add('  ' + t.c.added(lab, fmtAmount(c.value, a.lang)));
    else if (c.type === 'removed') add('  ' + t.c.removed(lab, fmtAmount(c.value, a.lang)));
    else add('  ' + t.c.rate(lab, c.before, c.after));
  }
  add();
  add(t.check, true);
  if (!a.checks.length) add(`  ${t.noCheck}`);
  for (const c of a.checks) {
    // Rows: DeskCalc adds net + tax on the tape; column totals are added up by the server.
    const isRow = c.check.startsWith('row '), col = c.check === 'net column' || c.check === 'tax column';
    const docL = isRow ? t.gross : t.doc_, calcL = col ? t.colSum : t.dc;
    let s = `  [${c.ok ? 'OK ' : 'ABW'}] ${checkName(c.check, a.lang)}: ${docL} ${fmtAmount(c.document, a.lang)}, ${calcL} ${fmtAmount(c.deskcalc, a.lang)}`;
    if (c.difference && !c.ok) s += `, ${t.diff} ${fmtAmount(c.difference, a.lang)}`;
    if (c.follows) s += ` (${t.follows})`;
    if (c.ok && c.rounding) s += ` (${t.round})`;
    add(s);
  }
  if (a.lang === 'en') L.forEach(l => { l.text = l.text.replace('[ABW]', '[DIFF]'); });
  const fp = createHash('sha256').update(JSON.stringify([a.reviewId, a.title, a.source, when, a.lines, a.total, a.corrections, a.checks])).digest('hex').slice(0, 16);
  add();
  add(`${t.fp}: ${fp}`);
  return buildPdf(L, (pg, pgs) => `${t.made} ${a.version} - ${t.id} ${a.reviewId} - ${t.page} ${pg}/${pgs}`, `${t.head}: ${a.title}`);
}
