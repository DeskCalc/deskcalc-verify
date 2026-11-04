---
name: reconcile-documents
description: Reconcile two documents with DeskCalc - invoice vs delivery note, order or payment - and list what matches, what differs and what is missing. Use when the user attaches two documents that should agree.
---

Reconcile the two documents:

1. Verify each with DeskCalc (`verify_numbers`): one tape each, positions only.
2. Call `compare_verifications` with both review_ids (`ignore_sign: true` if one side shows payments as negative).

List, in the user's language, the matched positions briefly and the differences and missing positions in detail, plus any corrections the user made in DeskCalc. Offer to save the audit records (`save_audit_record`).
