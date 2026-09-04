// Сиды залов и пример трассы.
// Berta Block — публичные данные без авторизации (пример из пакета +
// fixtures backend/test/fixtures). Официальный API — out of scope
// (любительский проект, договариваться не идём): работаем только
// с открытыми страницами сайта.
import type { ExternalRoute, Gym } from "./routeTypes.ts";
import { parseGrade } from "./gradeMaps.ts";

export const SEED_GYMS: Gym[] = [
  {
    id: "gym_berta",
    name: "Berta Block Boulderhalle",
    city: "Berlin",
    provider: "beta7",
    externalId: "bertablock",
    integrationMode: "FULL",
    gradeScaleId: "berta_v1",
    catalogUrl: "https://beta7.app/location/bertablock/routes?hl=en",
    capabilities: {
      qrLookup: true,
      gymCatalog: true,
      routeDetails: true,
      externalLink: true,
      personalHistoryImport: false,
      writeBackSend: false,
    },
    catalogStatus: "PARTIAL",
    catalogUpdatedAt: null,
    routeCount: 1,
  },
  {
    id: "gym_manual",
    name: "Свой зал (без интеграции)",
    city: "—",
    provider: "manual",
    externalId: null,
    integrationMode: "MANUAL",
    gradeScaleId: null,
    capabilities: {
      qrLookup: false,
      gymCatalog: false,
      routeDetails: false,
      externalLink: false,
      personalHistoryImport: false,
      writeBackSend: false,
    },
  },
];

function seedRoute(): ExternalRoute {
  const raw = "6C/LILA";
  const g = parseGrade(raw, "berta_v1");
  return {
    id: "route_beta7_jzquGG3GoYgvvQzFrKXnzvecLwm2",
    provider: "beta7",
    externalId: "jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814",
    canonicalUrl: "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814",
    gymId: "gym_berta",
    gymName: "Berta Block Boulderhalle",
    sector: "Wave",
    name: "cornflower slopers & pinches",
    holdDescription: "cornflower slopers & pinches",
    holdColor: null,
    grade: {
      raw,
      technical: g.technical,
      gymColor: g.gymColor,
      normalizedDifficulty: g.normalizedDifficulty,
      mappingVersion: g.mappingVersion,
    },
    styles: ["footwork", "complexity", "technic", "balance"],
    setter: "fabi_pensel",
    availability: "ACTIVE",
    photoUrl: null,
    photoSource: null,
    firstSeenAt: "2026-09-03T00:00:00.000Z",
    lastSeenAt: "2026-09-03T00:00:00.000Z",
    sourceFetchedAt: "2026-09-03T13:20:15.000Z",
  };
}

export const SEED_ROUTES: ExternalRoute[] = [seedRoute()];
