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

export interface DaySummary {
  date: string;
  title: string;
  format: string | null;
  theme: string | null;
  week: string;
  requiredMinutes: number;
  blocks: number;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  days: () => get<{ period: { from: string; to: string }; days: DaySummary[] }>("/api/days"),
  plan: (date: string) => get<PlanDay>(`/api/plan?date=${date}`),
  progress: (date: string) =>
    get<{ date: string; checks: Record<string, boolean>; note: string }>(`/api/progress?date=${date}`),
  saveProgress: (date: string, checks: Record<string, boolean>, note: string) =>
    put(`/api/progress`, { date, checks, note }),
  library: () => get<{ id: string; title: string }[]>("/api/library"),
  libraryEntry: (id: string) => get<{ id: string; title: string; body: string }>(`/api/library/entry?id=${id}`),
  doc: (id: string) => get<{ id: string; title: string; body: string }>(`/api/doc?id=${id}`),
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
