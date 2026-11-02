/**
 * src/commands/reconcileCommercialOwnership.js
 * Store-Safe Commercial Ownership Reconciliation Command
 * Uses side-effect-free configuredStore. Binds NO network ports and never imports server.js.
 */

import fs from "node:fs";
import { roles } from "../permissions.js";
// SIDE-EFFECT-FREE IMPORT: Binds NO HTTP ports and does NOT import server.js
import { store } from "../configuredStore.js";

const ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

function parseArgs(argv) {
  const args = { mappingFile: null, actorId: null, reason: null, dryRun: true, unredacted: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--mapping-file=")) args.mappingFile = arg.split("=")[1];
    else if (arg.startsWith("--actor-id=")) args.actorId = arg.split("=")[1];
    else if (arg.startsWith("--reason=")) args.reason = arg.split("=")[1];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--execute") args.dryRun = false;
    else if (arg === "--unredacted") args.unredacted = true;
  }
  return args;
}

function redact(val, unredacted, type = "name") {
  if (unredacted || !val) return val;
  if (type === "name") return val.length > 2 ? `${val[0]}***${val[val.length - 1]}` : "***";
  if (type === "id") return val.length > 6 ? `${val.slice(0, 4)}...${val.slice(-2)}` : "***";
  return "[REDACTED]";
}

