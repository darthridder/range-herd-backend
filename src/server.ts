// src/server.ts  (Railway-safe: Fastify + Prisma(Postgres) + WebSocket + TTN MQTT optional)

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import mqtt from "mqtt";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

import { hashPassword, verifyPassword, signToken, verifyToken, type TokenPayload } from "./auth.js";
import { checkGeofences } from "./geofencing.js";
import { generateInviteToken, getInviteExpiration, isInviteExpired } from "./invitations.js";

/* ============================================================
   1) ENV
============================================================ */

const PORT = Number(process.env.PORT ?? 8080);

const DATABASE_URL =
  process.env.DATABASE_URL ??
  (process.env as any).DATABASE_URLpostgresql ??
  "";

const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "";

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
  console.warn("⚠️  TTN_APP_ID / TTN_API_KEY not set — MQTT uplink listener DISABLED (API still runs)");
}

/* ============================================================
   2) PRISMA (Driver Adapter) — prevents Prisma init errors
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
   4) TTN MQTT
============================================================ */

const MQTT_HOST = `${TTN_REGION}.cloud.thethings.network`;
const MQTT_URL = `mqtts://${MQTT_HOST}:8883`;
const MQTT_USERNAME = `${TTN_APP_ID}@${TTN_TENANT}`;
const MQTT_TOPIC = `v3/${TTN_APP_ID}@${TTN_TENANT}/devices/+/up`;

/* ============================================================
   5) WEBSOCKET CLIENTS + BROADCAST
============================================================ */

const wsClients = new Set<any>();

