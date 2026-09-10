import express from "express";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./src/store.js";
import apiRouter from "./src/router.js";
import { config, validateRuntimeConfig } from "./src/config.js";

validateRuntimeConfig();

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(__dirname, "public");
export const store = createStore(join(__dirname, "data", "db.json"));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// CORS — allow the deployed frontend to call the API
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes(origin) || !config.isProduction)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Mutex lock middleware for API routes
app.use("/api", async (req, res, next) => {
  const { db, release } = await store.read();
  req.db = db;
  req.store = store;
  req.releaseDb = release;

  // Automatically commit changes to db.json on successful mutations before responding
  const originalJson = res.json;
  res.json = function (body) {
    if (req.method !== "GET" && res.statusCode >= 200 && res.statusCode < 300) {
      store.write(req.db, req.releaseDb);
    }
    return originalJson.call(this, body);
  };

  // Guarantee lock release
  res.on("finish", () => store.release(req.releaseDb));
  res.on("close", () => store.release(req.releaseDb));

  next();
});

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
