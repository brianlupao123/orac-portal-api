import test from "node:test";
import assert from "node:assert/strict";
import {
  toMinutes, isValidIsoDate, computeNormalHours, isValidOvertimeCell,
  validateDailyTimesheetEntries, voidStartIndex
} from "../src/dailyTimesheetValidation.js";

test("toMinutes parses HH:MM and rejects garbage", () => {
  assert.equal(toMinutes("08:00"), 480);
  assert.equal(toMinutes("17:30"), 1050);
  assert.equal(toMinutes("9:05"), 545);
  assert.equal(toMinutes("24:00"), null);
  assert.equal(toMinutes("08:60"), null);
  assert.equal(toMinutes("not-a-time"), null);
  assert.equal(toMinutes(""), null);
});

test("isValidIsoDate accepts real calendar dates only", () => {
  assert.equal(isValidIsoDate("2026-09-20"), true);
  assert.equal(isValidIsoDate("2026-13-01"), false);
  assert.equal(isValidIsoDate("20-09-2026"), false);
  assert.equal(isValidIsoDate(""), false);
});

test("computeNormalHours does NOT deduct a lunch break (matches the paper form)", () => {
  assert.equal(computeNormalHours("08:00", "17:00"), 9);
});

test("computeNormalHours returns null rather than a negative/zero value when end is not after start", () => {
  assert.equal(computeNormalHours("17:00", "08:00"), null);
  assert.equal(computeNormalHours("08:00", "08:00"), null);
  assert.equal(computeNormalHours("bad", "17:00"), null);
});

test("isValidOvertimeCell accepts blank, X/x, and in-range numbers; rejects the rest", () => {
  assert.equal(isValidOvertimeCell(undefined), true);
  assert.equal(isValidOvertimeCell(""), true);
  assert.equal(isValidOvertimeCell("X"), true);
  assert.equal(isValidOvertimeCell("x"), true);
  assert.equal(isValidOvertimeCell(2), true);
  assert.equal(isValidOvertimeCell(-1), false);
  assert.equal(isValidOvertimeCell(25), false);
  assert.equal(isValidOvertimeCell("banana"), false);
});

test("validateDailyTimesheetEntries accepts a clean two-row sheet with a separator row", () => {
  const entries = [
    { date: "2026-04-27", start_time: "08:00", end_time: "17:00", normal_hours: 8, ot_15: "X", ot_20: "X", description: "Housekeeping" },
    { kind: "separator" },
    { date: "2026-04-28", start_time: "08:00", end_time: "17:00", normal_hours: 8, ot_15: "X", ot_20: "X", description: "Washing worksuits" }
  ];
  assert.deepEqual(validateDailyTimesheetEntries(entries), []);
});

test("validateDailyTimesheetEntries requires a date on a non-separator row", () => {
  const errors = validateDailyTimesheetEntries([{ start_time: "08:00", end_time: "17:00" }]);
  assert.ok(errors.some((e) => /date is required/.test(e)));
});

test("validateDailyTimesheetEntries rejects end time not after start time", () => {
  const errors = validateDailyTimesheetEntries([{ date: "2026-04-27", start_time: "17:00", end_time: "08:00" }]);
  assert.ok(errors.some((e) => /end time must be after start time/.test(e)));
});

test("validateDailyTimesheetEntries rejects overlapping rows on the same date", () => {
  const entries = [
    { date: "2026-04-27", start_time: "08:00", end_time: "17:00" },
    { date: "2026-04-27", start_time: "12:00", end_time: "13:00" }
  ];
  const errors = validateDailyTimesheetEntries(entries);
  assert.ok(errors.some((e) => /overlaps/.test(e)));
});

test("validateDailyTimesheetEntries allows the same technician to work the same hours on different dates", () => {
  const entries = [
    { date: "2026-04-27", start_time: "08:00", end_time: "17:00" },
    { date: "2026-04-28", start_time: "08:00", end_time: "17:00" }
  ];
  assert.deepEqual(validateDailyTimesheetEntries(entries), []);
});

test("validateDailyTimesheetEntries flags an invalid overtime cell", () => {
  const errors = validateDailyTimesheetEntries([{ date: "2026-04-27", ot_15: "banana" }]);
  assert.ok(errors.some((e) => /1\.5 column/.test(e)));
});

test("voidStartIndex points to the row right after the last row with data", () => {
  const entries = [
    { date: "2026-04-27", start_time: "08:00", end_time: "17:00" },
    { kind: "separator" },
    { date: "2026-04-28", start_time: "08:00", end_time: "17:00" },
    {}, {}
  ];
  assert.equal(voidStartIndex(entries), 3);
});

test("voidStartIndex returns 0 for a completely empty sheet", () => {
  assert.equal(voidStartIndex([]), 0);
  assert.equal(voidStartIndex([{}, {}]), 0);
});

test("voidStartIndex returns the full length when every row has data", () => {
  const entries = [
    { date: "2026-04-27", start_time: "08:00", end_time: "17:00" },
    { date: "2026-04-28", start_time: "08:00", end_time: "17:00" }
  ];
  assert.equal(voidStartIndex(entries), 2);
});
