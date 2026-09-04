// QR-resolve и каталог: адаптация api/openapi.yaml + implementation/parser_contract.md.
// Scan-only режим (spec гл. 16): внешнего fetch к beta7.app НЕТ до
// письменного разрешения — резолвим только известные маршруты из кэша
// либо создаём minimal-запись (класс A: provider/externalId/canonical)
// с ручным обогащением. SSRF-поверхности нет: payload используется
// только для нормализации, никогда как fetch-URL.
import type { ExternalRoute, Gym } from "./routeTypes.ts";
import {
  normalizeBeta7RouteUrl,
  UnsafeExternalUrlError,
  UnsupportedQrPayloadError,
} from "./beta7.ts";
import { parseGrade } from "./gradeMaps.ts";
import { parseRoutePage } from "./beta7parse.ts";
import { applyParsedRoute, gymIdForHandle, type PageFetcher } from "./catalogSync.ts";
import {
  defaultState,
  findRouteByCanonical,
  newRouteId,
  upsertRoute,
  type RoutesDoc,
} from "./routeStore.ts";

export interface QrResolveResult {
  matched: boolean;
  provider: string | null;
  route: ExternalRoute | null;
  personalState: RoutesDoc["states"][string] | null;
  fieldConfidence: Record<string, number>;
  warnings: string[];
  manualFallback: { allowed: boolean; suggestedFields: string[] };
}

const MANUAL_FIELDS = ["gymId", "sector", "gradeRaw", "name", "styles"];

export type PhotoValidation = { ok: true; value: string | null } | { ok: false };

// Фото трассы: https-ссылка (<=2000) или сжатое data:image (<=150KB — весь
// routes-документ лежит одним item в Dynamo, раздувать нельзя).
// undefined = поле не передавали, null = убрать фото.
export function parsePhotoUrl(v: unknown): PhotoValidation {
  if (v === undefined) return { ok: true, value: null };
  if (v === null) return { ok: true, value: null };
  if (typeof v !== "string" || !v) return { ok: false };
  if (v.startsWith("https://") && v.length <= 2000 && !/["'\s<>]/.test(v)) {
    return { ok: true, value: v };
  }
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 150000) {
    return { ok: true, value: v };
  }
  return { ok: false };
}

export function resolveQr(doc: RoutesDoc, payload: unknown, selectedGymId: unknown): QrResolveResult {
  if (typeof payload !== "string" || !payload.trim() || payload.length > 2048) {
    throw new UnsupportedQrPayloadError("QR payload is empty or too long");
  }
  let norm: { provider: string; externalId: string; canonicalUrl: string };
  try {
    norm = normalizeBeta7RouteUrl(payload);
  } catch (e) {
    if (e instanceof UnsafeExternalUrlError) throw e;
    throw e instanceof UnsupportedQrPayloadError ? e : new UnsupportedQrPayloadError("Unsupported QR payload");
  }

  const now = new Date().toISOString();
  const existing = findRouteByCanonical(doc, norm.canonicalUrl);
  const gymId = typeof selectedGymId === "string" && selectedGymId ? selectedGymId : "gym_berta";
  const gym = doc.gyms.find((g) => g.id === gymId) ?? null;

  if (existing) {
    const warnings: string[] = [];
    if (typeof selectedGymId === "string" && selectedGymId && existing.gymId !== selectedGymId) {
      warnings.push(`Трасса из зала ${existing.gymName}, а выбрана другая тренировка.`);
    }
    return {
      matched: true,
      provider: norm.provider,
      route: existing,
      personalState: doc.states[existing.id] ?? null,
      fieldConfidence: { externalId: 1, gymId: 0.99, gradeRaw: 0.95, styles: 0.85 },
      warnings,
      manualFallback: { allowed: true, suggestedFields: MANUAL_FIELDS },
    };
  }

  // Новая валидная BETA7-ссылка, деталей нет (fetch отключён): minimal-запись.
  const route: ExternalRoute = {
    id: newRouteId("beta7"),
    provider: norm.provider,
    externalId: norm.externalId,
    canonicalUrl: norm.canonicalUrl,
    gymId: gym?.id ?? "gym_berta",
    gymName: gym?.name ?? "Berta Block Boulderhalle",
    sector: null,
    name: null,
    holdDescription: null,
    holdColor: null,
    grade: { raw: "", technical: null, gymColor: null, normalizedDifficulty: null, mappingVersion: null },
    styles: [],
    setter: null,
    availability: "UNKNOWN",
    photoUrl: null,
    photoSource: null,
    firstSeenAt: now,
    lastSeenAt: now,
    sourceFetchedAt: now,
  };
  upsertRoute(doc, route);
  if (!doc.states[route.id]) doc.states[route.id] = { ...defaultState(route.id), status: "DISCOVERED" };
  return {
    matched: true,
    provider: norm.provider,
    route,
    personalState: doc.states[route.id] ?? null,
    fieldConfidence: { externalId: 1, gymId: 0.5, gradeRaw: 0, styles: 0 },
    warnings: ["Трасса ещё без деталей: укажи сектор и грейд вручную. Детали подтянутся после разрешения BETA7."],
    manualFallback: { allowed: true, suggestedFields: MANUAL_FIELDS },
  };
}

