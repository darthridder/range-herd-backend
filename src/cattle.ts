/* src/cattle.ts
   CATTLE_TS_FINGERPRINT_2026-02-27_B

   Key fixes:
   - DO NOT use app.jwt.verify (often undefined due to plugin encapsulation/order)
   - Use request.jwtVerify() (correct fastify-jwt usage)
   - Provide ranch scope resolution:
       1) x-ranch-id header
       2) ranchId query param
       3) getPrimaryRanchId(userId) fallback (passed in from server.ts)
*/

import type { FastifyInstance, FastifyRequest } from "fastify";

type JwtPayload = {
  userId?: string;
  email?: string;
  iat?: number;
  exp?: number;
  [k: string]: any;
};

type GetPrimaryRanchId = (userId: string) => Promise<string | null>;

function getHeader(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase() as keyof typeof req.headers];
  if (!v) return undefined;
  if (Array.isArray(v)) return v[0];
  return String(v);
}

async function requireAuth(req: FastifyRequest) {
  // request.jwtVerify exists only if @fastify/jwt is registered in THIS scope.
  const jwtVerify = (req as any).jwtVerify as undefined | (() => Promise<void>);
  if (!jwtVerify) {
    // This is the exact problem you're seeing.
    throw Object.assign(new Error("JWT_NOT_AVAILABLE"), {
      statusCode: 500,
      message:
        "JWT verify not available (request.jwtVerify missing). Ensure @fastify/jwt is registered BEFORE registerCattle(app) and not encapsulated away.",
    });
  }

  await jwtVerify();

  // fastify-jwt sets req.user by default
  const user = (req as any).user as JwtPayload | undefined;
  const userId = user?.userId;

  if (!userId) {
    throw Object.assign(new Error("UNAUTHORIZED"), {
      statusCode: 401,
      message: "Unauthorized (missing userId in token payload).",
    });
  }

  return { userId, user };
}

async function resolveRanchId(
  req: FastifyRequest,
  userId: string,
  getPrimaryRanchId?: GetPrimaryRanchId
): Promise<string> {
  // 1) header
  const headerRanch = getHeader(req, "x-ranch-id");
  if (headerRanch) return headerRanch;

  // 2) query param
  const q: any = (req as any).query || {};
  if (q.ranchId) return String(q.ranchId);

  // 3) fallback to DB (passed in from server.ts)
  if (getPrimaryRanchId) {
    const primary = await getPrimaryRanchId(userId);
    if (primary) return primary;
  }

  throw Object.assign(new Error("MISSING_RANCH_SCOPE"), {
    statusCode: 401,
    message: "Missing ranch scope (no x-ranch-id, no ?ranchId, and no primary ranch).",
  });
}

export default async function registerCattle(
  app: FastifyInstance,
  getPrimaryRanchId?: GetPrimaryRanchId
) {
  console.log("🧪 CATTLE_TS_FINGERPRINT_2026-02-27_B");

  // GET /api/cattle
  // Return “cattle” for a ranch (you can map this to tags/devices as you evolve the schema)
  app.get("/api/cattle", async (req, reply) => {
    try {
      const { userId } = await requireAuth(req);
      const ranchId = await resolveRanchId(req, userId, getPrimaryRanchId);

      // IMPORTANT:
      // I’m assuming you have Prisma on app.prisma (common pattern in your project).
      // If your prisma is stored elsewhere, adjust here.
      const prisma = (app as any).prisma;
      if (!prisma) {
        return reply.code(500).send({
          error:
            "Prisma not available on app (app.prisma missing). Ensure you decorate app.prisma before registering routes.",
        });
      }

      // ---- OPTION A: if you have a Cattle table/model ----
      // const cattle = await prisma.cattle.findMany({
      //   where: { ranchId },
      //   orderBy: { createdAt: "desc" },
      // });
      // return reply.send(cattle);

      // ---- OPTION B: if “cattle” is basically “claimed devices in this ranch” ----
      // Adjust fields to match your schema.
      const cattle = await prisma.device.findMany({
        where: {
          ranchId,
          // if you only want trackers/tags:
          // type: "TRACKER",
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send(cattle);
    } catch (err: any) {
      const status = err?.statusCode ?? 500;
      const message = err?.message ?? "Unknown error";
      if (status >= 500) console.error("🐮 /api/cattle error:", err);
      return reply.code(status).send({ error: message });
    }
  });

  // POST /api/cattle (optional scaffold)
  // Create a cattle record or “assign a tag”. Keep this for later if you want.
  app.post("/api/cattle", async (req, reply) => {
    try {
      const { userId } = await requireAuth(req);
      const ranchId = await resolveRanchId(req, userId, getPrimaryRanchId);

      const prisma = (app as any).prisma;
      if (!prisma) {
        return reply.code(500).send({
          error:
            "Prisma not available on app (app.prisma missing). Ensure you decorate app.prisma before registering routes.",
        });
      }

      const body: any = (req as any).body ?? {};
      // Example payload: { deviceId, name }
      const { deviceId, name } = body;

      if (!deviceId) {
        return reply.code(400).send({ error: "deviceId is required" });
      }

      // If your model is different, change this.
      const updated = await prisma.device.update({
        where: { id: String(deviceId) },
        data: {
          ranchId,
          name: name ? String(name) : undefined,
          // claimedAt: new Date(),
        },
      });

      return reply.send(updated);
    } catch (err: any) {
      const status = err?.statusCode ?? 500;
      const message = err?.message ?? "Unknown error";
      if (status >= 500) console.error("🐮 POST /api/cattle error:", err);
      return reply.code(status).send({ error: message });
    }
  });
}