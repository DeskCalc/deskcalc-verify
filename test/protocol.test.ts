import { describe, it, expect } from 'vitest';
import { encodeCp1252, decodeCp1252 } from '../src/cp1252.js';
import { normaliseValue, buildJob, parseResult, diffLines, decimalSum, decimalMul, roundCents, cleanLabel, checkDocument, roundedModel, precheck, simulateTape, type Item } from '../src/protocol.js';

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
    const job = buildJob('ab12', 'Spesen <Okt>', [{ kind: 'amount', value: '12.3', label: 'A & B "x"' }]);
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
  const sent: Item[] = [
    { kind: 'amount', value: '45.8', label: 'Shell' },
    { kind: 'amount', value: '189', label: 'Hotel' },
    { kind: 'amount', value: '-20', label: 'Gutschrift' },
    { kind: 'amount', value: '12.3', label: 'Parken' },
  ];
  it('finds no corrections for an unchanged tape', () => {
    expect(diffLines(sent, sent.map(x => ({ value: x.value, label: x.label })))).toEqual([]);
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
    expect(diffLines([{ kind: 'amount', value: '189.00', label: 'a' }], [{ value: '189', label: 'a' }])).toEqual([]);
  });
});

describe('invoice support', () => {
  const invoice: Item[] = [
    { kind: 'qty', label: 'Pos.1 Wandfarbe', qty: '3', price: '42.01', value: '126.03', printed: '126.03' },
    { kind: 'qty', label: 'Pos.2 Schrauben', qty: '2', price: '12.50', value: '25', printed: '25.00' },
    { kind: 'amount', label: 'Pos.4 Versand', value: '35' },
    { kind: 'tax', label: 'USt 19 %', value: '', rate: '19', printed: '35.35' },
  ];
  const got = [
    { value: '126.03', label: 'Pos.1 Wandfarbe', qty: '3', price: '42.01' },
    { value: '25', label: 'Pos.2 Schrauben', qty: '2', price: '12.5' },
    { value: '35', label: 'Pos.4 Versand' },
    { value: '35.3514', label: 'USt 19 %', type: 'tax' as const, rate: '19', included: false, base: '186.06' },
  ];
  it('rounds and multiplies exactly', () => {
    expect(roundCents('348.1107')).toBe('348.11');
    expect(roundCents('55.585')).toBe('55.59');
    expect(roundCents('-20')).toBe('-20.00');
    expect(roundCents('1.4e-7')).toBe('0.00');
    expect(decimalMul('3', '42.01')).toBe('126.03');
    expect(decimalMul('15', '7.1')).toBe('106.5');
  });
  it('writes qty and tax lines into the job', () => {
    const xml = decodeCp1252(buildJob('x', 't', invoice).bytes);
    expect(xml).toContain('<LINE value="42.01" qty="3" label="Pos.1 Wandfarbe"/>');
    expect(xml).toContain('<LINE type="tax" rate="19" incl="0" label="USt 19 %"/>');
  });
  it('parses tax and qty attributes', () => {
    const r = parseResult(Buffer.from('<VERIFY_RESULT status="confirmed"><TOTAL>221.4507</TOTAL><LINE value="126.03" label="a" qty="3" price="42.01"/><LINE value="35.3507" label="t" type="tax" rate="19" incl="0" base="186.06"/></VERIFY_RESULT>'));
    expect(r.lines[0]).toMatchObject({ qty: '3', price: '42.01' });
    expect(r.lines[1]).toMatchObject({ type: 'tax', rate: '19', included: false, base: '186.06' });
  });
  it('does not count a recomputed tax amount as a correction', () => {
    expect(diffLines(invoice, got)).toEqual([]);
  });
  it('checks printed figures to the cent', () => {
    expect(checkDocument(invoice, got, '221.4114', '221.41').map(c => c.ok)).toEqual([true, true, true, true]);
    const wrong = checkDocument(invoice, got, '221.4114', '222.00');
    expect(wrong[3]).toMatchObject({ check: 'total', ok: false, document: '222.00', deskcalc: '221.41', difference: '-0.59' });
  });
  it('compares an included-tax total with the gross amount', () => {
    const items: Item[] = [{ kind: 'amount', label: 'a', value: '120' }, { kind: 'tax', label: 't', value: '', rate: '20', included: true, printed: '20.00' }];
    const g2 = [{ value: '120', label: 'a' }, { value: '-20', label: 't', type: 'tax' as const, rate: '20', included: true, base: '120' }];
    expect(checkDocument(items, g2, '100', '120.00').every(c => c.ok)).toBe(true);
  });
});