export function isLiveRoutesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BETA7_OFF !== "1";
}

const REVALIDATE_AFTER_MS = 7 * 24 * 3600 * 1000;

// Live-вариант: кэш/минимальная запись + подтягивание открытой страницы
// трассы. Ошибка сети/парсера не блокирует пользователя (spec 17.1):
// возвращаем сохранённое + предупреждение, попытки пишутся как обычно.
export async function resolveQrLive(
  doc: RoutesDoc,
  payload: unknown,
  selectedGymId: unknown,
  fetchPage?: PageFetcher,
  now: string = new Date().toISOString(),
): Promise<QrResolveResult> {
  const base = resolveQr(doc, payload, selectedGymId);
  if (!fetchPage || !base.route || base.route.provider !== "beta7") return base;
  const fetchedAt = Date.parse(base.route.sourceFetchedAt);
  const stale = !Number.isFinite(fetchedAt) || Date.parse(now) - fetchedAt > REVALIDATE_AFTER_MS;
  if (base.route.grade.raw && !stale) return base;
  try {
    const norm = normalizeBeta7RouteUrl(typeof payload === "string" ? payload : "");
    const { html } = await fetchPage(norm.canonicalUrl);
    const parsed = parseRoutePage(html, norm.externalId, norm.canonicalUrl);
    if (!parsed.data.gradeRaw && !parsed.data.name) {
      return { ...base, warnings: [...base.warnings, "Страница не похожа на трассу — оставил сохранённое."] };
    }
    const gymId = gymIdForHandle(doc, parsed.data.gymHandle, base.route.gymId);
    const { route } = applyParsedRoute(doc, gymId, parsed.data, now);
    const warnings = [...parsed.warnings];
    if (typeof selectedGymId === "string" && selectedGymId && route.gymId !== selectedGymId) {
      warnings.push(`Трасса из зала ${route.gymName}, а выбрана другая тренировка.`);
    }
    if (base.route.grade.raw === "") {
      warnings.push("Детали подтянуты с открытой страницы BETA7.");
    }
    return {
      matched: true,
      provider: "beta7",
      route,
      personalState: doc.states[route.id] ?? null,
      fieldConfidence: { externalId: 1, ...parsed.fieldConfidence },
      warnings,
      manualFallback: { allowed: true, suggestedFields: MANUAL_FIELDS },
    };
  } catch {
    return { ...base, warnings: [...base.warnings, "Не смог подтянуть детали с сайта — работаем с сохранённым."] };
  }
}

export interface ManualRouteInput {
  gymId: string;
  sector?: string | null;
  name?: string | null;
  gradeRaw?: string;
  styles?: string[];
  setter?: string | null;
  holdDescription?: string | null;
  photoUrl?: string | null;
}

