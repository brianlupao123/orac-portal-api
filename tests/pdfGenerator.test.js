import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeEntities,
  sanitizeForPdfText,
  humanizeTimestamp,
  formatCurrency,
  wrapTextToWidth,
  layoutControlledDocument,
  renderPdfFromLayout,
  generateControlledPdf
} from "../src/pdfGenerator.js";

// --- decodeEntities -------------------------------------------------------

test("decodeEntities decodes the named entity behind the raw '&rarr;' visual defect", () => {
  assert.equal(decodeEntities("Ngezi &rarr; SMC Concentrator"), "Ngezi -> SMC Concentrator");
});

test("decodeEntities decodes common named, decimal and hex entities", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("caf&#233;"), "caf\u00e9");
  assert.equal(decodeEntities("caf&#xE9;"), "caf\u00e9");
});

test("decodeEntities leaves unknown entities untouched rather than eating data", () => {
  assert.equal(decodeEntities("A&frobnicate;B"), "A&frobnicate;B");
});

// --- sanitizeForPdfText ----------------------------------------------------

test("sanitizeForPdfText strips embedded markup instead of escaping it into visible text", () => {
  assert.equal(sanitizeForPdfText("Site <img src=x onerror=alert(1)>"), "Site");
});

test("sanitizeForPdfText normalizes typographic Unicode to ASCII-safe equivalents", () => {
  assert.equal(sanitizeForPdfText("\u201CQuoted\u201D \u2013 note\u2026"), '"Quoted" - note...');
});

test("sanitizeForPdfText returns an empty string for null/undefined rather than throwing", () => {
  assert.equal(sanitizeForPdfText(null), "");
  assert.equal(sanitizeForPdfText(undefined), "");
});

test("sanitizeForPdfText collapses whitespace left behind by stripped markup", () => {
  assert.equal(sanitizeForPdfText("A <b>bold</b> B"), "A bold B");
});

// --- humanizeTimestamp -------------------------------------------------------

test("humanizeTimestamp passes date-only values through unchanged", () => {
  assert.equal(humanizeTimestamp("2026-09-20"), "2026-09-20");
});

test("humanizeTimestamp reformats a full ISO timestamp, keeping the calendar date exact", () => {
  assert.equal(humanizeTimestamp("2026-08-27T07:53:10.477Z"), "2026-08-27, 07:53 UTC");
});

test("humanizeTimestamp returns null for missing values so callers can show an explicit placeholder", () => {
  assert.equal(humanizeTimestamp(null), null);
  assert.equal(humanizeTimestamp(undefined), null);
  assert.equal(humanizeTimestamp(""), null);
});

test("humanizeTimestamp shows an unparseable value verbatim rather than hiding it", () => {
  assert.equal(humanizeTimestamp("not-a-date"), "not-a-date");
});

// --- formatCurrency ----------------------------------------------------------

test("formatCurrency renders thousands separators and two decimal places", () => {
  assert.equal(formatCurrency(12500), "$12,500.00");
  assert.equal(formatCurrency(0), "$0.00");
});

test("formatCurrency defaults absent/invalid amounts to $0.00 rather than NaN or blank", () => {
  assert.equal(formatCurrency(null), "$0.00");
  assert.equal(formatCurrency(undefined), "$0.00");
  assert.equal(formatCurrency("not-a-number"), "$0.00");
});

// --- wrapTextToWidth ----------------------------------------------------------

test("wrapTextToWidth keeps short text on a single line", () => {
  assert.deepEqual(wrapTextToWidth("Short line", 400, 10), ["Short line"]);
});

test("wrapTextToWidth wraps long text into multiple lines within the width budget", () => {
  const long = "word ".repeat(60).trim();
  const lines = wrapTextToWidth(long, 200, 10);
  assert.ok(lines.length > 1, "expected more than one wrapped line");
  assert.ok(lines.join(" ").split(" ").length === long.split(" ").length, "no words dropped while wrapping");
});

