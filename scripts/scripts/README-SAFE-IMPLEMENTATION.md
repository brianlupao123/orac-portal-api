# Orac-IOS Safe Implementation Scripts

These scripts are designed to help build Orac-IOS in controlled phases without breaking the working MVP.

They do not delete files, reset git, install packages, or rewrite the system automatically. Their job is to create backups, check health, and verify that each phase still works.

## Recommended Working Method

Before each implementation phase:

```powershell
cd "/workspace/orac-backend"
powershell -ExecutionPolicy Bypass -File .\scripts\00-backup-current.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\01-health-check.ps1
```

After each implementation phase:

```powershell
cd "/workspace/orac-backend"
powershell -ExecutionPolicy Bypass -File .\scripts\01-health-check.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\02-smoke-test.ps1
```

## Phased Build Order

1. Landing pages and login shell.
2. Real JWT authentication and role-based access control.
3. Worksheet/job-card approval module.
4. Quote, job card, worksheet, and invoice PDFs.
5. Client portal.
6. Report management dashboard.
7. PostgreSQL runtime adapter.
8. AI assistant and notifications.

## Rule For Future Implementation

Each phase should be small enough that the system can still run after the change.

No phase should bypass the existing business rule:

```text
No invoice can be generated or exported unless a valid client PO reference has been verified and any PO amendment requirement is cleared.
```

