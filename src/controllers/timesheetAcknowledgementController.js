import { requirePermission, roles } from "../permissions.js";
import { isClientViewer, scopeByClient } from "../middleware/clientScope.js";
import { generateControlledPdf, humanizeTimestamp } from "../pdfGenerator.js";
import { companyFromProfile } from "./documentController.js";

const PERIOD_PACK_COLUMNS = [
  { label: "Date", weight: 1.2 },
  { label: "Dispatch", weight: 1.2 },
  { label: "Hours", weight: 0.8, align: "right" },
  { label: "Status", weight: 1.4 },
  { label: "Signed By", weight: 1.6 },
  { label: "Signer Role", weight: 1.4 },
  { label: "Signed At", weight: 1.6 }
];

// Chat B — Digital Timesheets and client acknowledgement.
//
// Field evidence chain implemented here: Technician records work on a
// field_worksheet (existing createWorksheet/updateWorksheet/submitWorksheet
// in dispatchController.js) -> the client representative acknowledges that
// worksheet (this file) -> an independent ORAC Supervisor reviews it
// (existing reviewWorksheet, now gated on Client_Acknowledged instead of
// Submitted). A worksheet is already scoped to exactly one dispatch, one
// technician and one work_date, so the "one client/site/technician/day"
// entry rule in the cross-chat contract holds structurally — a technician
// working two clients already produces two distinct dispatch/worksheet
// records, never one blended entry.
//
// Research note (owner decision, not guessed): server-stored acknowledgement
// evidence (signer identity + explicit consent + timestamp + immutable
// reference + audit trail) follows the general evidence-binding shape in the
// current NIST SP 800-63-4 Digital Identity Guidelines (final, July 2025,
// https://csrc.nist.gov/pubs/sp/800/63/4/final — this supersedes the older
// SP 800-63-3/800-63B this system's earlier notes may have cited) and the
// EU eIDAS "simple electronic signature" definition,
// https://eur-lex.europa.eu/eli/reg/2014/910/oj, Art. 3(10) — a click/touch
// confirmation is legally an electronic signature once it is bound to a
// recorded intent, identity and timestamp. This system does not claim
// eIDAS "qualified" signature status or a specific NIST assurance level; it
// only adopts the underlying evidence shape (who, what, when, immutable
// reference). Confirming this against SP 800-63-4 §4 (Digital Identity Risk
// Management) and any Zimbabwe-specific e-signature/e-evidence rule the
// client contracts require is an owner decision, not made here.

function getActor(req) {
  return req.db.users.find((user) => user.id === req.user.id);
}

function resolveDispatch(db, worksheet) {
  return db.dispatch_cards.find((item) => item.id === worksheet.dispatch_card_id) || null;
}

function resolveQuote(db, dispatch) {
  return dispatch ? db.quotes.find((item) => item.id === dispatch.quotation_id) || null : null;
}

function resolveWorksheetClientId(db, worksheet) {
  const dispatch = resolveDispatch(db, worksheet);
  const quote = resolveQuote(db, dispatch);
  return quote?.client_id || null;
}

function resolveWorksheetSite(db, worksheet) {
  const dispatch = resolveDispatch(db, worksheet);
  const quote = resolveQuote(db, dispatch);
  const equipment = quote ? db.equipment_tags.find((item) => item.id === quote.equipment_tag_id) : null;
  const section = equipment ? db.plant_sections.find((item) => item.id === equipment.plant_section_id) : null;
  const plant = section ? db.plants.find((item) => item.id === section.plant_id) : null;
  const mineSite = plant ? db.mine_sites.find((item) => item.id === plant.mine_site_id) : null;
  return { dispatch, quote, equipment, section, plant, mineSite };
}

