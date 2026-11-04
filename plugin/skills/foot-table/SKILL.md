---
name: foot-table
description: Foot and cross-foot a table with DeskCalc - each row net + tax = gross, and the column totals against the printed totals. Use when the user attaches a sales or purchase day book, an invoice list or any table with net, tax and gross columns.
---

Foot and cross-foot the table with DeskCalc (`verify_numbers`):

1. One line per row: `value` = printed gross, plus `net` and `tax`. Nothing else in that call.
2. Pass the printed column totals as `expected_total` (gross), `expected_net_total` and `expected_tax_total`.
3. More than 125 rows: one call per page.

DeskCalc shows each row as a block (net, tax, printed gross as a checkpoint); ask the user to check net and tax of each row against the document. Then name, in the user's language, every row and column that does not add up and the corrections the user made. Offer to save the audit record (`save_audit_record`).
