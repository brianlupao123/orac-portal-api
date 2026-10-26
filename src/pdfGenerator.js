// Controlled-document PDF rendering.
//
// This module is split into three layers, kept deliberately independent so
// each can be unit-tested without touching the others (see
// tests/pdfGenerator.test.js):
//
// 1. Text-safety utilities (decodeEntities, sanitizeForPdfText,
//    humanizeTimestamp, formatCurrency, wrapTextToWidth) - pure string
//    functions with no PDF or layout knowledge.
// 2. layoutControlledDocument(model) - pure layout math. Given a document
//    "model" (header meta + an ordered list of content sections) it
//    produces a plain array of pages, each a list of drawing operations
//    (text / rect / line) in PDF page-coordinate space (origin bottom
//    left, y increasing upward, A4 at 595x842pt). No PDF byte-format
//    knowledge lives here.
// 3. renderPdfFromLayout(layout) - a small, dependency-free PDF-1.4 writer
//    that turns that layout into real PDF bytes (object table, content
//    streams, xref table). No external PDF library is added, per the
//    redesign brief's "do not add dependencies" rule.
//
// generateControlledPdf(model) is the composition of (2) and (3), and is
// what documentController.js calls for every supported document type.
//
// Font handling: only the PDF standard-14 fonts are used (no embedding),
// specifically Helvetica / Helvetica-Bold / Helvetica-Oblique under
// WinAnsiEncoding. That encoding covers ASCII plus the accented Latin-1
// range, but NOT the Unicode arrow/typographic-punctuation block. That is
// why sanitizeForPdfText normalizes those characters to ASCII equivalents
// before any text reaches the PDF writer, and why decodeEntities resolves
// an entity like "&rarr;" (the literal artifact seen in the raw export)
// to the ASCII "->" rather than the Unicode arrow glyph, which the base
// font cannot render.

// ---------------------------------------------------------------------------
// 1. Text-safety utilities
// ---------------------------------------------------------------------------

// Named HTML entities we accept, mapped to WinAnsi/ASCII-safe equivalents.
// Anything not in this table is left untouched (never eaten), because a
// half-decoded entity is worse than a visible "&unknown;" - the caller can
// still see the whole raw token and knows the data needs attention, exactly
// as the visual audit surfaced the un-decoded "&rarr;" in the first place.
const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  // Arrows have no WinAnsi glyph in the base-14 fonts this renderer uses,
  // so they resolve to their ASCII equivalent rather than a Unicode glyph
  // that would render as a missing-character box.
  rarr: "->",
  larr: "<-",
  uarr: "^",
  darr: "v",
  mdash: "--",
  ndash: "-",
  hellip: "...",
  copy: "(c)",
  reg: "(r)",
  trade: "(tm)"
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;

/**
 * Decodes named, decimal (&#233;) and hex (&#xE9;) HTML entities. Unknown
 * named entities are left exactly as written rather than dropped, so a
 * caller can never lose data silently.
 */
export function decodeEntities(value) {
  const str = value === null || value === undefined ? "" : String(value);
  return str.replace(ENTITY_PATTERN, (match, body) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X";
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    const name = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : match;
  });
}

const MARKUP_TAG_PATTERN = /<[^>]*>/g;

/**
 * Prepares any free-text field (client-entered or otherwise) for placement
 * in a PDF content stream:
 *  - decodes entities first, so an already-escaped tag cannot smuggle
 *    markup past the strip step below;
 *  - strips any embedded markup outright, rather than HTML-escaping it
 *    into visible "&lt;"/"&gt;" text - visible escaped-entity junk is the
 *    same defect class as the raw "&rarr;" this rewrite fixes elsewhere;
 *  - normalizes common typographic Unicode punctuation (curly quotes,
 *    en/em dash, ellipsis, no-break space) to ASCII-safe equivalents,
 *    since the base-14 WinAnsi fonts below cannot render most of it;
 *  - collapses whitespace left behind by stripped markup/entities.
 * Always returns a string; never throws on null/undefined input.
 */