function worksheetSummary(db, worksheet) {
  const { dispatch, mineSite } = resolveWorksheetSite(db, worksheet);
  const technician = db.users.find((user) => user.id === worksheet.technician_id);
  return {
    id: worksheet.id,
    dispatch_card_id: worksheet.dispatch_card_id,
    dispatch_number: dispatch?.dispatch_number || null,
    technician_id: worksheet.technician_id,
    technician_name: technician?.name || null,
    work_date: worksheet.work_date,
    hours: worksheet.hours,
    status: worksheet.status,
    revision_number: worksheet.revision_number || 1,
    revises_worksheet_id: worksheet.revises_worksheet_id || null,
    superseded_by: worksheet.superseded_by || null,
    mine_site_id: mineSite?.id || null,
    mine_site_name: mineSite?.name || null,
    client_acknowledgement: worksheet.client_acknowledgement || null,
    approved_by: worksheet.approved_by || null,
    approved_at: worksheet.approved_at || null
  };
}

// Client Viewer's own pending + historical timesheets for their client only.
export function listOwnClientTimesheets(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "viewOwnClientTimesheets");

  const scoped = scopeByClient(req.db.field_worksheets, actor, (item) => resolveWorksheetClientId(req.db, item));
  const data = scoped
    .filter((worksheet) => !["Draft"].includes(worksheet.status))
    .map((worksheet) => worksheetSummary(req.db, worksheet));

  res.json({ success: true, data });
}

export function acknowledgeWorksheet(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "acknowledgeWorksheet");

  const worksheet = req.db.field_worksheets.find((item) => item.id === req.params.id);
  if (!worksheet) return res.status(404).json({ success: false, message: "Worksheet not found." });

  const ownerClientId = resolveWorksheetClientId(req.db, worksheet);
  if (!isClientViewer(actor) || !actor.client_id || ownerClientId !== actor.client_id) {
    return res.status(403).json({ success: false, message: "A client representative may acknowledge only their own client's entries." });
  }

  if (worksheet.status !== "Submitted") {
    return res.status(400).json({
      success: false,
      message: `This entry is in ${worksheet.status} status and is not awaiting client acknowledgement.`
    });
  }

  const before = { ...worksheet };
  const acknowledgedAt = new Date().toISOString();
  worksheet.status = "Client_Acknowledged";
  worksheet.client_acknowledgement = {
    id: req.store.id("wsack"),
    signer_name: req.body.signer_name,
    signer_role: req.body.signer_role,
    acknowledged_by_user_id: actor.id,
    acknowledged_at: acknowledgedAt,
    // Immutable evidence reference: the acknowledgement audit-log entry id
    // (assigned below) is the durable pointer back to this exact evidence
    // event; it is never reassigned once written.
    evidence_reference: req.store.id("evd")
  };
  worksheet.updated_at = acknowledgedAt;

  req.store.audit(req.db, actor, "field_worksheet", worksheet.id, "WORKSHEET_CLIENT_ACKNOWLEDGED", before, worksheet);
  res.json({ success: true, data: worksheetSummary(req.db, worksheet) });
}

// Corrections after client acknowledgement (or after supervisor approval)
// never mutate signed data. They open a new Draft revision, linked to the
// original, which must independently be re-submitted, re-acknowledged and
// (where applicable) re-approved.
export function reviseWorksheet(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "reviseWorksheet");

  const original = req.db.field_worksheets.find((item) => item.id === req.params.id);
  if (!original) return res.status(404).json({ success: false, message: "Worksheet not found." });

  if (actor.role === roles.TECHNICIAN && original.technician_id !== actor.id) {
    return res.status(403).json({ success: false, message: "A Technician may revise only their own worksheet." });
  }

  if (!["Client_Acknowledged", "Supervisor_Approved"].includes(original.status)) {
    return res.status(400).json({
      success: false,
      message: `Only an acknowledged or approved worksheet can be revised (current status: ${original.status}). Use the edit endpoint for a Draft or Returned_For_Correction worksheet instead.`
    });
  }
  if (original.superseded_by) {
    return res.status(400).json({ success: false, message: "This worksheet has already been superseded by a later revision." });
  }

  const now = new Date().toISOString();
  const revision = {
    id: req.store.id("ws"),
    dispatch_card_id: original.dispatch_card_id,
    technician_id: original.technician_id,
    technician_trade: original.technician_trade,
    work_date: original.work_date,
    activity: original.activity,
    hours: original.hours,
    tools_used: original.tools_used,
    materials_used: original.materials_used,
    outcomes: original.outcomes,
    challenges: original.challenges,
    evidence_files: original.evidence_files,
    status: "Draft",
    submitted_by: null,
    submitted_at: null,
    supervisor_comment: "",
    approved_by: null,
    approved_at: null,
    client_acknowledgement: null,
    revision_number: (original.revision_number || 1) + 1,
    root_worksheet_id: original.root_worksheet_id || original.id,
    revises_worksheet_id: original.id,
    revision_reason: req.body.reason,
    revised_by: actor.id,
    revised_at: now,
    created_at: now,
    updated_at: now
  };

  const before = { ...original };
  original.superseded_by = revision.id;
  original.updated_at = now;

  req.db.field_worksheets.push(revision);
  req.store.audit(req.db, actor, "field_worksheet", original.id, "WORKSHEET_SUPERSEDED", before, original);
  req.store.audit(req.db, actor, "field_worksheet", revision.id, "WORKSHEET_REVISION_CREATED", null, revision);

  res.json({ success: true, data: revision });
}

