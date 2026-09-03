// Свои короткие сессии (HS256): после shared-Cognito логина выдаём access-токен.
// Портировано из fitness-tracker/backend-ts/src/jwt.ts, упрощено под один subject.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionClaims {
  token_type: "access";
  exp: number;
  iat: number;
  sub: string;
  email: string;
}

const ACCESS_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function issueSessionToken(sub: string, email: string, secret: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    token_type: "access",
    exp: issuedAt + ACCESS_LIFETIME_SECONDS,
    iat: issuedAt,
    sub,
    email,
  });
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

export function verifySessionToken(token: string, secret: string): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = decodeSegment(parts[0]);
  if (header?.alg !== "HS256") return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret), "base64url");
  const actual = Buffer.from(parts[2], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const claims = decodeSegment(parts[1]);
  if (
    !claims || claims.token_type !== "access" ||
    typeof claims.exp !== "number" || typeof claims.iat !== "number" ||
    typeof claims.sub !== "string" || typeof claims.email !== "string" ||
    claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return {
    token_type: "access",
    exp: claims.exp,
    iat: claims.iat,
    sub: claims.sub,
    email: claims.email,
  };
}

export function bearerEmail(headers: Record<string, string | undefined>, secret: string): string | null {
  const raw = headers.authorization ?? headers.Authorization;
  const match = typeof raw === "string" ? raw.match(/^Bearer\s+(.+)$/i) : null;
  if (!match?.[1]) return null;
  return verifySessionToken(match[1].trim(), secret)?.email ?? null;
}