test("wrapTextToWidth returns no lines for empty text", () => {
  assert.deepEqual(wrapTextToWidth("", 200, 10), []);
  assert.deepEqual(wrapTextToWidth(null, 200, 10), []);
});

// --- layoutControlledDocument -------------------------------------------------

function baseModel(overrides = {}) {
  return {
    documentType: "Quotation",
    documentNumber: "Q-0001",
    status: "Draft",
    company: { name: "Orac Systems", legalName: "Handon Enterprises (Pvt) Ltd" },
    sections: [],
    ...overrides
  };
}

test("layoutControlledDocument produces a single page for short content", () => {
  const layout = layoutControlledDocument(baseModel({
    sections: [{ type: "keyvalue", items: [{ label: "Client", value: "Zimplats" }] }]
  }));
  assert.equal(layout.pageCount, 1);
  assert.equal(layout.pages.length, 1);
});

test("controlled table and footer typography stays readable in printed documents", () => {
  const layout = layoutControlledDocument(baseModel({
    sections: [{
      type: "table",
      heading: "Line items",
      columns: [{ label: "Description", weight: 2 }, { label: "Total", weight: 1, align: "right" }],
      rows: [["Fictional inspection activity", "$125.00"]],
      totalsRow: ["Total", "$125.00"]
    }]
  }));
  const operations = layout.pages.flatMap((page) => page.ops);
  const header = operations.find((op) => op.type === "text" && op.text === "Description");
  const cell = operations.find((op) => op.type === "text" && op.text === "Fictional inspection activity");
  const totalSize = Math.max(...operations
    .filter((op) => op.type === "text" && op.text === "Total")
    .map((op) => op.size));
  const footer = operations.find((op) => op.type === "text" && /^Page 1 of 1$/.test(op.text));
  assert.ok(header?.size >= 9, "table headers must be at least 9pt");
  assert.ok(cell?.size >= 9, "table cells must be at least 9pt");
  assert.ok(totalSize >= 10, "totals must remain visually stronger than table cells");
  assert.ok(footer?.size >= 8, "footer text must remain readable when printed");
});

test("layoutControlledDocument shows an explicit empty-state row for a table with no rows, not a silent blank", () => {
  const layout = layoutControlledDocument(baseModel({
    sections: [{
      type: "table",
      heading: "Line Items",
      columns: [{ label: "Description", weight: 1 }],
      rows: [],
      emptyMessage: "No line items recorded for this quotation."
    }]
  }));
  const allText = layout.pages.flatMap((p) => p.ops.filter((o) => o.type === "text").map((o) => o.text));
  assert.ok(allText.includes("No line items recorded for this quotation."));
});

test("layoutControlledDocument paginates long tables across multiple pages without losing rows", () => {
  const rows = Array.from({ length: 80 }, (_, i) => [`Line item number ${i + 1}`, String(i + 1), "$10.00", "$10.00"]);
  const layout = layoutControlledDocument(baseModel({
    sections: [{
      type: "table",
      heading: "Line Items",
      columns: [
        { label: "Description", weight: 3 },
        { label: "Qty", weight: 1, align: "right" },
        { label: "Unit Price", weight: 1, align: "right" },
        { label: "Line Total", weight: 1, align: "right" }
      ],
      rows,
      emptyMessage: "No line items."
    }]
  }));
  assert.ok(layout.pageCount > 1, "expected long content to span more than one page");
  const allText = layout.pages.flatMap((p) => p.ops.filter((o) => o.type === "text").map((o) => o.text));
  assert.ok(allText.includes("Line item number 1"));
  assert.ok(allText.includes("Line item number 80"));
});

