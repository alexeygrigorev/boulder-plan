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

export interface ManualRouteInput {
  gymId: string;
  sector?: string | null;
  name?: string | null;
  gradeRaw?: string;
  styles?: string[];
  setter?: string | null;
  holdDescription?: string | null;
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
  patch: { sector?: string | null; name?: string | null; gradeRaw?: string; styles?: string[]; setter?: string | null },
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
