---
name: bank-statement
description: Check a bank statement, ledger or list over several pages with DeskCalc - opening balance, movements, printed carry-overs and closing balance - and find the first page where it stops adding up. Use when the user attaches a statement or a multi-page list with carry-overs.
---

Check the statement with DeskCalc (`verify_numbers`):

1. Opening balance as the first amount line.
2. Every movement as an amount line, debits negative.
3. Each printed carry-over or page subtotal as a `subtotal` line at its place, with the printed value.
4. The closing balance as `expected_total`.

Tell the user, in their language, the first carry-over that is wrong - later differences may only follow from it - and the corrections they made in DeskCalc. Offer to save the audit record (`save_audit_record`).
