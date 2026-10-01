// Shared by src/pool.js and operator scripts so TLS policy lives in one place.
export function secureConnectionString(connectionString) {
  if (!connectionString) return connectionString;

  try {
    const url = new URL(connectionString);
    // node-postgres lets SSL options in a connection URL overwrite the SSL
    // object below. Keep TLS policy in one reviewed place instead.
    for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    // Preserve the original value so node-postgres reports malformed URLs.
    return connectionString;
  }
}
