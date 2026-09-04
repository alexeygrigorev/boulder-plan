// Минимальный API-клиент. Одинаково работает против vite-proxy и Lambda URL.
export interface PlanBlock {
  id: string;
  start: string;
  end: string;
  minutes: number;
  kind: string;
  requirement: string;
  title: string;
  text: string;
  intensity: string | null;
  caution: string | null;
  section: string;
}

export interface PlanDay {
  date: string;
  title: string;
  format: string | null;
  theme: string | null;
  cue: string | null;
  requiredMinutes: number;
  blocks: PlanBlock[];
  sections: { heading: string; body: string }[];
  week: string;
}

export interface DayMetrics {
  shoulder?: number;
  fingers?: number;
  knee?: number;
  energy?: number;
}

export interface DayProgress {
  date: string;
  checks: Record<string, boolean>;
  note: string;
  metrics?: DayMetrics;
  notes?: Record<string, string>;
  updatedAt?: string;
}

export interface DaySummary {
  date: string;
  title: string;
  format: string | null;
  theme: string | null;
  week: string;
  requiredMinutes: number;
  blocks: number;
}

export interface LibraryEntryFull {
  id: string;
  title: string;
  body: string;
  coaching?: string;
}

export interface PlanWeekFull {
  id: string;
  title: string;
  dates: string;
  theme: string | null;
  cue: string | null;
  sections: { heading: string; body: string }[];
  resources: string[];
  days: { date: string; title: string; format: string | null; requiredMinutes: number; blocks: number }[];
}

export interface ResourceItem {
  id: string;
  title: string;
  url: string;
  type: string;
  minutes: string;
  task: string;
}

export interface GlossaryTerm {
  term: string;
  explanation: string;
}

