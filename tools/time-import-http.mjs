// Timing probe for a bulk import against a RUNNING API (for example a staging server that uses a disposable
// PostgreSQL branch). It sends synthetic rows over HTTP exactly as the Data Import page does.
//
//   Preview only (creates nothing):
//     ORAC_API_URL=https://your-staging-host/api ORAC_TOKEN=<admin token> node tools/time-import-http.mjs --rows 1000
//   Also commit (CREATES records, so use a disposable database only):
//     ... node tools/time-import-http.mjs --rows 1000 --commit --i-understand-this-creates-records
//
// Options: --entity clients|catalog_items (default clients)   --rows N (default 1000)
// The token is read from the environment and is never printed. Run it with 100, 300 and 1000 rows and compare.
// The importer cannot delete what it created: throw the disposable database away afterwards.

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

export const STATEMENT_LIMIT_MS = 10000;
export function buildCsv(entity, rows, runId) {
  const lines = [];
  if (entity === 'catalog_items') {
    lines.push('item_code,item_name,unit_price,category,unit_of_measure');
    for (let i = 1; i <= rows; i++) lines.push(`TIME-${runId}-${String(i).padStart(4, '0')},Timing test item ${i},${(10 + (i % 90) + 0.5).toFixed(2)},Timing,each`);
  } else {
    lines.push('name,client_type,contact_person,email');
    for (let i = 1; i <= rows; i++) lines.push(`Timing Test Client ${runId} ${String(i).padStart(4, '0')},Mine,Test Contact ${i},contact${i}.${runId}@example.test`);
  }
  return lines.join('\n') + '\n';
}
export function verdict(commitMs, rows) {
  if (commitMs < 5000) return { level: 'OK', text: 'Under 5 s: a comfortable margin below the 10 s statement limit.' };
  const safeRows = Math.max(1, Math.floor((rows * 5000) / commitMs));
  if (commitMs < 8000) return { level: 'CAUTION', text: `5-8 s: close to the limit. Consider IMPORT_MAX_ROWS=${safeRows}.` };
  return { level: 'TOO SLOW', text: `8 s or more: likely to hit the 10 s limit. Set IMPORT_MAX_ROWS to about ${safeRows} or lower.` };
}

async function main() {
  const base = (process.env.ORAC_API_URL || '').replace(/\/+$/, '');
  const token = process.env.ORAC_TOKEN || '';
  const entity = opt('--entity', 'clients');
  const rows = Math.min(1000, Math.max(1, Number(opt('--rows', '1000')) || 1000));
  const commit = flag('--commit');
  if (!base || !token) { console.error('Set ORAC_API_URL (ending in /api) and ORAC_TOKEN first. See the comment at the top of this file.'); process.exit(2); }
  if (!['clients', 'catalog_items'].includes(entity)) { console.error('--entity must be clients or catalog_items'); process.exit(2); }
  if (commit && !flag('--i-understand-this-creates-records')) { console.error('--commit creates records. Add --i-understand-this-creates-records, and only use a disposable database.'); process.exit(2); }

  const runId = Date.now().toString(36).slice(-5).toUpperCase();
  const csv = buildCsv(entity, rows, runId);
  const call = async (path, body) => {
    const started = process.hrtime.bigint();
    let status = 0, json = null, text = '';
    try {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      status = res.status; text = await res.text();
      try { json = JSON.parse(text); } catch { /* not JSON */ }
    } catch (error) { return { status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6, json: null, text: String(error.message || error) }; }
    return { status, ms: Number(process.hrtime.bigint() - started) / 1e6, json, text };
  };

  console.log(`Entity ${entity}, ${rows} synthetic rows, run ${runId}, ${commit ? 'PREVIEW + COMMIT' : 'preview only'}`);
  const preview = await call(`/imports/${entity}/preview`, { csv_content: csv });
  console.log(`preview: HTTP ${preview.status} in ${preview.ms.toFixed(0)} ms`);
  const data = preview.json?.data;
  if (preview.status !== 200 || !data) { console.error(`Preview failed: ${(preview.json?.message || preview.text).slice(0, 300)}`); process.exit(1); }
  console.log(`  rows ${data.row_count}, ready ${data.ok_count}, errors ${data.error_count}, can_commit ${data.can_commit}`);
  if (!commit) { console.log('Preview only. Nothing was created. Add --commit (and the confirmation flag) to time the commit, which is the slow part.'); return; }
  if (!data.can_commit) { console.error('The preview says this file cannot be committed. Stopping.'); process.exit(1); }

  const done = await call(`/imports/${entity}/commit`, { csv_content: csv, file_sha256: data.file_sha256, confirmation: data.confirmation_phrase, expected_row_count: data.row_count });
  console.log(`commit: HTTP ${done.status} in ${done.ms.toFixed(0)} ms`);
  if (done.status !== 201 && done.status !== 200) { console.error(`Commit failed: ${(done.json?.message || done.text).slice(0, 300)}`); process.exit(1); }
  const v = verdict(done.ms, rows);
  console.log(`  created ${done.json?.data?.created_count ?? '?'} records`);
  console.log(`RESULT ${v.level}: ${v.text}`);
  console.log(`(The statement limit is ${STATEMENT_LIMIT_MS / 1000} s. Repeat with --rows 100 and --rows 300 to see how time grows.)`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
