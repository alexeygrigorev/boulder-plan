// Локальный сервер: тот же route(), что и в Lambda, + раздача frontend.
// Запуск: npm run dev  →  http://localhost:3000
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "./handlers.ts";

const PORT = Number(process.env.PORT ?? 3000);
const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = join(here, "..", "..", "frontend", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(pathname: string): { status: number; type: string; data: Buffer } | null {
  if (!existsSync(FRONTEND_DIST)) return null;
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(FRONTEND_DIST, rel));
  if (!file.startsWith(FRONTEND_DIST)) return null;
  let target = file;
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
  if (!existsSync(target)) {
    // SPA fallback
    target = join(FRONTEND_DIST, "index.html");
    if (!existsSync(target)) return null;
  }
  return { status: 200, type: MIME[extname(target)] ?? "application/octet-stream", data: readFileSync(target) };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,PUT,OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        res.end();
        return;
      }
      let body: unknown;
      if (req.method === "PUT" || req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString("utf8");
        if (text) body = JSON.parse(text);
      }
      const out = await route({
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body,
      });
      res.writeHead(out.status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(out.body));
      return;
    }
    const staticRes = serveStatic(url.pathname);
    if (staticRes) {
      res.writeHead(staticRes.status, { "content-type": staticRes.type });
      res.end(staticRes.data);
      return;
    }
    // frontend ещё не собран — подсказка
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      message: "backend работает. Собери frontend (npm --workspace frontend run build) — и он будет раздаваться отсюда.",
      api: ["/api/health", "/api/days", "/api/plan?date=2026-09-08"],
    }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`boulder-plan backend+frontend: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/health`);
});
