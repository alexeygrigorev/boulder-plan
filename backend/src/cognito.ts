// Обмен PKCE-кода shared-Cognito на проверенные claims.
// Портировано из fitness-tracker/backend-ts/src/cognito.ts.
import { createPublicKey, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import type { AuthConfig } from "./config.ts";

export interface CognitoClaims {
  sub: string;
  email: string;
  name: string;
}

interface JsonWebKeySet {
  keys?: JsonWebKey[];
}

let cachedKeys: { url: string; keys: JsonWebKey[]; expiresAt: number } | undefined;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  try {
    return asObject(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

async function jwks(url: string, refresh = false): Promise<JsonWebKey[]> {
  if (!refresh && cachedKeys?.url === url && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("Shared auth keys are unavailable");
  const payload = (await response.json()) as JsonWebKeySet;
  if (!Array.isArray(payload.keys) || payload.keys.length === 0) throw new Error("Shared auth keys are invalid");
  cachedKeys = { url, keys: payload.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return payload.keys;
}

async function verifyIdToken(token: string, nonce: string, auth: AuthConfig): Promise<CognitoClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("Malformed ID token");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || !claims) throw new Error("Invalid ID token");
  let keys = await jwks(auth.jwksUrl);
  let key = keys.find((candidate) => candidate.kid === header.kid);
  if (!key) {
    keys = await jwks(auth.jwksUrl, true);
    key = keys.find((candidate) => candidate.kid === header.kid);
  }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  if (!key || !verify("RSA-SHA256", signed, createPublicKey({ key, format: "jwk" }), signature)) {
    throw new Error("Invalid ID token signature");
  }
  const valid = typeof claims.sub === "string" && typeof claims.email === "string" &&
    claims.email_verified === true && claims.iss === auth.issuer && claims.aud === auth.clientId &&
    claims.token_use === "id" && claims.nonce === nonce && typeof claims.exp === "number" &&
    claims.exp > Math.floor(Date.now() / 1000);
  if (!valid) throw new Error("Invalid ID token claims");
  return {
    sub: claims.sub as string,
    email: claims.email as string,
    name: typeof claims.name === "string" ? claims.name : (claims.email as string),
  };
}

export async function exchangeCognitoCode(
  code: string,
  verifier: string,
  nonce: string,
  auth: AuthConfig,
): Promise<CognitoClaims> {
  const response = await fetch(`${auth.baseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: auth.clientId,
      redirect_uri: auth.callbackUrl,
      code,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  const payload = asObject(await response.json().catch(() => undefined));
  if (!response.ok || typeof payload?.id_token !== "string") {
    throw new Error("Shared sign-in could not be completed.");
  }
  try {
    return await verifyIdToken(payload.id_token, nonce, auth);
  } catch {
    throw new Error("Shared sign-in response was invalid.");
  }
}

export function resetCognitoKeyCacheForTests(): void {
  cachedKeys = undefined;
}
