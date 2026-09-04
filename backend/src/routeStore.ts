// Хранилище трасс: адаптация database/postgresql_schema.sql под наш стек.
// Postgres -> один JSON-документ: локально backend/data/routes.json,
// в AWS — один item pk=routes#v1 в той же таблице (без смены infra,
// хватает имеющихся прав GetItem/PutItem). Многопользовательскость пока
// как у progress (один пользователь); per-user/par-item single-table
// с Query/GSI — следующим шагом, если понадобится.
// Таблицы пакета отображаются так:
//   gyms/external_routes -> doc.gyms/doc.routes (+seed)
//   user_route_state -> doc.states[routeId]
//   route_attempts -> doc.attempts (идемпотентность по clientAttemptId)
//   route_work_timers -> doc.timers[date::routeId]
//   catalog_sync_runs -> doc.catalogMeta[gymId] (полные runs — после sync)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  AttemptResult,
  ExternalRoute,
  FailureReason,
  Gym,
  RouteTimer,
  RouteAttempt,
  UserRouteState,
  UserRouteStatus,
} from "./routeTypes.ts";
import { SEED_GYMS, SEED_ROUTES } from "./routeSeed.ts";

export interface CatalogMeta {
  updatedAt: string | null;
  status: string;
}

export interface RoutesDoc {
  version: 1;
  gyms: Gym[];
  routes: ExternalRoute[];
  states: Record<string, UserRouteState>;
  attempts: RouteAttempt[];
  timers: Record<string, RouteTimer>;
  catalogMeta: Record<string, CatalogMeta>;
}

const ROUTES_PK = "routes#v1";

function dataFile(): string {
  if (process.env.DATA_DIR) return join(process.env.DATA_DIR, "routes.json");
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "data", "routes.json");
}

export function seedDoc(): RoutesDoc {
  return {
    version: 1,
    gyms: structuredClone(SEED_GYMS),
    routes: structuredClone(SEED_ROUTES),
    states: {},
    attempts: [],
    timers: {},
    catalogMeta: {
      gym_berta: { updatedAt: null, status: "NOT_SUPPORTED" },
      gym_manual: { updatedAt: null, status: "NOT_SUPPORTED" },
    },
  };
}

function normalizeDoc(raw: unknown): RoutesDoc {
  const base = seedDoc();
  if (typeof raw !== "object" || raw === null) return base;
  const d = raw as Partial<RoutesDoc>;
  return {
    version: 1,
    gyms: Array.isArray(d.gyms) && d.gyms.length ? (d.gyms as Gym[]) : base.gyms,
    routes: Array.isArray(d.routes) ? (d.routes as ExternalRoute[]) : base.routes,
    states: typeof d.states === "object" && d.states !== null ? (d.states as RoutesDoc["states"]) : {},
    attempts: Array.isArray(d.attempts) ? (d.attempts as RouteAttempt[]) : [],
    timers: typeof d.timers === "object" && d.timers !== null ? (d.timers as RoutesDoc["timers"]) : {},
    catalogMeta: typeof d.catalogMeta === "object" && d.catalogMeta !== null
      ? (d.catalogMeta as RoutesDoc["catalogMeta"])
      : base.catalogMeta,
  };
}

async function loadDynamoDoc(table: string): Promise<RoutesDoc | null> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const doc = new DynamoDBDocumentClient(new DynamoDBClient({}));
  const res = (await doc.get({ TableName: table, Key: { pk: ROUTES_PK } })) as { Item?: { doc?: unknown } };
  if (!res.Item?.doc) return null;
  return normalizeDoc(res.Item.doc);
}

async function saveDynamoDoc(table: string, d: RoutesDoc): Promise<void> {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
  const doc = new DynamoDBDocumentClient(new DynamoDBClient({}));
  await doc.put({ TableName: table, Item: { pk: ROUTES_PK, doc: d } });
}

export async function loadRoutesDoc(): Promise<RoutesDoc> {
  if (process.env.TABLE_NAME) {
    return (await loadDynamoDoc(process.env.TABLE_NAME)) ?? seedDoc();
  }
  const file = dataFile();
  try {
    if (!existsSync(file)) return seedDoc();
    return normalizeDoc(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return seedDoc();
  }
}

export async function saveRoutesDoc(d: RoutesDoc): Promise<void> {
  if (process.env.TABLE_NAME) {
    await saveDynamoDoc(process.env.TABLE_NAME, d);
    return;
  }
  const file = dataFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(d, null, 1));
}

export function findRouteByCanonical(d: RoutesDoc, canonicalUrl: string): ExternalRoute | null {
  return d.routes.find((r) => r.canonicalUrl === canonicalUrl) ?? null;
}

export function findRouteById(d: RoutesDoc, id: string): ExternalRoute | null {
  return d.routes.find((r) => r.id === id) ?? null;
}

export function upsertRoute(d: RoutesDoc, route: ExternalRoute): ExternalRoute {
  const i = d.routes.findIndex((r) => r.id === route.id);
  if (i >= 0) d.routes[i] = route;
  else d.routes.push(route);
  return route;
}

export function newRouteId(provider: string): string {
  return `route_${provider}_${randomUUID().slice(0, 8)}`;
}

