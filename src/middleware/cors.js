// CORS policy for the API, extracted from server.js unchanged in behaviour so it
// can be tested. Allowed origins are NOT widened: an origin is honoured only if
// it is listed in CORS_ORIGINS, or the server is not running in production.
export const CORS_ALLOWED_HEADERS = "Content-Type,Authorization,Idempotency-Key";
// Browsers hide non-safelisted response headers from scripts unless exposed.
export const CORS_EXPOSED_HEADERS = "Idempotency-Replayed";

export function createCors({ allowedOrigins = [], isProduction = false } = {}) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.includes(origin) || !isProduction)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
      res.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}
