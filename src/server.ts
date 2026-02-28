// src/server.ts
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import mqtt from "mqtt";

import registerCattle from "./cattle.js";

// ✅ IMPORTANT for ESM on Railway: local imports need .js
import { maybeBootstrapPostgis } from "./postgisBootstrap.js";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  type TokenPayload,
} from "./auth.js";

import { isInsideGeofence } from "./geofencing.js";
import {
  generateInviteToken,
  getInviteExpiration,
  isInviteExpired,
} from "./invitations.js";

/* ============================================================
   ENV
============================================================ */

const PORT = Number(process.env.PORT ?? 8080);

const DATABASE_URL =
  process.env.DATABASE_URL ??
  (process.env as any).DATABASE_URLpostgresql ??
  "";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "";

// PostGIS bootstrap toggle (only needs to run once)
const BOOTSTRAP_POSTGIS = String(process.env.BOOTSTRAP_POSTGIS ?? "false").toLowerCase() === "true";

const TTN_REGION = process.env.TTN_REGION ?? "nam1";
const TTN_APP_ID = process.env.TTN_APP_ID ?? "";
const TTN_TENANT = process.env.TTN_TENANT ?? "ttn";
const TTN_API_KEY = process.env.TTN_API_KEY ?? "";

if (!DATABASE_URL) {
  console.error("❌ Missing required env var: DATABASE_URL");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET not set — tokens will be insecure in production!");
}

const TTN_ENABLED = Boolean(TTN_APP_ID && TTN_API_KEY);
if (!TTN_ENABLED) {
  console.warn(
    "⚠️  TTN_APP_ID / TTN_API_KEY not set — MQTT uplink listener DISABLED (API still runs)"
  );
}

/* ============================================================
   PRISMA (Driver Adapter)
============================================================ */

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/* ============================================================
   MQTT / TTN
============================================================ */

const MQTT_HOST = `${TTN_REGION}.cloud.thethings.network`;
const MQTT_URL = `mqtts://${MQTT_HOST}:8883`;
const MQTT_USERNAME = `${TTN_APP_ID}@${TTN_TENANT}`;
const MQTT_TOPIC = `v3/${TTN_APP_ID}@${TTN_TENANT}/devices/+/up`;

/* ============================================================
   WS CLIENTS
============================================================ */

const wsClients = new Set<any>();

function broadcast(obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try {
      if (ws?.readyState === 1) ws.send(msg); // 1 = OPEN
    } catch {
      wsClients.delete(ws);
    }
  }
}

/* ============================================================
   TYPES / NORMALIZE
============================================================ */

type NormalizedUplink = {
  deviceId: string | undefined;
  devEui: string | undefined;
  receivedAt: Date;

  lat: number | null;
  lon: number | null;
  altM: number | null;

  batteryV: number | null;
  batteryPct: number | null;

  tempC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;

  rssi: number | null;
  snr: number | null;
  fCnt: number | null;

  raw: unknown;
};

function normalizeUplink(u: unknown): NormalizedUplink {
  const raw = u as any;

  const deviceId = raw?.end_device_ids?.device_id as string | undefined;
  const devEui = raw?.end_device_ids?.dev_eui as string | undefined;
  const receivedAt = raw?.received_at ? new Date(raw.received_at) : new Date();

  const dp = raw?.uplink_message?.decoded_payload ?? {};
  const gps = dp?.gps ?? {};
  const md0 = raw?.uplink_message?.rx_metadata?.[0] ?? {};
  const fCnt = raw?.uplink_message?.f_cnt;

  return {
    deviceId,
    devEui,
    receivedAt,

    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,
    altM: gps?.alt_m ?? null,

    batteryV: dp?.battery_v ?? null,
    batteryPct: dp?.battery_pct_est ?? null,

    tempC: dp?.temperature_c ?? null,
    humidityPct: dp?.humidity_pct ?? null,
    pressureHpa: dp?.pressure_hpa ?? null,

    rssi: typeof md0?.rssi === "number" ? md0.rssi : null,
    snr: typeof md0?.snr === "number" ? md0.snr : null,
    fCnt: typeof fCnt === "number" ? fCnt : null,

    raw: u,
  };
}

/* ============================================================
   AUTH HELPERS
============================================================ */

async function authenticate(req: any, reply: any): Promise<TokenPayload | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid authorization header" });
    return null;
  }

  const token = authHeader.substring(7);
  const payload = await verifyToken(token);

  if (!payload) {
    reply.code(401).send({ error: "Invalid or expired token" });
    return null;
  }

  return payload;
}

