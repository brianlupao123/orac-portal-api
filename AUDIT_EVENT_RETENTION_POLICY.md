# Audit Event Retention Policy

**Status:** owner-confirmed policy. Local source documentation only; not a deployment, storage-capacity, privacy, or legal-compliance certification.

## Policy

ORAC retains audit events indefinitely so that authorized staff can retrieve the evidence when it is needed for operational investigation, reconciliation, dispute handling, governance, or reporting.

This applies to audit events, not to unrestricted visibility of their contents. Existing role and record-scope controls remain in force:

- Admin, Management, and Finance retain the `viewAudit` permission.
- Other roles do not gain generic audit-event access from this retention decision.
- Client Viewer and field roles remain scoped to their existing records and do not receive generic audit history.
- The typed ORAC AI analysis route continues to return only allowlisted, role-scoped evidence projections. It does not expose audit snapshots or turn retention into unrestricted conversational lookup.

## Implementation Boundary

The current store appends audit rows and contains no automated audit-retention or purge job. Existing read APIs bound returned event history; the quote trail returns the newest 200 matching events by default and discloses `events_pagination`. Admin, Management, and Finance may pass the opaque server-issued `event_cursor` as `?event_cursor=...` to retrieve older matching quote events. Malformed cursors are refused with `400`. Indefinite retention does not remove the response bound, authorize bulk export, or change access permissions.

## Operational Release Gates

Before production certification, confirm and record:

1. Storage growth, archive/indexing, backup, restore and retrieval expectations for indefinite audit retention.
2. Approved privacy, data-protection, legal-hold and record-correction procedures for audit data.
3. Authorized audit viewers and role changes in the deployed environment.
4. Long-running cursor-pagination performance, archive behavior, and recovery, without weakening role scope or exposing sensitive snapshots.

No audit event is deleted, altered, or exported by this policy document.