// Shared by the JSON and PDF period-pack endpoints so the inclusion rule
// (which entries qualify for a client pack) lives in exactly one place.
// Throws { status, message } on a validation/lookup failure; callers turn
// that into the appropriate response.
// Permission is checked by each caller before this runs (so a permission
// failure still throws synchronously, matching every other permission
// check in this codebase, instead of being caught below).
function buildPeriodPack(req, actor) {
  const { client_id: clientId, site, from, to } = req.query;
  if (!clientId) throw { status: 400, message: "client_id is required." };
  if (!from || !to) throw { status: 400, message: "A from and to work-date range is required." };

  const client = req.db.clients.find((item) => item.id === clientId);
  if (!client) throw { status: 404, message: "Client not found." };

  const included = req.db.field_worksheets.filter((worksheet) => {
    if (resolveWorksheetClientId(req.db, worksheet) !== clientId) return false;
    if (!["Client_Acknowledged", "Supervisor_Approved"].includes(worksheet.status)) return false;
    if (worksheet.superseded_by) return false; // only the current revision ships in a pack
    if (worksheet.work_date < from || worksheet.work_date > to) return false;
    if (site && resolveWorksheetSite(req.db, worksheet).mineSite?.id !== site) return false;
    return true;
  });

  const grouped = {};
  for (const worksheet of included) {
    const key = worksheet.technician_id;
    if (!grouped[key]) {
      const technician = req.db.users.find((user) => user.id === key);
      grouped[key] = { technician_id: key, technician_name: technician?.name || null, days: {} };
    }
    grouped[key].days[worksheet.work_date] = grouped[key].days[worksheet.work_date] || [];
    grouped[key].days[worksheet.work_date].push(worksheetSummary(req.db, worksheet));
  }

  return {
    client: { id: client.id, name: client.name },
    site_filter: site || null,
    date_range: { from, to },
    generated_by: actor.id,
    generated_at: new Date().toISOString(),
    entry_count: included.length,
    technicians: Object.values(grouped).sort((a, b) => String(a.technician_name).localeCompare(String(b.technician_name)))
  };
}

// Operations: a downloadable JSON pack for one client (optionally one site)
// over a date range, grouped by technician then day. Only client-
// acknowledged or supervisor-approved entries are included — a client pack
// is never built from unacknowledged drafts, and never mixes another
// client's evidence. See getTimesheetPeriodPackPdf for the printable form.
export function getTimesheetPeriodPack(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "downloadTimesheetPeriodPack");
  let pack;
  try {
    pack = buildPeriodPack(req, actor);
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Unable to build period pack." });
  }
  res.setHeader("Content-Disposition", `attachment; filename="orac-period-pack-${req.query.client_id}-${req.query.from}-to-${req.query.to}.json"`);
  res.json({ success: true, data: pack });
}