async function getPrimaryRanchId(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { ownedRanches: true, memberships: true },
  });

  const owned = user?.ownedRanches?.[0]?.id;
  if (owned) return owned;

  const member = user?.memberships?.[0]?.ranchId;
  if (member) return member;

  throw new Error("User has no ranch. (No owned ranch or membership found)");
}

/* ============================================================
   MAIN
============================================================ */

async function main() {
  console.log("Entered main()");
  const app = Fastify({ logger: true });

  // ✅ Only bootstrap PostGIS when explicitly enabled
  if (BOOTSTRAP_POSTGIS) {
    // This is safe to run once; afterward set BOOTSTRAP_POSTGIS=false
    await maybeBootstrapPostgis();
  }

  await app.register(jwt, { secret: JWT_SECRET });

  await app.register(cors, {
    origin: CORS_ORIGIN.split(",").map((o: string) => o.trim()),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  await app.register(rateLimit, { global: true, max: 100, timeWindow: "1 minute" });
  await app.register(websocket);

  console.log("🔥 calling registerCattle(app) now");
  await registerCattle(app, getPrimaryRanchId);
  console.log("🔥 registerCattle(app) finished");

  // Root health
  app.get("/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
    wsClients: wsClients.size,
    uptime: process.uptime(),
    ttnEnabled: TTN_ENABLED,
    bootstrapPostgis: BOOTSTRAP_POSTGIS,
  }));

  // Optional WS legacy endpoint
  app.get("/live", { websocket: true }, (socket, req) => {
    const ws = socket as any;
    app.log.info({ ip: req.ip }, "WS CONNECT (/live)");
    wsClients.add(ws);
    try {
      ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
    } catch {}
    ws.on("close", () => {
      wsClients.delete(ws);
      app.log.info("WS CLOSE (/live)");
    });
    ws.on("error", (err: any) => {
      app.log.error(err, "WS ERROR (/live)");
      wsClients.delete(ws);
    });
  });

  /* ============================================================
     API ROUTES UNDER /api
  ============================================================ */
  app.register(
    async (api) => {
      api.get("/health", async () => ({
        ok: true,
        ts: new Date().toISOString(),
        wsClients: wsClients.size,
        uptime: process.uptime(),
        ttnEnabled: TTN_ENABLED,
      }));

      // Canonical WS endpoint expected by UI: /api/live
      api.get("/live", { websocket: true }, (socket, req) => {
        const ws = socket as any;
        api.log.info({ ip: req.ip }, "WS CONNECT (/api/live)");
        wsClients.add(ws);

        try {
          ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
        } catch {}

        ws.on("close", () => {
          wsClients.delete(ws);
          api.log.info("WS CLOSE (/api/live)");
        });

        ws.on("error", (err: any) => {
          api.log.error(err, "WS ERROR (/api/live)");
          wsClients.delete(ws);
        });
      });

      api.get("/db-check", async () => {
        const result = await prisma.$queryRaw`SELECT 1 as status`;
        return result;
      });

      /* ----------------------------
         ✅ PARCEL LINES (PUBLIC or AUTH — your choice)
         GET /api/parcel-lines?bbox=minLon,minLat,maxLon,maxLat
         Returns GeoJSON FeatureCollection
      ---------------------------- */

      api.get("/parcel-lines", async (req, reply) => {
        // If you want this protected, uncomment these lines:
        // const payload = await authenticate(req, reply);
        // if (!payload) return;

        const bboxStr = String((req.query as any)?.bbox ?? "").trim();
        if (!bboxStr) return reply.code(400).send({ error: "bbox is required" });

        const parts = bboxStr.split(",").map((v) => Number(v));
        if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
          return reply.code(400).send({ error: "bbox must be minLon,minLat,maxLon,maxLat" });
        }

        const [minLon, minLat, maxLon, maxLat] = parts;

        // IMPORTANT: ensure you have an index:
        // CREATE INDEX IF NOT EXISTS parcels_geom_gix ON parcels USING GIST (geom);

        // Return simplified geometry as GeoJSON for speed
        const rows = await prisma.$queryRawUnsafe<any[]>(`
          SELECT
            id,
            parcel_id,
            owner,
            ST_AsGeoJSON(
              ST_SimplifyPreserveTopology(geom::geometry, 0.00003)
            ) AS geom_geojson
          FROM parcels
          WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326)
          LIMIT 4000
        `, minLon, minLat, maxLon, maxLat);

        const features = rows
          .filter((r) => r.geom_geojson)
          .map((r) => ({
            type: "Feature",
            geometry: JSON.parse(r.geom_geojson),
            properties: {
              id: r.id,
              parcel_id: r.parcel_id ?? null,
              owner: r.owner ?? null,
            },
          }));

        return {
          type: "FeatureCollection",
          features,
        };
      });

      /* ----------------------------
         AUTH (PUBLIC)
      ---------------------------- */

      api.post("/auth/register", async (req, reply) => {
        const body = req.body as any;
        const { email, password, name, ranchName } = body;

        if (!email || !password)
          return reply.code(400).send({ error: "Email and password required" });
        if (password.length < 8)
          return reply.code(400).send({ error: "Password must be at least 8 characters" });

        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) return reply.code(409).send({ error: "Email already registered" });

        const passwordHash = hashPassword(password);

        const user = await prisma.user.create({
          data: {
            email,
            passwordHash,
            name: name || null,
            ownedRanches: {
              create: { name: ranchName || `${name || email}'s Ranch` },
            },
          },
          include: { ownedRanches: true },
        });

        // Ensure owner is a member
        const ranchId = user.ownedRanches[0]?.id;
        if (ranchId) {
          await prisma.ranchMember.upsert({
            where: { ranchId_userId: { ranchId, userId: user.id } },
            create: { ranchId, userId: user.id, role: "owner" },
            update: { role: "owner" },
          });
        }

        const token = await signToken({ userId: user.id, email: user.email });

        return {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            ranchId,
            ranchName: user.ownedRanches[0]?.name,
          },
        };
      });

      api.post("/auth/login", async (req, reply) => {
        const body = req.body as any;
        const { email, password } = body;

        if (!email || !password)
          return reply.code(400).send({ error: "Email and password required" });

        const user = await prisma.user.findUnique({
          where: { email },
          include: { ownedRanches: true, memberships: true },
        });

        if (!user || !verifyPassword(password, user.passwordHash)) {
          return reply.code(401).send({ error: "Invalid credentials" });
        }

        const token = await signToken({ userId: user.id, email: user.email });

        const ranchId = user.ownedRanches[0]?.id ?? user.memberships[0]?.ranchId ?? null;
        const ranch = ranchId ? await prisma.ranch.findUnique({ where: { id: ranchId } }) : null;

        return {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            ranchId,
            ranchName: ranch?.name ?? null,
          },
        };
      });

      api.get("/auth/me", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          include: { ownedRanches: true, memberships: true },
        });

        if (!user) return reply.code(404).send({ error: "User not found" });

        const ranchId = user.ownedRanches[0]?.id ?? user.memberships[0]?.ranchId ?? null;
        const ranch = ranchId ? await prisma.ranch.findUnique({ where: { id: ranchId } }) : null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          ranchId,
          ranchName: ranch?.name ?? null,
        };
      });

      /* ----------------------------
         DEVICES (AUTH)
      ---------------------------- */

      api.get("/devices", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        const devices = await prisma.device.findMany({
          where: { ranchId },
          orderBy: [{ name: "asc" }, { deviceId: "asc" }],
          select: {
            deviceId: true,
            devEui: true,
            name: true,
            lastSeen: true,
            ranchId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        return devices;
      });

      api.get("/devices/unclaimed", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const rows = await prisma.device.findMany({
          where: { ranchId: null },
          orderBy: [{ lastSeen: "desc" }, { createdAt: "desc" }],
          select: {
            deviceId: true,
            devEui: true,
            name: true,
            lastSeen: true,
            createdAt: true,
          },
          take: 200,
        });

        return rows;
      });

      api.post("/devices/claim", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        const body = req.body as any;
        const deviceId = String(body?.deviceId ?? "").trim();
        const name = body?.name != null ? String(body.name).trim() : null;

        if (!deviceId) return reply.code(400).send({ error: "deviceId is required" });

        const device = await prisma.device.findUnique({ where: { deviceId } });
        if (!device) return reply.code(404).send({ error: "Device not found" });

        if (device.ranchId && device.ranchId !== ranchId) {
          return reply.code(409).send({ error: "Device already claimed by another ranch" });
        }

        const updated = await prisma.device.update({
          where: { deviceId },
          data: {
            ranchId,
            ...(name ? { name } : {}),
          },
          select: {
            deviceId: true,
            devEui: true,
            name: true,
            lastSeen: true,
            ranchId: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        return { ok: true, device: updated };
      });

      api.get("/devices/:deviceId/latest", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const deviceId = (req.params as any).deviceId as string;

        const device = await prisma.device.findUnique({ where: { deviceId } });
        if (!device || device.ranchId !== ranchId)
          return reply.code(404).send({ error: "Device not found" });

        const latest = await prisma.telemetry.findFirst({
          where: { deviceId },
          orderBy: { receivedAt: "desc" },
        });

        return latest;
      });

      api.get("/live/latest", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        const ranchDevices = await prisma.device.findMany({
          where: { ranchId },
          select: { deviceId: true },
        });

        const deviceIds = ranchDevices.map((d) => d.deviceId);
        if (deviceIds.length === 0) return [];

        const rows = await prisma.telemetry.findMany({
          where: {
            deviceId: { in: deviceIds },
          },
          orderBy: { receivedAt: "desc" },
          take: 200,
        });

        return rows
          .filter((t) => t.lat != null && t.lon != null)
          .map((t) => ({
            deviceId: t.deviceId,
            lat: t.lat!,
            lon: t.lon!,
            altM: t.altM ?? null,
            receivedAt: new Date(t.receivedAt).toISOString(),
            batteryPct: t.batteryPct ?? null,
            batteryV: t.batteryV ?? null,
            rssi: t.rssi ?? null,
            snr: t.snr ?? null,
            temperatureC: t.tempC ?? null,
            fCnt: t.fCnt ?? null,
          }));
      });

      /* ----------------------------
         GEOFENCES + ALERTS + TEAM
         (unchanged from your current file)
      ---------------------------- */

      // NOTE: Keep your existing geofences/alerts/team endpoints here exactly as-is.
      // I’m not re-pasting them to avoid accidentally drifting your working logic.
      // (If you want, paste me your current server.ts again and I’ll output a FULL 1:1 final file.)
    },
    { prefix: "/api" }
  );

  /* ============================================================
     MQTT (OPTIONAL)
  ============================================================ */

  let mqttClient: mqtt.MqttClient | null = null;

  if (TTN_ENABLED) {
    mqttClient = mqtt.connect(MQTT_URL, {
      username: MQTT_USERNAME,
      password: TTN_API_KEY,
      protocolVersion: 4,
      reconnectPeriod: 2000,
      connectTimeout: 30000,
    });

    mqttClient.on("connect", () => {
      app.log.info(`✅ MQTT connected: ${MQTT_HOST}`);
      mqttClient!.subscribe(MQTT_TOPIC, { qos: 0 }, (err) => {
        if (err) app.log.error(err, "MQTT subscribe failed");
        else app.log.info(`📡 MQTT subscribed: ${MQTT_TOPIC}`);
      });
    });

    mqttClient.on("reconnect", () => app.log.warn("MQTT reconnecting..."));
    mqttClient.on("offline", () => app.log.warn("MQTT offline"));
    mqttClient.on("error", (err) => app.log.error(err, "MQTT error"));

    mqttClient.on("message", async (_topic, payload) => {
      try {
        const uplink = JSON.parse(payload.toString("utf8")) as unknown;
        const n = normalizeUplink(uplink);

        if (!n.deviceId) {
          app.log.warn("Uplink missing deviceId — skipped");
          return;
        }

        await prisma.device.upsert({
          where: { deviceId: n.deviceId },
          create: {
            deviceId: n.deviceId,
            devEui: n.devEui,
            lastSeen: n.receivedAt,
            ranchId: null,
          },
          update: {
            devEui: n.devEui ?? undefined,
            lastSeen: n.receivedAt,
          },
        });

        await prisma.telemetry.create({
          data: {
            deviceId: n.deviceId,
            receivedAt: n.receivedAt,
            lat: n.lat,
            lon: n.lon,
            altM: n.altM,
            batteryV: n.batteryV,
            batteryPct: n.batteryPct,
            tempC: n.tempC,
            humidityPct: n.humidityPct,
            pressureHpa: n.pressureHpa,
            rssi: n.rssi,
            snr: n.snr,
            fCnt: n.fCnt,
            raw: n.raw as object,
          },
        });

        broadcast({ type: "uplink", data: n });
        app.log.info({ deviceId: n.deviceId, lat: n.lat, lon: n.lon }, "Uplink saved");
      } catch (err) {
        app.log.error(err, "MQTT uplink handling error");
      }
    });
  }

  /* ============================================================
     START
  ============================================================ */

  console.log("About to listen...");
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`🚀 Server running at http://0.0.0.0:${PORT}`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down gracefully`);
    try {
      mqttClient?.end();
    } catch {}
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});