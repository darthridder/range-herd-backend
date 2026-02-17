// src/server.ts  (OPTION A: TTN OPTIONAL - server always boots if DATABASE_URL exists)

import "dotenv/config";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import mqtt from "mqtt";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { WebSocket } from "ws";
import { hashPassword, verifyPassword, signToken, verifyToken, type TokenPayload } from "./auth.js";
import { checkGeofences } from "./geofencing.js";
import { generateInviteToken, getInviteExpiration, isInviteExpired } from "./invitations.js";

/* ============================================================
   1) ENVIRONMENT (Option A: TTN is OPTIONAL)
============================================================ */

const PORT = Number(process.env.PORT ?? 8080);
const TTN_REGION = process.env.TTN_REGION ?? "nam1";
const TTN_APP_ID = process.env.TTN_APP_ID ?? "";
const TTN_TENANT = process.env.TTN_TENANT ?? "ttn";
const TTN_API_KEY = process.env.TTN_API_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? process.env.DATABASE_URLpostgresql ?? ""; // extra guard
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "";

// ✅ Only DATABASE_URL is required to boot the API in production
const missing = [!DATABASE_URL && "DATABASE_URL"].filter(Boolean) as string[];

if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const TTN_ENABLED = Boolean(TTN_APP_ID && TTN_API_KEY);
if (!TTN_ENABLED) {
  console.warn("⚠️  TTN_APP_ID / TTN_API_KEY not set — MQTT uplink listener DISABLED (API still running)");
}

if (!JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET not set — using default (INSECURE for production!)");
}

/* ============================================================
   2) PRISMA
============================================================ */

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/* ============================================================
   3) TYPES
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

/* ============================================================
   4) MQTT SETUP
============================================================ */

const MQTT_HOST = `${TTN_REGION}.cloud.thethings.network`;
const MQTT_URL = `mqtts://${MQTT_HOST}:8883`;
const MQTT_USERNAME = `${TTN_APP_ID}@${TTN_TENANT}`;
const MQTT_TOPIC = `v3/${TTN_APP_ID}@${TTN_TENANT}/devices/+/up`;

/* ============================================================
   5) WEBSOCKET CLIENTS
============================================================ */

const wsClients = new Set<WebSocket>();

function broadcast(obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
}

/* ============================================================
   6) NORMALIZE TTN PAYLOAD
============================================================ */

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
   7) AUTH MIDDLEWARE
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

/* ============================================================
   8) MAIN SERVER
============================================================ */

async function main() {
  console.log("Entered main()");
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: CORS_ORIGIN.split(",").map((o: string) => o.trim()),
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(websocket);

  app.get("/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
    wsClients: wsClients.size,
    uptime: process.uptime(),
    ttnEnabled: TTN_ENABLED,
  }));

  /* ───────────────────────────────────────────────────────────
     AUTH ROUTES (PUBLIC)
  ─────────────────────────────────────────────────────────── */

  app.post("/auth/register", async (req, reply) => {
    const body = req.body as any;
    const { email, password, name, ranchName } = body;

    if (!email || !password) return reply.code(400).send({ error: "Email and password required" });
    if (password.length < 8) return reply.code(400).send({ error: "Password must be at least 8 characters" });

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

    const token = await signToken({ userId: user.id, email: user.email });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        ranchId: user.ownedRanches[0].id,
        ranchName: user.ownedRanches[0].name,
      },
    };
  });

  app.post("/auth/login", async (req, reply) => {
    const body = req.body as any;
    const { email, password } = body;

    if (!email || !password) return reply.code(400).send({ error: "Email and password required" });

    const user = await prisma.user.findUnique({
      where: { email },
      include: { ownedRanches: true },
    });

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return reply.code(401).send({ error: "Invalid credentials" });
    }

    const token = await signToken({ userId: user.id, email: user.email });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        ranchId: user.ownedRanches[0]?.id,
        ranchName: user.ownedRanches[0]?.name,
      },
    };
  });

  app.get("/auth/me", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user) return reply.code(404).send({ error: "User not found" });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      ranchId: user.ownedRanches[0]?.id,
      ranchName: user.ownedRanches[0]?.name,
    };
  });

  /* ───────────────────────────────────────────────────────────
     WEBSOCKET LIVE FEED
  ─────────────────────────────────────────────────────────── */

  app.get("/live", { websocket: true }, (socket, req) => {
    const ws = socket as unknown as WebSocket;
    app.log.info({ ip: req.ip }, "WS CONNECT");

    wsClients.add(ws);

    try {
      ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
    } catch (e) {
      app.log.error(e, "WS hello send failed");
    }

    ws.on("close", () => {
      wsClients.delete(ws);
      app.log.info("WS CLOSE");
    });

    ws.on("error", (err) => {
      app.log.error(err, "WS ERROR");
      wsClients.delete(ws);
    });
  });

  /* ───────────────────────────────────────────────────────────
     MQTT (OPTION A: only start if TTN_ENABLED)
  ─────────────────────────────────────────────────────────── */

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

        // GEOFENCE CHECK — only if device has GPS and is assigned to a ranch
        if (n.lat != null && n.lon != null) {
          const device = await prisma.device.findUnique({
            where: { deviceId: n.deviceId },
            include: { ranch: true },
          });

          if (device?.ranchId) {
            const geofences = await prisma.geofence.findMany({
              where: { ranchId: device.ranchId },
            });

            const { inside } = checkGeofences(n.lat, n.lon, geofences);

            const recentAlert = await prisma.alert.findFirst({
              where: {
                deviceId: n.deviceId,
                type: "geofence_exit",
                createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
              },
            });

            if (!inside && !recentAlert && geofences.length > 0) {
              const alert = await prisma.alert.create({
                data: {
                  ranchId: device.ranchId,
                  deviceId: n.deviceId,
                  geofenceId: geofences[0].id,
                  type: "geofence_exit",
                  severity: "high",
                  message: `${n.deviceId} has left the geofenced area`,
                  lat: n.lat,
                  lon: n.lon,
                },
              });

              broadcast({ type: "alert", data: alert });
              app.log.warn({ deviceId: n.deviceId, lat: n.lat, lon: n.lon }, "GEOFENCE VIOLATION");
            }
          }
        }

        broadcast({ type: "uplink", data: n });
        app.log.info({ deviceId: n.deviceId, lat: n.lat, lon: n.lon }, "Uplink saved");
      } catch (err) {
        app.log.error(err, "MQTT uplink handling error");
      }
    });
  }

  /* ───────────────────────────────────────────────────────────
     START (THIS is the app.listen)
  ─────────────────────────────────────────────────────────── */

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