describe('rounding differences', () => {
  // Found by search: netto 200.03, 3 % discount, 19 % VAT. The invoice rounds each
  // step (discount -6.00, VAT 36.87) and prints 230.90; the exact result is 230.8946.
  const items: Item[] = [
    { kind: 'amount', label: 'Pos.1', value: '150.03' },
    { kind: 'amount', label: 'Pos.2', value: '50' },
    { kind: 'percent', label: 'Rabatt 3 %', value: '', rate: '-3', printed: '-6.00' },
    { kind: 'tax', label: 'USt 19 %', value: '', rate: '19', printed: '36.87' },
  ];
  const got = [
    { value: '150.03', label: 'Pos.1' },
    { value: '50', label: 'Pos.2' },
    { value: '-6.0009', label: 'Rabatt 3 %', type: 'percent' as const, rate: '-3', base: '200.03' },
    { value: '36.865529', label: 'USt 19 %', type: 'tax' as const, rate: '19', included: false, base: '194.0291' },
  ];
  it('models the invoice rounding', () => {
    expect(roundedModel(got).total).toBe('230.9');
  });
  it('accepts a 1-cent difference that the rounding explains', () => {
    const c = checkDocument(items, got, '230.894629', '230.90');
    const total = c.find(x => x.check === 'total')!;
    expect(total).toMatchObject({ ok: true, document: '230.90', deskcalc: '230.89', difference: '-0.01' });
    expect(total.rounding).toMatch(/rounded to the cent/);
  });
  it('still reports a 1-cent difference that the rounding does not explain', () => {
    const c = checkDocument(items, got, '230.894629', '230.91');
    expect(c.find(x => x.check === 'total')).toMatchObject({ ok: false, difference: '-0.02' });
  });
  it('accepts exact matches without a rounding note', () => {
    const c = checkDocument(items, got, '230.894629', '230.89');
    const total = c.find(x => x.check === 'total')!;
    expect(total.ok).toBe(true);
    expect(total.rounding).toBeUndefined();
  });
});

describe('blocks', () => {
  it('rounds per block and adds the blocks', () => {
    const got = [
      { value: '0.5', label: 'a', qty: '1', price: '0.5', block: 1 },
      { value: '0.025', label: 't', type: 'tax' as const, rate: '5', included: false, base: '0.5', block: 1 },
      { value: '10.005', label: 'b', qty: '1', price: '10.005', block: 2 },
      { value: '1.0005', label: 't2', type: 'tax' as const, rate: '10', included: false, base: '10.005', block: 2 },
    ];
    // block 1: 0.50 + 0.03 = 0.53; block 2: 10.01 + 1.00 = 11.01 -> 11.54
    expect(roundedModel(got).total).toBe('11.54');
  });
});

