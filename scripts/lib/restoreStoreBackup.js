export async function restoreStoreBackup(client, backupId) {
  await client.query("BEGIN");
  try {
    await client.query("CREATE TABLE IF NOT EXISTS store_backups (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), label TEXT NOT NULL, data JSONB NOT NULL)");
    const current = await client.query("SELECT data FROM store WHERE id = 'main' FOR UPDATE");
    if (!current.rowCount) throw new Error("The main store does not exist; refusing to restore into an uninitialised database.");
    const backup = await client.query("SELECT data FROM store_backups WHERE id = $1", [backupId]);
    if (!backup.rowCount) throw new Error("Backup was not found.");
    const safety = await client.query(
      "INSERT INTO store_backups (label, data) VALUES ($1, $2) RETURNING id",
      [`before-restore-of-${backupId}`, current.rows[0].data]
    );
    await client.query("UPDATE store SET data = $1 WHERE id = 'main'", [backup.rows[0].data]);
    await client.query("COMMIT");
    return safety.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
