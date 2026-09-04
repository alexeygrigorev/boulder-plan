// Связка кэша с публичными страницами BETA7 (без API).
// Правила sync из spec гл. 7, с одной честной поправкой: SSR каталога
// отдаёт только первые ~10 трасс (проверено 2026-09-04), полноту доказать
// нельзя → sync всегда PARTIAL и НИКОГДА не архивирует отсутствующие
// (spec 7.3: частичный sync не меняет availability). Каталог растёт от
// сканов + обновлений виденных трасс; удаление со стены отслеживается
// только тем, что трасса перестаёт встречаться (lastSeenAt).
import type { ExternalRoute } from "./routeTypes.ts";
import { parseGrade } from "./gradeMaps.ts";
import { BETA7_PARSER_VERSION, parseCatalogPage, parseRoutePage, type ParsedBeta7Route } from "./beta7parse.ts";
import {
  defaultState,
  newRouteId,
  upsertRoute,
  type RoutesDoc,
} from "./routeStore.ts";

export type PageFetcher = (url: string) => Promise<{ html: string }>;

export const SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000;

export function gymIdForHandle(doc: RoutesDoc, handle: string | null, fallbackGymId: string): string {
  if (handle) {
    const found = doc.gyms.find((g) => g.externalId === handle);
    if (found) return found.id;
  }
  return fallbackGymId;
}

export function applyParsedRoute(
  doc: RoutesDoc,
  gymId: string,
  parsed: ParsedBeta7Route,
  now: string,
): { route: ExternalRoute; isNew: boolean } {
  const byCanonical = doc.routes.find((r) => r.canonicalUrl === parsed.canonicalUrl) ?? null;
  const gym = doc.gyms.find((g) => g.id === gymId);
  const g = parseGrade(parsed.gradeRaw, gym?.gradeScaleId ?? null);
  if (byCanonical) {
    byCanonical.sector = parsed.sector ?? byCanonical.sector;
    byCanonical.name = parsed.name ?? byCanonical.name;
    byCanonical.holdDescription = parsed.holdDescription ?? byCanonical.holdDescription;
    byCanonical.holdColor = parsed.holdColor ?? byCanonical.holdColor;
    if (parsed.gradeRaw) {
      byCanonical.grade = {
        raw: parsed.gradeRaw,
        technical: g.technical,
        gymColor: g.gymColor,
        normalizedDifficulty: g.normalizedDifficulty,
        mappingVersion: g.mappingVersion,
      };
    }
    if (parsed.styles.length) byCanonical.styles = parsed.styles;
    byCanonical.setter = parsed.setter ?? byCanonical.setter;
    // Ручное фото важнее автоматного: сайт перезаписывает только пустое/своё.
    if (parsed.photoUrl && (!byCanonical.photoUrl || byCanonical.photoSource === "beta7")) {
      byCanonical.photoUrl = parsed.photoUrl;
      byCanonical.photoSource = "beta7";
    }
    byCanonical.availability = "ACTIVE";
    byCanonical.lastSeenAt = now;
    byCanonical.sourceFetchedAt = now;
    return { route: byCanonical, isNew: false };
  }
  const route: ExternalRoute = {
    id: newRouteId("beta7"),
    provider: "beta7",
    externalId: parsed.externalId,
    canonicalUrl: parsed.canonicalUrl,
    gymId,
    gymName: gym?.name ?? "Berta Block Boulderhalle",
    sector: parsed.sector,
    name: parsed.name,
    holdDescription: parsed.holdDescription,
    holdColor: parsed.holdColor,
    grade: {
      raw: parsed.gradeRaw,
      technical: g.technical,
      gymColor: g.gymColor,
      normalizedDifficulty: g.normalizedDifficulty,
      mappingVersion: g.mappingVersion,
    },
    styles: parsed.styles,
    setter: parsed.setter,
    availability: "ACTIVE",
    photoUrl: parsed.photoUrl,
    photoSource: parsed.photoUrl ? "beta7" : null,
    firstSeenAt: now,
    lastSeenAt: now,
    sourceFetchedAt: now,
  };
  upsertRoute(doc, route);
  if (!doc.states[route.id]) doc.states[route.id] = { ...defaultState(route.id), status: "DISCOVERED" };
  return { route, isNew: true };
}

export interface SyncResult {
  gymId: string;
  status: "PARTIAL" | "FAILED";
  discovered: number;
  updated: number;
  totalSeen: number;
  complete: false;
  warnings: string[];
  parserVersion: string;
  updatedAt: string;
}

// Частичный sync: добавляет/обновляет виденные, отсутствие не архивирует.
export function syncGymCatalogFromHtml(
  doc: RoutesDoc,
  gymId: string,
  html: string,
  now: string,
): SyncResult {
  const gym = doc.gyms.find((g) => g.id === gymId);
  if (!gym) throw new Error("unknown gym");
  const parsed = parseCatalogPage(html);
  let discovered = 0;
  let updated = 0;
  for (const ref of parsed.data) {
    const mapped: ParsedBeta7Route = {
      provider: "beta7",
      externalId: ref.externalId,
      canonicalUrl: ref.canonicalUrl,
      gymHandle: gym.externalId,
      sector: ref.sector,
      name: null,
      holdDescription: ref.holdDescription,
      holdColor: ref.holdColor,
      gradeRaw: ref.gradeRaw,
      styles: ref.styles,
      setter: ref.setter,
      sends: null,
      posts: null,
      photoUrl: null,
      ageText: ref.ageText,
    };
    const { isNew } = applyParsedRoute(doc, gymId, mapped, now);
    if (isNew) discovered += 1;
    else updated += 1;
  }
  doc.catalogMeta[gymId] = { updatedAt: now, status: "PARTIAL" };
  return {
    gymId,
    status: "PARTIAL",
    discovered,
    updated,
    totalSeen: parsed.data.length,
    complete: false,
    warnings: [
      "SSR каталога — только первые ~10 трасс: sync частичный, отсутствие трассы в нём ничего не значит.",
      ...parsed.warnings,
    ],
    parserVersion: BETA7_PARSER_VERSION,
    updatedAt: now,
  };
}

export function checkSyncRateLimit(doc: RoutesDoc, gymId: string, nowMs: number, force: boolean): string | null {
  if (force) return null;
  const at = doc.catalogMeta[gymId]?.updatedAt;
  if (!at) return null;
  const elapsed = nowMs - Date.parse(at);
  if (Number.isFinite(elapsed) && elapsed < SYNC_MIN_INTERVAL_MS) {
    const waitMin = Math.ceil((SYNC_MIN_INTERVAL_MS - elapsed) / 60000);
    return `Каталог недавно обновляли — подожди ~${waitMin} мин.`;
  }
  return null;
}

export { parseRoutePage };