function broadcast(obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try {
      // ws.OPEN is not reliable across types; 1 = OPEN
      if (ws?.readyState === 1) ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
}

/* ============================================================
   6) NORMALIZE TTN PAYLOAD
   IMPORTANT: requires TTN decoded_payload.gps.lat/lon to exist
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
   7) AUTH HELPERS
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
   8) MAIN SERVER
============================================================ */

async function main() {
  console.log("Entered main()");
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: CORS_ORIGIN.split(",").map((o: string) => o.trim()),
    credentials: true,
  });

  await app.register(rateLimit, { global: true, max: 100, timeWindow: "1 minute" });
  await app.register(websocket);

  // Root health (works without /api)
  app.get("/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
    wsClients: wsClients.size,
    uptime: process.uptime(),
    ttnEnabled: TTN_ENABLED,
  }));

  // WebSocket legacy endpoint (optional)
  app.get("/live", { websocket: true }, (socket, req) => {
    const ws = socket as any;
    app.log.info({ ip: req.ip }, "WS CONNECT (/live)");
    wsClients.add(ws);

    try {
      ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
    } catch (e) {
      app.log.error(e, "WS hello send failed");
    }

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
     ALL API ROUTES UNDER /api
  ============================================================ */
  app.register(
    async (api) => {
      // API health
      api.get("/health", async () => ({
        ok: true,
        ts: new Date().toISOString(),
        wsClients: wsClients.size,
        uptime: process.uptime(),
        ttnEnabled: TTN_ENABLED,
      }));

      // Canonical WS endpoint expected by frontend: /api/live
      api.get("/live", { websocket: true }, (socket, req) => {
        const ws = socket as any;
        api.log.info({ ip: req.ip }, "WS CONNECT (/api/live)");
        wsClients.add(ws);

        try {
          ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() }));
        } catch (e) {
          api.log.error(e, "WS hello send failed");
        }

        ws.on("close", () => {
          wsClients.delete(ws);
          api.log.info("WS CLOSE (/api/live)");
        });

        ws.on("error", (err: any) => {
          api.log.error(err, "WS ERROR (/api/live)");
          wsClients.delete(ws);
        });
      });

      // Quick DB check
      api.get("/db-check", async () => {
        const result = await prisma.$queryRaw`SELECT 1 as status`;
        return result;
      });

      /* ----------------------------
         AUTH (PUBLIC)
      ---------------------------- */

      api.post("/auth/register", async (req, reply) => {
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

        // Ensure owner is also a member (for team views)
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

        if (!email || !password) return reply.code(400).send({ error: "Email and password required" });

        const user = await prisma.user.findUnique({
          where: { email },
          include: { ownedRanches: true, memberships: true },
        });

        if (!user || !verifyPassword(password, user.passwordHash)) {
          return reply.code(401).send({ error: "Invalid credentials" });
        }

        const token = await signToken({ userId: user.id, email: user.email });

        // Prefer owned ranch; else membership ranch
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

      api.get("/devices/:deviceId/latest", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const deviceId = (req.params as any).deviceId as string;

        const device = await prisma.device.findUnique({ where: { deviceId } });
        if (!device || device.ranchId !== ranchId) return reply.code(404).send({ error: "Device not found" });

        const latest = await prisma.telemetry.findFirst({
          where: { deviceId },
          orderBy: { receivedAt: "desc" },
        });

        return latest;
      });

      /* ----------------------------
         GEOFENCES (AUTH)
      ---------------------------- */

      api.get("/geofences", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        return prisma.geofence.findMany({
          where: { ranchId },
          orderBy: { createdAt: "desc" },
        });
      });

      api.post("/geofences", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const body = req.body as any;

        const { name, type, centerLat, centerLon, radiusM, polygon } = body;

        if (!name || !type) return reply.code(400).send({ error: "name and type are required" });
        if (type !== "circle" && type !== "polygon") return reply.code(400).send({ error: "type must be circle|polygon" });

        if (type === "circle") {
          if (centerLat == null || centerLon == null || radiusM == null) {
            return reply.code(400).send({ error: "circle requires centerLat, centerLon, radiusM" });
          }
        }

        if (type === "polygon") {
          if (!polygon) return reply.code(400).send({ error: "polygon requires polygon coordinates" });
        }

        const fence = await prisma.geofence.create({
          data: {
            ranchId,
            name,
            type,
            centerLat: centerLat ?? null,
            centerLon: centerLon ?? null,
            radiusM: radiusM ?? null,
            polygon: polygon ?? null,
          },
        });

        return fence;
      });

      api.delete("/geofences/:id", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const id = (req.params as any).id as string;

        const fence = await prisma.geofence.findUnique({ where: { id } });
        if (!fence || fence.ranchId !== ranchId) return reply.code(404).send({ error: "Geofence not found" });

        await prisma.geofence.delete({ where: { id } });
        return { ok: true };
      });

      /* ----------------------------
         ALERTS (AUTH)
      ---------------------------- */

      api.get("/alerts", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const unreadOnly = (req.query as any)?.unreadOnly === "true";

        const alerts = await prisma.alert.findMany({
          where: { ranchId, ...(unreadOnly ? { isRead: false } : {}) },
          orderBy: { createdAt: "desc" },
          take: 200,
          include: {
            device: { select: { name: true, deviceId: true } },
            geofence: { select: { name: true } },
          },
        });

        return alerts;
      });

      api.patch("/alerts/:id/read", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const id = (req.params as any).id as string;

        const alert = await prisma.alert.findUnique({ where: { id } });
        if (!alert || alert.ranchId !== ranchId) return reply.code(404).send({ error: "Alert not found" });

        await prisma.alert.update({ where: { id }, data: { isRead: true } });
        return { ok: true };
      });

      api.post("/alerts/read-all", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        await prisma.alert.updateMany({
          where: { ranchId, isRead: false },
          data: { isRead: true },
        });

        return { ok: true };
      });

      /* ----------------------------
         TEAM / INVITES (AUTH)
      ---------------------------- */

      api.get("/team/members", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        const members = await prisma.ranchMember.findMany({
          where: { ranchId },
          include: { user: { select: { id: true, email: true, name: true } } },
          orderBy: { createdAt: "asc" },
        });

        return members.map((m) => ({
          id: m.id,
          role: m.role,
          createdAt: m.createdAt,
          user: m.user,
        }));
      });

      api.get("/team/invitations", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);

        return prisma.invitation.findMany({
          where: { ranchId, status: "pending" },
          orderBy: { createdAt: "desc" },
        });
      });

      api.post("/team/invite", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const body = req.body as any;

        const email = String(body?.email ?? "").trim().toLowerCase();
        const role = body?.role === "owner" ? "owner" : "viewer";

        if (!email) return reply.code(400).send({ error: "email is required" });

        const token = generateInviteToken();
        const expiresAt = getInviteExpiration();

        const invite = await prisma.invitation.create({
          data: {
            ranchId,
            invitedBy: payload.userId,
            email,
            role,
            token,
            expiresAt,
            status: "pending",
          },
        });

        return invite;
      });

      api.delete("/team/invitations/:id", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const id = (req.params as any).id as string;

        const invite = await prisma.invitation.findUnique({ where: { id } });
        if (!invite || invite.ranchId !== ranchId) return reply.code(404).send({ error: "Invitation not found" });

        await prisma.invitation.delete({ where: { id } });
        return { ok: true };
      });

      // Accept invite token (public-ish, but we still require auth so invites can attach to a user)
      api.post("/team/accept/:token", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const token = (req.params as any).token as string;

        const invite = await prisma.invitation.findUnique({ where: { token } });
        if (!invite) return reply.code(404).send({ error: "Invite not found" });
        if (invite.status !== "pending") return reply.code(400).send({ error: "Invite is not pending" });
        if (isInviteExpired(invite.expiresAt)) return reply.code(400).send({ error: "Invite expired" });

        await prisma.ranchMember.upsert({
          where: { ranchId_userId: { ranchId: invite.ranchId, userId: payload.userId } },
          create: { ranchId: invite.ranchId, userId: payload.userId, role: invite.role },
          update: { role: invite.role },
        });

        await prisma.invitation.update({
          where: { id: invite.id },
          data: { status: "accepted", acceptedAt: new Date() },
        });

        return { ok: true };
      });

      api.delete("/team/members/:id", async (req, reply) => {
        const payload = await authenticate(req, reply);
        if (!payload) return;

        const ranchId = await getPrimaryRanchId(payload.userId);
        const id = (req.params as any).id as string;

        const member = await prisma.ranchMember.findUnique({ where: { id } });
        if (!member || member.ranchId !== ranchId) return reply.code(404).send({ error: "Member not found" });

        await prisma.ranchMember.delete({ where: { id } });
        return { ok: true };
      });
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

        // Upsert device
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

        // Store telemetry
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

        // Geofence checks only if GPS exists and device is assigned to a ranch
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

        // Broadcast to live UI
        broadcast({ type: "uplink", data: n });
        app.log.info({ deviceId: n.deviceId, lat: n.lat, lon: n.lon }, "Uplink saved");
      } catch (err) {
        app.log.error(err, "MQTT uplink handling error");
      }
    });
  }

  /* ============================================================
     START (Railway: host 0.0.0.0 + process.env.PORT)
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