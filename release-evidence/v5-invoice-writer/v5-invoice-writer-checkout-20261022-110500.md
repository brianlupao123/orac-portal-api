# V5 Invoice Writer Checkout Evidence

- Captured: 2026-10-22T11:05:02.8564115+02:00
- Root: `C:\Users\BRIAN LUPAO\Desktop\ffims-asset-register\two-concept-packet-backend-20261005-235259`
- Branch: `codex/fix-fictional-pilot-json-store`
- HEAD: `490822b9a4b1c37751b10ddcf85feacf8e713e29`
- V5 commercial flag: unset
- V5 writer flag: unset
- Test database URL: unset

This capture reads the checkout only. It does not run the application, enable a feature, open a database connection, or record any secret value.

## Git Status

``text
## codex/fix-fictional-pilot-json-store...origin/codex/fix-fictional-pilot-json-store
 M DOCUMENTATION_INDEX.md
 M ORAC_IOS_SYSTEM_HANDOVER.md
 M scripts/00-backup-current.ps1
 M scripts/restore-demo-backup.js
 M scripts/scripts/00-backup-current.ps1
 M server.js
 M src/config.js
 M src/controllers/aiController.js
 M src/controllers/coreController.js
 M src/controllers/dispatchController.js
 M src/controllers/quoteController.js
 M src/controllers/timesheetWorkflowController.js
 M src/middleware/rateLimit.js
 M src/notificationDestinations.js
 M src/permissions.js
 M src/postgresStore.js
 M src/reports.js
 M src/router.js
 M src/schemas.js
 M src/services/aiWorkflowKnowledge.js
 M src/stateMachine.js
 M src/store.js
 M src/v5CommercialWorkflow.js
 M src/v5QuoteRules.js
 M tests/aiWorkflowAssistant.test.js
 M tests/aiWorkflowHttp.test.js
 M tests/financePilotControls.test.js
 M tests/helpers/v5SignatureFixture.js
 M tests/masterDataActiveBackfill.test.js
 M tests/notificationRouting.test.js
 M tests/poAmendmentSeparation.test.js
 M tests/rateLimit.test.js
 M tests/security.test.js
 M tests/stateMachine.test.js
 M tests/timesheetWorkflowStep1And2.test.js
 M tests/timesheetWorkflowSteps3To9.test.js
 M tests/v5CommercialWorkflow.test.js
 M tests/v5QuoteController.test.js
 M tests/v5QuoteRules.test.js
?? .lead-retry-backups/
?? .orac-v5-signature-phase/
?? AUDIT_EVENT_RETENTION_POLICY.md
?? CONTROLLED_COMMERCIAL_PRICING_PROPOSAL.md
?? INVOICE_SETTLEMENT_FRONTEND_CONTRACT.md
?? INVOICE_SETTLEMENT_POLICY.md
?? LEAD_TO_QUOTE_RECORD_TRAIL.md
?? ORAC_AI_RECORD_ANALYSIS_API.md
?? PO_VERIFICATION_AND_DISPATCH_POLICY.md
?? PUBLIC_LEAD_IDEMPOTENCY.md
?? V5_AMENDMENT_APPROVAL_CONTRACT.md
?? V5_AMENDMENT_COVERAGE_DESIGN.md
?? V5_INVOICE_PREVIEW_CONTRACT.md
?? V5_INVOICE_WRITER_FICTIONAL_UAT.md
?? V5_INVOICE_WRITER_RELEASE_GATES.md
?? V5_MATERIAL_ALLOCATION_CONTRACT.md
?? scripts/capture-v5-invoice-writer-release-evidence.ps1
?? scripts/lib/restoreStoreBackup.js
?? scripts/run-v5-postgres-verification.ps1
?? src/controllers/invoiceSettlementController.js
?? src/controllers/trailController.js
?? src/controllers/v5AmendmentEvidenceAllocationController.js
?? src/controllers/v5AmendmentLinkController.js
?? src/controllers/v5InvoicePreviewController.js
?? src/controllers/v5InvoiceWriterController.js
?? src/controllers/v5MaterialAllocationController.js
?? src/idempotency.js
?? src/invoiceReadiness.js
?? src/invoiceSettlement.js
?? src/middleware/cors.js
?? src/recordTrail.js
?? src/v5InvoicePreview.js
?? src/v5InvoiceWriter.js
?? src/v5InvoiceWriterPolicy.js
?? tests/dispatchJobCard.test.js
?? tests/dispatchJobCardHttp.test.js
?? tests/dispatchPoPolicyHttp.test.js
?? tests/invoiceReadinessConsistency.test.js
?? tests/invoiceSettlement.test.js
?? tests/invoiceSettlementHttp.test.js
?? tests/leadIdempotency.test.js
?? tests/postgresStoreDoesNotSeedUsers.test.js
?? tests/rateRowRestrictionHttp.test.js
?? tests/recordTrailHttp.test.js
?? tests/recordTrailSlice01.test.js
?? tests/restoreStoreBackup.test.js
?? tests/v5AmendmentDispatchLink.test.js
?? tests/v5AmendmentEvidenceAllocation.test.js
?? tests/v5InvoicePreview.test.js
?? tests/v5InvoiceWriterFoundation.test.js
?? tests/v5InvoiceWriterHttp.test.js
?? tests/v5InvoiceWriterPostgres.test.js
?? tests/v5MaterialAllocation.test.js
``

## V5 File Hashes

| File | SHA-256 |
| --- | --- |
| `src/controllers/v5InvoiceWriterController.js` | `F85593B577550A31BC3BF8B4EDD221A4E4E589937006EF9281BB5E5BDB587913` |
| `src/v5InvoiceWriter.js` | `B98C4E49EC44E87B8F23C986E0E0FF4413F443B2FE72C06A73F0285ECF0EF6F7` |
| `src/v5InvoiceWriterPolicy.js` | `CFE21761C358A7A94C3CF7DC76A5882F261A6FF296C6674544B91E67124C38A7` |
| `src/postgresStore.js` | `DB4C2EC9C063F670B16AD23273B942AB967D1C0821AB13155A565AC5BBB1C886` |
| `tests/v5InvoiceWriterFoundation.test.js` | `22E338F3AE72B35468F6088ECA50AEAEE94120DF6960954A9266778207E982F8` |
| `tests/v5InvoiceWriterHttp.test.js` | `B4FB615DF84BB649369E88CD669FEBF7B349C31B7916C971E43DF9AEF5650240` |
| `tests/v5InvoiceWriterPostgres.test.js` | `F5C2B6A5D93B43F3114F9B9443200FE6A343593BFC68B139659F255B034599A0` |
| `V5_INVOICE_WRITER_RELEASE_GATES.md` | `E13B727F0BB0C229C664D3E4AEAA6432AC06A8573FF087EF0F869AA2A7887E83` |
| `V5_INVOICE_WRITER_FICTIONAL_UAT.md` | `F9A6A3F5171B9C7A3D45505BF3F2909C90573C153E5B86E46E0E8B706E4591F4` |
