# ORAC TOTP Operational Standard Operating Procedure (SOP)

This document formalizes the operational protocols, identity-verification standards, and break-glass procedures for ORAC two-factor authentication (TOTP) management on the candidate branch `codex/auth-totp`.

---

## 1. First-Admin CLI Bootstrap Protocol (D1)

When TOTP protection is first activated for the `Admin` role, or when bootstrapping a new environment where no enrolled Admin exists to issue enrollment tickets, the technical CLI bootstrap tool must be executed.

### 1.1 Prerequisites & Requirements
- Direct console / shell access to the production or staging application host.
- Access to production secrets manager to retrieve `DATABASE_URL` and `ORAC_TOTP_ENCRYPTION_KEY`.
- Mandatory Named Operator identity: The operator executing the script must identify themselves via `ORAC_OPERATOR_NAME` (e.g., `brian.lupao`). The system records attribution as `operator:<name>`.

### 1.2 Execution Procedure
```bash
ORAC_TOTP_ENCRYPTION_KEY="<base64-32byte-key>" \
DATABASE_URL="<secure-database-url>" \
BOOTSTRAP_ADMIN_EMAIL="admin@oracsystems.com" \
ORAC_OPERATOR_NAME="brian.lupao" \
node scripts/bootstrap-totp-ticket.js
```

### 1.3 Audit & Verification
- The script acquires a PostgreSQL row lock (`SELECT ... FOR UPDATE`), generates a cryptographically random 256-bit ticket, stores its SHA-256 digest in `user.totp_enrollment_ticket`, records `issued_by: "operator:brian.lupao"`, and writes an immutable audit record:
  - `action`: `TOTP_ENROLLMENT_TICKET_ISSUED`
  - `actor_id`: `operator:brian.lupao`
  - `entity_id`: `<admin_user_id>`
- The ticket is printed to the console standard output **exactly once**. It is never written to disk, application logs, or external stores.

### 1.4 Secure Out-of-Band Delivery SOP
- The operator must **never** transmit the bootstrap ticket over unencrypted email, public chat channels, or ticketing systems.
- Permitted delivery channels:
  1. In-person verbal/visual handoff on an air-gapped terminal.
  2. End-to-end encrypted ephemeral messaging (e.g. Signal with disappearing messages enabled) directly to the verified individual's verified device.
- The Admin recipient must complete enrollment within **30 minutes** (`TICKET_TTL_MS = 1,800,000`). Once confirmed, the ticket digest is permanently cleared from the database.

---

## 2. Admin Factor Reset Dual-Authorization Workflow (D2)

To prevent rogue account takeover or single-administrator compromise, factor reset for any account with the `Admin` role strictly requires a **two-step dual-authorization workflow** executed by two distinct authenticated Administrators.

### 2.1 Policy Rules & Constraints
1. **Refusal of Direct Reset**: `POST /api/auth/totp/factor/reset` will return `403 Forbidden` (`admin_requires_approval_workflow`) if called on an Admin target.
2. **Step 1 (Request)**: Admin A submits a reset request for Admin Target (`POST /api/auth/totp/factor/reset/request`).
   - Admin A cannot request a reset for themselves (403 `self_request`).
   - Target must have an enrolled factor (409 `not_enrolled`).
   - System generates a 256-bit random `request_id`, stores its SHA-256 digest on target with a 30-minute expiration (`RESET_REQUEST_TTL_MS = 1,800,000`), and logs `TOTP_FACTOR_RESET_REQUESTED` with `actor_id: Admin_A.id`.
3. **Step 2 (Approval)**: Distinct Admin B submits an approval (`POST /api/auth/totp/factor/reset/approve`) presenting `{ user_id, request_id }` with Admin B's own bearer JWT.
   - Admin B cannot be Admin A (403 `self_approval`).
   - Admin B cannot be the Target Admin (403 `target_approval`).
   - Request ID must match the persisted digest and not be expired.
   - Upon approval, `target.totp` is wiped (`null`), `target.totp_factor_reset_request` is wiped (`null`), `session_epoch` is incremented to invalidate all existing sessions, and audit entries `TOTP_FACTOR_RESET_APPROVED` and `TOTP_FACTOR_RESET` are recorded.
   - The request ID is consumed immediately; replay attempts fail with 404.

---

## 3. Non-Admin Factor Reset & Identity Verification Standard

For non-Admin protected roles (e.g. `Finance`, `Management`):

### 3.1 Verification Checklist
Before executing `POST /api/auth/totp/factor/reset` for a staff member:
1. **Out-of-band Identity Verification**: The Admin must verify the requester's identity through a secondary, out-of-band channel (live video call or verified voice recognition with security challenge questions). Email or Slack requests are strictly insufficient.
2. **Manager Acknowledgment**: For Finance personnel, confirmation from the Finance Director or designated lead must be archived in the security log.

### 3.2 Execution
- Admin calls `POST /api/auth/totp/factor/reset` with `{ user_id }`.
- System invalidates existing factor, increments `session_epoch`, and logs `TOTP_FACTOR_RESET`.
- Admin generates and issues a fresh single-use enrollment ticket via `POST /api/auth/totp/enrollment/tickets`.
- User re-enrolls with their password and the new ticket.

---

## 4. Break-Glass Custodian Protocol (Catastrophic Loss / Total Lockout)

### 4.1 Trigger Condition
Total administrative lockout occurs only if:
- All active Administrators lose access to their authenticator devices and recovery codes simultaneously, OR
- An encryption key or database corruption event invalidates factor verification across all Admin accounts.

### 4.2 Break-Glass Custodians
- Designated Custodian A: Engineering Lead / Systems Architect
- Designated Custodian B: System Owner / Director (Brian Lupao)

### 4.3 Execution Steps
1. **Access Authorization**: Both Custodians must jointly authorize emergency access in writing.
2. **Console Authentication**: Custodian A connects to the production infrastructure console.
3. **Targeted CLI Password & Factor Reset**:
   ```bash
   DATABASE_URL="<secure-database-url>" \
   RESET_ADMIN_EMAIL="owner@oracsystems.com" \
   RESET_ADMIN_PASSWORD="<temporary-random-32char-pass>" \
   ORAC_OPERATOR_NAME="custodian:brian.lupao" \
   node scripts/reset-admin-password.js
   ```
4. **Bootstrap Single-Use Ticket**:
   ```bash
   ORAC_TOTP_ENCRYPTION_KEY="<base64-32byte-key>" \
   DATABASE_URL="<secure-database-url>" \
   BOOTSTRAP_ADMIN_EMAIL="owner@oracsystems.com" \
   ORAC_OPERATOR_NAME="custodian:brian.lupao" \
   node scripts/bootstrap-totp-ticket.js
   ```
5. **Immediate Re-enrollment & Post-Mortem**:
   - The owner logs in and registers a new authenticator device immediately.
   - All other Admin accounts are inspected for anomalies.
   - An incident post-mortem report is completed within 24 hours.
