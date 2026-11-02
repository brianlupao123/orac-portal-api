/**
 * src/configuredStore.js
 * Side-effect-free configured store factory and instance.
 * Binds NO network ports and does NOT import server.js or start Express.
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createStore as createJsonStore } from "./store.js";
import { createStore as createPostgresStore } from "./postgresStore.js";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

export function getConfiguredStore() {
  return config.storeDriver === "postgres"
    ? createPostgresStore(join(__dirname, "..", "data", "db.json"))
    : createJsonStore(config.jsonDbPath);
}

export const store = getConfiguredStore();
