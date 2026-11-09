// Timing probe for a bulk import on the JSON store (synthetic rows, temporary folder).
// Not a test. PostgreSQL was not measured. Run: node tools/time-import.mjs
import express from "express";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiRouter from "../src/router.js";
import { persistenceMiddleware } from "../src/persistenceMiddleware.js";
import { createStore } from "../src/store.js";
import { generateToken } from "../src/middleware/auth.js";
import { sha256Text } from "../src/importers/masterDataImport.js";

const dir = mkdtempSync(join(tmpdir(), "orac-import-timing-"));
const file = join(dir, "db.json");
const store = createStore(file);
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/api", persistenceMiddleware(store));
app.use("/api", apiRouter);
app.use((err, _req, res, _next) => res.status(err.status || 500).json({ success: false, message: err.message }));
const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
const url = `http://127.0.0.1:${server.address().port}/api`;
const db = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
const token = generateToken(db.users.find((u) => u.id === "u_admin"));
const post = async (path, body) => {
  const t = process.hrtime.bigint();
  const r = await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = await r.json();
  return { status: r.status, ms: Number(process.hrtime.bigint() - t) / 1e6, j };
};
for (const rows of [100, 500, 1000]) {
  const csv = "name,client_type,contact_person,email\n" + Array.from({ length: rows }, (_, i) => `Timing Co ${rows}-${i},Mine,Pat Example,pat${i}@example.test`).join("\n") + "\n";
  const p = await post("/imports/clients/preview", { csv_content: csv });
  const c = await post("/imports/clients/commit", { csv_content: csv, confirmation: "IMPORT_CLIENTS", expected_row_count: rows, file_sha256: sha256Text(csv) });
  console.log(`${rows} rows: csv ${(csv.length / 1024).toFixed(0)} KB | preview ${p.status} ${p.ms.toFixed(0)} ms | commit ${c.status} ${c.ms.toFixed(0)} ms | store file ${(statSync(file).size / 1024).toFixed(0)} KB`);
}
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
rmSync(dir, { recursive: true, force: true });
