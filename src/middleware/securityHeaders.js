// Response headers that are safe for a JSON API and do not depend on the
// deployment topology. Content-Security-Policy is intentionally NOT set here:
// this service serves JSON, and the browser app is a separate static site whose
// policy must name the real API origin (owner input required).
export function securityHeaders({ isProduction = false } = {}) {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (isProduction) {
      // Applies only over HTTPS at the browser. No includeSubDomains: the
      // service is hosted on a shared provider domain.
      res.setHeader("Strict-Transport-Security", "max-age=15552000");
    }
    if (String(req.originalUrl || req.url || "").startsWith("/api")) {
      // API responses carry personal and commercial data; never store them.
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  };
}