export async function runReconciliation(argv = process.argv) {
  const args = parseArgs(argv);

  console.log("==================================================================");
  console.log("ORAC Commercial Ownership Reconciliation Runner");
  console.log(`Driver: ${store.driver.toUpperCase()}`);
  console.log(`Mode:   ${args.dryRun ? "DRY-RUN (Simulated Validation - ZERO writes)" : "EXECUTE (Transactional Write)"}`);
  console.log("==================================================================");

  // 1. Initial Argument Checks
  if (!args.actorId || !ID_REGEX.test(args.actorId)) {
    throw new Error("FATAL: --actor-id is required and must match valid ID format.");
  }
  if (!args.reason || args.reason.trim().length < 10) {
    throw new Error("FATAL: --reason is required and must be at least 10 characters.");
  }
  if (!args.mappingFile || !fs.existsSync(args.mappingFile)) {
    throw new Error(`FATAL: Mapping file not found at ${args.mappingFile}`);
  }

  const mapping = JSON.parse(fs.readFileSync(args.mappingFile, "utf8"));
  const clientMappings = mapping.clients || [];
  const quoteMappings = mapping.quotes || [];

  // 2. Acquire Store Context using verified store.read()
  const { db, release } = await store.read({ lock: !args.dryRun });

  try {
    // 3. Verify Actor in db.users
    const actor = (db.users || []).find((u) => u.id === args.actorId);
    if (!actor || ![roles.ADMIN, roles.MANAGEMENT].includes(actor.role) || actor.is_active === false) {
      throw new Error(`Actor ${args.actorId} is not an active Admin or Management user.`);
    }

    // 4. PHASE 1: STAGE & VALIDATE ALL MAPPINGS BEFORE ANY MUTATION
    // Strict Invariant: On any invalid mapping, commit nothing!
    const stagedClientUpdates = [];
    const stagedQuoteUpdates = [];

    for (const item of clientMappings) {
      if (!item.client_id || !ID_REGEX.test(item.client_id)) {
        throw new Error(`[VALIDATION_FAILED] Malformed client_id: "${item.client_id}".`);
      }
      if (!item.primary_sales_owner_id || !ID_REGEX.test(item.primary_sales_owner_id)) {
        throw new Error(`[VALIDATION_FAILED] Malformed primary_sales_owner_id: "${item.primary_sales_owner_id}".`);
      }

      const client = (db.clients || []).find((c) => c.id === item.client_id);
      if (!client) {
        throw new Error(`[VALIDATION_FAILED] Client ${item.client_id} does not exist in store.`);
      }

      // Never overwrite existing owner
      if (client.primary_sales_owner_id) {
        console.log(`[SKIPPED_EXISTING_OWNER] Client ${redact(client.id, args.unredacted, "id")} already owned by ${redact(client.primary_sales_owner_id, args.unredacted, "id")}.`);
        continue;
      }

      // Validate primary owner is an active Sales user
      const owner = (db.users || []).find((u) => u.id === item.primary_sales_owner_id);
      if (!owner || owner.role !== roles.SALES || owner.is_active === false) {
        throw new Error(`[VALIDATION_FAILED] Owner ${item.primary_sales_owner_id} for client ${item.client_id} is not an active Sales user.`);
      }

      // Deduplicate and validate account team members
      const cleanTeamIds = [...new Set(item.account_team_user_ids || [])];

      // Primary owner must NOT appear in account team
      if (cleanTeamIds.includes(item.primary_sales_owner_id)) {
        throw new Error(`[VALIDATION_FAILED] Primary owner ${item.primary_sales_owner_id} cannot also appear in account_team_user_ids for client ${item.client_id}.`);
      }

      for (const teamUserId of cleanTeamIds) {
        if (!ID_REGEX.test(teamUserId)) {
          throw new Error(`[VALIDATION_FAILED] Malformed account_team_user_id: "${teamUserId}" for client ${item.client_id}.`);
        }
        const teamUser = (db.users || []).find((u) => u.id === teamUserId);
        if (!teamUser || teamUser.role !== roles.SALES || teamUser.is_active === false) {
          throw new Error(`[VALIDATION_FAILED] Team member ${teamUserId} for client ${item.client_id} is not an active Sales user.`);
        }
      }

      stagedClientUpdates.push({ client, newOwnerId: item.primary_sales_owner_id, teamIds: cleanTeamIds });
    }

    for (const item of quoteMappings) {
      if (!item.quotation_id || !ID_REGEX.test(item.quotation_id)) {
        throw new Error(`[VALIDATION_FAILED] Malformed quotation_id: "${item.quotation_id}".`);
      }
      if (!item.sales_owner_id || !ID_REGEX.test(item.sales_owner_id)) {
        throw new Error(`[VALIDATION_FAILED] Malformed sales_owner_id: "${item.sales_owner_id}".`);
      }

      const quote = (db.quotes || []).find((q) => q.id === item.quotation_id);
      if (!quote) {
        throw new Error(`[VALIDATION_FAILED] Quote ${item.quotation_id} does not exist in store.`);
      }

      // Never overwrite existing owner
      if (quote.sales_owner_id) {
        console.log(`[SKIPPED_EXISTING_OWNER] Quote ${redact(quote.id, args.unredacted, "id")} already owned by ${redact(quote.sales_owner_id, args.unredacted, "id")}.`);
        continue;
      }

      // Validate primary owner is an active Sales user
      const owner = (db.users || []).find((u) => u.id === item.sales_owner_id);
      if (!owner || owner.role !== roles.SALES || owner.is_active === false) {
        throw new Error(`[VALIDATION_FAILED] Owner ${item.sales_owner_id} for quote ${item.quotation_id} is not an active Sales user.`);
      }

      // Deduplicate and validate account team members
      const cleanTeamIds = [...new Set(item.account_team_user_ids || [])];

      // Primary owner must NOT appear in account team
      if (cleanTeamIds.includes(item.sales_owner_id)) {
        throw new Error(`[VALIDATION_FAILED] Primary owner ${item.sales_owner_id} cannot also appear in account_team_user_ids for quote ${item.quotation_id}.`);
      }

      for (const teamUserId of cleanTeamIds) {
        if (!ID_REGEX.test(teamUserId)) {
          throw new Error(`[VALIDATION_FAILED] Malformed account_team_user_id: "${teamUserId}" for quote ${item.quotation_id}.`);
        }
        const teamUser = (db.users || []).find((u) => u.id === teamUserId);
        if (!teamUser || teamUser.role !== roles.SALES || teamUser.is_active === false) {
          throw new Error(`[VALIDATION_FAILED] Team member ${teamUserId} for quote ${item.quotation_id} is not an active Sales user.`);
        }
      }

      stagedQuoteUpdates.push({ quote, newOwnerId: item.sales_owner_id, teamIds: cleanTeamIds });
    }

    // 5. PHASE 2: EXECUTE OR RELEASE
    console.log("------------------------------------------------------------------");
    console.log("Staging Validation Passed:");
    console.log(`- Clients to assign: ${stagedClientUpdates.length}`);
    console.log(`- Quotes to assign:  ${stagedQuoteUpdates.length}`);

    if (args.dryRun) {
      console.log("DRY-RUN SUCCESS: All mappings verified. Calling store.release() without writes.");
      await store.release(release);
      return { success: true, dryRun: true, clientsAssigned: stagedClientUpdates.length, quotesAssigned: stagedQuoteUpdates.length };
    }

    // Apply staged updates and record audit entries with prior and final values
    for (const { client, newOwnerId, teamIds } of stagedClientUpdates) {
      const previous = {
        primary_sales_owner_id: client.primary_sales_owner_id || null,
        account_team_user_ids: client.account_team_user_ids || []
      };
      client.primary_sales_owner_id = newOwnerId;
      client.account_team_user_ids = teamIds;
      const current = {
        primary_sales_owner_id: newOwnerId,
        account_team_user_ids: teamIds,
        reason: args.reason
      };
      store.audit(db, actor, "client", client.id, "COMMERCIAL_OWNERSHIP_RECONCILED", previous, current);
      console.log(`[COMMITTED:CLIENT] ${redact(client.id, args.unredacted, "id")} -> Owner: ${redact(newOwnerId, args.unredacted, "id")}`);
    }

    for (const { quote, newOwnerId, teamIds } of stagedQuoteUpdates) {
      const previous = {
        sales_owner_id: quote.sales_owner_id || null,
        account_team_user_ids: quote.account_team_user_ids || []
      };
      quote.sales_owner_id = newOwnerId;
      quote.account_team_user_ids = teamIds;
      const current = {
        sales_owner_id: newOwnerId,
        account_team_user_ids: teamIds,
        reason: args.reason
      };
      store.audit(db, actor, "quote", quote.id, "COMMERCIAL_OWNERSHIP_RECONCILED", previous, current);
      console.log(`[COMMITTED:QUOTE] ${redact(quote.id, args.unredacted, "id")} -> Owner: ${redact(newOwnerId, args.unredacted, "id")}`);
    }

    // Atomic write via store.write()
    await store.write(db, release);
    console.log("SUCCESS: All commercial ownership assignments committed atomically with audit trail.");
    return { success: true, dryRun: false, clientsAssigned: stagedClientUpdates.length, quotesAssigned: stagedQuoteUpdates.length };

  } catch (err) {
    await store.release(release);
    console.error("TRANSACTION ABORTED (Commit Nothing):", err.message);
    throw err;
  }
}

if (process.argv[1] && process.argv[1].endsWith("reconcileCommercialOwnership.js")) {
  runReconciliation().catch(() => process.exit(1));
}
