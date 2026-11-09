// Routes for the master-data importer (Clients and Catalog Items).
// All routes sit after authentication. Permission is checked on the server from the
// database account (the same manageClients / manageCatalog permissions the admin forms use).
import { hasPermission, requirePermission } from "../permissions.js";
import { IMPORT_ENTITIES, ImportError, commitImport, jobSummary, previewImport } from "../importers/masterDataImport.js";

function getActor(req) {
  return req.db.users.find((u) => u.id === req.user.id);
}

// ImportError becomes { success: false, message, code }. Any other error (for example the
// 403 from requirePermission) goes to the global error handler unchanged.
function respond(res, work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof ImportError) {
      return res.status(error.status).json({ success: false, message: error.message, code: error.code, ...error.extra });
    }
    throw error;
  }
}

// The template is returned as JSON ({ filename, csv_content }) so the browser can use the shared
// request helper; the page turns it into a file download.
export const downloadImportTemplate = (entityKey) => (req, res) => {
  const entity = IMPORT_ENTITIES[entityKey];
  requirePermission(getActor(req), entity.permission);
  res.json({ success: true, data: { filename: `${entity.key}-import-template.csv`, csv_content: `${entity.columns.map((c) => c.name).join(",")}\r\n` } });
};

export const previewMasterDataImport = (entityKey) => (req, res) => respond(res, () => {
  const entity = IMPORT_ENTITIES[entityKey];
  requirePermission(getActor(req), entity.permission);
  return res.json({ success: true, data: previewImport(entity, req.body?.csv_content, req.db) });
});

export const commitMasterDataImport = (entityKey) => (req, res) => respond(res, () => {
  const entity = IMPORT_ENTITIES[entityKey];
  const actor = getActor(req);
  requirePermission(actor, entity.permission);
  const job = commitImport({ entity, body: req.body || {}, db: req.db, store: req.store, actor, nowMs: req.nowMs ?? Date.now() });
  return res.status(201).json({ success: true, data: { job_id: job.id, entity: job.entity, created_count: job.created_count } });
});

// Import history is limited to the kinds of data the person may manage. A user who can
// manage clients but not the catalog sees client imports only (and the reverse).
export const manageableEntities = (actor, can = hasPermission) =>
  Object.values(IMPORT_ENTITIES).filter((entity) => can(actor, entity.permission)).map((entity) => entity.key);

function requireImportHistoryAccess(actor) {
  const entities = manageableEntities(actor);
  if (entities.length === 0) requirePermission(actor, "manageClients");
  return new Set(entities);
}

export const listImportJobs = (req, res) => {
  const allowed = requireImportHistoryAccess(getActor(req));
  const jobs = [...(req.db.import_jobs || [])].reverse().filter((job) => allowed.has(job.entity)).map(jobSummary);
  res.json({ success: true, data: jobs });
};

export const getImportJob = (req, res) => {
  const allowed = requireImportHistoryAccess(getActor(req));
  const job = (req.db.import_jobs || []).find((j) => j.id === req.params.id);
  // A job of a kind the person may not manage is reported as not found, so its existence is not revealed.
  if (!job || !allowed.has(job.entity)) return res.status(404).json({ success: false, message: "Import job not found." });
  res.json({ success: true, data: job });
};
