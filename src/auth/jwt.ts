import jwt from "jsonwebtoken";

export function getJwtSecret(): string {
  const s = process.env.JWT_SECRET?.trim();
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }
  return "qc-api-dev-jwt-secret-change-me";
}

export type JwtRole = "admin" | "user";

export interface VerifiedJwtPayload {
  sub: string;
  username: string;
  role: JwtRole;
}

export function signToken(userId: string, username: string, role: JwtRole): string {
  return jwt.sign({ sub: userId, username, role }, getJwtSecret(), { expiresIn: "7d" });
}

export function verifyToken(token: string): VerifiedJwtPayload {
  const decoded = jwt.verify(token, getJwtSecret());
  if (typeof decoded === "string" || typeof decoded !== "object" || decoded === null) {
    throw new Error("invalid token payload");
  }
  const sub = "sub" in decoded ? String((decoded as { sub?: unknown }).sub ?? "") : "";
  if (!sub) throw new Error("invalid token subject");
  const username = "username" in decoded ? String((decoded as { username?: unknown }).username ?? "") : "";
  const roleRaw = "role" in decoded ? String((decoded as { role?: unknown }).role ?? "") : "";
  const role: JwtRole = roleRaw === "admin" ? "admin" : "user";
  return { sub, username, role };
}