export function defaultState(routeId: string): UserRouteState {
  return {
    routeId,
    status: "DISCOVERED",
    priority: 0,
    notes: null,
    personalDifficulty: null,
    totalAttempts: 0,
    totalTimeSeconds: 0,
    sent: false,
    firstAttemptAt: null,
    lastAttemptAt: null,
    sentAt: null,
  };
}

export interface AttemptInput {
  clientAttemptId: string;
  routeId: string;
  workoutDate: string | null;
  exerciseId: string | null;
  result: AttemptResult;
  failureReason: FailureReason | null;
  perceivedDifficulty: number | null;
  restBeforeSeconds: number | null;
  climbingSeconds: number | null;
  notes: string | null;
}

// Idempotent: повтор с тем же clientAttemptId возвращает существующую попытку.
export function recordAttempt(d: RoutesDoc, input: AttemptInput, now: string): { attempt: RouteAttempt; created: boolean } {
  const existing = d.attempts.find((a) => a.clientAttemptId === input.clientAttemptId);
  if (existing) return { attempt: existing, created: false };
  const sameRoute = d.attempts.filter((a) => a.routeId === input.routeId);
  const attempt: RouteAttempt = {
    id: randomUUID(),
    clientAttemptId: input.clientAttemptId,
    routeId: input.routeId,
    workoutDate: input.workoutDate,
    exerciseId: input.exerciseId,
    attemptNumber: sameRoute.length + 1,
    startedAt: null,
    recordedAt: now,
    result: input.result,
    failureReason: input.failureReason,
    perceivedDifficulty: input.perceivedDifficulty,
    restBeforeSeconds: input.restBeforeSeconds,
    climbingSeconds: input.climbingSeconds,
    notes: input.notes,
  };
  d.attempts.push(attempt);
  const st = d.states[input.routeId] ?? defaultState(input.routeId);
  st.totalAttempts += 1;
  if (!st.firstAttemptAt) st.firstAttemptAt = now;
  st.lastAttemptAt = now;
  if (input.result === "SENT" || input.result === "FLASHED") {
    st.sent = true;
    st.sentAt = now;
    if (st.status !== "FLASHED" && input.result === "FLASHED") st.status = "FLASHED";
    else if (st.status !== "FLASHED" && st.status !== "SENT") st.status = "SENT";
  }
  d.states[input.routeId] = st;
  return { attempt, created: true };
}

export function setRouteStatus(
  d: RoutesDoc,
  routeId: string,
  status: UserRouteStatus,
  fields: { priority?: number; notes?: string | null; personalDifficulty?: number | null },
  now: string,
): UserRouteState {
  const st = d.states[routeId] ?? defaultState(routeId);
  const prev = st.status;
  st.status = status;
  if (fields.priority !== undefined) st.priority = Math.max(0, Math.min(5, fields.priority));
  if (fields.notes !== undefined) st.notes = fields.notes?.slice(0, 5000) ?? null;
  if (fields.personalDifficulty !== undefined) st.personalDifficulty = fields.personalDifficulty;
  if ((status === "SENT" || status === "FLASHED") && !st.sentAt) {
    st.sent = true;
    st.sentAt = now;
  }
  if (status !== "SENT" && status !== "FLASHED" && prev !== status) {
    // ручной откат статуса send не стирает историю попыток, только флаг — нет, историю храним:
    // sent остаётся true если была попытка SENT (история не удаляется, D-06).
  }
  d.states[routeId] = st;
  return st;
}

export function timerKey(workoutDate: string, routeId: string): string {
  return `${workoutDate}::${routeId}`;
}

export function startTimer(d: RoutesDoc, workoutDate: string, routeId: string, now: string): RouteTimer {
  const key = timerKey(workoutDate, routeId);
  const existing = d.timers[key];
  if (existing && existing.status === "RUNNING") return existing;
  const acc = existing?.accumulatedSeconds ?? 0;
  const t: RouteTimer = { routeId, workoutDate, status: "RUNNING", startedAt: now, stoppedAt: null, accumulatedSeconds: acc };
  d.timers[key] = t;
  return t;
}

export function stopTimer(d: RoutesDoc, workoutDate: string, routeId: string, now: string): RouteTimer {
  const key = timerKey(workoutDate, routeId);
  const existing = d.timers[key];
  if (!existing || existing.status !== "RUNNING") {
    const t: RouteTimer = { routeId, workoutDate, status: "STOPPED", startedAt: null, stoppedAt: now, accumulatedSeconds: existing?.accumulatedSeconds ?? 0 };
    d.timers[key] = t;
    return t;
  }
  const started = Date.parse(existing.startedAt ?? now);
  const ended = Date.parse(now);
  const delta = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.floor((ended - started) / 1000)) : 0;
  const t: RouteTimer = {
    routeId,
    workoutDate,
    status: "STOPPED",
    startedAt: existing.startedAt,
    stoppedAt: now,
    accumulatedSeconds: existing.accumulatedSeconds + delta,
  };
  d.timers[key] = t;
  const st = d.states[routeId] ?? defaultState(routeId);
  st.totalTimeSeconds += delta;
  d.states[routeId] = st;
  return t;
}
