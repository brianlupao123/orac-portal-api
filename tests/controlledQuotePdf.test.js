import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getQuotePdf } from "../src/controllers/documentController.js";
import { roles } from "../src/permissions.js";

function makeReq(options = {}) {
  return {
    params: options.params || { id: "q1" },
    user: options.user || { id: "u_sales" },
    db: options.db || {}
  };
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(t) {
      this.headers["Content-Type"] = t;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    }
  };
  return res;
}

describe("Controlled Quotation PDF endpoint", () => {
  it("renders a controlled quotation PDF with work packages, UoM, and commercial summary", () => {
    const db = {
      users: [
        { id: "u_sales", role: roles.SALES, is_active: true },
        { id: "u_client", role: roles.CLIENT_VIEWER, client_id: "c1", is_active: true }
      ],
      clients: [{ id: "c1", name: "Anglo American Platinum" }],
      quotes: [{
        id: "q1",
        quote_number: "QT-2026-0042",
        client_id: "c1",
        status: "Draft",
        currency: "USD",
        tax_status: "provisional",
        applied_tax_rate: 0.155,
        discount_percent: 5,
        validity_days: 30,
        scope_summary: "Substation transformer maintenance and oil sampling.",
        assumptions: "Client provides site escort and access permits.",
        pre_tax_total_cents: 100000,
        discount_cents: 5000,
        net_subtotal_cents: 95000,
        tax_total_cents: 14725,
        grand_total_cents: 109725,
        total_amount: 1097.25,
        work_packages: [
          { id: "wp_01", name: "Engineering & Diagnostics" },
          { id: "wp_02", name: "Site Execution" }
        ],
        created_at: "2026-10-15T08:00:00Z"
      }],
      quote_lines: [
        {
          id: "ql_1",
          quotation_id: "q1",
          work_package_id: "wp_01",
          cost_type: "labour",
          resource_role: "Lead Electrical Engineer",
          description: "Transformer insulation diagnostic review",
          quantity: 4,
          unit_of_measure: "hours",
          unit_price_cents: 12500,
          line_total: 450
        },
        {
          id: "ql_2",
          quotation_id: "q1",
          work_package_id: "wp_02",
          cost_type: "material",
          resource_role: "-",
          description: "Dielectric oil test kits",
          quantity: 2,
          unit_of_measure: "set",
          unit_price_cents: 25000,
          line_total_cents: 55000
        }
      ],
      equipment_tags: [],
      plant_sections: [],
      plants: [],
      mine_sites: [],
      company_profile: {
        company_name: "Orac Systems",
        legal_name: "Handon Enterprises (Pvt) Ltd",
        brand_primary: "#1e3a8a"
      }
    };

    const req = makeReq({ db, user: { id: "u_sales" }, params: { id: "q1" } });
    const res = makeRes();

    getQuotePdf(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "application/pdf");
    assert.ok(Buffer.isBuffer(res.body), "PDF output must be a Buffer");
    assert.ok(res.body.length > 500, "PDF buffer must have reasonable size");
    // PDF Magic bytes
    assert.equal(res.body.subarray(0, 5).toString("ascii"), "%PDF-");

    // Convert PDF buffer to ASCII string to inspect text operations
    const pdfText = res.body.toString("binary");
    assert.ok(pdfText.includes("QT-2026-0042"), "Must contain quote number");
    assert.ok(pdfText.includes("Anglo American Platinum"), "Must contain client name");
    assert.ok(pdfText.includes("USD"), "Must indicate USD currency");
    assert.ok(pdfText.includes("Commercial Summary"), "Must include Commercial Summary");
    assert.ok(pdfText.includes("VAT @ 15.5%"), "Fractional VAT rates must not be rounded to whole percentages");
    assert.equal((pdfText.match(/450\.00/g) || []).length, 2, "Work-package subtotal must match the recorded line total");
    assert.ok(pdfText.includes("Commercial Terms"), "Must include Commercial Terms");
    assert.ok(pdfText.includes("Authorised Signatory"), "Must include signature blocks");
  });

  it("denies Client Viewer access to Draft quotation PDF", () => {
    const db = {
      users: [
        { id: "u_client", role: roles.CLIENT_VIEWER, client_id: "c1", is_active: true }
      ],
      clients: [{ id: "c1", name: "Client A" }],
      quotes: [{
        id: "q1",
        quote_number: "QT-0001",
        client_id: "c1",
        status: "Draft",
        created_at: "2026-10-15T08:00:00Z"
      }],
      quote_lines: [],
      equipment_tags: [],
      plant_sections: [],
      plants: [],
      mine_sites: []
    };

    const req = makeReq({ db, user: { id: "u_client" }, params: { id: "q1" } });
    const res = makeRes();

    getQuotePdf(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.match(res.body.message, /not yet available for client viewing/i);
  });

  it("permits Client Viewer access to Sent quotation PDF", () => {
    const db = {
      users: [
        { id: "u_client", role: roles.CLIENT_VIEWER, client_id: "c1", is_active: true }
      ],
      clients: [{ id: "c1", name: "Client A" }],
      quotes: [{
        id: "q1",
        quote_number: "QT-0001",
        client_id: "c1",
        status: "Sent",
        tax_status: "taxable",
        applied_tax_rate: 0.15,
        grand_total_cents: 11500,
        total_amount: 115,
        created_at: "2026-10-15T08:00:00Z"
      }],
      quote_lines: [
        {
          id: "ql_1",
          quotation_id: "q1",
          description: "Approved inspection",
          quantity: 1,
          unit_price_cents: 10000,
          line_total_cents: 10000
        }
      ],
      equipment_tags: [],
      plant_sections: [],
      plants: [],
      mine_sites: []
    };

    const req = makeReq({ db, user: { id: "u_client" }, params: { id: "q1" } });
    const res = makeRes();

    getQuotePdf(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["Content-Type"], "application/pdf");
  });
});
