// Маршрутизация API — общая для Lambda и локального сервера.
// Никаких зависимостей: вход — { method, path, query, body }, выход — { status, body }.
import { loadPlan } from "./plan.ts";
import { createStore } from "./storage.ts";
import type { ProgressEntry } from "./types.ts";

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const json = (body: unknown, status = 200): ApiResponse => ({ status, body });

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export async function route(req: ApiRequest): Promise<ApiResponse> {
  const plan = loadPlan();
  const store = createStore();
  const { method, path, query } = req;

  if (method === "GET" && path === "/api/health") {
    return json({ ok: true, days: plan.days.length, period: plan.meta.period });
  }
  if (method === "GET" && path === "/api/days") {
    return json({
      period: plan.meta.period,
      days: plan.days.map((d) => ({
        date: d.date, title: d.title, format: d.format,
        theme: d.theme, week: d.week, requiredMinutes: d.requiredMinutes,
        blocks: d.blocks.length,
      })),
    });
  }
  if (method === "GET" && path === "/api/weeks") {
    return json(plan.weeks.map((w) => ({ id: w.id, title: w.title, dates: w.dates, theme: w.theme })));
  }
  if (method === "GET" && path === "/api/plan") {
    const date = query.date ?? todayIso();
    if (!isDate(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    const day = plan.days.find((d) => d.date === date);
    if (!day) return json({ error: "no plan for date", date }, 404);
    return json(day);
  }
  if (method === "GET" && path === "/api/library") {
    return json(plan.library.map((e) => ({ id: e.id, title: e.title })));
  }
  if (method === "GET" && path === "/api/library/entry") {
    const entry = plan.library.find((e) => e.id === query.id);
    if (!entry) return json({ error: "unknown library id" }, 404);
    return json(entry);
  }
  if (method === "GET" && path === "/api/doc") {
    const doc = plan.docs.find((d) => d.id === query.id);
    if (!doc) return json({ error: "unknown doc id", known: plan.docs.map((d) => d.id) }, 404);
    return json(doc);
  }
  if (method === "GET" && path === "/api/progress") {
    const date = query.date ?? todayIso();
    if (!isDate(date)) return json({ error: "date must be YYYY-MM-DD" }, 400);
    return json((await store.get(date)) ?? { date, checks: {}, note: "" });
  }
  if (method === "PUT" && path === "/api/progress") {
    const b = (req.body ?? {}) as Partial<ProgressEntry>;
    if (typeof b.date !== "string" || !isDate(b.date)) return json({ error: "body.date must be YYYY-MM-DD" }, 400);
    if (typeof b.checks !== "object" || b.checks === null) return json({ error: "body.checks must be object" }, 400);
    const entry: ProgressEntry = {
      date: b.date,
      checks: b.checks as Record<string, boolean>,
      note: typeof b.note === "string" ? b.note.slice(0, 2000) : "",
      updatedAt: new Date().toISOString(),
    };
    return json(await store.put(entry));
  }
  return json({ error: "not found", path }, 404);
}
