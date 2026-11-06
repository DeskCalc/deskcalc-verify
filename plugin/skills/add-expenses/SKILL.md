---
name: add-expenses
description: Add up a stack of receipts (e.g. 30 receipts for an expense report) on ONE DeskCalc tape and get the total confirmed by a human. Use when the user attaches several receipts, bills or an expense report and wants the sum or the input VAT.
---

Add up all receipts with DeskCalc (`verify_numbers`) in ONE call and ONE tape:

1. In date order, never one call per receipt.
2. If the receipts print their VAT: each receipt its own `group` (label "date vendor", max. 25 characters) with the gross amount and a tax line (`included: true`) whose `value` is the **printed** VAT - that is how a misprinted VAT is found. Receipts without printed VAT: one amount line each.
3. If the expense report prints a total, pass it as `expected_total`.

Then report, in the user's language, the confirmed total, every figure that does not match and the corrections the user made in DeskCalc. To compare an expense report with its receipts, verify both and call `compare_verifications`. Offer to save the audit record (`save_audit_record`).