test("layoutControlledDocument keeps every text draw operation within the page bounds (no off-page overlap)", () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`Item ${i + 1}`, "1", "$10.00", "$10.00"]);
  const layout = layoutControlledDocument(baseModel({
    sections: [{
      type: "table",
      columns: [
        { label: "Description", weight: 3 },
        { label: "Qty", weight: 1 },
        { label: "Unit Price", weight: 1 },
        { label: "Line Total", weight: 1 }
      ],
      rows
    }]
  }));
  for (const page of layout.pages) {
    for (const op of page.ops) {
      const ys = op.type === "line" ? [op.y1, op.y2] : [op.y];
      for (const y of ys) assert.ok(y >= 0 && y <= 842, `operation y=${y} out of page bounds (${op.type})`);
    }
  }
});

test("layoutControlledDocument renders a placeholder style for missing optional fields, never a blank value", () => {
  const layout = layoutControlledDocument(baseModel({
    sections: [{ type: "keyvalue", items: [{ label: "Supervisor", value: "Pending", placeholder: true }] }]
  }));
  const placeholderOps = layout.pages[0].ops.filter((o) => o.type === "text" && o.text === "Pending");
  assert.equal(placeholderOps.length, 1);
  assert.equal(placeholderOps[0].font, "F3");
});

test("layoutControlledDocument writes 'Page X of Y' using the true final page count", () => {
  const rows = Array.from({ length: 80 }, (_, i) => [`Item ${i + 1}`, "1", "$10.00", "$10.00"]);
  const layout = layoutControlledDocument(baseModel({
    sections: [{
      type: "table",
      columns: [{ label: "Description", weight: 3 }, { label: "Qty", weight: 1 }, { label: "Unit Price", weight: 1 }, { label: "Line Total", weight: 1 }],
      rows
    }]
  }));
  const n = layout.pageCount;
  layout.pages.forEach((page, i) => {
    const found = page.ops.some((o) => o.type === "text" && o.text === `Page ${i + 1} of ${n}`);
    assert.ok(found, `page ${i + 1} missing correct footer page marker`);
  });
});

// --- renderPdfFromLayout / generateControlledPdf ------------------------------

test("generateControlledPdf returns a real, well-formed PDF buffer", () => {
  const buf = generateControlledPdf(baseModel({
    sections: [{ type: "keyvalue", items: [{ label: "Client", value: "Zimplats" }] }]
  }));
  assert.ok(Buffer.isBuffer(buf));
  const text = buf.toString("latin1");
  assert.equal(text.slice(0, 5), "%PDF-");
  assert.ok(text.trim().endsWith("%%EOF"));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages/);
});

test("renderPdfFromLayout emits one PDF page object per layout page", () => {
  const layout = layoutControlledDocument(baseModel());
  const buf = renderPdfFromLayout(layout);
  const text = buf.toString("latin1");
  const pageObjectCount = (text.match(/\/Type \/Page[^s]/g) || []).length;
  assert.equal(pageObjectCount, layout.pages.length);
});

test("renderPdfFromLayout never breaks on an empty pages array", () => {
  const buf = renderPdfFromLayout({ pages: [] });
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString("latin1").slice(0, 5), "%PDF-");
});

test("renderPdfFromLayout resets text colour after a warning and normalizes signoff punctuation", () => {
  const buf = generateControlledPdf(baseModel({
    sections: [
      { type: "notice", tone: "warning", text: "Provisional - accountant confirmation required" },
      { type: "paragraph", heading: "Commercial Terms", text: "Standard terms apply." },
      { type: "signoff", boxes: [{ label: "Orac Systems — Authorised Signatory" }] }
    ]
  }));
  const text = buf.toString("latin1");
  assert.match(text, /0\.600 0\.420 0\.020 rg/, "warning text must use its warning colour");
  assert.match(text, /0\.000 0\.000 0\.000 rg[\s\S]*\(Standard terms apply\.\) Tj/, "ordinary text must reset to black after a warning");
  assert.match(text, /Orac Systems - Authorised Signatory/, "signoff punctuation must be PDF-safe ASCII");
  assert.ok(!text.includes("Orac Systems ? Authorised Signatory"), "unsupported punctuation must not become question marks");
});
