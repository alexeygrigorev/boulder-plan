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
import { loadRoutesDoc, saveRoutesDoc, recordAttempt, deleteAttempt, setRouteStatus, startTimer, stopTimer, findRouteById } from "./routeStore.ts";
import { FAILURE_REASONS, ROUTE_STATUSES } from "./routeTypes.ts";
import { createManualRoute, enrichRoute, isLiveRoutesEnabled, listGymRoutes, resolveQrLive } from "./routeApi.ts";
import { checkSyncRateLimit, syncGymCatalogFromHtml } from "./catalogSync.ts";
import { safeFetchBeta7Page } from "./beta7fetch.ts";
import { RECOMMENDATION_VERSION, recommend } from "./recommend.ts";
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
    const catalogWarning = meta?.status === "NOT_SUPPORTED"
      ? "Каталог недоступен: работает сканирование QR + ручной ввод."
      : meta?.status === "PARTIAL"
        ? "Каталог частичный: первые ~10 с сайта + твои сканы. Отсутствие трассы в списке ничего не значит."
        : null;
    return json({
      items: items.map((route) => ({ route, personalState: doc.states[route.id] ?? null })),
      catalog: {
        status: meta?.status ?? "UNKNOWN",
        updatedAt: meta?.updatedAt ?? null,
        routeCount: doc.routes.filter((r) => r.gymId === query.gymId).length,
        warning: catalogWarning,
      },
    });
  }
  if (method === "POST" && path === "/api/gym/sync") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.gymId !== "string" || !b.gymId) return json({ error: "gymId required" }, 400);
    const doc = await loadRoutesDoc();
    const gym = doc.gyms.find((g) => g.id === b.gymId);
    if (!gym) return json({ error: "unknown gym" }, 404);
    if (!gym.catalogUrl) return json({ error: "gym has no public catalog page" }, 400);
    const limited = checkSyncRateLimit(doc, gym.id, Date.now(), b.force === true);
    if (limited) return json({ error: limited, retryable: true }, 429);
    if (!isLiveRoutesEnabled()) return json({ error: "sync disabled (BETA7_OFF=1)", retryable: false }, 503);
    try {
      const page = await safeFetchBeta7Page(gym.catalogUrl);
      const run = syncGymCatalogFromHtml(doc, gym.id, page.html, new Date().toISOString());
      await saveRoutesDoc(doc);
      return json(run);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "sync failed", retryable: true }, 502);
    }
  }
  if (method === "POST" && path === "/api/qr/resolve") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const doc = await loadRoutesDoc();
    try {
      const fetchPage = isLiveRoutesEnabled()
        ? ((url: string) => safeFetchBeta7Page(url).then((p) => ({ html: p.html })))
        : undefined;
      const out = await resolveQrLive(doc, b.payload, b.selectedGymId, fetchPage);
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
  if (method === "POST" && path === "/api/recommendations") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.gymId !== "string" || !b.gymId) return json({ error: "gymId required" }, 400);
    if (!Array.isArray(b.exercises) || !b.exercises.length) return json({ error: "exercises required" }, 400);
    const doc = await loadRoutesDoc();
    if (!doc.gyms.some((g) => g.id === b.gymId)) return json({ error: "unknown gym" }, 404);
    try {
      const exercises = b.exercises.map((e) => {
        const ex = e as Record<string, unknown>;
        if (typeof ex.id !== "string" || !ex.id) throw new Error("bad exercise");
        const diff = ex.difficulty as { min?: unknown; max?: unknown } | undefined;
        const min = typeof diff?.min === "number" ? diff.min : 0;
        const max = typeof diff?.max === "number" ? diff.max : 10;
        const tc = typeof ex.targetCount === "number" && Number.isInteger(ex.targetCount) && ex.targetCount > 0
          ? Math.min(20, ex.targetCount)
          : 3;
        return {
          id: ex.id,
          targetCount: tc,
          difficulty: { min, max },
          targetStyles: Array.isArray(ex.targetStyles)
            ? ex.targetStyles.filter((s): s is string => typeof s === "string")
            : [],
          excludeSent: ex.excludeSent !== false,
          preferWantToTry: ex.preferWantToTry !== false,
          selectionPolicy: typeof ex.selectionPolicy === "string" ? ex.selectionPolicy : "FREE",
        };
      });
      const { exercises: out, empty } = recommend(doc, b.gymId, exercises, Date.now());
      const meta = doc.catalogMeta[b.gymId];
      return json({
        gymId: b.gymId,
        generatedAt: new Date().toISOString(),
        recommendationVersion: RECOMMENDATION_VERSION,
        catalog: {
          status: meta?.status ?? "UNKNOWN",
          updatedAt: meta?.updatedAt ?? null,
          routeCount: doc.routes.filter((r) => r.gymId === b.gymId).length,
          warning: empty ? "Подходящих трасс нет — попробуй scan-only поиск у стены." : null,
        },
        exercises: out,
      });
    } catch {
      return json({ error: "bad exercises (difficulty 0..10, min<=max)" }, 400);
    }
  }
  if (method === "GET" && path === "/api/route") {
    if (typeof query.id !== "string" || !query.id) return json({ error: "id required" }, 400);
    const doc = await loadRoutesDoc();
    const r = findRouteById(doc, query.id);
    if (!r) return json({ error: "unknown route" }, 404);
    return json({
      route: r,
      personalState: doc.states[r.id] ?? null,
      attempts: doc.attempts.filter((a) => a.routeId === r.id),
      timers: Object.values(doc.timers).filter((t) => t.routeId === r.id),
    });
  }
  if (method === "PUT" && path === "/api/route/state") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.routeId !== "string" || !b.routeId) return json({ error: "routeId required" }, 400);
    if (typeof b.status !== "string" || !(ROUTE_STATUSES as string[]).includes(b.status)) {
      return json({ error: "unknown status" }, 400);
    }
    const doc = await loadRoutesDoc();
    if (!findRouteById(doc, b.routeId)) return json({ error: "unknown route" }, 404);
    const prio = typeof b.priority === "number" && Number.isInteger(b.priority) ? b.priority : undefined;
    if (prio !== undefined && (prio < 0 || prio > 5)) return json({ error: "priority 0-5" }, 400);
    const pd = b.personalDifficulty === null || b.personalDifficulty === undefined
      ? undefined
      : typeof b.personalDifficulty === "number" && b.personalDifficulty >= 0 && b.personalDifficulty <= 10
        ? b.personalDifficulty
        : NaN;
    if (typeof pd === "number" && Number.isNaN(pd)) return json({ error: "personalDifficulty 0-10" }, 400);
    const st = setRouteStatus(doc, b.routeId, b.status as (typeof ROUTE_STATUSES)[number], {
      ...(prio !== undefined ? { priority: prio } : {}),
      ...(typeof b.notes === "string" || b.notes === null ? { notes: b.notes } : {}),
      ...(pd !== undefined ? { personalDifficulty: pd } : {}),
    }, new Date().toISOString());
    await saveRoutesDoc(doc);
    return json(st);
  }
  if (method === "POST" && path === "/api/route/attempts") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.routeId !== "string" || !b.routeId) return json({ error: "routeId required" }, 400);
    if (typeof b.clientAttemptId !== "string" || b.clientAttemptId.length < 4) {
      return json({ error: "clientAttemptId required" }, 400);
    }
    const results = ["FAILED", "SENT", "FLASHED", "ABORTED", "SKIPPED"];
    if (typeof b.result !== "string" || !results.includes(b.result)) return json({ error: "unknown result" }, 400);
    if (b.failureReason !== undefined && b.failureReason !== null &&
      (typeof b.failureReason !== "string" || !(FAILURE_REASONS as string[]).includes(b.failureReason))) {
      return json({ error: "unknown failureReason" }, 400);
    }
    const doc = await loadRoutesDoc();
    const r = findRouteById(doc, b.routeId);
    if (!r) return json({ error: "unknown route" }, 404);
    // Flash — только первой попыткой, иначе нужен явный override (spec qa/22).
    if (b.result === "FLASHED" && b.allowFlashOverride !== true) {
      const prior = doc.attempts.some((a) => a.routeId === b.routeId && a.clientAttemptId !== b.clientAttemptId);
      if (prior || doc.states[b.routeId]?.totalAttempts) {
        return json({ error: "flash needs first attempt or allowFlashOverride" }, 400);
      }
    }
    const numOrNull = (v: unknown, min: number, max: number): number | null | undefined => {
      if (v === undefined || v === null) return null;
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) return undefined;
    };
    const pd = numOrNull(b.perceivedDifficulty, 0, 10);
    const rest = numOrNull(b.restBeforeSeconds, 0, 24 * 3600);
    const climb = numOrNull(b.climbingSeconds, 0, 24 * 3600);
    if (pd === undefined || rest === undefined || climb === undefined) return json({ error: "bad numeric field" }, 400);
    const now = new Date().toISOString();
    const { attempt, created } = recordAttempt(doc, {
      clientAttemptId: b.clientAttemptId,
      routeId: b.routeId,
      workoutDate: typeof b.workoutDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.workoutDate) ? b.workoutDate : null,
      exerciseId: typeof b.exerciseId === "string" ? b.exerciseId : null,
      result: b.result as "FAILED" | "SENT" | "FLASHED" | "ABORTED" | "SKIPPED",
      failureReason: (b.failureReason ?? null) as null | (typeof FAILURE_REASONS)[number],
      perceivedDifficulty: pd,
      restBeforeSeconds: rest !== null ? Math.round(rest) : null,
      climbingSeconds: climb !== null ? Math.round(climb) : null,
      notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : null,
    }, now);
    await saveRoutesDoc(doc);
    return json(attempt, created ? 201 : 200);
  }
  if (method === "GET" && path === "/api/route/attempts") {
    if (typeof query.routeId !== "string" || !query.routeId) return json({ error: "routeId required" }, 400);
    const doc = await loadRoutesDoc();
    return json({ items: doc.attempts.filter((a) => a.routeId === query.routeId) });
  }
  if (method === "DELETE" && path === "/api/route/attempts") {
    if (typeof query.id !== "string" || !query.id) return json({ error: "id required" }, 400);
    const doc = await loadRoutesDoc();
    const gone = deleteAttempt(doc, query.id);
    if (!gone) return json({ error: "unknown attempt" }, 404);
    await saveRoutesDoc(doc);
    return json({ deleted: query.id, routeId: gone.routeId });
  }
  if (method === "POST" && path === "/api/route/timer/start") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.routeId !== "string" || !b.routeId) return json({ error: "routeId required" }, 400);
    if (typeof b.workoutDate !== "string" || !isDate(b.workoutDate)) return json({ error: "workoutDate YYYY-MM-DD" }, 400);
    const doc = await loadRoutesDoc();
    if (!findRouteById(doc, b.routeId)) return json({ error: "unknown route" }, 404);
    const t = startTimer(doc, b.workoutDate, b.routeId, new Date().toISOString());
    await saveRoutesDoc(doc);
    return json(t);
  }
  if (method === "POST" && path === "/api/route/timer/stop") {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.routeId !== "string" || !b.routeId) return json({ error: "routeId required" }, 400);
    if (typeof b.workoutDate !== "string" || !isDate(b.workoutDate)) return json({ error: "workoutDate YYYY-MM-DD" }, 400);
    const doc = await loadRoutesDoc();
    if (!findRouteById(doc, b.routeId)) return json({ error: "unknown route" }, 404);
    const t = stopTimer(doc, b.workoutDate, b.routeId, new Date().toISOString());
    await saveRoutesDoc(doc);
    return json(t);
  }
  if (method === "GET" && path === "/api/activity") {
    const { from = plan.meta.period.from, to = plan.meta.period.to } = query;
    if (!isDate(from) || !isDate(to)) return json({ error: "from/to must be YYYY-MM-DD" }, 400);
    const days = plan.days.filter((d) => d.date >= from && d.date <= to);
    // Один батч вместо N отдельных get: раньше 186 параллельных Dynamo-клиентов
    // роняли эндпоинт в Lambda (таймаут → «Нет связи с API» в календаре/прогрессе).
    const saved = await store.getMany(days.map((d) => d.date));
    const out = days.map((d) => {
      const required = d.blocks.filter((b) => b.requirement === "обязательно").map((b) => b.id);
      const checks = saved.get(d.date)?.checks ?? {};
      return {
        date: d.date, title: d.title, format: d.format, kind: dayKind(d.date, d.format),
        requiredMinutes: d.requiredMinutes,
        requiredTotal: required.length,
        done: required.filter((id) => checks[id]).length,
      };
    });
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
    const notes = parseBlockNotes(b.notes);
    if (notes === null) return json({ error: "body.notes must be {blockId: text}" }, 400);
    const entry: ProgressEntry = {
      date: b.date,
      checks: b.checks as Record<string, boolean>,
      note: typeof b.note === "string" ? b.note.slice(0, 2000) : "",
      ...(metrics ? { metrics } : {}),
      ...(notes ? { notes } : {}),
      updatedAt: new Date().toISOString(),
    };
    return json(await store.put(entry));
  }
  return json({ error: "not found", path }, 404);
}

function parseBlockNotes(v: unknown): Record<string, string> | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= 50) break;
    if (typeof val !== "string") return null;
    const t = val.slice(0, 500);
    if (t) out[k.slice(0, 64)] = t;
  }
  return out;
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
