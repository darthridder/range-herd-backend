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
   1) ENVIRONMENT
============================================================ */

const PORT = Number(process.env.PORT ?? 8080);
const TTN_REGION = process.env.TTN_REGION ?? "nam1";
const TTN_APP_ID = process.env.TTN_APP_ID ?? "";
const TTN_TENANT = process.env.TTN_TENANT ?? "ttn";
const TTN_API_KEY = process.env.TTN_API_KEY ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const JWT_SECRET = process.env.JWT_SECRET ?? "";

const missing = [
  !TTN_APP_ID && "TTN_APP_ID",
  !TTN_API_KEY && "TTN_API_KEY",
  !DATABASE_URL && "DATABASE_URL",
].filter(Boolean);

if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
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
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
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
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: CORS_ORIGIN.split(",").map((o) => o.trim()),
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
  }));

  /* ───────────────────────────────────────────────────────────
     AUTH ROUTES (PUBLIC)
  ─────────────────────────────────────────────────────────── */

  app.post("/auth/register", async (req, reply) => {
    const body = req.body as any;
    const { email, password, name, ranchName } = body;

    if (!email || !password) {
      return reply.code(400).send({ error: "Email and password required" });
    }

    if (password.length < 8) {
      return reply.code(400).send({ error: "Password must be at least 8 characters" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "Email already registered" });
    }

    const passwordHash = hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name || null,
        ownedRanches: {
          create: {
            name: ranchName || `${name || email}'s Ranch`,
          },
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

    if (!email || !password) {
      return reply.code(400).send({ error: "Email and password required" });
    }

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

    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      ranchId: user.ownedRanches[0]?.id,
      ranchName: user.ownedRanches[0]?.name,
    };
  });

  /* ───────────────────────────────────────────────────────────
     TEAM & INVITATION ROUTES (PROTECTED)
  ─────────────────────────────────────────────────────────── */

  // Get team members for user's ranch
  app.get("/team/members", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    const members = await prisma.ranchMember.findMany({
      where: { ranchId: user.ownedRanches[0].id },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      createdAt: m.createdAt,
    }));
  });

  // Send invitation
  app.post("/team/invite", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const body = req.body as any;
    const { email, role } = body;

    if (!email || !role) {
      return reply.code(400).send({ error: "Email and role required" });
    }

    if (role !== "viewer" && role !== "owner") {
      return reply.code(400).send({ error: "Role must be 'viewer' or 'owner'" });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    // Check if user is already a member
    const existingMember = await prisma.ranchMember.findFirst({
      where: {
        ranchId: user.ownedRanches[0].id,
        user: { email },
      },
    });

    if (existingMember) {
      return reply.code(409).send({ error: "User is already a team member" });
    }

    // Check for pending invitation
    const existingInvite = await prisma.invitation.findFirst({
      where: {
        ranchId: user.ownedRanches[0].id,
        email,
        status: "pending",
      },
    });

    if (existingInvite) {
      return reply.code(409).send({ error: "Invitation already sent to this email" });
    }

    const token = generateInviteToken();
    const expiresAt = getInviteExpiration();

    const invitation = await prisma.invitation.create({
      data: {
        ranchId: user.ownedRanches[0].id,
        invitedBy: user.id,
        email,
        role,
        token,
        expiresAt,
      },
    });

    // In production, you'd send an email here
    const inviteUrl = `${req.protocol}://${req.hostname}/accept-invite/${token}`;

    return {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
      },
      inviteUrl,
      message: "Invitation created. Share the invite link.",
    };
  });

  // List pending invitations
  app.get("/team/invitations", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    const invitations = await prisma.invitation.findMany({
      where: {
        ranchId: user.ownedRanches[0].id,
        status: "pending",
      },
      include: {
        sender: {
          select: { name: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return invitations.map((inv) => ({
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
      invitedBy: inv.sender.name || inv.sender.email,
      createdAt: inv.createdAt,
    }));
  });

  // Cancel invitation
  app.delete("/team/invitations/:id", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const { id } = req.params as { id: string };

    const invitation = await prisma.invitation.findUnique({
      where: { id },
      include: { ranch: { include: { owner: true } } },
    });

    if (!invitation || invitation.ranch.ownerId !== payload.userId) {
      return reply.code(404).send({ error: "Invitation not found" });
    }

    await prisma.invitation.delete({ where: { id } });

    return { success: true };
  });

  // Accept invitation (PUBLIC)
  app.post("/team/accept/:token", async (req, reply) => {
    const { token } = req.params as { token: string };
    const body = req.body as any;
    const { email, password, name } = body;

    const invitation = await prisma.invitation.findUnique({
      where: { token },
      include: { ranch: true },
    });

    if (!invitation) {
      return reply.code(404).send({ error: "Invalid invitation" });
    }

    if (invitation.status !== "pending") {
      return reply.code(400).send({ error: "Invitation already used" });
    }

    if (isInviteExpired(invitation.expiresAt)) {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "expired" },
      });
      return reply.code(400).send({ error: "Invitation expired" });
    }

    if (invitation.email !== email) {
      return reply.code(400).send({ error: "Email does not match invitation" });
    }

    // Check if user exists
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Create new user
      if (!password || password.length < 8) {
        return reply.code(400).send({ error: "Password must be at least 8 characters" });
      }

      const passwordHash = hashPassword(password);

      user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          name: name || null,
        },
      });
    }

    // Add user to ranch
    await prisma.ranchMember.create({
      data: {
        ranchId: invitation.ranchId,
        userId: user.id,
        role: invitation.role,
      },
    });

    // Mark invitation as accepted
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        status: "accepted",
        acceptedAt: new Date(),
      },
    });

    const jwtToken = await signToken({ userId: user.id, email: user.email });

    return {
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        ranchId: invitation.ranchId,
        ranchName: invitation.ranch.name,
      },
      message: "Successfully joined the ranch",
    };
  });

  // Remove team member
  app.delete("/team/members/:id", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const { id } = req.params as { id: string };

    const member = await prisma.ranchMember.findUnique({
      where: { id },
      include: { ranch: { include: { owner: true } } },
    });

    if (!member || member.ranch.ownerId !== payload.userId) {
      return reply.code(404).send({ error: "Team member not found" });
    }

    // Can't remove the owner
    if (member.userId === member.ranch.ownerId) {
      return reply.code(400).send({ error: "Cannot remove ranch owner" });
    }

    await prisma.ranchMember.delete({ where: { id } });

    return { success: true };
  });

  /* ───────────────────────────────────────────────────────────
     DEVICE ROUTES (PROTECTED)
  ─────────────────────────────────────────────────────────── */

  app.get("/devices", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    return prisma.device.findMany({
      where: { ranchId: user.ownedRanches[0].id },
      orderBy: { lastSeen: "desc" },
    });
  });

  app.get("/devices/:deviceId/latest", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const { deviceId } = req.params as { deviceId: string };

    const device = await prisma.device.findUnique({
      where: { deviceId },
      include: { ranch: { include: { owner: true } } },
    });

    if (!device || device.ranch?.ownerId !== payload.userId) {
      return reply.code(404).send({ error: "Device not found" });
    }

    const result = await prisma.telemetry.findFirst({
      where: { deviceId },
      orderBy: { receivedAt: "desc" },
    });

    if (!result) return reply.code(404).send({ error: "No telemetry found" });
    return result;
  });

  app.get("/devices/:deviceId/history", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const { deviceId } = req.params as { deviceId: string };
    const query = req.query as { limit?: string; since?: string };

    const device = await prisma.device.findUnique({
      where: { deviceId },
      include: { ranch: { include: { owner: true } } },
    });

    if (!device || device.ranch?.ownerId !== payload.userId) {
      return reply.code(404).send({ error: "Device not found" });
    }

    const limit = Math.min(Number(query.limit ?? 100), 1000);
    const since = query.since ? new Date(query.since) : undefined;

    const records = await prisma.telemetry.findMany({
      where: {
        deviceId,
        ...(since && { receivedAt: { gte: since } }),
      },
      orderBy: { receivedAt: "desc" },
      take: limit,
      select: {
        id: true,
        deviceId: true,
        receivedAt: true,
        lat: true,
        lon: true,
        altM: true,
        batteryV: true,
        batteryPct: true,
        tempC: true,
        rssi: true,
        snr: true,
        fCnt: true,
      },
    });

    return records.reverse();
  });

  /* ───────────────────────────────────────────────────────────
     GEOFENCE ROUTES (PROTECTED)
  ─────────────────────────────────────────────────────────── */

  // List all geofences for user's ranch
  app.get("/geofences", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    return prisma.geofence.findMany({
      where: { ranchId: user.ownedRanches[0].id },
      orderBy: { createdAt: "desc" },
    });
  });

  // Create a new geofence
  app.post("/geofences", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const body = req.body as any;
    const { name, type, centerLat, centerLon, radiusM, polygon } = body;

    if (!name || !type) {
      return reply.code(400).send({ error: "Name and type required" });
    }

    if (type === "circle" && (!centerLat || !centerLon || !radiusM)) {
      return reply.code(400).send({ error: "Circle geofence requires centerLat, centerLon, radiusM" });
    }

    if (type === "polygon" && (!polygon || !Array.isArray(polygon))) {
      return reply.code(400).send({ error: "Polygon geofence requires polygon array" });
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    const geofence = await prisma.geofence.create({
      data: {
        ranchId: user.ownedRanches[0].id,
        name,
        type,
        centerLat: type === "circle" ? centerLat : null,
        centerLon: type === "circle" ? centerLon : null,
        radiusM: type === "circle" ? radiusM : null,
        polygon: type === "polygon" ? polygon : null,
      },
    });

    return geofence;
  });

  // Delete a geofence
  app.delete("/geofences/:id", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const { id } = req.params as { id: string };

    const geofence = await prisma.geofence.findUnique({
      where: { id },
      include: { ranch: { include: { owner: true } } },
    });

    if (!geofence || geofence.ranch.ownerId !== payload.userId) {
      return reply.code(404).send({ error: "Geofence not found" });
    }

    await prisma.geofence.delete({ where: { id } });

    return { success: true };
  });

  /* ───────────────────────────────────────────────────────────
     ALERT ROUTES (PROTECTED)
  ─────────────────────────────────────────────────────────── */

  // List all alerts for user's ranch
  app.get("/alerts", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const query = req.query as { unreadOnly?: string };

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    return prisma.alert.findMany({
      where: {
        ranchId: user.ownedRanches[0].id,
        ...(query.unreadOnly === "true" && { isRead: false }),
      },
      include: {
        device: true,
        geofence: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  });

  // Mark alert as read
  app.patch("/alerts/:id/read", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const { id } = req.params as { id: string };

    const alert = await prisma.alert.findUnique({
      where: { id },
      include: { ranch: { include: { owner: true } } },
    });

    if (!alert || alert.ranch.ownerId !== payload.userId) {
      return reply.code(404).send({ error: "Alert not found" });
    }

    const updated = await prisma.alert.update({
      where: { id },
      data: { isRead: true },
    });

    return updated;
  });

  // Mark all alerts as read
  app.post("/alerts/read-all", async (req, reply) => {
    const payload = await authenticate(req, reply);
    if (!payload) return;

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: { ownedRanches: true },
    });

    if (!user || !user.ownedRanches[0]) {
      return reply.code(404).send({ error: "Ranch not found" });
    }

    await prisma.alert.updateMany({
      where: {
        ranchId: user.ownedRanches[0].id,
        isRead: false,
      },
      data: { isRead: true },
    });

    return { success: true };
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
     MQTT
  ─────────────────────────────────────────────────────────── */

  const mqttClient = mqtt.connect(MQTT_URL, {
    username: MQTT_USERNAME,
    password: TTN_API_KEY,
    protocolVersion: 4,
    reconnectPeriod: 2000,
    connectTimeout: 30000,
  });

  mqttClient.on("connect", () => {
    app.log.info(`✅ MQTT connected: ${MQTT_HOST}`);
    mqttClient.subscribe(MQTT_TOPIC, { qos: 0 }, (err) => {
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

      // Save telemetry
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

          const { inside, geofenceId } = checkGeofences(n.lat, n.lon, geofences);

          // Check for recent exit alert to avoid duplicates
          const recentAlert = await prisma.alert.findFirst({
            where: {
              deviceId: n.deviceId,
              type: "geofence_exit",
              createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) }, // Last 10 minutes
            },
          });

          // If outside all geofences and no recent alert, create alert
          if (!inside && !recentAlert && geofences.length > 0) {
            const alert = await prisma.alert.create({
              data: {
                ranchId: device.ranchId,
                deviceId: n.deviceId,
                geofenceId: geofences[0].id, // Use first geofence for now
                type: "geofence_exit",
                severity: "high",
                message: `${n.deviceId} has left the geofenced area`,
                lat: n.lat,
                lon: n.lon,
              },
            });

            // Broadcast alert to all connected clients
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

  /* ───────────────────────────────────────────────────────────
     START
  ─────────────────────────────────────────────────────────── */

  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info(`🚀 Server running at http://localhost:${PORT}`);

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down gracefully`);
    mqttClient.end();
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
