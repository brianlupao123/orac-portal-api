// Small CSV text parser for the master-data importer. UTF-8 text in, records out.
// Handles a leading BOM, quoted cells with commas and doubled quotes, and CRLF, LF or
// lone CR record endings. A line break inside a quoted cell is not supported in v0: the
// record is still read to the end so later records stay aligned, and it is flagged
// (quotedBreak). Text that follows a closing quote, as in "abc"def, is also flagged
// (malformedQuote) so it can never be merged silently into the cell.
// Blank lines are skipped. Cell contents are never changed.

export function parseCsvText(text) {
  let src = String(text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const records = [];
  let cells = [];
  let cell = "";
  let inQuotes = false;
  let quoteUsed = false; // this cell started with a quote
  let quoteClosed = false; // the quote that opened this cell has been closed
  let quotedBreak = false;
  let malformedQuote = false;
  let line = 1;
  let recordLine = 1;
  let unterminated = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    quoteUsed = false;
    quoteClosed = false;
  };
  const endRecord = () => {
    endCell();
    const blank = cells.length === 1 && cells[0] === "" && !quotedBreak && !malformedQuote;
    if (!blank) records.push({ line: recordLine, cells, quotedBreak, malformedQuote });
    cells = [];
    quotedBreak = false;
    malformedQuote = false;
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else { inQuotes = false; quoteClosed = true; }
      } else if (ch === "\n" || ch === "\r") {
        quotedBreak = true;
        if (ch === "\r" && src[i + 1] === "\n") i += 1;
        cell += "\n";
        line += 1;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "" && !quoteUsed) {
      inQuotes = true;
      quoteUsed = true;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      if (quoteClosed) malformedQuote = true; // text after a closing quote
      cell += ch;
    }
  }
  if (inQuotes) unterminated = true;
  if (cell !== "" || cells.length > 0 || quoteUsed) endRecord();
  return { records, unterminated };
}
