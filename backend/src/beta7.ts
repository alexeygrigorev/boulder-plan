// Нормализация BETA7 QR-URL. Порт contracts/typescript_models.ts из пакета
// (normalizeBeta7RouteUrl) без изменений логики безопасности:
// exact host allowlist, без credentials/портов, только /route/{id},
// externalId — непрозрачная строка, hl/query отбрасываются из canonical.
export class UnsupportedQrPayloadError extends Error {
  public readonly code = "UNSUPPORTED_QR_PAYLOAD";
  public constructor(message = "QR payload is not a supported route URL") {
    super(message);
    this.name = "UnsupportedQrPayloadError";
  }
}

export class UnsafeExternalUrlError extends Error {
  public readonly code = "UNSAFE_EXTERNAL_URL";
  public constructor(message = "External URL failed security validation") {
    super(message);
    this.name = "UnsafeExternalUrlError";
  }
}

export interface NormalizedBeta7RouteUrl {
  provider: "beta7";
  externalId: string;
  canonicalUrl: string;
  originalUrl: string;
}

const BETA7_ALLOWED_HOSTS = new Set(["beta7.app"]);
const ROUTE_ID_PATTERN = /^[A-Za-z0-9._~-]{8,240}$/u;

export function normalizeBeta7RouteUrl(payload: string): NormalizedBeta7RouteUrl {
  const trimmed = payload.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) {
    throw new UnsupportedQrPayloadError("QR payload is empty or too long");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (error: unknown) {
    throw new UnsupportedQrPayloadError(
      error instanceof Error ? `Invalid URL: ${error.message}` : "Invalid URL",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeExternalUrlError("Only HTTP(S) URLs are accepted");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeExternalUrlError("Credentials in URLs are not accepted");
  }
  if (url.port !== "") {
    throw new UnsafeExternalUrlError("Custom ports are not accepted");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!BETA7_ALLOWED_HOSTS.has(hostname)) {
    throw new UnsafeExternalUrlError(`Host is not allowed: ${hostname}`);
  }

  const match = /^\/route\/([^/]+)\/?$/u.exec(url.pathname);
  if (match === null) {
    throw new UnsupportedQrPayloadError("URL is not a BETA7 route page");
  }

  const rawExternalId = match[1];
  if (rawExternalId === undefined) {
    throw new UnsupportedQrPayloadError("Route ID is missing");
  }
  const externalId = decodeURIComponent(rawExternalId);
  if (!ROUTE_ID_PATTERN.test(externalId)) {
    throw new UnsupportedQrPayloadError("Route ID has an unsupported format");
  }

  const canonicalUrl = `https://beta7.app/route/${encodeURIComponent(externalId)}`;
  return { provider: "beta7", externalId, canonicalUrl, originalUrl: trimmed };
}

export function isBeta7RoutePayload(payload: string): boolean {
  try {
    normalizeBeta7RouteUrl(payload);
    return true;
  } catch {
    return false;
  }
}

export function assertDifficultyRange(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new TypeError("Difficulty values must be finite numbers");
  }
  if (min < 0 || max > 10 || min > max) {
    throw new RangeError("Difficulty range must satisfy 0 <= min <= max <= 10");
  }
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
