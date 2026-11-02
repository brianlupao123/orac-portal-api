# Phase 5 Credit-Note Browser UAT

Date: 2026-10-27  
Scope: fictional local PostgreSQL fixture only (`orac_phase5_browser_test`)

## Result

Pass. The controlled legacy-invoice correction flow was verified end to end:

1. Finance prepared a reasoned USD 100 credit note against `INV-0001`.
2. A different Finance reviewer issued it.
3. The immutable issued correction reduced the effective invoice total and outstanding amount from USD 800 to USD 700.
4. The source invoice remained unchanged; the correction is represented as its own audited record.

## Evidence

- `finance-credit-note-prepared.png` — preparer view showing the prepared correction.
- `finance-credit-note-issued.png` — independent reviewer view showing USD 100 credited and USD 700 outstanding.

## Automated verification

| Check | Result |
| --- | --- |
| Focused backend settlement and billing regression | 19 passed, 0 failed |
| Portal test suite | 482 passed, 0 failed |
| Portal production build | Passed |
| Browser: Finance prepares correction | Passed |
| Browser: independent Finance reviewer issues correction | Passed |
| Settlement after issue | USD 100 credited; USD 700 outstanding |

## Controls verified

- Only Finance/Admin may prepare or issue a correction.
- The preparer cannot issue their own credit note.
- A credit note needs a positive amount and reason.
- An issued credit note cannot exceed the currently outstanding balance.
- The Pastel review export represents issued credit notes as negative correction rows and does not claim accounting posting.
- V5 remained unseeded and disabled for this fixture.

## Local-only safeguards

- The fixture seed refuses any database other than `orac_phase5_browser_test`.
- The UAT setup refuses non-loopback API URLs.
- No production database, credential store, migration, push, or deployment was used.

## Checkpoints

- Backend controlled credit-note implementation: `832bf46`.
- Backend fictional Phase 5 setup: `ea1825e`.
- Portal credit-note UI: `e1b23ab`.
- Portal browser-UAT hardening: `e487283`.

## Remaining release gates

- Confirm the production VAT configuration with the company accountant; the 15% value remains a development/test fixture only.
- Complete the broader public-site and portal UI/UX visual refinement and independent visual review before external deployment.
- Run staging, backup/restore, access review, and operational sign-off before production release.
