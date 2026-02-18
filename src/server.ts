import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const app = Fastify({
  logger: true,
});

const PORT = Number(process.env.PORT) || 8080;

// ===============================
// CORS (Railway frontend support)
// ===============================
app.register(cors, {
  origin: true, // allow Railway frontend domain
  credentials: true,
});

// ===============================
// WebSocket Support
// ===============================
app.register(websocket);

// Track connected clients
const wsClients = new Set<any>();

const liveWsHandler = (socket: any, req: any) => {
  const ws = socket as any;

  app.log.info({ ip: req.ip }, "WS CONNECT");
  wsClients.add(ws);

  try {
    ws.send(
      JSON.stringify({
        type: "hello",
        ts: new Date().toISOString(),
      })
    );
  } catch (e) {
    app.log.error(e, "WS hello send failed");
  }

  ws.on("close", () => {
    wsClients.delete(ws);
    app.log.info("WS CLOSE");
  });

  ws.on("error", (err: any) => {
    app.log.error(err, "WS ERROR");
    wsClients.delete(ws);
  });
};

// Canonical route
app.get("/api/live", { websocket: true }, liveWsHandler);

// Backwards compatibility
app.get("/live", { websocket: true }, liveWsHandler);

// ===============================
// Health Route (ONLY ONCE)
// ===============================
app.get("/api/health", async () => {
  return {
    ok: true,
    ts: new Date().toISOString(),
    wsClients: wsClients.size,
    uptime: process.uptime(),
  };
});

// Optional root health
app.get("/health", async () => {
  return {
    ok: true,
    ts: new Date().toISOString(),
  };
});

// ===============================
// Example DB Test Route
// ===============================
app.get("/api/db-check", async () => {
  const result = await prisma.$queryRaw`SELECT 1 as status`;
  return result;
});

// ===============================
// Start Server (Railway Safe)
// ===============================
const start = async () => {
  try {
    await prisma.$connect();
    app.log.info("Prisma connected");

    await app.listen({
      port: PORT,
      host: "0.0.0.0", // REQUIRED for Railway
    });

    app.log.info(`Server running on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
