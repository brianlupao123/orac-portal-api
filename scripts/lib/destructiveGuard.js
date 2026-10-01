// Shared guard for operator scripts that OVERWRITE the whole `store` row.
//
// A script using this guard:
//   1. does nothing (no database access at all) unless run with --apply;
//   2. with --apply, refuses unless ALL of these hold:
//        - ORAC_CONFIRM_DESTRUCTIVE equals the script's own phrase,
//        - ORAC_TARGET_DB_HOST equals the host name in DATABASE_URL, so the
//          operator has to type which server they are about to overwrite,
//        - NODE_ENV is not "production";
//   3. takes a snapshot of the current `main` row into store_backups first.
// It never prints DATABASE_URL, passwords, or tokens.

export function parseDbHost(connectionString) {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function evaluateGuard({ phrase, argv, env }) {
  if (!argv.includes("--apply")) return { mode: "dry-run", problems: [] };

  const problems = [];
  if (!env.DATABASE_URL) problems.push("DATABASE_URL is not set.");
  if (env.NODE_ENV === "production") {
    problems.push("NODE_ENV is production. This script must never run against a production database.");
  }
  if (env.ORAC_CONFIRM_DESTRUCTIVE !== phrase) {
    problems.push(`Set ORAC_CONFIRM_DESTRUCTIVE=${phrase} to confirm you understand the effect.`);
  }
  const host = parseDbHost(env.DATABASE_URL || "");
  if (!host) {
    problems.push("The host in DATABASE_URL could not be read.");
  } else if (String(env.ORAC_TARGET_DB_HOST || "").trim().toLowerCase() !== host) {
    problems.push(
      "Set ORAC_TARGET_DB_HOST to the exact host name of the database you intend to overwrite, and confirm it is NOT the production database."
    );
  }
  return { mode: problems.length ? "refused" : "apply", problems };
}

export function requireDestructiveApply({
  scriptName,
  phrase,
  effect,
  argv = process.argv,
  env = process.env,
  log = console.log,
  exit = process.exit
}) {
  const result = evaluateGuard({ phrase, argv, env });
  log(`[${scriptName}] ${effect}`);
  if (result.mode === "dry-run") {
    log("DRY RUN: the database was not contacted and nothing was changed.");
    log(`To proceed on a NON-PRODUCTION database: pass --apply and set ORAC_CONFIRM_DESTRUCTIVE=${phrase} and ORAC_TARGET_DB_HOST=<exact database host>.`);
    exit(0);
  } else if (result.mode === "refused") {
    for (const problem of result.problems) log(`REFUSED: ${problem}`);
    exit(1);
  }
  return result;
}

// Copies the current `main` row into store_backups and returns the backup id
// (or null if there was no row to copy).
export async function snapshotStore(pool, label) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS store_backups (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), label TEXT NOT NULL, data JSONB NOT NULL)"
  );
  const result = await pool.query(
    "INSERT INTO store_backups (label, data) SELECT $1, data FROM store WHERE id = 'main' RETURNING id",
    [label]
  );
  return result.rowCount ? result.rows[0].id : null;
}