export interface ActivityDay {
  date: string;
  title: string;
  format: string | null;
  kind: "workout" | "sunday" | "regular";
  requiredMinutes: number;
  requiredTotal: number;
  done: number;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    let msg = `${url}: ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.message ?? j.error ?? msg;
    } catch { /* keep status */ }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE", headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export class AuthError extends Error {
  constructor() {
    super("unauthorized");
  }
}

const TOKEN_KEY = "bp:token";

export interface AuthConfig {
  enabled: boolean;
  base_url?: string;
  client_id?: string;
  callback_url?: string;
  logout_url?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

interface OidcPending {
  verifier: string;
  state: string;
  nonce: string;
  returnTo: string;
}

export interface Gym {
  id: string;
  name: string;
  city: string;
  provider: string | null;
  integrationMode: string;
  catalogStatus?: string;
  catalogUpdatedAt?: string | null;
  routeCount?: number;
}

export interface RouteGrade {
  raw: string;
  technical: string | null;
  gymColor: string | null;
  normalizedDifficulty: number | null;
}

export interface RouteItem {
  id: string;
  provider: string;
  externalId: string;
  canonicalUrl: string;
  gymId: string;
  gymName: string;
  sector: string | null;
  name: string | null;
  holdDescription: string | null;
  grade: RouteGrade;
  styles: string[];
  setter: string | null;
  availability: string;
  photoUrl: string | null;
  photoSource: "beta7" | "manual" | null;
}

export interface RoutePersonalState {
  routeId: string;
  status: string;
  priority: number;
  notes: string | null;
  totalAttempts: number;
  totalTimeSeconds: number;
  sent: boolean;
  lastAttemptAt: string | null;
}

export interface RouteWithPersonal {
  route: RouteItem;
  personalState: RoutePersonalState | null;
}

export interface QrResolveOut {
  matched: boolean;
  provider: string | null;
  route: RouteItem | null;
  personalState: RoutePersonalState | null;
  fieldConfidence: Record<string, number>;
  warnings: string[];
  manualFallback: { allowed: boolean; suggestedFields: string[] };
  code?: string;
  message?: string;
}

export interface RouteAttempt {
  id: string;
  attemptNumber: number;
  recordedAt: string;
  result: string;
  failureReason: string | null;
  workoutDate: string | null;
}

export interface RouteCard {
  route: RouteItem;
  personalState: RoutePersonalState | null;
  attempts: RouteAttempt[];
  timers: { status: string; accumulatedSeconds: number }[];
}

export interface RecommendationCandidate {
  route: RouteWithPersonal;
  score: number;
  reasons: string[];
  alternatives: { route: RouteWithPersonal; reason: string }[];
}

export const api = {
  days: () => get<{ period: { from: string; to: string }; days: DaySummary[] }>("/api/days"),
  plan: (date: string) => get<PlanDay>(`/api/plan?date=${date}`),
  progress: (date: string) =>
    get<DayProgress>(`/api/progress?date=${date}`),
  saveProgress: (date: string, checks: Record<string, boolean>, note: string, metrics?: DayMetrics, notes?: Record<string, string>) =>
    put<DayProgress>(`/api/progress`, { date, checks, note, ...(metrics ? { metrics } : {}), ...(notes ? { notes } : {}) }),
  library: () => get<{ id: string; title: string }[]>("/api/library"),
  libraryEntry: (id: string) => get<LibraryEntryFull>(`/api/library/entry?id=${id}`),
  doc: (id: string) => get<{ id: string; title: string; body: string }>(`/api/doc?id=${id}`),
  week: (id: string) => get<PlanWeekFull>(`/api/week?id=${id}`),
  resources: () => get<ResourceItem[]>("/api/resources"),
  glossary: () => get<GlossaryTerm[]>("/api/glossary"),
  activity: (from: string, to: string) =>
    get<{ from: string; to: string; days: ActivityDay[] }>(`/api/activity?from=${from}&to=${to}`),
  me: () => get<{ enabled: boolean; email: string | null }>("/api/auth/me"),
  gyms: () => get<{ gyms: Gym[] }>("/api/gyms"),
  gymRoutes: (gymId: string) =>
    get<{ items: RouteWithPersonal[]; catalog: { status: string; warning: string | null } }>(
      `/api/gym/routes?gymId=${encodeURIComponent(gymId)}`,
    ),
  syncGym: (gymId: string) =>
    post<{ discovered: number; updated: number; totalSeen: number; warnings: string[] }>(
      "/api/gym/sync",
      { gymId },
    ),
  resolveQr: (payload: string, selectedGymId: string | null) =>
    post<QrResolveOut>("/api/qr/resolve", { payload, selectedGymId }),
  createRoute: (body: Record<string, unknown>) =>
    post<{ route: RouteItem }>("/api/gym/routes", body),
  enrichRoute: (id: string, patch: Record<string, unknown>) =>
    put<{ route: RouteItem }>(`/api/gym/route`, { id, patch }),
  routeCard: (id: string) => get<RouteCard>(`/api/route?id=${encodeURIComponent(id)}`),
  setRouteState: (routeId: string, status: string) =>
    put<RoutePersonalState>(`/api/route/state`, { routeId, status }),
  addAttempt: (body: Record<string, unknown>) =>
    post<RouteAttempt>("/api/route/attempts", body),
  deleteAttempt: (id: string) =>
    del<{ deleted: string; routeId: string }>(`/api/route/attempts?id=${encodeURIComponent(id)}`),
  timerStart: (routeId: string, workoutDate: string) =>
    post<{ status: string; accumulatedSeconds: number }>("/api/route/timer/start", { routeId, workoutDate }),
  timerStop: (routeId: string, workoutDate: string) =>
    post<{ status: string; accumulatedSeconds: number }>("/api/route/timer/stop", { routeId, workoutDate }),
  recommend: (gymId: string, exercises: Record<string, unknown>[]) =>
    post<{ exercises: { exerciseId: string; candidates: RecommendationCandidate[]; relaxations: string[] }[] }>(
      "/api/recommendations",
      { gymId, exercises },
    ),
};

export const auth = {
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clearToken: () => localStorage.removeItem(TOKEN_KEY),

  getConfig: () => get<AuthConfig>("/api/auth/config"),

  beginLogin: async (returnTo = "/") => {
    const config = await get<AuthConfig>("/api/auth/config");
    if (!config.enabled || !config.base_url || !config.client_id || !config.callback_url) {
      throw new Error("Вход через Google не настроен");
    }
    const random = (n: number) => base64Url(crypto.getRandomValues(new Uint8Array(n)));
    const verifier = random(64);
    const state = random(32);
    const nonce = random(32);
    const challenge = base64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    const pending: OidcPending = { verifier, state, nonce, returnTo };
    sessionStorage.setItem("oidc_login", JSON.stringify(pending));
    const query = new URLSearchParams({
      response_type: "code",
      client_id: config.client_id,
      redirect_uri: config.callback_url,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      identity_provider: "Google",
    });
    window.location.assign(`${config.base_url}/oauth2/authorize?${query}`);
  },

  completeLogin: async (code: string, state: string): Promise<string> => {
    const raw = sessionStorage.getItem("oidc_login");
    sessionStorage.removeItem("oidc_login");
    const pending = (raw ? JSON.parse(raw) : undefined) as OidcPending | undefined;
    if (!pending?.verifier || !pending.nonce || pending.state !== state) {
      throw new Error("Протухшая ссылка входа — попробуй ещё раз");
    }
    const res = await fetch("/api/auth/callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pending.verifier, nonce: pending.nonce }),
    });
    if (!res.ok) throw new Error("Вход не удался");
    const data = (await res.json()) as { access: string };
    localStorage.setItem(TOKEN_KEY, data.access);
    return pending.returnTo || "/";
  },

  logout: async () => {
    localStorage.removeItem(TOKEN_KEY);
    try {
      const config = await get<AuthConfig>("/api/auth/config");
      if (config.enabled && config.base_url && config.client_id && config.logout_url) {
        const query = new URLSearchParams({ client_id: config.client_id, logout_uri: config.logout_url });
        window.location.assign(`${config.base_url}/logout?${query}`);
        return;
      }
    } catch {
      /* уже вышли локально */
    }
    window.location.assign("/");
  },
};

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T12:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
