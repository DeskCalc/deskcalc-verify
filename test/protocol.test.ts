import { describe, it, expect } from 'vitest';
import { encodeCp1252, decodeCp1252 } from '../src/cp1252.js';
import { normaliseValue, buildJob, parseResult, diffLines, decimalSum, cleanLabel } from '../src/protocol.js';

describe('cp1252', () => {
  it('round-trips €, umlauts and quotes', () => {
    const s = 'Parken 8 € – „Köln“';
    const e = encodeCp1252(s);
    expect(e.replaced).toBe(0);
    expect(decodeCp1252(e.bytes)).toBe(s);
  });
  it('replaces characters outside windows-1252', () => {
    const e = encodeCp1252('Taxi 🚕 Москва');
    expect(e.replaced).toBe(7);
  });
});

describe('normaliseValue', () => {
  it('accepts numbers and dotted strings', () => {
    expect(normaliseValue(189)).toEqual({ ok: true, value: '189' });
    expect(normaliseValue(-20.5)).toEqual({ ok: true, value: '-20.5' });
    expect(normaliseValue('1234.56')).toEqual({ ok: true, value: '1234.56' });
    expect(normaliseValue('+7')).toEqual({ ok: true, value: '7' });
    expect(normaliseValue(0.0000001)).toEqual({ ok: true, value: '0.0000001' });
  });
  it('rejects localized or malformed values with a helpful message', () => {
    const r = normaliseValue('1.234,56');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/decimal separator/);
    expect(normaliseValue('12 EUR').ok).toBe(false);
    expect(normaliseValue(NaN).ok).toBe(false);
    expect(normaliseValue(1e16).ok).toBe(false);
  });
});

describe('job and result', () => {
  it('builds an escaped windows-1252 job', () => {
    const job = buildJob('ab12', 'Spesen <Okt>', [{ value: '12.3', label: 'A & B "x"' }]);
    const xml = decodeCp1252(job.bytes);
    expect(xml).toContain('encoding="windows-1252"');
    expect(xml).toContain('<TITLE>Spesen &lt;Okt&gt;</TITLE>');
    expect(xml).toContain('label="A &amp; B &quot;x&quot;"');
  });
  it('parses a confirmed result as DeskCalc writes it', () => {
    const text = '<?xml version="1.0" encoding="windows-1252"?>\r\n<VERIFY_RESULT version="1" id="t" status="confirmed" decimal=".">\r\n<TOTAL>227.1</TOTAL>\r\n<CALCULATIONS>1</CALCULATIONS>\r\n<LINE value="45.8" label="12.10. Shell"/>\r\n<LINE value="-20" label="Gutschrift"/>\r\n<LINE value="12" label="x" op="*"/>\r\n</VERIFY_RESULT>\r\n';
    const r = parseResult(encodeCp1252(text).bytes);
    expect(r.status).toBe('confirmed');
    expect(r.total).toBe('227.1');
    expect(r.lines).toEqual([{ value: '45.8', label: '12.10. Shell' }, { value: '-20', label: 'Gutschrift' }, { value: '12', label: 'x', op: '*' }]);
  });
  it('parses problem and notes', () => {
    const text = '<VERIFY_RESULT id="t" status="limit_reached"><PROBLEM line="2" value="1500000"/><NOTE>labels_truncated</NOTE></VERIFY_RESULT>';
    const r = parseResult(Buffer.from(text));
    expect(r.problem).toEqual({ line: 2, value: '1500000' });
    expect(r.notes).toEqual(['labels_truncated']);
  });
  it('cleans labels', () => {
    expect(cleanLabel(' a\r\nb ')).toBe('a b');
    expect(cleanLabel('x'.repeat(80)).length).toBe(60);
  });
});

describe('decimalSum', () => {
  it('adds exactly', () => {
    expect(decimalSum(['0.1', '0.2'])).toBe('0.3');
    expect(decimalSum(['45.8', '189', '-20', '12.3'])).toBe('227.1');
    expect(decimalSum(['-5', '2.5'])).toBe('-2.5');
  });
});

describe('diffLines', () => {
  const sent = [
    { value: '45.8', label: 'Shell' },
    { value: '189', label: 'Hotel' },
    { value: '-20', label: 'Gutschrift' },
    { value: '12.3', label: 'Parken' },
  ];
  it('finds no corrections for an unchanged tape', () => {
    expect(diffLines(sent, sent)).toEqual([]);
  });
  it('detects changed, added, removed and relabelled lines', () => {
    const got = [
      { value: '45.8', label: 'Shell' },
      { value: '5', label: 'Hotel' },          // changed value
      { value: '78', label: 'inserted' },      // added
      { value: '-20', label: 'Credit note' },  // relabelled
    ];                                          // Parken removed
    expect(diffLines(sent, got)).toEqual([
      { type: 'changed', line: 2, label: 'Hotel', before: '189', after: '5' },
      { type: 'added', line: 3, label: 'inserted', value: '78' },
      { type: 'relabelled', line: 4, value: '-20', before: 'Gutschrift', after: 'Credit note' },
      { type: 'removed', label: 'Parken', value: '12.3' },
    ]);
  });
  it('treats 189 and 189.00 as the same value', () => {
    expect(diffLines([{ value: '189.00', label: 'a' }], [{ value: '189', label: 'a' }])).toEqual([]);
  });
});
