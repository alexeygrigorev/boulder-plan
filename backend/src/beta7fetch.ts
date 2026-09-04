// Загрузка публичных страниц BETA7 без API (личный проект, только открытые данные).
// Защита из spec гл. 15.1: exact host allowlist, только HTTPS, без credentials
// и портов, проверка финального URL после редиректов, timeout, лимит размера,
// только text/html, блок private/loopback IP после DNS.
import { lookup } from "node:dns/promises";
import { UnsafeExternalUrlError } from "./beta7.ts";

export const BETA7_FETCH_TIMEOUT_MS = 8000;
export const BETA7_FETCH_MAX_BYTES = 1500000;
const USER_AGENT = "boulder-plan/1.0 (personal hobby project, single user)";

export interface FetchedPage {
  html: string;
  finalUrl: string;
  status: number;
}

type FetchFn = typeof fetch;

export function assertSafeBeta7Url(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeExternalUrlError("Invalid URL");
  }
  if (url.protocol !== "https:") throw new UnsafeExternalUrlError("Only HTTPS is fetched");
  if (url.username !== "" || url.password !== "") throw new UnsafeExternalUrlError("Credentials rejected");
  if (url.port !== "") throw new UnsafeExternalUrlError("Custom ports rejected");
  if (url.hostname.toLowerCase().replace(/\.$/u, "") !== "beta7.app") {
    throw new UnsafeExternalUrlError(`Host not allowed: ${url.hostname}`);
  }
  return url;
}

function isBlockedIp(ip: string): boolean {
  if (ip.startsWith("127.") || ip === "::1") return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith("169.254.") || ip.toLowerCase().startsWith("fe80:")) return true;
  if (ip === "::" || ip === "0.0.0.0") return true;
  return false;
}

export async function safeFetchBeta7Page(rawUrl: string, fetchFn: FetchFn = fetch): Promise<FetchedPage> {
  const url = assertSafeBeta7Url(rawUrl);
  // DNS-проверка до запроса: не ходим в private/loopback даже при подмене DNS.
  try {
    const addrs = await lookup(url.hostname, { all: true });
    if (addrs.some((a) => isBlockedIp(a.address))) {
      throw new UnsafeExternalUrlError("Resolved to a blocked address");
    }
  } catch (e) {
    if (e instanceof UnsafeExternalUrlError) throw e;
    throw new UnsafeExternalUrlError("DNS lookup failed");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BETA7_FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchFn(url.toString(), {
      signal: ctrl.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    });
  } catch (e) {
    throw new Error(`BETA7 fetch failed: ${e instanceof Error ? e.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }
  // Финальный URL после редиректов — снова через allowlist.
  try {
    assertSafeBeta7Url(res.url || url.toString());
  } catch {
    throw new UnsafeExternalUrlError("Redirect left the allowed host");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`BETA7 responded with HTTP ${res.status}`);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.toLowerCase().includes("text/html")) {
    throw new Error(`Unexpected content type: ${ctype}`);
  }
  if (!res.body) {
    const text = await res.text();
    if (text.length > BETA7_FETCH_MAX_BYTES) throw new Error("Response exceeds size limit");
    return { html: text, finalUrl: res.url || url.toString(), status: res.status };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > BETA7_FETCH_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch { /* noop */ }
        throw new Error("Response exceeds size limit");
      }
      chunks.push(value);
    }
  }
  const html = Buffer.concat(chunks).toString("utf8");
  return { html, finalUrl: res.url || url.toString(), status: res.status };
}
