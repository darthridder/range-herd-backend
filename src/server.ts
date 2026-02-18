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
const DATABASE_URL = process.env.DATABASE_URL ?? (process.env as any).DATABASE_URLpostgresql ?? ""; // extra guard
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
 
  // Same health endpoint but under /api so the frontend can hit it consistently in prod
  app.get("/api/health", async () => ({
    ok: true,
    ts: new Date().toISOString(),
    wsClients: wsClients.size,
    uptime: process.uptime(),
    ttnEnabled: TTN_ENABLED,
  }));

  // Helper: resolve a user's primary ranch (owner first, else first membership)
  async function getPrimaryRanchId(userId: string): Promise<string | null> {
    const owned = await prisma.ranch.findFirst({
      where: { ownerId: userId },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    if (owned?.id) return owned.id;

    const member = await prisma.ranchMember.findFirst({
      where: { userId },
      select: { ranchId: true },
      orderBy: { createdAt: "asc" },
    });
    return member?.ranchId ?? null;
  }

  async function requireAuth(
    req: any,
    reply: any
  ): Promise<{ payload: TokenPayload; ranchId: string } | null> {
    const payload = await authenticate(req, reply);
    if (!payload) return null;

    const ranchId = await getPrimaryRanchId(payload.userId);
    if (!ranchId) {
      reply.code(403).send({ error: "No ranch access" });
      return null;
    }
    return { payload, ranchId };
  }

  /* ───────────────────────────────────────────────────────────
     AUTH ROUTES (PUBLIC)
  ─────────────────────────────────────────────────────────── */

  app.post("/api/auth/register", async (req, reply) => {
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

  app.post("/api/auth/login", async (req, reply) => {
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

  app.get("/api/auth/me", async (req, reply) => {
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

  app.get("/api/live", { websocket: true }, (socket, req) => {
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
     DEVICES (AUTH)
  ─────────────────────────────────────────────────────────── */

  app.get("/api/devices", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const devices = await prisma.device.findMany({
      where: { ranchId: ctx.ranchId },
      select: { deviceId: true, devEui: true, name: true, lastSeen: true },
      orderBy: [{ lastSeen: "desc" }, { deviceId: "asc" }],
    });

    return devices.map((d) => ({
      deviceId: d.deviceId,
      devEui: d.devEui ?? null,
      name: d.name ?? null,
      lastSeen: d.lastSeen ? d.lastSeen.toISOString() : "",
    }));
  });

  app.get("/api/devices/:deviceId/latest", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const deviceId = (req.params as any).deviceId as string;

    const device = await prisma.device.findUnique({
      where: { deviceId },
      select: { ranchId: true },
    });
    if (!device || device.ranchId !== ctx.ranchId) {
      return reply.code(404).send({ error: "Device not found" });
    }

    const t = await prisma.telemetry.findFirst({
      where: { deviceId },
      orderBy: { receivedAt: "desc" },
    });

    if (!t) return null;

    return {
      deviceId: t.deviceId,
      receivedAt: t.receivedAt.toISOString(),
      lat: t.lat ?? null,
      lon: t.lon ?? null,
      altM: t.altM ?? null,
      batteryV: t.batteryV ?? null,
      batteryPct: t.batteryPct ?? null,
      tempC: t.tempC ?? null,
      humidityPct: (t as any).humidityPct ?? null,
      pressureHpa: (t as any).pressureHpa ?? null,
      rssi: t.rssi ?? null,
      snr: t.snr ?? null,
      fCnt: t.fCnt ?? null,
    };
  });

  /* ───────────────────────────────────────────────────────────
     GEOFENCES (AUTH)
  ─────────────────────────────────────────────────────────── */

  app.get("/api/geofences", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    return prisma.geofence.findMany({
      where: { ranchId: ctx.ranchId },
      orderBy: { createdAt: "desc" },
    });
  });

  app.delete("/api/geofences/:id", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const id = (req.params as any).id as string;

    const fence = await prisma.geofence.findUnique({ where: { id } });
    if (!fence || fence.ranchId !== ctx.ranchId) {
      return reply.code(404).send({ error: "Geofence not found" });
    }

    await prisma.geofence.delete({ where: { id } });
    return { ok: true };
  });

  /* ───────────────────────────────────────────────────────────
     ALERTS (AUTH)
  ─────────────────────────────────────────────────────────── */

  app.get("/api/alerts", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const unreadOnly = (req.query as any)?.unreadOnly === "true";

    return prisma.alert.findMany({
      where: {
        ranchId: ctx.ranchId,
        ...(unreadOnly ? { isRead: false } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        device: { select: { name: true, deviceId: true } },
        geofence: { select: { name: true } },
      },
      take: 200,
    });
  });

  app.patch("/api/alerts/:id/read", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const id = (req.params as any).id as string;

    const alert = await prisma.alert.findUnique({ where: { id } });
    if (!alert || alert.ranchId !== ctx.ranchId) {
      return reply.code(404).send({ error: "Alert not found" });
    }

    await prisma.alert.update({ where: { id }, data: { isRead: true } });
    return { ok: true };
  });

  app.post("/api/alerts/read-all", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    await prisma.alert.updateMany({
      where: { ranchId: ctx.ranchId, isRead: false },
      data: { isRead: true },
    });
    return { ok: true };
  });

  /* ───────────────────────────────────────────────────────────
     TEAM (AUTH)
  ─────────────────────────────────────────────────────────── */

  app.get("/api/team/members", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const ranch = await prisma.ranch.findUnique({
      where: { id: ctx.ranchId },
      include: {
        owner: { select: { id: true, email: true, name: true, createdAt: true } },
        members: { include: { user: { select: { id: true, email: true, name: true, createdAt: true } } } },
      },
    });
    if (!ranch) return reply.code(404).send({ error: "Ranch not found" });

    const list = [
      {
        id: `owner:${ranch.owner.id}`,
        userId: ranch.owner.id,
        email: ranch.owner.email,
        name: ranch.owner.name ?? null,
        role: "owner",
        createdAt: ranch.owner.createdAt.toISOString(),
      },
      ...ranch.members.map((m) => ({
        id: m.id,
        userId: m.userId,
        email: m.user.email,
        name: m.user.name ?? null,
        role: m.role,
        createdAt: m.createdAt.toISOString(),
      })),
    ];

    const seen = new Set<string>();
    return list.filter((x) => {
      if (seen.has(x.userId)) return false;
      seen.add(x.userId);
      return true;
    });
  });

  app.get("/api/team/invitations", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const invites = await prisma.invitation.findMany({
      where: { ranchId: ctx.ranchId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Mark expired on read (cleanup)
    const expiredIds = invites
      .filter((i) => i.status === "pending" && isInviteExpired(i.expiresAt))
      .map((i) => i.id);

    if (expiredIds.length) {
      await prisma.invitation.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: "expired" },
      });
    }

    return prisma.invitation.findMany({
      where: { ranchId: ctx.ranchId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  app.post("/api/team/invite", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const body = req.body as any;
    const email = (body?.email as string | undefined)?.trim()?.toLowerCase();
    const role = (body?.role as string | undefined) === "owner" ? "owner" : "viewer";
    if (!email) return reply.code(400).send({ error: "Email required" });

    // Only allow the ranch owner to invite
    const ranch = await prisma.ranch.findUnique({ where: { id: ctx.ranchId }, select: { ownerId: true } });
    if (!ranch) return reply.code(404).send({ error: "Ranch not found" });
    if (ranch.ownerId !== ctx.payload.userId) {
      return reply.code(403).send({ error: "Only the ranch owner can invite" });
    }

    const token = generateInviteToken();
    const expiresAt = getInviteExpiration();

    const inv = await prisma.invitation.create({
      data: {
        ranchId: ctx.ranchId,
        invitedBy: ctx.payload.userId,
        email,
        role,
        token,
        expiresAt,
      },
    });

    const frontendUrl = (process.env.FRONTEND_URL ?? "").trim();
    const inviteUrl = frontendUrl ? `${frontendUrl.replace(/\/$/, "")}/?invite=${token}` : token;

    return { ok: true, invitation: inv, inviteUrl };
  });

  app.delete("/api/team/invitations/:id", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const id = (req.params as any).id as string;

    const inv = await prisma.invitation.findUnique({ where: { id } });
    if (!inv || inv.ranchId !== ctx.ranchId) return reply.code(404).send({ error: "Invitation not found" });

    await prisma.invitation.delete({ where: { id } });
    return { ok: true };
  });

  app.delete("/api/team/members/:id", async (req, reply) => {
    const ctx = await requireAuth(req, reply);
    if (!ctx) return;

    const id = (req.params as any).id as string;

    // Only owner can remove
    const ranch = await prisma.ranch.findUnique({ where: { id: ctx.ranchId }, select: { ownerId: true } });
    if (!ranch) return reply.code(404).send({ error: "Ranch not found" });
    if (ranch.ownerId !== ctx.payload.userId) {
      return reply.code(403).send({ error: "Only the ranch owner can remove members" });
    }

    if (id.startsWith("owner:")) {
      return reply.code(400).send({ error: "Cannot remove ranch owner" });
    }

    const member = await prisma.ranchMember.findUnique({ where: { id } });
    if (!member || member.ranchId !== ctx.ranchId) return reply.code(404).send({ error: "Member not found" });

    await prisma.ranchMember.delete({ where: { id } });
    return { ok: true };
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