// Ручной ввод / обогащение (fallback из spec гл. 17.2). Для BETA7-зала без
// QR создаёт manual-запись; существующую minimal-запись дополняет.
export function createManualRoute(doc: RoutesDoc, input: ManualRouteInput, now: string): ExternalRoute {
  const gym: Gym | undefined = doc.gyms.find((g) => g.id === input.gymId);
  if (!gym) throw new Error("unknown gym");
  const gradeRaw = (input.gradeRaw ?? "").trim();
  const g = parseGrade(gradeRaw, gym.gradeScaleId);
  const styles = Array.isArray(input.styles)
    ? input.styles.map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  const photo = parsePhotoUrl(input.photoUrl ?? null);
  if (!photo.ok) throw new Error("bad photoUrl");
  const route: ExternalRoute = {
    id: newRouteId(gym.provider ?? "manual"),
    provider: gym.provider ?? "manual",
    externalId: `manual-${Date.now().toString(36)}`,
    canonicalUrl: "",
    gymId: gym.id,
    gymName: gym.name,
    sector: input.sector?.trim() || null,
    name: input.name?.trim() || null,
    holdDescription: input.holdDescription?.trim() || input.name?.trim() || null,
    holdColor: null,
    grade: {
      raw: gradeRaw,
      technical: g.technical,
      gymColor: g.gymColor,
      normalizedDifficulty: g.normalizedDifficulty,
      mappingVersion: g.mappingVersion,
    },
    styles,
    setter: input.setter?.trim() || null,
    availability: "ACTIVE",
    photoUrl: photo.value,
    photoSource: photo.value ? "manual" : null,
    firstSeenAt: now,
    lastSeenAt: now,
    sourceFetchedAt: now,
  };
  upsertRoute(doc, route);
  return route;
}

export function enrichRoute(
  doc: RoutesDoc,
  routeId: string,
  patch: { sector?: string | null; name?: string | null; gradeRaw?: string; styles?: string[]; setter?: string | null; photoUrl?: string | null },
  now: string,
): ExternalRoute {
  const route = doc.routes.find((r) => r.id === routeId);
  if (!route) throw new Error("unknown route");
  const gym = doc.gyms.find((g) => g.id === route.gymId);
  if (patch.sector !== undefined) route.sector = patch.sector?.trim() || null;
  if (patch.name !== undefined) {
    route.name = patch.name?.trim() || null;
    if (!route.holdDescription) route.holdDescription = route.name;
  }
  if (patch.setter !== undefined) route.setter = patch.setter?.trim() || null;
  if (patch.photoUrl !== undefined) {
    const photo = parsePhotoUrl(patch.photoUrl);
    if (!photo.ok) throw new Error("bad photoUrl");
    route.photoUrl = photo.value;
    route.photoSource = photo.value ? "manual" : null;
  }
  if (patch.styles !== undefined) {
    route.styles = patch.styles.map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 12);
  }
  if (patch.gradeRaw !== undefined) {
    const raw = patch.gradeRaw.trim();
    const g = parseGrade(raw, gym?.gradeScaleId ?? null);
    route.grade = {
      raw,
      technical: g.technical,
      gymColor: g.gymColor,
      normalizedDifficulty: g.normalizedDifficulty,
      mappingVersion: g.mappingVersion,
    };
  }
  route.lastSeenAt = now;
  return route;
}

export interface RouteListFilter {
  gymId: string;
  availability?: string;
  difficultyMin?: number;
  difficultyMax?: number;
  styles?: string[];
  excludeSent?: boolean;
  limit?: number;
}

export function listGymRoutes(doc: RoutesDoc, f: RouteListFilter): ExternalRoute[] {
  const styles = (f.styles ?? []).map((s) => s.toLowerCase());
  let out = doc.routes.filter((r) => r.gymId === f.gymId);
  if (f.availability) out = out.filter((r) => r.availability === f.availability);
  if (typeof f.difficultyMin === "number") {
    out = out.filter((r) => (r.grade.normalizedDifficulty ?? -1) >= f.difficultyMin!);
  }
  if (typeof f.difficultyMax === "number") {
    out = out.filter((r) => (r.grade.normalizedDifficulty ?? 99) <= f.difficultyMax!);
  }
  if (styles.length) out = out.filter((r) => r.styles.some((s) => styles.includes(s.toLowerCase())));
  if (f.excludeSent) out = out.filter((r) => !doc.states[r.id]?.sent);
  out.sort((a, b) => (a.grade.normalizedDifficulty ?? 99) - (b.grade.normalizedDifficulty ?? 99));
  return out.slice(0, Math.max(1, Math.min(100, f.limit ?? 50)));
}
