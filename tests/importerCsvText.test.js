import assert from "node:assert/strict";
import test from "node:test";
import { parseCsvText } from "../src/importers/csvText.js";

// Synthetic text only.
const cells = (text) => parseCsvText(text).records.map((r) => r.cells);

test("parser reads plain records with LF and CRLF endings", () => {
  assert.deepEqual(cells("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(cells("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(cells("a,b\n1,2"), [["a", "b"], ["1", "2"]]); // no final newline
});

test("a leading BOM is removed from the first cell", () => {
  assert.deepEqual(cells("\uFEFFname,type\nx,y\n")[0], ["name", "type"]);
});

test("quoted commas and doubled quotes are read as text", () => {
  assert.deepEqual(cells('"Doe, Jo","say ""hi"""\n'), [["Doe, Jo", 'say "hi"']]);
});

test("blank lines are skipped, but a row of empty cells is kept", () => {
  assert.deepEqual(cells("a,b\n\n1,2\n\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(cells("a,b\n,\n"), [["a", "b"], ["", ""]]);
});

test("a line break inside quotes is flagged and later records stay aligned", () => {
  const { records } = parseCsvText('a,b\n"x\ny",2\n3,4\n');
  assert.equal(records.length, 3);
  assert.equal(records[1].quotedBreak, true);
  assert.equal(records[2].quotedBreak, false);
  assert.deepEqual(records[2].cells, ["3", "4"]);
});

test("an unclosed quote is reported", () => {
  assert.equal(parseCsvText('a,b\n"x,2\n').unterminated, true);
  assert.equal(parseCsvText("a,b\n1,2\n").unterminated, false);
});

test("cell contents are never changed: spaces, leading zeros and formula-like text stay as typed", () => {
  assert.deepEqual(cells(" a ,007,=SUM(A1)\n"), [[" a ", "007", "=SUM(A1)"]]);
});

test("a very long cell is read in full", () => {
  const big = "x".repeat(200000);
  assert.equal(cells(`${big},b\n`)[0][0].length, 200000);
});