export function sanitizeForPdfText(value) {
  if (value === null || value === undefined) return "";
  let str = decodeEntities(String(value));
  str = str.replace(MARKUP_TAG_PATTERN, " ");
  str = str
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ");
  str = str.replace(/\s+/g, " ").trim();
  return str;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

/**
 * Turns a stored date/timestamp into a human-readable form without ever
 * reparsing through a Date object (which can shift the calendar date under
 * a viewer's local timezone). A date-only value ("2026-09-20") is already
 * readable and is returned unchanged. A full ISO timestamp becomes
 * "YYYY-MM-DD, HH:MM UTC" - the calendar date is preserved exactly as
 * stored, and the "UTC" suffix is explicit rather than implied, since this
 * renderer has no per-user timezone to convert into.
 * Returns null (not a string) for a missing value, so callers can render an
 * explicit "Not recorded"-style placeholder instead of an empty string.
 * An unparseable value is shown verbatim rather than hidden, since hiding a
 * bad value would look like the field itself is silently blank.
 */
export function humanizeTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const str = String(value);
  if (DATE_ONLY_PATTERN.test(str)) return str;
  const match = str.match(ISO_TIMESTAMP_PATTERN);
  if (match) {
    const [, datePart, hh, mm] = match;
    return `${datePart}, ${hh}:${mm} UTC`;
  }
  return str;
}

/**
 * Formats a currency amount as "$1,234.56". Any non-finite input
 * (null/undefined/NaN/non-numeric string) safely defaults to "$0.00"
 * rather than printing "$NaN" or a blank cell.
 */