describe('tax rounded per position (billing programs)', () => {
  // 3 positions of 0.125 net... use 3 x 1.05 at 10 %: per line 0.105 -> 0.11 each = 0.33;
  // on the subtotal 3.15 x 10 % = 0.315 -> 0.32. A document printing 0.33 is correct.
  const sent: Item[] = [
    { kind: 'amount', label: 'a', value: '1.05' },
    { kind: 'amount', label: 'b', value: '1.05' },
    { kind: 'amount', label: 'c', value: '1.05' },
    { kind: 'tax', label: 'USt', value: '', rate: '10', printed: '0.33' },
  ];
  const got = [
    { value: '1.05', label: 'a' }, { value: '1.05', label: 'b' }, { value: '1.05', label: 'c' },
    { value: '0.315', label: 'USt', type: 'tax' as const, rate: '10', included: false, base: '3.15' },
  ];
  it('accepts tax rounded per line, with an explanation', () => {
    const c = checkDocument(sent, got, '3.465', '3.48');
    expect(c.every(x => x.ok)).toBe(true);
    expect(c[0].rounding).toMatch(/per position/);
    expect(c[1].rounding).toMatch(/per position/);
  });
  it('still reports a real misprint', () => {
    const bad = sent.map(x => (x.kind === 'tax' ? { ...x, printed: '0.35' } : x));
    const c = checkDocument(bad, got, '3.465', '3.50');
    expect(c[0].ok).toBe(false);
    expect(c[1].ok).toBe(false);
  });
});

describe('cross-footing', () => {
  // As the server sends it: one block per row - net, tax, checkpoint with the printed gross.
  const rows: [string, string, string, string][] = [
    ['R1', '120', '100', '20'], ['R2', '55.00', '50', '5'],
    ['R3', '-12', '-10', '-2'],                 // credit note
    ['R4', '36.31', '30.25', '6.05'],           // misprint: net + tax = 36.30
  ];
  const sent: Item[] = rows.flatMap(([label, gross, net, tax]) => [
    { kind: 'group', label, value: '', row: 'group' }, { kind: 'amount', label: 'Netto', value: net, row: 'net' },
    { kind: 'amount', label: 'USt', value: tax, row: 'tax' }, { kind: 'subtotal', label: 'Brutto', value: '', printed: gross, row: 'gross' },
  ] as Item[]);
  const tape = (rs: typeof rows) => rs.flatMap(([, , net, tax], b) => [
    { value: net, label: 'Netto', block: b + 1 }, { value: tax, label: 'USt', block: b + 1 },
    { value: decimalSum([net, tax]), label: 'Brutto', type: 'subtotal' as const, block: b + 1 },
  ]);
  it('checks each row and both columns', () => {
    const c = checkDocument(sent, tape(rows), '199.30', '199.31', { net: '170.25', tax: '29.05' });
    expect(c.map(x => x.check.split(':')[0])).toEqual(['row "R1"', 'row "R2"', 'row "R3"', 'row "R4"', 'net column', 'tax column', 'total']);
    expect(c.map(x => x.ok)).toEqual([true, true, true, false, true, true, false]);
    expect(c[3].difference).toBe('-0.01');
    expect(c[6].follows).toBe(true);           // the total differs only because of row R4
  });
  it('uses the net the user corrected', () => {
    const fixed = rows.map(r => (r[0] === 'R4' ? ['R4', '36.31', '30.26', '6.05'] : r)) as typeof rows;
    const c = checkDocument(sent, tape(fixed), '199.31', undefined, { net: '170.26' });
    expect(c.every(x => x.ok)).toBe(true);
    expect(c[3].check).toBe('row "R4": net 30.26 + tax 6.05');
  });
  it('reports a wrong column total', () => {
    const c = checkDocument(sent, tape(rows), '199.30', undefined, { net: '170.00' });
    expect(c.find(x => x.check === 'net column')!.ok).toBe(false);
  });
});

import { reconcile } from '../src/compare.js';
import { auditFileName, fmtAmount, buildAuditPdf } from '../src/audit.js';

