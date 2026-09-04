// Домен интеграции трасс (BETA7 + ручные залы).
// Адаптация contracts/typescript_models.ts из BETA7-пакета под наш стек:
// PostgreSQL -> файл/Dynamo single-table (см. routeStore.ts), API -> /api/*,
// провайдерная абстракция сохранена, BETA7 — один из провайдеров.
// Erasable syntax only (interfaces + type aliases).

export type IntegrationMode = "FULL" | "SCAN_ONLY" | "CATALOG_ONLY" | "MANUAL";

export type RouteAvailability = "ACTIVE" | "POSSIBLY_REMOVED" | "ARCHIVED" | "UNKNOWN";

export type UserRouteStatus =
  | "DISCOVERED"
  | "WANT_TO_TRY"
  | "PLANNED"
  | "PROJECTING"
  | "SENT"
  | "FLASHED"
  | "SKIPPED";

export type AttemptResult = "FAILED" | "SENT" | "FLASHED" | "ABORTED" | "SKIPPED";

export type FailureReason =
  | "START"
  | "MOVE_UNCLEAR"
  | "FOOT_SLIP"
  | "HOLD_FAILURE"
  | "POWER"
  | "ENDURANCE"
  | "REACH"
  | "FEAR"
  | "FATIGUE"
  | "PAIN_OR_DISCOMFORT"
  | "OTHER";

export interface ProviderCapabilities {
  qrLookup: boolean;
  gymCatalog: boolean;
  routeDetails: boolean;
  externalLink: boolean;
  personalHistoryImport: boolean;
  writeBackSend: boolean;
}

export interface Gym {
  id: string;
  name: string;
  city: string;
  provider: string | null;
  externalId: string | null;
  integrationMode: IntegrationMode;
  gradeScaleId: string | null;
  capabilities: ProviderCapabilities;
  catalogStatus?: string | undefined;
  catalogUpdatedAt?: string | null | undefined;
  routeCount?: number | undefined;
}

export interface Grade {
  raw: string;
  technical: string | null;
  gymColor: string | null;
  normalizedDifficulty: number | null;
  mappingVersion: string | null;
}

export interface ExternalRoute {
  id: string;
  provider: string;
  externalId: string;
  canonicalUrl: string;
  gymId: string;
  gymName: string;
  sector: string | null;
  name: string | null;
  holdDescription: string | null;
  holdColor: string | null;
  grade: Grade;
  styles: string[];
  setter: string | null;
  availability: RouteAvailability;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  sourceFetchedAt: string;
}

export interface UserRouteState {
  routeId: string;
  status: UserRouteStatus;
  priority: number;
  notes: string | null;
  personalDifficulty: number | null;
  totalAttempts: number;
  totalTimeSeconds: number;
  sent: boolean;
  firstAttemptAt: string | null;
  lastAttemptAt: string | null;
  sentAt: string | null;
}

export interface RouteAttempt {
  id: string;
  clientAttemptId: string;
  routeId: string;
  workoutDate: string | null;
  exerciseId: string | null;
  attemptNumber: number;
  startedAt: string | null;
  recordedAt: string;
  result: AttemptResult;
  failureReason: FailureReason | null;
  perceivedDifficulty: number | null;
  restBeforeSeconds: number | null;
  climbingSeconds: number | null;
  notes: string | null;
}

export interface RouteTimer {
  routeId: string;
  workoutDate: string;
  status: "RUNNING" | "STOPPED";
  startedAt: string | null;
  stoppedAt: string | null;
  accumulatedSeconds: number;
}

export interface RouteWithPersonal {
  route: ExternalRoute;
  personalState: UserRouteState | null;
}

export const ROUTE_STATUSES: UserRouteStatus[] = [
  "DISCOVERED",
  "WANT_TO_TRY",
  "PLANNED",
  "PROJECTING",
  "SENT",
  "FLASHED",
  "SKIPPED",
];

export const FAILURE_REASONS: FailureReason[] = [
  "START",
  "MOVE_UNCLEAR",
  "FOOT_SLIP",
  "HOLD_FAILURE",
  "POWER",
  "ENDURANCE",
  "REACH",
  "FEAR",
  "FATIGUE",
  "PAIN_OR_DISCOMFORT",
  "OTHER",
];

export const FAILURE_REASON_RU: Record<FailureReason, string> = {
  START: "Старт",
  MOVE_UNCLEAR: "Не понял движение",
  FOOT_SLIP: "Сорвались ноги",
  HOLD_FAILURE: "Не удержал зацеп",
  POWER: "Не хватило силы",
  ENDURANCE: "Не хватило выносливости",
  REACH: "Не хватило размаха",
  FEAR: "Страшно делать движение",
  FATIGUE: "Устал",
  PAIN_OR_DISCOMFORT: "Боль или дискомфорт",
  OTHER: "Другое",
};

export const ROUTE_STATUS_RU: Record<UserRouteStatus, string> = {
  DISCOVERED: "Увидел",
  WANT_TO_TRY: "Хочу попробовать",
  PLANNED: "В плане",
  PROJECTING: "Проект",
  SENT: "Сделал",
  FLASHED: "Флеш",
  SKIPPED: "Пропустил",
};
