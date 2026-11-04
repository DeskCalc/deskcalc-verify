---
name: add-expenses
description: Add up a stack of receipts (e.g. 30 receipts for an expense report) on ONE DeskCalc tape and get the total confirmed by a human. Use when the user attaches several receipts, bills or an expense report and wants the sum or the input VAT.
---

Add up all receipts with DeskCalc (`verify_numbers`) in ONE call and ONE tape:

1. One amount line per receipt, label "date vendor" (max. 25 characters), in date order. Never one call per receipt.
2. If the user asks for the input VAT, give each receipt its own `group` with its tax line (`included: true`).
3. If the expense report prints a total, pass it as `expected_total`.

Then report, in the user's language, the confirmed total, every figure that does not match and the corrections the user made in DeskCalc. To compare an expense report with its receipts, verify both and call `compare_verifications`. Offer to save the audit record (`save_audit_record`).
