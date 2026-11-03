// Minimal PDF writer: A4 pages of monospaced text (Courier / Courier-Bold, the
// standard fonts every PDF reader has). WinAnsiEncoding = windows-1252, so umlauts
// and the euro sign work without embedding a font. No dependencies.

import { encodeCp1252 } from './cp1252.js';

export interface PdfLine { text: string; bold?: boolean }

const W = 595, H = 842, MARGIN = 42, SIZE = 9, LEAD = 12.5;
export const PDF_COLS = Math.floor((W - 2 * MARGIN) / (SIZE * 0.6));   // Courier: 0.6 em per char
const PER_PAGE = Math.floor((H - 2 * MARGIN - 2 * LEAD) / LEAD);

function pdfString(s: string): Buffer {
  const b = encodeCp1252(s).bytes;
  const out: number[] = [0x28];
  for (const c of b) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) out.push(0x5c);
    out.push(c);
  }
  out.push(0x29);
  return Buffer.from(out);
}

export function buildPdf(lines: PdfLine[], footer: (page: number, pages: number) => string, title = ''): Buffer {
  const pages: PdfLine[][] = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += PER_PAGE) pages.push(lines.slice(i, i + PER_PAGE));
  const objs: Buffer[] = [];
  const add = (b: Buffer | string) => { objs.push(typeof b === 'string' ? Buffer.from(b, 'latin1') : b); return objs.length; };
  const catalog = add('');            // placeholders, filled below
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((pl, p) => {
    const parts: Buffer[] = [Buffer.from('BT\n', 'latin1')];
    let y = H - MARGIN;
    for (const l of pl) {
      parts.push(Buffer.from(`/${l.bold ? 'F2' : 'F1'} ${SIZE} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(1)} Tm `, 'latin1'), pdfString(l.text.slice(0, PDF_COLS)), Buffer.from(' Tj\n', 'latin1'));
      y -= LEAD;
    }
    parts.push(Buffer.from(`/F1 8 Tf 1 0 0 1 ${MARGIN} ${MARGIN - 14} Tm `, 'latin1'), pdfString(footer(p + 1, pages.length)), Buffer.from(' Tj\nET\n', 'latin1'));
    const stream = Buffer.concat(parts);
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('endstream', 'latin1')]));
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1');
  objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1');
  const info = add(Buffer.concat([Buffer.from('<< /Producer (DeskCalc Verify) /Title ', 'latin1'), pdfString(title), Buffer.from(' >>', 'latin1')]));

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(b); pos += b.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
