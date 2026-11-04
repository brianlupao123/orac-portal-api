import test from "node:test";
import assert from "node:assert/strict";
import { TECHNICIAN_TRADES, isTechnicianTrade } from "../src/trades.js";

test("technician trade classifications are explicit and accepted", () => {
  assert.deepEqual(TECHNICIAN_TRADES, [
    "Fitter", "Fitter Assistant", "Boilermaker", "Boilermaker Assistant",
    "Instrument Technician", "Instrument Assistant", "Scaffolder Assistant",
    "Rigger Assistant", "General Hand", "Plumber", "Plumber Assistant",
    "Welder Assistant", "Electrician", "Welder", "Rigger"
  ]);
  assert.equal(isTechnicianTrade("Fitter"), true);
  assert.equal(isTechnicianTrade(null), true);
});

test("unknown trade classifications are rejected instead of becoming free-text account data", () => {
  assert.equal(isTechnicianTrade("Unverified Trade"), false);
});
