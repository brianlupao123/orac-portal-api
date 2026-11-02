import express from "express";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import apiRouter from "./src/router.js";
import { config, validateRuntimeConfig } from "./src/config.js";

validateRuntimeConfig();

import { ensureTableExists } from "./src/pool.js";
import { store } from "./src/configuredStore.js";

import { persistenceMiddleware } from "./src/persistenceMiddleware.js";
import { securityHeaders } from "./src/middleware/securityHeaders.js";
import { createPublicEndpointLimits } from "./src/middleware/rateLimit.js";
import { createCors } from "./src/middleware/cors.js";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(__dirname, "public");

export { store };



if (config.storeDriver === "postgres") {
  await ensureTableExists();
}

const app = express();
app.disable("x-powered-by");

// Trust forwarded headers only when the operator states how many proxy hops sit
// in front of this service (Render / Fly are normally 1). Unset by default: a
// wrong value would let a client spoof req.ip, which the rate limiter keys on.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
if (Number.isInteger(trustProxyHops) && trustProxyHops > 0) app.set("trust proxy", trustProxyHops);

app.use(securityHeaders({ isProduction: config.isProduction }));
app.use(express.json({ limit: "1mb" }));

// Render probes this endpoint without an application session. Keeping it
// outside the API router means a healthy service is not marked unavailable
// merely because its protected routes require a bearer token.
app.get("/healthz", (req, res) => {
  res.status(200).json({ success: true, status: "ok", store_driver: config.storeDriver });
});

// CORS — allow the deployed frontend to call the API
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(createCors({ allowedOrigins: ALLOWED_ORIGINS, isProduction: config.isProduction }));

// Rate limits for the unauthenticated endpoints. This MUST stay ahead of
// persistenceMiddleware: that middleware takes the store lock for every write.
app.use("/api", createPublicEndpointLimits());

// Mutex lock middleware for API routes
app.use("/api", persistenceMiddleware(store));

// API Routes
app.use("/api", apiRouter);

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "API route not found." });
});

// Static files
app.use(express.static(publicDir));

// Fallback for browser routes
app.use((req, res) => {
  res.sendFile(join(publicDir, "index.html"));
});

// Global error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = config.isProduction && status >= 500 ? "Internal server error." : (err.message || "Internal server error.");
  res.status(status).json({ success: false, message });
});

export const server = app.listen(config.port, () => {
  console.log(`Orac-IOS running at http://localhost:${config.port}`);
});
