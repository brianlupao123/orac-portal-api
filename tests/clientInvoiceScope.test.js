import test from "node:test";
import assert from "node:assert/strict";

import { getCollection } from "../src/controllers/coreController.js";

function createResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

test("Client Viewer can read only invoices belonging to their client", () => {
  const clientUser = { id: "user-client", role: "Client Viewer", client_id: "client-a", is_active: true };
  const req = {
    user: { id: clientUser.id },
    db: {
      users: [clientUser],
      quotes: [
        { id: "quote-a", client_id: "client-a" },
        { id: "quote-b", client_id: "client-b" }
      ],
      dispatch_cards: [
        { id: "dispatch-a", quotation_id: "quote-a" },
        { id: "dispatch-b", quotation_id: "quote-b" }
      ],
      invoices: [
        { id: "invoice-a", dispatch_card_id: "dispatch-a" },
        { id: "invoice-b", dispatch_card_id: "dispatch-b" }
      ]
    }
  };
  const res = createResponse();

  getCollection("invoices")(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.data.map((invoice) => invoice.id), ["invoice-a"]);
});