describe('reconcile', () => {
  const L = (xs: [string, string][]) => xs.map(([label, value]) => ({ label, value }));
  it('matches regardless of order, duplicates count once each', () => {
    const r = reconcile(L([['x', '50'], ['x', '50'], ['y', '10']]), L([['y', '10'], ['x', '50']]));
    expect(r.matched).toHaveLength(2);
    expect(r.only_in_a).toHaveLength(1);
    expect(r.difference).toBe('50.00');
  });
  it('a cent difference is a difference, not a match', () => {
    const r = reconcile(L([['a', '10.00']]), L([['a', '10.01']]));
    expect(r.matched).toHaveLength(0);
    expect(r.amount_differs[0].difference).toBe('-0.01');
  });
  it('ignore_sign pairs invoice amounts with payments', () => {
    const r = reconcile(L([['RE 1', '120']]), L([['Zahlung', '-120']]), true);
    expect(r.matched).toHaveLength(1);
  });
  it('ignores tax and subtotal lines', () => {
    const r = reconcile([{ label: 'a', value: '10' }, { label: 'USt', value: '2', type: 'tax' as const }], [{ label: 'a', value: '10' }]);
    expect(r.only_in_a).toHaveLength(0);
  });
});

describe('audit record helpers', () => {
  it('builds a safe file name', () => {
    const n = auditFileName('Re: 10/26 <A>?. ', new Date(2026, 10, 3, 9, 5), 'ab12cd34');
    expect(n).toBe('2026-11-03 0905 Re 10 26 A ab12cd34.pdf');
  });
  it('formats amounts per language', () => {
    expect(fmtAmount('-1234567.5', 'de')).toBe('-1.234.567,50');
    expect(fmtAmount('1234.005', 'en')).toBe('1,234.01');
  });
});

describe('figures that only carry a wrong line total forward', () => {
  // V1 sample invoice: 12 x 7.45 = 89.40 printed as 98.40; discount, VAT and total are
  // computed correctly by the invoice from 98.40.
  const pos: [string, string, string, string][] = [['8', '24.9', '199.2', '199.20'], ['3', '89.9', '269.7', '269.70'],
    ['25', '2.35', '58.75', '58.75'], ['12', '7.45', '89.4', '98.40'], ['10', '5.95', '59.5', '59.50'], ['1', '9.5', '9.5', '9.50']];
  const sent = (vat = '134.84'): Item[] => [
    ...pos.map(([qty, price, value, printed], i) => ({ kind: 'qty' as const, label: `P${i + 1}`, qty, price, value, printed })),
    { kind: 'percent', label: 'Discount', value: '', rate: '-3', printed: '-20.85' },
    { kind: 'tax', label: 'VAT', value: '', rate: '20', printed: vat },
  ];
  const got = [
    ...pos.map(([qty, price, value], i) => ({ value, label: `P${i + 1}`, qty, price })),
    { value: '-20.5815', label: 'Discount', type: 'percent' as const, rate: '-3', base: '686.05' },
    { value: '133.0937', label: 'VAT', type: 'tax' as const, rate: '20', base: '665.4685' },
  ];
  it('marks discount, VAT and total as following from the wrong line', () => {
    const c = checkDocument(sent(), got, '798.5622', '809.04');
    const bad = c.filter(x => !x.ok);
    expect(bad.map(x => [x.check.split(':')[0].split(' on')[0], !!x.follows])).toEqual([
      ['line 4 "P4"', false], ['tax 20 %', true], ['discount 3 %', true], ['total', true]]);
  });
  it('still reports a VAT amount that is wrong on its own', () => {
    const c = checkDocument(sent('135.00'), got, '798.5622', '809.04');
    const tax = c.find(x => x.check.startsWith('tax'))!;
    expect(tax.ok).toBe(false);
    expect(tax.follows).toBeFalsy();
  });
});