export function formatCurrency(value) {
  const num = Number(value);
  const safe = Number.isFinite(num) ? num : 0;
  return `$${safe.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Approximate per-character advance widths as a fraction of font size.
// This renderer intentionally does not embed real AFM/font-metric tables
// (that would mean shipping font data or a dependency); these are rough,
// documented heuristics good enough to make safe wrapping decisions with
// the base-14 Helvetica family. They err slightly wide, which is the safe
// direction (a slight under-fill is harmless; overflow causing overlap is
// not).
const NARROW_CHARS = new Set("iIl.,'!|;:\"".split(""));
const WIDE_CHARS = new Set("mMWw@%".split(""));

function estimateCharWidth(ch, fontSize) {
  if (ch === " ") return fontSize * 0.27;
  if (NARROW_CHARS.has(ch)) return fontSize * 0.28;
  if (WIDE_CHARS.has(ch)) return fontSize * 0.82;
  if (ch >= "A" && ch <= "Z") return fontSize * 0.68;
  if (ch >= "0" && ch <= "9") return fontSize * 0.56;
  return fontSize * 0.52;
}

function estimateTextWidth(text, fontSize) {
  let width = 0;
  for (const ch of text) width += estimateCharWidth(ch, fontSize);
  return width;
}

/**
 * Word-wraps text to fit within maxWidth (points) at the given fontSize,
 * using the width heuristic above. Never drops a word: a single word wider
 * than maxWidth on its own is still placed on its own line rather than
 * being split mid-word or discarded. Returns [] for empty/null input.
 */
export function wrapTextToWidth(text, maxWidth, fontSize) {
  const str = text === null || text === undefined ? "" : String(text);
  const words = str.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || estimateTextWidth(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ---------------------------------------------------------------------------
// 2. Layout engine
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842; // A4 in points, matching the original renderer's MediaBox.
const MARGIN_X = 50;
const TOP_Y = PAGE_HEIGHT - 46;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const BOTTOM_LIMIT = 78; // Nothing is drawn below this y; footer occupies the reserve beneath it.
const FOOTER_LINE_1_Y = 46;
const FOOTER_LINE_2_Y = 32;
const FOOTER_RULE_Y = 58;

const FONT = { regular: "F1", bold: "F2", italic: "F3" };

const STYLE = {
  brandName: { font: FONT.bold, size: 15, lineHeight: 18 },
  brandLegal: { font: FONT.regular, size: 8, lineHeight: 11 },
  docType: { font: FONT.bold, size: 12, lineHeight: 15 },
  docNumber: { font: FONT.regular, size: 10, lineHeight: 13 },
  statusPill: { font: FONT.bold, size: 8, lineHeight: 11 },
  continuationHeader: { font: FONT.bold, size: 9, lineHeight: 13 },
  sectionHeading: { font: FONT.bold, size: 9.5, lineHeight: 13 },
  kvLabel: { font: FONT.bold, size: 8, lineHeight: 11 },
  kvValue: { font: FONT.regular, size: 9.5, lineHeight: 12.5 },
  tableHeader: { font: FONT.bold, size: 8, lineHeight: 11 },
  tableCell: { font: FONT.regular, size: 8.5, lineHeight: 11.5 },
  tableTotal: { font: FONT.bold, size: 8.5, lineHeight: 11.5 },
  paragraphHeading: { font: FONT.bold, size: 9, lineHeight: 12 },
  paragraphText: { font: FONT.regular, size: 9, lineHeight: 12.5 },
  notice: { font: FONT.bold, size: 10.5, lineHeight: 14 },
  footer: { font: FONT.regular, size: 7.5, lineHeight: 10 },
  signoffLabel: { font: FONT.regular, size: 8, lineHeight: 11 }
};

const COLOR = {
  black: [0, 0, 0],
  slate: [0.33, 0.35, 0.37],
  lightRule: [0.82, 0.83, 0.84],
  headerFill: [0.93, 0.94, 0.95],
  placeholderFill: [0.96, 0.96, 0.96],
  danger: [0.71, 0.09, 0.09],
  dangerFill: [0.98, 0.9, 0.9],
  warning: [0.6, 0.42, 0.02],
  warningFill: [0.99, 0.95, 0.85],
  info: [0.29, 0.33, 0.62],
  infoFill: [0.92, 0.93, 0.98]
};

function hexToRgb(hex, fallback) {
  if (typeof hex !== "string") return fallback;
  const match = hex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) return fallback;
  const int = parseInt(match[1], 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

function newPage() {
  return { ops: [] };
}

function text(page, x, y, str, style, colorOverride) {
  const value = sanitizeForPdfText(str);
  if (!value) return;
  page.ops.push({
    type: "text",
    x,
    y,
    text: value,
    font: style.font,
    size: style.size,
    color: colorOverride || COLOR.black
  });
}

function rect(page, x, y, w, h, color) {
  if (w <= 0 || h <= 0) return;
  page.ops.push({ type: "rect", x, y, w, h, color });
}

function line(page, x1, y1, x2, y2, color, width) {
  page.ops.push({ type: "line", x1, y1, x2, y2, color, width: width || 0.75 });
}

function toneColors(tone) {
  if (tone === "warning") return { ink: COLOR.warning, fill: COLOR.warningFill };
  if (tone === "info") return { ink: COLOR.info, fill: COLOR.infoFill };
  return { ink: COLOR.danger, fill: COLOR.dangerFill };
}

/**
 * Draws the identity block. Returns the y coordinate content may start at
 * beneath it. isFirstPage draws the full identity/meta header; continuation
 * pages get a slim repeated running header instead, so the reader always
 * knows what document they are looking at without repeating the full block.
 */
function drawHeader(page, model, isFirstPage) {
  const brand = hexToRgb(model.company?.brandPrimary, [0.43, 0.76, 0.89]);

  if (!isFirstPage) {
    rect(page, MARGIN_X, TOP_Y - 4, CONTENT_WIDTH, 2, brand);
    const companyName = sanitizeForPdfText(model.company?.name) || "Company";
    const docNumber = sanitizeForPdfText(model.documentNumber);
    const label = `${companyName} - ${model.documentTypeLabel || model.documentType} ${docNumber} (continued)`;
    text(page, MARGIN_X, TOP_Y - 18, label, STYLE.continuationHeader, COLOR.slate);
    return TOP_Y - 34;
  }

  // Fixed, non-overlapping vertical bands (rather than cumulative
  // lineHeight arithmetic) so the identity row, meta row, status pill and
  // brand rule can never collide regardless of which fields are present.
  const ROW1_Y = TOP_Y; // company name (left) / doc type (right)
  const ROW2_Y = TOP_Y - 20; // legal name (left) / doc number (right)
  const PILL_TOP_Y = TOP_Y - 40; // top edge of the status pill
  const PILL_H = 16;
  const RULE_Y = TOP_Y - 64; // brand rule, 2pt tall
  const META_START_Y = TOP_Y - 80; // first meta-row label baseline

  text(page, MARGIN_X, ROW1_Y, sanitizeForPdfText(model.company?.name) || "Company", STYLE.brandName);
  if (model.company?.legalName) {
    text(page, MARGIN_X, ROW2_Y, sanitizeForPdfText(model.company.legalName), STYLE.brandLegal, COLOR.slate);
  }

  const docTypeLabel = (model.documentTypeLabel || model.documentType || "Document").toUpperCase();
  const docTypeWidth = estimateTextWidth(docTypeLabel, STYLE.docType.size);
  text(page, MARGIN_X + CONTENT_WIDTH - docTypeWidth, ROW1_Y, docTypeLabel, STYLE.docType);

  const numberLine = model.documentNumber ? sanitizeForPdfText(model.documentNumber) : "Not yet assigned";
  const numberWidth = estimateTextWidth(numberLine, STYLE.docNumber.size);
  text(
    page,
    MARGIN_X + CONTENT_WIDTH - numberWidth,
    ROW2_Y,
    numberLine,
    STYLE.docNumber,
    model.documentNumber ? COLOR.black : COLOR.slate
  );

  // Status pill, right-aligned, sitting in its own band above the rule.
  if (model.status) {
    const pillText = String(model.status).toUpperCase();
    const pillTextWidth = estimateTextWidth(pillText, STYLE.statusPill.size);
    const pillW = pillTextWidth + 14;
    const pillX = MARGIN_X + CONTENT_WIDTH - pillW;
    rect(page, pillX, PILL_TOP_Y - PILL_H, pillW, PILL_H, COLOR.headerFill);
    text(page, pillX + 7, PILL_TOP_Y - PILL_H + 5, pillText, STYLE.statusPill, COLOR.slate);
  }

  rect(page, MARGIN_X, RULE_Y, CONTENT_WIDTH, 2, brand);

  let metaY = META_START_Y;
  const metaItems = model.headerMeta || [];
  const metaColWidth = CONTENT_WIDTH / 3;
  metaItems.forEach((item, index) => {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = MARGIN_X + col * metaColWidth;
    const y = metaY - row * (STYLE.kvLabel.lineHeight + STYLE.kvValue.lineHeight);
    text(page, x, y, `${item.label}`, STYLE.kvLabel, COLOR.slate);
    const valueStyle = item.placeholder ? { ...STYLE.kvValue, font: FONT.italic } : STYLE.kvValue;
    const valueColor = item.placeholder ? COLOR.slate : COLOR.black;
    const metaValue = item.placeholder ? item.value : sanitizeForPdfText(item.value);
    text(page, x, y - STYLE.kvLabel.lineHeight, metaValue, valueStyle, valueColor);
  });
  const metaRows = Math.ceil(metaItems.length / 3) || 1;
  const consumedByMeta = metaRows * (STYLE.kvLabel.lineHeight + STYLE.kvValue.lineHeight);

  return metaY - consumedByMeta - 12;
}

function drawFooter(page, model, pageNumber, pageCount) {
  rect(page, MARGIN_X, FOOTER_RULE_Y, CONTENT_WIDTH, 1, COLOR.lightRule);
  const left1 = model.controlledNote || "Controlled record - generated by Orac-IOS.";
  text(page, MARGIN_X, FOOTER_LINE_1_Y, left1, STYLE.footer, COLOR.slate);
  const generatedLine = model.generatedAt ? `${model.generatedAtLabel || "Generated"}: ${model.generatedAt}` : "";
  if (generatedLine) text(page, MARGIN_X, FOOTER_LINE_2_Y, generatedLine, STYLE.footer, COLOR.slate);

  const pageLabel = `Page ${pageNumber} of ${pageCount}`;
  const pageLabelWidth = estimateTextWidth(pageLabel, STYLE.footer.size);
  text(page, MARGIN_X + CONTENT_WIDTH - pageLabelWidth, FOOTER_LINE_1_Y, pageLabel, STYLE.footer, COLOR.slate);

  if (model.company?.name) {
    const companyName = sanitizeForPdfText(model.company.name);
    const companyWidth = estimateTextWidth(companyName, STYLE.footer.size);
    text(page, MARGIN_X + CONTENT_WIDTH - companyWidth, FOOTER_LINE_2_Y, companyName, STYLE.footer, COLOR.slate);
  }
}

/**
 * Lays out a full controlled-document model into an array of pages, each a
 * flat list of draw operations in page coordinates. Pure function: same
 * input always produces the same output, and nothing here talks to the
 * filesystem, a clock (besides model.generatedAt, which the caller
 * supplies), or the PDF byte format.
 */
export function layoutControlledDocument(model) {
  const pages = [];
  let page = newPage();
  pages.push(page);
  let cursorY = drawHeader(page, model, true);

  function ensureSpace(neededHeight) {
    if (cursorY - neededHeight < BOTTOM_LIMIT) {
      page = newPage();
      pages.push(page);
      cursorY = drawHeader(page, model, false);
    }
  }

  function drawSectionHeading(heading) {
    if (!heading) return;
    ensureSpace(STYLE.sectionHeading.lineHeight + 4);
    text(page, MARGIN_X, cursorY, heading, STYLE.sectionHeading);
    cursorY -= STYLE.sectionHeading.lineHeight + 4;
  }

  function drawKeyValue(section) {
    drawSectionHeading(section.heading);
    const items = section.items || [];
    const colWidth = CONTENT_WIDTH / 2;
    const valueOffset = 96;
    for (let i = 0; i < items.length; i += 2) {
      const rowItems = [items[i], items[i + 1]].filter(Boolean);
      const wrapped = rowItems.map((item) =>
        wrapTextToWidth(sanitizeForPdfText(item.value), colWidth - valueOffset - 8, STYLE.kvValue.size)
      );
      const rowLines = Math.max(1, ...wrapped.map((w) => w.length || 1));
      const rowHeight = rowLines * STYLE.kvValue.lineHeight + 6;
      ensureSpace(rowHeight);
      rowItems.forEach((item, col) => {
        const x = MARGIN_X + col * colWidth;
        text(page, x, cursorY, `${item.label}`, STYLE.kvLabel, COLOR.slate);
        const lines = wrapped[col].length ? wrapped[col] : ["-"];
        const isPlaceholder = Boolean(item.placeholder) || !wrapped[col].length;
        const valueStyle = isPlaceholder ? { ...STYLE.kvValue, font: FONT.italic } : STYLE.kvValue;
        const valueColor = isPlaceholder ? COLOR.slate : COLOR.black;
        lines.forEach((ln, li) => {
          text(page, x + valueOffset, cursorY - li * STYLE.kvValue.lineHeight, ln, valueStyle, valueColor);
        });
      });
      cursorY -= rowHeight;
    }
    cursorY -= 6;
  }

  function drawParagraph(section) {
    drawSectionHeading(section.heading);
    const raw = section.placeholder ? section.text : sanitizeForPdfText(section.text);
    const lines = wrapTextToWidth(raw, CONTENT_WIDTH, STYLE.paragraphText.size);
    const style = section.placeholder ? { ...STYLE.paragraphText, font: FONT.italic } : STYLE.paragraphText;
    const color = section.placeholder ? COLOR.slate : COLOR.black;
    if (!lines.length) {
      ensureSpace(STYLE.paragraphText.lineHeight);
      text(page, MARGIN_X, cursorY, "Not recorded.", { ...STYLE.paragraphText, font: FONT.italic }, COLOR.slate);
      cursorY -= STYLE.paragraphText.lineHeight + 6;
      return;
    }
    lines.forEach((ln) => {
      ensureSpace(STYLE.paragraphText.lineHeight);
      text(page, MARGIN_X, cursorY, ln, style, color);
      cursorY -= STYLE.paragraphText.lineHeight;
    });
    cursorY -= 6;
  }

  function columnWidths(columns) {
    const totalWeight = columns.reduce((sum, c) => sum + (c.weight || 1), 0);
    let x = MARGIN_X;
    return columns.map((col) => {
      const w = (CONTENT_WIDTH * (col.weight || 1)) / totalWeight;
      const entry = { ...col, x, w };
      x += w;
      return entry;
    });
  }

  function drawTableHeaderRow(cols) {
    // Band spans exactly [cursorY - headerHeight, cursorY] - no bleed above
    // the entry cursorY, so it can never overlap whatever was drawn just
    // above it (a section heading, etc.).
    const headerHeight = STYLE.tableHeader.lineHeight + 8;
    rect(page, MARGIN_X, cursorY - headerHeight, CONTENT_WIDTH, headerHeight, COLOR.headerFill);
    const baseline = cursorY - headerHeight + 5;
    cols.forEach((col) => {
      const label = col.label || "";
      const labelWidth = estimateTextWidth(label, STYLE.tableHeader.size);
      const tx = col.align === "right" ? col.x + col.w - labelWidth - 4 : col.x + 4;
      text(page, tx, baseline, label, STYLE.tableHeader, COLOR.slate);
    });
    cursorY -= headerHeight;
    line(page, MARGIN_X, cursorY, MARGIN_X + CONTENT_WIDTH, cursorY, COLOR.black, 1);
    // Gap sized to clear a text line's ascent (not just an arbitrary small
    // number), so the first data row's glyphs can never cross back up
    // through this rule - this is what the raw export's missing table
    // structure is being replaced with, so it has to hold up under long
    // wrapped descriptions, not just short demo text.
    cursorY -= 10;
  }

  function drawTableRow(cols, cells, style, rule) {
    const wrapped = cols.map((col, i) => {
      const raw = sanitizeForPdfText(cells[i]);
      return wrapTextToWidth(raw, col.w - 8, style.size);
    });
    const rowLines = Math.max(1, ...wrapped.map((w) => w.length || 1));
    const rowHeight = rowLines * style.lineHeight + 6;
    ensureSpace(rowHeight + 2);
    cols.forEach((col, i) => {
      const lines = wrapped[i].length ? wrapped[i] : ["-"];
      lines.forEach((ln, li) => {
        const lnWidth = estimateTextWidth(ln, style.size);
        const tx = col.align === "right" ? col.x + col.w - lnWidth - 4 : col.x + 4;
        text(page, tx, cursorY - li * style.lineHeight, ln, style, COLOR.black);
      });
    });
    cursorY -= rowHeight;
    if (rule) line(page, MARGIN_X, cursorY + 3, MARGIN_X + CONTENT_WIDTH, cursorY + 3, COLOR.lightRule, 0.5);
  }

  function drawTable(section) {
    drawSectionHeading(section.heading);
    const cols = columnWidths(section.columns || []);
    ensureSpace(STYLE.tableHeader.lineHeight + 10);
    drawTableHeaderRow(cols);

    const rows = section.rows || [];
    if (!rows.length) {
      ensureSpace(STYLE.tableCell.lineHeight + 6);
      text(
        page,
        MARGIN_X + 4,
        cursorY - STYLE.tableCell.lineHeight,
        section.emptyMessage || "No records found.",
        { ...STYLE.tableCell, font: FONT.italic },
        COLOR.slate
      );
      cursorY -= STYLE.tableCell.lineHeight + 10;
    } else {
      rows.forEach((cells) => {
        // If a row would land right at a page break, start a new page and
        // repeat the column header so a reader on the continuation page
        // still knows what each cell means, before drawing the row itself.
        const wrapped = cols.map((col, i) => wrapTextToWidth(sanitizeForPdfText(cells[i]), col.w - 8, STYLE.tableCell.size));
        const rowLines = Math.max(1, ...wrapped.map((w) => w.length || 1));
        const willBreak = cursorY - (rowLines * STYLE.tableCell.lineHeight + 8) < BOTTOM_LIMIT;
        if (willBreak) {
          page = newPage();
          pages.push(page);
          cursorY = drawHeader(page, model, false);
          drawTableHeaderRow(cols);
        }
        drawTableRow(cols, cells, STYLE.tableCell, true);
      });
    }

    if (section.totalsRow) {
      ensureSpace(STYLE.tableTotal.lineHeight + 10);
      line(page, MARGIN_X, cursorY + 4, MARGIN_X + CONTENT_WIDTH, cursorY + 4, COLOR.black, 1.25);
      cursorY -= 4;
      drawTableRow(cols, section.totalsRow, STYLE.tableTotal, false);
    }
    cursorY -= 8;
  }

  function drawNotice(section) {
    const { ink, fill } = toneColors(section.tone);
    const noticeText = sanitizeForPdfText(section.text);
    const h = STYLE.notice.lineHeight + 12;
    ensureSpace(h + 6);
    rect(page, MARGIN_X, cursorY - h + 8, CONTENT_WIDTH, h, fill);
    text(page, MARGIN_X + 10, cursorY - h / 2 - 2, noticeText, STYLE.notice, ink);
    cursorY -= h + 10;
  }

  function drawSignoff(section) {
    ensureSpace(60);
    const boxes = section.boxes || [];
    const boxWidth = CONTENT_WIDTH / boxes.length - 20;
    boxes.forEach((box, i) => {
      const x = MARGIN_X + i * (boxWidth + 20);
      line(page, x, cursorY - 30, x + boxWidth, cursorY - 30, COLOR.slate, 0.75);
      text(page, x, cursorY - 42, box.label, STYLE.signoffLabel, COLOR.slate);
    });
    cursorY -= 54;
  }

  for (const section of model.sections || []) {
    if (section.type === "keyvalue") drawKeyValue(section);
    else if (section.type === "table") drawTable(section);
    else if (section.type === "paragraph") drawParagraph(section);
    else if (section.type === "notice") drawNotice(section);
    else if (section.type === "signoff") drawSignoff(section);
  }

  pages.forEach((p, i) => drawFooter(p, model, i + 1, pages.length));

  return { pageCount: pages.length, pages };
}

// ---------------------------------------------------------------------------
// 3. PDF-1.4 writer
// ---------------------------------------------------------------------------

function pdfEscapeText(value) {
  const str = String(value === null || value === undefined ? "" : value);
  let out = "";
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "(") out += "\\(";
    else if (ch === ")") out += "\\)";
    else if (code <= 255) out += ch;
    else out += "?"; // Outside WinAnsi's single-byte range; see module header note.
  }
  return out;
}

function contentStreamFor(page) {
  const cmds = [];
  for (const op of page.ops) {
    if (op.type === "text") {
      const [r, g, b] = op.color || COLOR.black;
      cmds.push("BT");
      // PDF graphics state persists between text objects. Always write the
      // fill colour, including black, so a warning or status colour cannot
      // leak into the next ordinary paragraph.
      cmds.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      cmds.push(`/${op.font} ${op.size} Tf`);
      cmds.push(`1 0 0 1 ${op.x.toFixed(2)} ${op.y.toFixed(2)} Tm`);
      cmds.push(`(${pdfEscapeText(op.text)}) Tj`);
      cmds.push("ET");
    } else if (op.type === "rect") {
      const [r, g, b] = op.color || COLOR.headerFill;
      cmds.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      cmds.push(`${op.x.toFixed(2)} ${op.y.toFixed(2)} ${op.w.toFixed(2)} ${op.h.toFixed(2)} re f`);
    } else if (op.type === "line") {
      const [r, g, b] = op.color || COLOR.black;
      cmds.push(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
      cmds.push(`${op.width || 0.75} w`);
      cmds.push(`${op.x1.toFixed(2)} ${op.y1.toFixed(2)} m`);
      cmds.push(`${op.x2.toFixed(2)} ${op.y2.toFixed(2)} l`);
      cmds.push("S");
    }
  }
  return cmds.join("\n");
}

/**
 * Renders a layout (as produced by layoutControlledDocument) into raw PDF
 * bytes. Handles a zero-page layout without throwing, producing a minimal
 * structurally-valid PDF with an empty page tree.
 */
export function renderPdfFromLayout(layout) {
  const pages = layout?.pages || [];

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const catalogId = addObject("");
  const pagesId = addObject("");
  const fontRegularId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontBoldId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const fontItalicId = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>");

  const resourcesDict = `<< /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontItalicId} 0 R >> >>`;

  const pageIds = pages.map((page) => {
    const stream = contentStreamFor(page);
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
    return addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources ${resourcesDict} /Contents ${contentId} 0 R >>`
    );
  });

  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

/**
 * Composition of layoutControlledDocument + renderPdfFromLayout: the single
 * entry point documentController.js calls for every supported document
 * type once authorization and business preconditions have already passed.
 */
export function generateControlledPdf(model) {
  return renderPdfFromLayout(layoutControlledDocument(model));
}