// Operations: the same pack, laid out as a controlled PDF — one table per
// technician, each row one acknowledged/approved client/site/day entry with
// its signer, declared role and signed timestamp. Reuses the same
// generateControlledPdf renderer as every other Orac-IOS document, so no
// new PDF dependency is introduced.
export function getTimesheetPeriodPackPdf(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "downloadTimesheetPeriodPack");
  let pack;
  try {
    pack = buildPeriodPack(req, actor);
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, message: err.message || "Unable to build period pack." });
  }

  const siteName = pack.site_filter
    ? req.db.mine_sites.find((item) => item.id === pack.site_filter)?.name || pack.site_filter
    : null;

  const technicianSections = pack.technicians.map((tech) => {
    const rows = Object.keys(tech.days).sort().flatMap((day) =>
      tech.days[day].map((entry) => [
        entry.work_date,
        entry.dispatch_number || "",
        String(entry.hours ?? ""),
        entry.status,
        entry.client_acknowledgement?.signer_name || "",
        entry.client_acknowledgement?.signer_role || "",
        humanizeTimestamp(entry.client_acknowledgement?.acknowledged_at) || ""
      ])
    );
    return {
      type: "table",
      heading: tech.technician_name || tech.technician_id,
      columns: PERIOD_PACK_COLUMNS,
      rows,
      emptyMessage: "No acknowledged entries for this technician in range."
    };
  });

  const model = {
    documentType: "TIMESHEET_PERIOD_PACK",
    documentTypeLabel: "Timesheet Period Pack",
    documentNumber: `${pack.client.name} ${pack.date_range.from} to ${pack.date_range.to}`,
    status: `${pack.entry_count} acknowledged ${pack.entry_count === 1 ? "entry" : "entries"}`,
    company: companyFromProfile(req.db.company_profile),
    generatedAtLabel: "Generated",
    generatedAt: humanizeTimestamp(pack.generated_at),
    controlledNote: "Controlled record generated by Orac-IOS. Contains only this client's client-acknowledged or Supervisor-approved entries — never another client's evidence.",
    headerMeta: [
      { label: "Client", value: pack.client.name },
      siteName ? { label: "Site", value: siteName } : { label: "Site", value: "All sites", placeholder: true },
      { label: "Date Range", value: `${pack.date_range.from} to ${pack.date_range.to}` }
    ],
    sections: technicianSections.length
      ? technicianSections
      : [{ type: "paragraph", heading: "No entries", text: "No client-acknowledged or Supervisor-approved entries fall in this range.", placeholder: true }]
  };

  res.setHeader("Content-Disposition", `attachment; filename="orac-period-pack-${req.query.client_id}-${req.query.from}-to-${req.query.to}.pdf"`);
  res.type("application/pdf").send(generateControlledPdf(model));
}

// Internal ORAC management summary: a technician's work across every client
// in the period, but each entry keeps its own client/site/day reference and
// signature status. This is explicitly a management view, never a
// substitute for the client's own acknowledgement.
export function getTimesheetPeriodSummary(req, res) {
  const actor = getActor(req);
  requirePermission(actor, "viewTimesheetPeriodSummary");

  const { from, to, technician_id: technicianId } = req.query;
  if (!from || !to) return res.status(400).json({ success: false, message: "A from and to work-date range is required." });

  const included = req.db.field_worksheets.filter((worksheet) => {
    if (worksheet.superseded_by) return false;
    if (worksheet.work_date < from || worksheet.work_date > to) return false;
    if (technicianId && worksheet.technician_id !== technicianId) return false;
    return true;
  });

  const grouped = {};
  for (const worksheet of included) {
    const key = worksheet.technician_id;
    const client = req.db.clients.find((item) => item.id === resolveWorksheetClientId(req.db, worksheet));
    if (!grouped[key]) {
      const technician = req.db.users.find((user) => user.id === key);
      grouped[key] = { technician_id: key, technician_name: technician?.name || null, entries: [] };
    }
    grouped[key].entries.push({
      ...worksheetSummary(req.db, worksheet),
      client_id: client?.id || null,
      client_name: client?.name || null,
      signature_status: worksheet.client_acknowledgement ? "acknowledged" : "pending_client_acknowledgement"
    });
  }

  res.json({
    success: true,
    data: {
      date_range: { from, to },
      note: "Internal cross-client management summary. Not a client acknowledgement.",
      technicians: Object.values(grouped)
    }
  });
}
