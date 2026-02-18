// src/server.ts (Railway-safe: Fastify + WebSocket + Prisma v7 driver adapter)

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { WebSocket } from "ws";

/* =========================
   ENV
========================= */

const PORT = Number(process.env.PORT ?? 8080);
const DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.DATABASE_URLpostgresql ?? "";
const CORS_ORIGIN =
  process.env.CORS_ORIGIN ??
  "http://localhost:5173,https://range-herd-frontend-production.up.railway.app";

/* =========================
   REQUIRED ENV CHECKS
========================= */

if (!DATABASE_URL) {
  console.error("❌ Missing required env var: DATABASE_URL");
  process.exit(1);
}

/* =========================
   PRISMA (FIX FOR YOUR CRASH)
   Prisma v7 + adapter-pg => you MUST pass { adapter }
========================= */

const adapter = new PrismaPg({ connectionString: DATABASE_URL });
const prisma = new PrismaClient({ adapter });

/* =========================
   FASTIFY
========================= */

const app = Fastify({ logger: true });

/* =========================
   CORS
========================= */

const allowedOrigins = CORS_ORIGIN.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: (origin, cb) => {
    // allow curl/postman/no-origin
    if (!origin) return cb(null, true);

    // allow configured origins
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // block everything else
    return cb(new Error(`CORS blocked for origin: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

await app.register(rateLimit, {
  global: true,
  max: 200,
  timeWindow: "1 minute",
});

await app.register(websocket);

/* =========================
   WEBSOCKET LIVE FEED
========================= */

const wsClients = new Set<WebSocket>();

function broadcast(obj: unknown) {
  const msg = JSON.stringify(obj);
  for (const ws of wsClients) {
    try {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
}

function liveWsHandler(socket: any, req: any) {
  const ws = socket as WebSocket;
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
    wsClients.delete(ws);
    app.log.error(err, "WS ERROR");
  });
}

// Canonical + backwards compatible
app.get("/api/live", { websocket: true }, liveWsHandler);
app.get("/live", { websocket: true }, liveWsHandler);

/* =========================
   HEALTH ROUTES (ONLY ONCE)
========================= */

app.get("/api/health", async () => ({
  ok: true,
  ts: new Date().toISOString(),
  wsClients: wsClients.size,
  uptime: process.uptime(),
}));

app.get("/health", async () => ({
  ok: true,
  ts: new Date().toISOString(),
}));

/* =========================
   DB CHECK (OPTIONAL)
========================= */

app.get("/api/db-check", async () => {
  const result = await prisma.$queryRaw`SELECT 1 as status`;
  return result;
});

/* =========================
   START (Railway-safe)
========================= */

async function main() {
  try {
    await prisma.$connect();
    app.log.info("✅ Prisma connected");

    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(`🚀 Server listening on 0.0.0.0:${PORT}`);
  } catch (err) {
    app.log.error(err, "❌ Fatal startup error");
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    try {
      await app.close();
    } catch {}
    try {
      await prisma.$disconnect();
    } catch {}
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main();
