import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWorkerPayrollReadiness, computeTechnicianPayroll } from "../src/payroll.js";

test("Lane 5 Pre-Month-End Payroll Completeness Parity: evaluateWorkerPayrollReadiness matches computeTechnicianPayroll exactly", () => {
  // Case A: Worker with no employee code
  const workerNoCode = {
    technician_id: "u_tech_1",
    full_name: "Simba Moyo",
    national_id: "63-998877-A",
    employee_code: null
  };
  const readinessA = evaluateWorkerPayrollReadiness(workerNoCode);
  assert.equal(readinessA.export_ready, false);
  assert.deepEqual(readinessA.export_blockers, ["No employee code on file (national ID fallback is disabled)"]);

  // Case B: Worker not linked to technician account
  const workerUnlinked = {
    technician_id: null,
    full_name: "Unknown Artisan",
    employee_code: "EMP-009"
  };
  const readinessB = evaluateWorkerPayrollReadiness(workerUnlinked);
  assert.equal(readinessB.export_ready, false);
  assert.deepEqual(readinessB.export_blockers, ["Not linked to a Technician account"]);

  // Case C: Fully configured technician
  const workerReady = {
    technician_id: "u_tech_2",
    full_name: "Farai Chitepo",
    employee_code: "EMP-042"
  };
  const readinessC = evaluateWorkerPayrollReadiness(workerReady);
  assert.equal(readinessC.export_ready, true);
  assert.deepEqual(readinessC.export_blockers, []);

  // Now prove parity against computeTechnicianPayroll on an approved register
  const db = {
    users: [
      { id: "u_tech_1", name: "Simba Moyo", employee_code: null },
      { id: "u_tech_2", name: "Farai Chitepo", employee_code: "EMP-042" }
    ],
    worksheet_registers: [
      {
        id: "wr_1",
        status: "Approved",
        roster: [
          { key: "r_1", technician_id: "u_tech_1", display_name: "Simba Moyo" },
          { key: "r_2", technician_id: "u_tech_2", display_name: "Farai Chitepo" }
        ],
        lines: [
          {
            date: "2026-11-04",
            roster_key: "r_1",
            normal: 8,
            ot_15: 0,
            ot_20: 0
          },
          {
            date: "2026-11-04",
            roster_key: "r_2",
            normal: 8,
            ot_15: 2,
            ot_20: 0
          }
        ]
      }
    ],
    dispatch_cards: [],
    quotes: []
  };

  const payroll = computeTechnicianPayroll(db, "2026-11");
  const emp1 = payroll.employees.find((e) => e.technician_id === "u_tech_1");
  const emp2 = payroll.employees.find((e) => e.technician_id === "u_tech_2");

  assert.ok(emp1);
  assert.ok(emp2);

  // Parity check
  assert.equal(emp1.export_ready, readinessA.export_ready);
  assert.deepEqual(emp1.export_blockers, readinessA.export_blockers);

  assert.equal(emp2.export_ready, readinessC.export_ready);
  assert.deepEqual(emp2.export_blockers, readinessC.export_blockers);
});

test("Lane 5 Privacy & Invariant Guard: evaluateWorkerPayrollReadiness contains zero PII or wage rates", () => {
  const workerWithSensitiveData = {
    id: "u_tech_99",
    name: "Privileged Worker",
    national_id: "63-000111-Z",
    phone_number: "+263772123456",
    bank_account: "SECRET_BANK_123",
    hourly_rate: 55.00,
    employee_code: "EMP-099"
  };

  const result = evaluateWorkerPayrollReadiness(workerWithSensitiveData);

  assert.equal(result.export_ready, true);
  const resultJson = JSON.stringify(result);
  assert.ok(!resultJson.includes("63-000111-Z"), "National ID must never be exposed");
  assert.ok(!resultJson.includes("+263772123456"), "Phone number must never be exposed");
  assert.ok(!resultJson.includes("SECRET_BANK_123"), "Bank account must never be exposed");
  assert.ok(!resultJson.includes("55"), "Wage rate must never be exposed");
});
