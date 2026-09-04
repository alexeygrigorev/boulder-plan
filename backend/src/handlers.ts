// Маршрутизация API — общая для Lambda и локального сервера.
// Никаких зависимостей: вход — { method, path, query, body, headers }, выход — { status, body }.
// Auth: если задан AUTH_* (прод), всё кроме /api/health и /api/auth/* требует Bearer.
// Локально без AUTH_* — открыто, как раньше.
import { loadPlan } from "./plan.ts";
import { createStore } from "./storage.ts";
import { loadConfig, sharedAuthPublicConfig, type AppConfig } from "./config.ts";
import { bearerEmail, issueSessionToken } from "./jwt.ts";
import { exchangeCognitoCode } from "./cognito.ts";
import type { ProgressEntry } from "./types.ts";
import { loadRoutesDoc, saveRoutesDoc } from "./routeStore.ts";
import { createManualRoute, enrichRoute, listGymRoutes, resolveQr } from "./routeApi.ts";
import { UnsafeExternalUrlError, UnsupportedQrPayloadError } from "./beta7.ts";

export interface ApiRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
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

// Тип дня для календаря: будняя тренировка / воскресенье (расслабленное, опционально) / обычный день.
function dayKind(date: string, format: string | null): "workout" | "sunday" | "regular" {
  if (new Date(date + "T12:00:00").getDay() === 0) return "sunday";
  if (format && (format.startsWith("Тренировка A") || format.startsWith("Тренировка B"))) return "workout";
  return "regular";
}

