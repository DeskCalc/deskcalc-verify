---
name: check-invoice
description: Check an invoice to the cent with DeskCalc - positions, quantity x unit price, discounts, VAT (also several VAT rates) and the amount payable. Use when the user attaches an invoice or bill and wants it checked, or before you rely on an invoice total.
---

Check the invoice with DeskCalc (`verify_numbers`), so a human confirms every figure on a tape:

1. One line per position: `qty` and `price`, with the printed line total as `value`.
2. Discounts, surcharges, Skonto as percent lines (`type: "percent"`, negative rate for a discount).
3. VAT as tax lines after the positions it applies to. With several VAT rates, one `group` per rate with its positions and its tax line.
4. Pass the printed amount payable as `expected_total`.

Then report, in the user's language, every figure that does not match and the corrections the user made in DeskCalc. If the result says `gt_outdated`, call `verify_numbers` again with the arguments in `rerun`. Offer to save the audit record (`save_audit_record`) with the document name.
