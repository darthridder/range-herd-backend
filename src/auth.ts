import { createHash, randomBytes, pbkdf2Sync } from "crypto";
import { SignJWT, jwtVerify } from "jose";

// ─── Environment ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PRODUCTION";
const secret = new TextEncoder().encode(JWT_SECRET);

// ─── Password Hashing ─────────────────────────────────────────────────────────

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, originalHash] = storedHash.split(":");
  const hash = pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return hash === originalHash;
}

// ─── JWT Tokens ───────────────────────────────────────────────────────────────

export type TokenPayload = {
  userId: string;
  email: string;
};

export async function signToken(payload: TokenPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d") // 7 day expiration
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload as TokenPayload;
  } catch {
    return null;
  }
}