describe('document check before DeskCalc opens (V12)', () => {
  const inv = (vat = '134.84', total = '809.04'): Item[] => [
    ...[['8', '24.9', '199.20'], ['3', '89.9', '269.70'], ['25', '2.35', '58.75'], ['12', '7.45', '98.40'], ['10', '5.95', '59.50'], ['1', '9.5', '9.50']]
      .map(([qty, price, printed], i) => ({ kind: 'qty' as const, label: `P${i + 1}`, qty, price, value: decimalMul(qty, price), printed })),
    { kind: 'percent', label: 'Discount', value: '', rate: '-3', printed: '20.85' },
    { kind: 'tax', label: 'VAT', value: '', rate: '20', printed: vat },
  ];
  it('marks the wrong line and the figures that only follow from it', () => {
    const p = precheck(inv(), '809.04')!;
    expect(p.status).toBe('diff');
    expect([...p.marks].sort((x, y) => x[0] - y[0])).toEqual([[3, 'err'], [6, 'follow'], [7, 'follow']]);
    expect(p.total).toEqual({ value: '809.04', mark: 'follow' });
    expect(p.docs.slice(3)).toEqual(['98.40', '59.50', '9.50', '-20.85', '134.84']);
  });
  it('says ok when every printed figure matches', () => {
    const ok = inv().map(it => (it.label === 'P4' ? { ...it, printed: '89.40' } : it));
    const p = precheck(ok.map(it => (it.kind === 'percent' ? { ...it, printed: '20.58' } : it.kind === 'tax' ? { ...it, printed: '133.09' } : it)), '798.56')!;
    expect(p.status).toBe('ok');
    expect(p.marks.size).toBe(0);
  });
  it('has nothing to say without printed figures', () => {
    expect(precheck([{ kind: 'amount', label: 'a', value: '1' }])).toBeUndefined();
  });
  it('flags a total that is added up wrong on its own', () => {
    const ok = inv().map(it => (it.label === 'P4' ? { ...it, printed: '89.40' } : it.kind === 'percent' ? { ...it, printed: '20.58' } : it.kind === 'tax' ? { ...it, printed: '133.09' } : it));
    expect(precheck(ok, '799.56')!.total).toEqual({ value: '799.56', mark: 'err' });
  });
  it('writes the document figures and marks into the job', () => {
    const p = precheck(inv(), '809.04')!;
    const xml = decodeCp1252(buildJob('j1', 'Inv', inv(), undefined, p).bytes);
    expect(xml).toContain('check="diff" doctotal="809.04" doctotalmark="follow"');
    expect(xml).toMatch(/label="P4" doc="98.40" mark="err"/);
    expect(xml).toMatch(/type="tax" rate="20" incl="0" label="VAT" doc="134.84" mark="follow"/);
    expect(xml).not.toMatch(/label="P1" doc="199.20" mark/);
  });
  it('agrees with the check after Confirm when nothing was changed', () => {
    const sim = simulateTape(inv());
    const after = checkDocument(inv(), sim.lines, sim.total, '809.04');
    expect(after.filter(c => !c.ok).length).toBe(4);
  });
});

describe('audit record layout', () => {
  const base = {
    reviewId: 'r1', title: 'RA-Buch', confirmedAt: new Date(2026, 10, 3), total: '7420.02', version: 't', lang: 'de' as const,
    lines: [{ label: 'RE-1107 Alpha 13%', value: '7420.02' }], corrections: [],
    checks: [
      { check: 'row "RE-1107 Alpha 13%": net 6566.55 + tax 853.65', document: '7420.02', deskcalc: '7420.20', difference: '-0.18', ok: false },
      { check: 'net column', document: '73683.19', deskcalc: '73583.19', difference: '100.00', ok: false },
    ],
  };
  it('wraps long lines instead of cutting them', () => {
    const note = 'Anfang ' + 'wort '.repeat(60) + 'ENDEMARKE';
    const pdf = buildAuditPdf({ ...base, note } as any).toString('latin1');
    expect(pdf).toContain('ENDEMARKE');
  });
  it('labels column totals as added up by the server', () => {
    const raw = buildAuditPdf(base as any).toString('latin1');
    const text = [...raw.matchAll(/\((.*)\) Tj/g)].map(m => m[1]).join(' ').replace(/\s+/g, ' ');
    expect(text).toContain('Brutto 7.420,02, DeskCalc 7.420,20');
    expect(text).toContain('Beleg 73.683,19, Summe der Zeilen 73.583,19');
    expect(text).not.toContain('DeskCalc 73.583,19');
  });
});
