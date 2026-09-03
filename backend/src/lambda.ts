// AWS Lambda entry (API Gateway HTTP API v2).
// Обслуживает и API (/api/*), и собранный SPA (FRONTEND_BUILD=/var/task/frontend).
// Локально не используется — для локали см. local.ts.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { route } from "./handlers.ts";
import { loadConfig } from "./config.ts";

interface ApiGatewayEvent {
  warmup?: boolean;
  requestContext?: { http?: { method?: string; path?: string } };
  rawPath?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string> | null;
  headers?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
}

const MIME: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function lowerHeaders(headers?: Record<string, string | undefined> | null): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = v;
  return out;
}

async function serveSpa(pathname: string, frontendBuild: string): Promise<{ status: number; type: string; text?: string; binary?: string }> {
  const root = path.resolve(frontendBuild);
  try {
    if (!(await stat(root)).isDirectory()) throw new Error("no frontend");
  } catch {
    return { status: 503, type: "text/plain; charset=utf-8", text: "Frontend build not found." };
  }
  let relative = "";
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, "").split("?")[0] ?? "";
    if (relative.includes("\0")) throw new Error("bad path");
  } catch {
    return { status: 403, type: "text/plain; charset=utf-8", text: "Access denied." };
  }
  if (relative && !relative.endsWith("/")) {
    try {
      const file = path.resolve(root, relative);
      if (file === root || file.startsWith(root + path.sep)) {
        const st = await stat(file);
        if (st.isFile()) {
          const ext = path.extname(file).toLowerCase();
          const body = await readFile(file);
          const isText = ext === ".html" || ext === ".svg" || (MIME[ext]?.startsWith("text/") ?? false) ||
            MIME[ext] === "application/json" || MIME[ext] === "application/manifest+json";
          return {
            status: 200,
            type: MIME[ext] ?? "application/octet-stream",
            ...(isText ? { text: body.toString("utf8") } : { binary: body.toString("base64") }),
          };
        }
      }
    } catch {
      // fallthrough к index.html
    }
  }
  try {
    const index = await readFile(path.join(root, "index.html"), "utf8");
    return { status: 200, type: "text/html; charset=utf-8", text: index };
  } catch {
    return { status: 503, type: "text/plain; charset=utf-8", text: "Frontend build incomplete." };
  }
}

const config = loadConfig();

export const handler = async (event: ApiGatewayEvent) => {
  if (event.warmup === true) return { statusCode: 200, body: "warm" };
  const method = event.requestContext?.http?.method ?? "GET";
  const pathName = event.rawPath ?? event.requestContext?.http?.path ?? "/";
  const headers = lowerHeaders(event.headers);

  if (!pathName.startsWith("/api/") && method === "GET" && config.frontendBuild) {
    const page = await serveSpa(pathName, config.frontendBuild);
    return {
      statusCode: page.status,
      headers: { "content-type": page.type, "cache-control": "no-store, must-revalidate" },
      body: page.text ?? page.binary ?? "",
      isBase64Encoded: page.binary !== undefined,
    };
  }

  const query: Record<string, string> = {};
  if (event.queryStringParameters) Object.assign(query, event.queryStringParameters);
  else if (event.rawQueryString) {
    for (const part of event.rawQueryString.split("&")) {
      const [k, v] = part.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  let body: unknown;
  if (event.body) {
    try {
      const text = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  const res = await route({ method, path: pathName, query, headers, body }, config);
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    body: JSON.stringify(res.body),
  };
};
