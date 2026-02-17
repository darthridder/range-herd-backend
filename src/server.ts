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
].filter(Boolean) as string[];

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

    return members.map((m: any) => ({
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
    const inviteUrl = `${(req as any).protocol}://${(req as any).hostname}/accept-invite/${token}`;

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

    return invitations.map((inv: any) => ({
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

  /* ... rest of your file continues unchanged ... */
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});