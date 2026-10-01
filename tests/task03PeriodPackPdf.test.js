import test from "node:test";
import assert from "node:assert/strict";
import { getTimesheetPeriodPack, getTimesheetPeriodPackPdf } from "../src/controllers/timesheetAcknowledgementController.js";
import { getWorksheetPdf } from "../src/controllers/documentController.js";

function response() {
  return {
    statusCode: 200, headers: {}, contentType: null, sentBytes: null,
    status(c) { this.statusCode = c; return this; },
    setHeader(n, v) { this.headers[n] = v; return this; },
    json(b) { this.body = b; return this; },
    type(v) { this.contentType = v; return this; },
    send(b) { this.sentBytes = b; return this; }
  };
}
// The in-house generator writes uncompressed text operators. Decode each (..) Tj
// string, undo PDF escapes and join with spaces so wrapped table cells and escaped
// parentheses still compare as the words a reader sees.
const pdfText = (res) => {
  const raw = res.sentBytes.toString("latin1");
  const parts = [...raw.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, "$1"));
  return `${raw.slice(0, 8)} ${parts.join(" ").replace(/\s+/g, " ")}`;
};

function makeDb() {
  return {
    users: [
      { id: "ops", role: "Operations", is_active: true },
      { id: "sup", role: "Supervisor", name: "Sipho Sup", is_active: true },
      { id: "t1", role: "Technician", name: "Tapiwa Moyo", is_active: true },
      { id: "t2", role: "Technician", name: "Rudo Chuma", is_active: true },
      { id: "cz", role: "Client Viewer", client_id: "c_z", is_active: true },
      { id: "cm", role: "Client Viewer", client_id: "c_m", is_active: true }
    ],
    clients: [{ id: "c_z", name: "Zimplats" }, { id: "c_m", name: "Mimosa" }],
    mine_sites: [{ id: "ms1", name: "Ngezi" }, { id: "ms2", name: "Mhondoro" }],
    plants: [{ id: "p1", mine_site_id: "ms1" }, { id: "p2", mine_site_id: "ms2" }],
    plant_sections: [{ id: "s1", plant_id: "p1" }, { id: "s2", plant_id: "p2" }],
    equipment_tags: [{ id: "e1", plant_section_id: "s1" }, { id: "e2", plant_section_id: "s2" }],
    quotes: [
      { id: "q1", client_id: "c_z", equipment_tag_id: "e1" },
      { id: "q2", client_id: "c_z", equipment_tag_id: "e2" },
      { id: "q3", client_id: "c_m", equipment_tag_id: null }
    ],
    dispatch_cards: [
      { id: "d1", quotation_id: "q1", dispatch_number: "DC-ZIM-1" },
      { id: "d2", quotation_id: "q2", dispatch_number: "DC-ZIM-2" },
      { id: "d3", quotation_id: "q3", dispatch_number: "DC-MIM-3" }
    ],
    field_worksheets: [
      { id: "w1", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-05", hours: 8, status: "Client_Acknowledged", revision_number: 1,
        client_acknowledgement: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledged_at: "2026-09-05T16:00:00.000Z", evidence_reference: "evd-77" } },
      { id: "w2", dispatch_card_id: "d1", technician_id: "t2", work_date: "2026-09-06", hours: 6, status: "Supervisor_Approved", revision_number: 1,
        client_acknowledgement: { signer_name: "Farai Ncube", signer_role: "Site Manager", acknowledged_at: "2026-09-06T16:00:00.000Z" }, approved_by: "sup", approved_at: "2026-09-07T08:00:00.000Z" },
      { id: "w3", dispatch_card_id: "d2", technician_id: "t1", work_date: "2026-09-08", hours: 5, status: "Client_Acknowledged", revision_number: 1,
        client_acknowledgement: { signer_name: "Tendai Zhou", signer_role: "Planner", acknowledged_at: "2026-09-08T16:00:00.000Z" } },
      { id: "w4", dispatch_card_id: "d3", technician_id: "t1", work_date: "2026-09-05", hours: 7, status: "Client_Acknowledged", revision_number: 1,
        client_acknowledgement: { signer_name: "Someone At Mimosa", signer_role: "Manager", acknowledged_at: "2026-09-05T10:00:00.000Z" } },
      { id: "w5", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-09", hours: 3, status: "Submitted", revision_number: 1 }
    ],
    timesheets: [
      { id: "k-ok", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-10", hours_logged: 9, hourly_rate: 999, entry_source: "kiosk", review_status: "approved", shift: "day" },
      { id: "k-pending", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-11", hours_logged: 4, entry_source: "kiosk", review_status: "pending_review" },
      { id: "k-legacy", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-12", hours_logged: 4, entry_source: "kiosk" },
      { id: "k-rej", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-13", hours_logged: 4, entry_source: "kiosk", review_status: "rejected" },
      { id: "k-other-client", dispatch_card_id: "d3", technician_id: "t1", work_date: "2026-09-10", hours_logged: 6, entry_source: "kiosk", review_status: "approved" },
      { id: "k-direct", dispatch_card_id: "d1", technician_id: "t1", work_date: "2026-09-10", hours_logged: 2 }
    ],
    company_profile: null,
    audit_logs: []
  };
}
function rq(db, userId, query = {}, params = {}) { return { user: { id: userId }, db, store: {}, query, params, body: {} }; }
const BASE = { client_id: "c_z", from: "2026-09-01", to: "2026-09-30" };
function pack(db, query = {}) { const r = response(); getTimesheetPeriodPack(rq(db, "ops", { ...BASE, ...query }), r); return r; }
function pdf(db, query = {}) { const r = response(); getTimesheetPeriodPackPdf(rq(db, "ops", { ...BASE, ...query }), r); return r; }

test("pack is grouped per technician and per day, for one client only, with plain status labels", () => {
  const r = pack(makeDb());
  assert.equal(r.statusCode, 200);
  const names = r.body.data.technicians.map((t) => t.technician_name);
  assert.deepEqual(names, ["Rudo Chuma", "Tapiwa Moyo"]);
  const ids = r.body.data.technicians.flatMap((t) => Object.values(t.days).flat()).map((e) => e.id).sort();
  assert.deepEqual(ids, ["w1", "w2", "w3"]);          // w4 other client, w5 not yet acknowledged
  const all = r.body.data.technicians.flatMap((t) => Object.values(t.days).flat());
  assert.equal(all.find((e) => e.id === "w1").status_label, "Client acknowledged, awaiting Supervisor approval");
  assert.equal(all.find((e) => e.id === "w2").status_label, "Supervisor approved");
  assert.equal(all.find((e) => e.id === "w1").status, "Client_Acknowledged"); // raw status kept
  assert.equal(r.body.data.kiosk_entry_count, 0);                              // kiosk off by default
});

test("technician, task (dispatch) and site filters narrow the pack; a foreign dispatch is refused", () => {
  const db = makeDb();
  const byTech = pack(db, { technician_id: "t2" }).body.data.technicians;
  assert.deepEqual(byTech.map((t) => t.technician_id), ["t2"]);
  const byDispatch = pack(db, { dispatch_id: "d2" }).body.data.technicians.flatMap((t) => Object.values(t.days).flat());
  assert.deepEqual(byDispatch.map((e) => e.id), ["w3"]);
  const bySite = pack(db, { site: "ms1" }).body.data.technicians.flatMap((t) => Object.values(t.days).flat());
  assert.deepEqual(bySite.map((e) => e.id).sort(), ["w1", "w2"]);
  const byPeriod = pack(db, { from: "2026-09-06", to: "2026-09-30" }).body.data.technicians.flatMap((t) => Object.values(t.days).flat());
  assert.deepEqual(byPeriod.map((e) => e.id).sort(), ["w2", "w3"]);
  const foreign = pack(db, { dispatch_id: "d3" });
  assert.equal(foreign.statusCode, 400);
  assert.equal(pack(db, { dispatch_id: "nope" }).statusCode, 400);
});

test("PDF shows client signature attribution and plain status, never another client's data", () => {
  const r = pdf(makeDb());
  assert.equal(r.contentType, "application/pdf");
  const text = pdfText(r);
  assert.match(text, /%PDF-/);
  for (const needle of ["Client Signed By", "Farai Ncube", "Site Manager", "Tendai Zhou", "Supervisor approved", "Client acknowledged, awaiting Supervisor approval", "Tapiwa Moyo", "Rudo Chuma", "DC-ZIM-1", "DC-ZIM-2"]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
  assert.doesNotMatch(text, /Someone At Mimosa|DC-MIM-3|Client_Acknowledged/);
});

test("PDF header names the technician and task filters", () => {
  const text = pdfText(pdf(makeDb(), { technician_id: "t1", dispatch_id: "d2" }));
  assert.ok(text.includes("Tapiwa Moyo") && text.includes("DC-ZIM-2"));
  assert.ok(!text.includes("Rudo Chuma") && !text.includes("DC-ZIM-1"));
});

test("kiosk time appears only when asked, only if Supervisor-approved, only for this client, in a separate not-client-acknowledged section, with no rate", () => {
  const db = makeDb();
  const off = pack(db); assert.equal(off.body.data.kiosk_technicians.length, 0);
  const on = pack(db, { include_kiosk: "true" });
  const kiosk = on.body.data.kiosk_technicians.flatMap((t) => t.entries);
  assert.deepEqual(kiosk.map((e) => e.id), ["k-ok"]);   // not pending, legacy, rejected, other client or non-kiosk
  assert.equal(kiosk[0].client_acknowledged, false);
  assert.ok(!JSON.stringify(on.body.data).includes("hourly_rate") && !JSON.stringify(on.body.data).includes("999"));
  const text = pdfText(pdf(db, { include_kiosk: "true" }));
  assert.ok(text.includes("Kiosk time, Supervisor approved"));
  assert.ok(text.includes("Supervisor approved (not client-acknowledged)"));
  assert.ok(!text.includes("999"));
  assert.ok(!pdfText(pdf(db)).includes("Kiosk time"));
});

test("legacy kiosk rows without a review status never reach a pack", () => {
  const db = makeDb();
  const ids = pack(db, { include_kiosk: "true" }).body.data.kiosk_technicians.flatMap((t) => t.entries.map((e) => e.id));
  assert.ok(!ids.includes("k-legacy") && !ids.includes("k-pending"));
});

test("worksheet PDF prints the digital client acknowledgement as evidence and keeps the signature boxes", () => {
  const db = makeDb();
  const r = response(); getWorksheetPdf(rq(db, "ops", {}, { id: "w1" }), r);
  assert.equal(r.statusCode, 200);
  const text = pdfText(r);
  for (const needle of ["Client Acknowledgement (recorded digitally)", "Farai Ncube", "Site Manager", "evd-77", "Technician Signature", "Client / Supervisor Signature"]) {
    assert.ok(text.includes(needle), `missing ${needle}`);
  }
  const plain = response(); getWorksheetPdf(rq(db, "ops", {}, { id: "w5" }), plain);
  assert.ok(!pdfText(plain).includes("Client Acknowledgement (recorded digitally)"));
});

test("a Client Viewer cannot download another client's worksheet or the operations pack", () => {
  const db = makeDb();
  const other = response(); getWorksheetPdf(rq(db, "cm", {}, { id: "w2" }), other);
  assert.equal(other.statusCode, 403);
  assert.throws(() => getTimesheetPeriodPackPdf(rq(db, "cz", BASE), response()), { status: 403 });
});
