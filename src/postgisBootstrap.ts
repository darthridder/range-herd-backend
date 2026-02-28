import { Client } from "pg";

/**
 * Enables PostGIS extensions if BOOTSTRAP_POSTGIS=true.
 * Safe to leave in codebase; it will do nothing unless enabled.
 */
export async function maybeBootstrapPostgis() {
  if (process.env.BOOTSTRAP_POSTGIS !== "true") return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[postgis] DATABASE_URL is not set; skipping");
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log("[postgis] Enabling extensions...");
    await client.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);
    await client.query(`CREATE EXTENSION IF NOT EXISTS postgis_topology;`);

    const { rows } = await client.query(`SELECT PostGIS_Version() as v;`);
    console.log("[postgis] PostGIS enabled:", rows[0]?.v ?? "(unknown)");

    console.log("[postgis] Done. You can now set BOOTSTRAP_POSTGIS=false.");
  } catch (err: any) {
    console.error("[postgis] Failed to enable PostGIS:", err?.message || err);
    // Don't crash your app; just log. If you want it to hard-fail, uncomment:
    // throw err;
  } finally {
    await client.end();
  }
}