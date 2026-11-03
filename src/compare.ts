// Reconcile two confirmed verifications (invoice <-> delivery note, order, bank
// statement): which positions match, which differ, which are missing on one side.
// Only positions are compared (amount and qty lines) - tax, percent and subtotal
// lines follow from them. Amounts are compared to the cent.

import { roundCents, decimalSum, type ResultLine } from './protocol.js';

export interface Side { line: number; label: string; amount: string }

export interface Reconciliation {
  matched: { a: Side; b: Side }[];
  amount_differs: { label: string; a: Side; b: Side; difference: string }[];
  only_in_a: Side[];
  only_in_b: Side[];
  total_a: string;
  total_b: string;
  difference: string;        // total_a - total_b, to the cent
}

const neg = (x: string) => (x.startsWith('-') ? x.slice(1) : '-' + x);

export function reconcile(a: ResultLine[], b: ResultLine[], ignoreSign = false): Reconciliation {
  const side = (lines: ResultLine[]) => lines
    .map((g, i) => ({ g, i }))
    .filter(x => !x.g.type)
    .map(x => {
      let amount = roundCents(x.g.value);
      if (ignoreSign) amount = amount.replace(/^-/, '');
      return { line: x.i + 1, label: x.g.label, amount };
    });
  const A = side(a), B = side(b);
  const usedB = new Set<number>();
  const out: Reconciliation = { matched: [], amount_differs: [], only_in_a: [], only_in_b: [], total_a: '0.00', total_b: '0.00', difference: '0.00' };
  const restA: Side[] = [];
  // 1. same amount and same label, 2. same amount (labels differ between documents)
  for (const pass of [true, false]) {
    const src = pass ? A : restA.splice(0);
    for (const x of src) {
      const k = B.findIndex((y, j) => !usedB.has(j) && y.amount === x.amount && (!pass || y.label === x.label));
      if (k >= 0) { usedB.add(k); out.matched.push({ a: x, b: B[k] }); }
      else restA.push(x);
    }
  }
  // 3. same label, different amount: the classic "price differs" finding
  for (const x of restA.splice(0)) {
    const k = x.label ? B.findIndex((y, j) => !usedB.has(j) && y.label === x.label) : -1;
    if (k >= 0) {
      usedB.add(k);
      out.amount_differs.push({ label: x.label, a: x, b: B[k], difference: roundCents(decimalSum([x.amount, neg(B[k].amount)])) });
    } else out.only_in_a.push(x);
  }
  out.only_in_b = B.filter((_, j) => !usedB.has(j));
  out.total_a = roundCents(decimalSum(A.map(x => x.amount)));
  out.total_b = roundCents(decimalSum(B.map(x => x.amount)));
  out.difference = roundCents(decimalSum([out.total_a, neg(out.total_b)]));
  return out;
}
