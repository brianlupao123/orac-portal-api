# ORAC authenticator sign-in contract (local branch candidate)

This describes the **as-built backend candidate** on `codex/auth-totp`. It is not an activation or deployment instruction. The portal has not yet been wired to these states. The first owner-selected roles are Admin, Management and Finance; other roles are for later rollout.

## Default and activation

- With `ORAC_TOTP_PROTECTED_ROLES` unset, the existing password login response remains `{success:true,data:{user,token,note}}`. This is the current default.
- To enroll before enforcement, explicitly set `ORAC_TOTP_ENROLLMENT_ENABLED=true`, `ORAC_REQUIRE_PASSWORD=true` outside production, and `ORAC_TOTP_ENCRYPTION_KEY` as a base64-encoded 32-byte key from a secret manager. Enrollment routes return 404 when that flag is off. To enforce a tested role set, configure `ORAC_TOTP_PROTECTED_ROLES=Admin,Management,Finance`. Production requires a password already. Startup rejects an invalid role list or missing/invalid encryption key whenever either enrollment or enforcement is enabled. Never put the key in the repository, logs, screenshots or handover ZIPs.
- An unenrolled protected account receives no JWT from login. A different active Admin may issue a single-use enrollment ticket; the user then proves their password and ticket on the limited public enrollment route, including after their role becomes protected. Existing JWTs without a matching factor claim are rejected once protection is enabled. The first-Admin bootstrap, independent delivery/notice and lost-factor recovery are not implemented; **do not activate** until those and enrollment UAT are complete.
- The encryption key must be durably backed up in the operator's secret manager; loss of the key makes enrolled secrets unreadable. Key rotation is not implemented in this candidate.

## Routes and response states

| Route | Authentication | Request | Success |
| --- | --- | --- | --- |
| `POST /api/auth/totp/enrollment/tickets` | Active Admin bearer JWT | `{user_id}` | `{success:true,data:{ticket,expires_in_seconds:1800}}` (shown once to issuer) |
| `POST /api/auth/totp/factor/reset` | Active Admin bearer JWT | `{user_id, approver_id?}` | `{success:true,message:"Authenticator factor has been reset. The user must re-enroll."}` (dual Admin required if target is Admin) |
| `POST /api/auth/totp/enrollment/start` | Public; ticket plus account password | `{email,password,ticket}` | `{success:true,data:{enrollment_id,otpauth_uri,expires_in_seconds:600}}` |
| `POST /api/auth/totp/enrollment/confirm` | Public; limited pending enrollment | `{email,enrollment_id,code}` | `{success:true,data:{recovery_codes:[...]}}` (shown once) |
| `POST /api/auth/login` | Public | `{email,password}` | Protected, enrolled role: `{success:true,data:{status:"verification_required",challenge_id,expires_in_seconds:300}}`; no JWT or user. Other roles/flag off retain the existing response. |
| `POST /api/auth/totp/verify` | Public, bound to a password challenge | `{email,challenge_id,code}` **or** `{email,challenge_id,recovery_code}` | `{success:true,data:{user,token}}` |

The enrollment ticket is 256-bit random, stored as a digest, expires after 30 minutes and is bound to the target's password digest, email, role and session epoch. Issuer and target must differ. The issuing Admin cannot be the recorded account creator/password setter or setup-link issuer; accounts without recorded password provenance fail closed. An independently reviewed legacy credential must first be reset through a tracked process before ticket issuance. Reissuing invalidates the previous ticket and pending enrollment. A pending enrollment expires after 10 minutes and accepts at most five code attempts. Confirmation consumes the ticket and invalidates older sessions. The raw ticket is returned once to the issuing Admin; secure handoff and independent notification remain an operational gate.

Refused ticket issuance, enrollment start and enrollment confirmation for an existing account are written to the audit log with a fixed reason code (for example `bad_ticket`, `issuer_set_password`, `expired`) and are saved even though the response is an error. Rows hold ids and reason codes only, never the submitted email, password, ticket, enrollment id or code. Attempts against an unknown account are not recorded. Responses are unchanged.

The password challenge is random, stored as a digest, expires after five minutes, is bound to the account's password state, email, role and session epoch, and is single use. Six-digit TOTP accepts the current 30-second counter and one adjacent counter on either side. A successful counter cannot be replayed. Five failed attempts end one challenge; ten failures across new challenges lock factor verification for 15 minutes. A recovery code is 144-bit random, stored as a SHA-256 digest and single use. Response bodies containing a challenge, enrollment URI, ticket or recovery code use `Cache-Control: no-store`.

Tokens now carry an integer `session_epoch` claim. Any password change or reset, role/email/client/status change, TOTP enrollment confirmation or recovery-code use increments the account's epoch, ending older sessions even when the change occurs in the same second as token issue. Historical tokens without the claim remain valid only while the account epoch is zero, subject to the existing password timestamp check. Generic user archive and reactivation also increment the epoch and return only public user fields.

## Scope limits and rollout gates

- **Lost-factor recovery and break-glass (D2)**: Implemented via `POST /api/auth/totp/factor/reset`. A single Admin can reset a non-Admin user (clears factor & ticket, bumps epoch, revokes sessions). Resetting an Admin requires dual-authorization (second independent active Admin `approver_id`). No self-service or email-only reset exists.
- **First-Admin bootstrap (D1)**: Implemented via `scripts/bootstrap-totp-ticket.js`. Runs with trusted console access, verifies the encryption key, and writes a single-use ticket with `issued_by: "operator:cli"`, avoiding the chicken-and-egg same-issuer lock.
- **CLI password reset provenance (D3)**: `scripts/reset-admin-password.js` records `password_changed_by: "operator:cli"`, increments `session_epoch`, and clears stale TOTP state so tickets can subsequently be issued.
- Password-reset email delivery remains unconfigured. Existing `/api/auth/request-password-reset` still acknowledges requests without sending a link; do not describe it as functional recovery.
- The current rate limiter is per process. The account-wide factor failure budget is persisted in the existing JSON/PostgreSQL user record, but distributed deployment, recovery and lockout operations still need an independent security review and browser UAT.
- The frontend must handle `verification_required` without storing a token or user. It should offer authenticator code and recovery-code entry, with no resend timer or emailed login code. Do not wire to a guessed contract; use this as-built route list after review.
- V5 commercial and invoice flags are unrelated and remain off. No production settings or data were changed by this branch.

The algorithm follows [RFC 6238](https://www.rfc-editor.org/info/rfc6238/) and its [HOTP foundation](https://www.rfc-editor.org/info/rfc4226/). TOTP is not phishing resistant; passkeys remain the later target.
