// Ready-made prompts (V1): in Claude Desktop they appear in the "+" menu under
// deskcalc-verify. They make the first try succeed - the user picks the kind of check,
// attaches the document and gets the right tape. Texts go to the model, so they are
// English; the model answers in the user's language.

export interface PromptDef { name: string; title: string; description: string; text: string }

const COMMON =
  ' Answer in my language. Report every figure that does not match, and the corrections I made in DeskCalc. ' +
  'Afterwards offer to save the audit record (save_audit_record) with the document name.';

export const PROMPTS: PromptDef[] = [
  {
    name: 'check_invoice',
    title: 'Check an invoice',
    description: 'Positions, quantity x price, discounts, VAT (also mixed rates) and the amount payable - to the cent.',
    text:
      'Check the attached invoice with DeskCalc (verify_numbers). One line per position: quantity x unit price ' +
      'with the printed line total as value; discounts as percent lines; VAT as tax lines after the positions - ' +
      'with several VAT rates one group per rate; pass the printed amount payable as expected_total.' + COMMON,
  },
  {
    name: 'add_expenses',
    title: 'Add up expense receipts',
    description: 'A stack of receipts (e.g. 30 for an expense report) on ONE tape, one line per receipt.',
    text:
      'Add up all attached receipts with DeskCalc (verify_numbers) in ONE call and ONE tape: one amount line per ' +
      'receipt, label "date vendor" (max. 25 characters), in date order. Do not split into several calls. If I ' +
      'ask for the input VAT, give each receipt its own group with its tax line (included=true). If the expense ' +
      'report prints a total, pass it as expected_total.' + COMMON,
  },
  {
    name: 'foot_table',
    title: 'Foot and cross-foot a table',
    description: 'Each row net + tax = gross, and the column totals against the printed totals.',
    text:
      'Foot and cross-foot the attached table with DeskCalc (verify_numbers): one line per row with value = gross, ' +
      'net and tax; pass the printed column totals as expected_total (gross), expected_net_total and ' +
      'expected_tax_total. DeskCalc shows each row as a block (net, tax, printed ' +
      'gross); tell me to check net and tax of each row against the document. Name every row and column that ' +
      'does not add up. More than 125 rows: one call per page.' + COMMON,
  },
  {
    name: 'bank_statement',
    title: 'Check a statement with carry-overs',
    description: 'Bank statement, ledger or list over several pages: opening balance, movements, carry-overs, closing balance.',
    text:
      'Check the attached statement with DeskCalc (verify_numbers): opening balance as the first amount line, ' +
      'every movement as an amount line (debits negative), each printed carry-over / page subtotal as a ' +
      'subtotal line at its place, the closing balance as expected_total. Tell me the first carry-over that is ' +
      'wrong - later differences may only follow from it.' + COMMON,
  },
  {
    name: 'reconcile_documents',
    title: 'Reconcile two documents',
    description: 'Invoice vs delivery note, order or payment: what matches, what differs, what is missing.',
    text:
      'Reconcile the two attached documents (e.g. invoice and delivery note): verify each with DeskCalc ' +
      '(verify_numbers, one tape each, positions only), then call compare_verifications with both review_ids ' +
      '(ignore_sign=true if one side shows payments as negative). List matched positions briefly and the ' +
      'differences and missing positions in detail.' + COMMON,
  },
];
