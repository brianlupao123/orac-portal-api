# ORAC Systems — Final External Facts Turnkey Activation Guide

**Document Version**: 1.0  
**Date**: 2026-11-11  
**Target Environments**: Fly.io (`orac-operations-api`) & Render (`orac-industrial-service-portal`)  

This operational guide provides turnkey, copy-paste procedures to activate the three remaining business facts as soon as human stakeholder decisions or approvals are received.

---

## 1. VAT & Tax Authority Activation

### Background
Taxable invoice generation is currently protected by the security gate `ORAC_REQUIRE_APPROVED_TAX`. Unconfigured tax status allows non-taxable and zero-rated operations, while blocking unapproved taxable invoices.

### When Received:
You need:
1. Company VAT Registration / BP number from ZIMRA.
2. Official Tax Status: `taxable` (standard 15%), `zero-rated` (0%), or `exempt` (0%).
3. Reference note or approval name.

### Method A: Through Portal UI (No deployment needed)
1. Sign in to the portal as an **Admin** at `https://orac-industrial-service-portal.onrender.com/`.
2. Navigate to **Administration** (`/admin`).
3. Scroll to **Quotation Tax Authority**:
   - Select **Tax Status**: `Taxable (Standard 15%)`, `Zero-Rated`, or `Exempt`.
   - Enter **Applied Tax Rate (%)**: `15` (or `0` for zero-rated/exempt).
   - Enter **Approval Reference**: e.g., `ZIMRA-BP-200012345` or `ACCOUNTANT-2026-11`.
   - Check **Approved & Effective**.
4. Click **Save Company Profile**.
   - The system immediately writes an immutable audit record and applies the approved rate to new quotations and invoices.

### Method B: Through Server Console
Run on the Fly application container:
```bash
flyctl ssh console --app orac-operations-api

# Inside container:
TAX_STATUS="taxable" \
TAX_RATE=0.15 \
APPROVAL_REF="ZIMRA-BP-200012345" \
ORAC_OPERATOR_NAME="brian.lupao" \
node scripts/set-company-tax-config.js
```

---

## 2. Sage Pastel Accounting Integration & Pay Codes

### Background
All 4 review export endpoints are active on the live backend, outputting clean, non-posting CSVs with byte-exact SHA-256 digests in audit logs:
- `GET /api/exports/pastel-review/invoices.csv`
- `GET /api/exports/pastel-review/quotes.csv`
- `GET /api/exports/pastel-review/invoice-ready.csv`
- `GET /api/reports/technician-payroll?month=YYYY-MM` (JSON report)
- `GET /api/exports/pastel-payroll.csv?month=YYYY-MM` (Review CSV)

### When Accountant Confirms Specific Pay Codes:
Default placeholder pay codes are `NORMAL`, `OT15`, and `OT20`. If the accountant requires numeric or legacy codes (e.g. `1001` for Normal, `2001` for OT 1.5, `2002` for OT 2.0), update Fly secrets:
```bash
flyctl secrets set \
  ORAC_PASTEL_PAY_CODE_NORMAL="1001" \
  ORAC_PASTEL_PAY_CODE_OT15="2001" \
  ORAC_PASTEL_PAY_CODE_OT20="2002" \
  --app orac-operations-api
```
The application dynamically reads these variables; no code rebuild is needed.

---

## 3. TOTP / Two-Factor Authentication Activation Protocol

### Background
All TOTP routes, 256-bit single-use tickets, dual-admin factor reset, session epoch invalidation, and UI handlers are deployed to production. Enforcement is currently turned off (`ORAC_TOTP_PROTECTED_ROLES` is unset).

### Step 1: Configure Encryption Key & Enable Enrollment
Generate a secure 32-byte encryption key (base64-encoded) and set it in Fly secrets:
```bash
# Generate 32-byte random key:
# Node.js: crypto.randomBytes(32).toString('base64')

flyctl secrets set \
  ORAC_TOTP_ENROLLMENT_ENABLED="true" \
  ORAC_TOTP_ENCRYPTION_KEY="<base64-encoded-32-byte-key>" \
  --app orac-operations-api
```

### Step 2: Bootstrap the First Administrator Ticket
Run the bootstrap utility on the host console:
```bash
flyctl ssh console --app orac-operations-api

# Inside container:
BOOTSTRAP_ADMIN_EMAIL="admin@oracsystems.com" \
ORAC_OPERATOR_NAME="brian.lupao" \
node scripts/bootstrap-totp-ticket.js
```
The script will output the single-use 256-bit ticket and record an audit log.

### Step 3: Out-of-Band Delivery & Admin Enrollment
1. Deliver the ticket to the Admin via the verified out-of-band channel (in person or via end-to-end encrypted messaging to their verified physical device per `docs/totp-operational-sop.md`).
2. The Admin initiates enrollment within 30 minutes via the portal, scans the QR code / enters the secret into their authenticator app (Google Authenticator, Microsoft Authenticator, or 1Password), and confirms with a 6-digit code.
3. The Admin saves the 10 emergency recovery codes.

### Step 4: Admin Issues Tickets for Finance and Management
The enrolled Admin calls `POST /api/auth/totp/enrollment/tickets` for each `Management` and `Finance` user. Each user completes enrollment and receives their recovery codes.

### Step 5: Activate Mandatory Enforcement
Once all protected users have enrolled, activate the role enforcement gate:
```bash
flyctl secrets set \
  ORAC_TOTP_PROTECTED_ROLES="Admin,Management,Finance" \
  --app orac-operations-api
```
From this point forward:
- Password login returns `status: "verification_required"` with a 5-minute challenge.
- Bearer tokens are issued only upon valid 6-digit TOTP code or single-use 144-bit recovery code.
- Lost factors for non-Admins are reset directly by Admin.
- Lost factors for Admins strictly require dual-admin request and approval.
