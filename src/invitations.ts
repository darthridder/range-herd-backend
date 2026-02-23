import { randomBytes } from "crypto";

// Generate a random invitation token
export function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

// Calculate expiration date (7 days from now)
export function getInviteExpiration(): Date {
  const exp = new Date();
  exp.setDate(exp.getDate() + 7);
  return exp;
}

// Check if an invitation is expired
export function isInviteExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}