export async function route(req: ApiRequest, config: AppConfig = loadConfig()): Promise<ApiResponse> {
  const plan = loadPlan();
  const store = createStore();
  const { method, path, query, headers } = req;

  if (method === "GET" && path === "/api/health") {
    return json({ ok: true, days: plan.days.length, period: plan.meta.period, auth: Boolean(config.auth) });
  }
  if (method === "GET" && path === "/api/auth/config") {
    return json(config.auth ? { enabled: true, ...sharedAuthPublicConfig(config.auth) } : { enabled: false });
  }
  if (method === "POST" && path === "/api/auth/callback") {
    if (!config.auth) return json({ error: "Shared authentication is not configured." }, 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.code !== "string" || typeof b.code_verifier !== "string" || typeof b.nonce !== "string") {
      return json({ error: "Invalid authentication callback." }, 400);
    }
    try {
      const claims = await exchangeCognitoCode(b.code, b.code_verifier, b.nonce, config.auth);
      const access = issueSessionToken(claims.sub, claims.email, config.jwtSecret);
      return json({ access, email: claims.email, name: claims.name });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Sign-in failed." }, 401);
    }
  }

  // Дальше — закрытая зона, если auth включён.
  let email: string | null = null;
  if (config.auth) {
    email = bearerEmail(headers, config.jwtSecret);
    if (!email) return json({ error: "unauthorized" }, 401);
  }
  if (method === "GET" && path === "/api/auth/me") {
    if (!config.auth) return json({ enabled: false, email: null });
    return json({ enabled: true, email });
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
  if (method === "GET" && path === "/api/week") {
    const week = plan.weeks.find((w) => w.id === query.id);
    if (!week) return json({ error: "unknown week id" }, 404);
    const days = plan.days
      .filter((d) => d.week === week.id)
      .map((d) => ({
        date: d.date, title: d.title, format: d.format,
        requiredMinutes: d.requiredMinutes, blocks: d.blocks.length,
      }));
    const resources = (week.resources ?? [])
      .map((id) => plan.resources.find((r) => r.id === id))
      .filter(Boolean);
    return json({ ...week, days, resources });
  }
  if (method === "GET" && path === "/api/resources") {
    return json(plan.resources);
  }
  if (method === "GET" && path === "/api/glossary") {
    return json(plan.glossary);
  }
  if (method === "GET" && path === "/api/gyms") {
    const doc = await loadRoutesDoc();
    return json({
      gyms: doc.gyms.map((g) => ({
        ...g,
        catalogUpdatedAt: doc.catalogMeta[g.id]?.updatedAt ?? null,
        routeCount: doc.routes.filter((r) => r.gymId === g.id && r.availability === "ACTIVE").length,
      })),
    });
  }
  if (method === "GET" && path === "/api/gym/routes") {
    if (typeof query.gymId !== "string" || !query.gymId) return json({ error: "gymId required" }, 400);
    const doc = await loadRoutesDoc();
    if (!doc.gyms.some((g) => g.id === query.gymId)) return json({ error: "unknown gym" }, 404);
    const num = (v: string | undefined): number | undefined => {
      if (v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const styles = typeof query.styles === "string" && query.styles
      ? query.styles.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const items = listGymRoutes(doc, {
      gymId: query.gymId,
      availability: typeof query.availability === "string" && query.availability ? query.availability : undefined,
      difficultyMin: num(query.difficultyMin),
      difficultyMax: num(query.difficultyMax),
      styles,
      excludeSent: query.excludeSent === "true" || query.excludeSent === "1",
      limit: num(query.limit),
    });
    const meta = doc.catalogMeta[query.gymId];
    return json({
      items: items.map((route) => ({ route, personalState: doc.states[route.id] ?? null })),
      catalog: {
        status: meta?.status ?? "UNKNOWN",
        updatedAt: meta?.updatedAt ?? null,
        routeCount: doc.routes.filter((r) => r.gymId === query.gymId).length,
        warning: meta?.status === "NOT_SUPPORTED"
          ? "Каталог недоступен без разрешения BETA7: работает scan-only + ручной ввод."
          : null,
      },
    });
  }
  if (method === "POST" && path === "/api/qr/resolve") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const doc = await loadRoutesDoc();
    try {
      const out = resolveQr(doc, b.payload, b.selectedGymId);
      await saveRoutesDoc(doc);
      return json(out);
    } catch (e) {
      if (e instanceof UnsafeExternalUrlError) {
        return json({ matched: false, code: e.code, message: "Ссылка не из разрешённого домена.", manualFallback: { allowed: false, suggestedFields: [] } }, 400);
      }
      if (e instanceof UnsupportedQrPayloadError) {
        return json({ matched: false, code: e.code, message: "Это не ссылка на трассу BETA7. Можно добавить вручную.", manualFallback: { allowed: true, suggestedFields: ["gymId", "sector", "gradeRaw", "name", "styles"] } }, 422);
      }
      throw e;
    }
  }
  if (method === "POST" && path === "/api/gym/routes") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.gymId !== "string" || !b.gymId) return json({ error: "gymId required" }, 400);
    const doc = await loadRoutesDoc();
    try {
      const route = createManualRoute(doc, {
        gymId: b.gymId,
        sector: typeof b.sector === "string" ? b.sector : null,
        name: typeof b.name === "string" ? b.name : null,
        gradeRaw: typeof b.gradeRaw === "string" ? b.gradeRaw : "",
        styles: Array.isArray(b.styles) ? b.styles.filter((s): s is string => typeof s === "string") : [],
        setter: typeof b.setter === "string" ? b.setter : null,
        holdDescription: typeof b.holdDescription === "string" ? b.holdDescription : null,
      }, new Date().toISOString());
      await saveRoutesDoc(doc);
      return json({ route, personalState: doc.states[route.id] ?? null }, 201);
    } catch {
      return json({ error: "unknown gym" }, 404);
    }
  }
  if (method === "PUT" && path === "/api/gym/route") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.id !== "string" || !b.id) return json({ error: "id required" }, 400);
    const doc = await loadRoutesDoc();
    try {
      const patch = (typeof b.patch === "object" && b.patch !== null ? b.patch : {}) as Record<string, unknown>;
      const route = enrichRoute(doc, b.id, {
        sector: typeof patch.sector === "string" ? patch.sector : patch.sector === null ? null : undefined,
        name: typeof patch.name === "string" ? patch.name : patch.name === null ? null : undefined,
        gradeRaw: typeof patch.gradeRaw === "string" ? patch.gradeRaw : undefined,
        styles: Array.isArray(patch.styles) ? patch.styles.filter((s): s is string => typeof s === "string") : undefined,
        setter: typeof patch.setter === "string" ? patch.setter : patch.setter === null ? null : undefined,
      }, new Date().toISOString());
      await saveRoutesDoc(doc);
      return json({ route, personalState: doc.states[route.id] ?? null });
    } catch {
      return json({ error: "unknown route" }, 404);
    }
  }
  if (method === "GET" && path === "/api/activity") {
    const { from = plan.meta.period.from, to = plan.meta.period.to } = query;
    if (!isDate(from) || !isDate(to)) return json({ error: "from/to must be YYYY-MM-DD" }, 400);
    const days = plan.days.filter((d) => d.date >= from && d.date <= to);
    const out = await Promise.all(days.map(async (d) => {
      const required = d.blocks.filter((b) => b.requirement === "обязательно").map((b) => b.id);
      const checks = (await store.get(d.date))?.checks ?? {};
      return {
        date: d.date, title: d.title, format: d.format, kind: dayKind(d.date, d.format),
        requiredMinutes: d.requiredMinutes,
        requiredTotal: required.length,
        done: required.filter((id) => checks[id]).length,
      };
    }));
    return json({ from, to, days: out });
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
    const metrics = parseMetrics(b.metrics);
    if (metrics === null) return json({ error: "body.metrics must be {shoulder,fingers,knee 0-10, energy 1-5}" }, 400);
    const entry: ProgressEntry = {
      date: b.date,
      checks: b.checks as Record<string, boolean>,
      note: typeof b.note === "string" ? b.note.slice(0, 2000) : "",
      ...(metrics ? { metrics } : {}),
      updatedAt: new Date().toISOString(),
    };
    return json(await store.put(entry));
  }
  return json({ error: "not found", path }, 404);
}

function parseMetrics(v: unknown): ProgressEntry["metrics"] | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: NonNullable<ProgressEntry["metrics"]> = {};
  const ints: [keyof NonNullable<ProgressEntry["metrics"]>, number, number][] = [
    ["shoulder", 0, 10], ["fingers", 0, 10], ["knee", 0, 10], ["energy", 1, 5],
  ];
  for (const [k, min, max] of ints) {
    const val = (v as Record<string, unknown>)[k];
    if (val === undefined || val === null) continue;
    if (typeof val !== "number" || !Number.isInteger(val) || val < min || val > max) return null;
    out[k] = val;
  }
  return out;
}
