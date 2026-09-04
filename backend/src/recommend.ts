// Рекомендации: порт implementation/recommendation_rules.md (rules_v1).
// Сначала правила, потом ML (D-10). Формула и порядок ослаблений — из пакета,
// данные — из нашего RoutesDoc (стили, попытки, статусы). ML-вероятности нет:
// predictedSendProbability — грубый heuristic-band, честно помеченный.
import type { ExternalRoute, UserRouteState } from "./routeTypes.ts";
import { assertDifficultyRange } from "./beta7.ts";
import type { RoutesDoc } from "./routeStore.ts";

export const RECOMMENDATION_VERSION = "rules_v1";

export interface ExerciseReq {
  id: string;
  targetCount: number;
  difficulty: { min: number; max: number };
  targetStyles: string[];
  excludeSent?: boolean;
  preferWantToTry?: boolean;
  selectionPolicy?: string;
}

export interface Candidate {
  route: ExternalRoute;
  personalState: UserRouteState | null;
  score: number;
  predictedSendProbability: number | null;
  expectedAttempts: { min: number; max: number } | null;
  reasons: string[];
  alternatives: { route: ExternalRoute; personalState: UserRouteState | null; reason: string }[];
}

export interface ExerciseRecs {
  exerciseId: string;
  candidates: Candidate[];
  relaxations: string[];
}

function styleStats(doc: RoutesDoc): Map<string, { attempts: number; sends: number }> {
  const m = new Map<string, { attempts: number; sends: number }>();
  for (const a of doc.attempts) {
    const route = doc.routes.find((r) => r.id === a.routeId);
    if (!route) continue;
    for (const s of route.styles) {
      const e = m.get(s) ?? { attempts: 0, sends: 0 };
      e.attempts += 1;
      if (a.result === "SENT" || a.result === "FLASHED") e.sends += 1;
      m.set(s, e);
    }
  }
  return m;
}

function weakestStyles(doc: RoutesDoc): Set<string> {
  const stats = styleStats(doc);
  let worst: string | null = null;
  let worstRate = 1;
  for (const [style, s] of stats) {
    if (s.attempts < 2) continue;
    const rate = s.sends / s.attempts;
    if (rate < worstRate) {
      worstRate = rate;
      worst = style;
    }
  }
  return worst ? new Set([worst]) : new Set();
}

function difficultyMatch(d: number | null, min: number, max: number): number {
  if (d === null) return 0.3;
  if (d >= min && d <= max) {
    const mid = (min + max) / 2;
    const half = Math.max(0.5, (max - min) / 2);
    return Math.max(0.6, 1 - Math.abs(d - mid) / (half * 2));
  }
  const edge = d < min ? min - d : d - max;
  return Math.max(0, 0.5 - edge / 2);
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 86400000);
}

export function recommendForExercise(
  doc: RoutesDoc,
  gymId: string,
  req: ExerciseReq,
  now: number,
): ExerciseRecs {
  assertDifficultyRange(req.difficulty.min, req.difficulty.max);
  const relaxations: string[] = [];
  const weak = weakestStyles(doc);
  const wantBoost = req.preferWantToTry !== false;
  const excludeSent = req.excludeSent !== false;
  const targets = req.targetStyles.map((s) => s.toLowerCase());

  const passes = (r: ExternalRoute, relaxed: number): boolean => {
    if (r.gymId !== gymId) return false;
    if (r.availability !== "ACTIVE") return false;
    const st = doc.states[r.id];
    if (excludeSent && relaxed < 2 && st?.sent) return false;
    const d = r.grade.normalizedDifficulty;
    const pad = relaxed >= 0 ? 0.5 : 0;
    if (d !== null && (d < req.difficulty.min - pad || d > req.difficulty.max + pad)) return false;
    if (targets.length && relaxed < 1) {
      const rs = r.styles.map((s) => s.toLowerCase());
      if (!targets.some((t) => rs.includes(t))) return false;
    }
    return true;
  };

  let pool: ExternalRoute[] = [];
  let relaxed = -1;
  const relaxLabels = [
    "расширили диапазон сложности ±0.5",
    "разрешили смежные стили",
    "разрешили повтор пройденных",
  ];
  for (let level = -1; level <= 2; level++) {
    pool = doc.routes.filter((r) => passes(r, level));
    if (pool.length > 0 || level === 2) {
      relaxed = level;
      break;
    }
    relaxations.push(relaxLabels[level + 1] ?? "");
  }
  if (relaxed > -1) relaxations.splice(relaxed + 1);

  const scored = pool.map((r) => {
    const st = doc.states[r.id] ?? null;
    const d = r.grade.normalizedDifficulty;
    const dm = difficultyMatch(d, req.difficulty.min, req.difficulty.max);
    const rs = r.styles.map((s) => s.toLowerCase());
    const sm = targets.length ? targets.filter((t) => rs.includes(t)).length / targets.length : 0.5;
    const weakHit = r.styles.some((s) => weak.has(s.toLowerCase())) ? 1 : weak.size ? 0 : 0.5;
    const want = st && (st.status === "WANT_TO_TRY" || st.status === "PLANNED") ? 1 : 0;
    const novelty = !st || st.totalAttempts === 0 ? 1 : st.sent ? 0 : 0.5;
    const recency = daysSince(st?.lastAttemptAt ?? null, now);
    const exposure = recency === null ? 0 : recency < 3 ? 1 : recency < 7 ? 0.5 : 0;
    const fit = d === null ? 0.4 : d >= 4.5 && d <= 6.5 ? 0.7 : 0.4;
    const score = 0.3 * dm + 0.25 * sm + 0.15 * weakHit + 0.12 * (wantBoost ? want : 0) +
      0.08 * novelty + 0.05 * 0.5 + 0.05 * fit - 0.1 * exposure;
    return { r, st, score, dm, sm, weakHit, want, novelty, fit };
  });
  scored.sort((a, b) => b.score - a.score);

  // Rerank: не больше двух подряд из одного сектора.
  const ordered: typeof scored = [];
  const sectorRun: string[] = [];
  const rest = [...scored];
  while (rest.length && ordered.length < Math.max(req.targetCount, 1)) {
    const idx = rest.findIndex((c) => {
      const n = sectorRun.length;
      if (n >= 2 && sectorRun[n - 1] === c.r.sector && sectorRun[n - 2] === c.r.sector) return false;
      return true;
    });
    const pick = rest.splice(idx === -1 ? 0 : idx, 1)[0];
    if (!pick) break;
    ordered.push(pick);
    sectorRun.push(pick.r.sector ?? "?");
  }

  const candidates: Candidate[] = ordered.map((c, i) => {
    const reasons: string[] = [];
    if (c.sm >= 1) reasons.push(`Подходит к упражнению: ${req.id}`);
    else if (c.sm > 0) reasons.push("Частично совпадает по стилю");
    if (c.st?.status === "WANT_TO_TRY") reasons.push("Добавлено в «Хочу попробовать»");
    if (c.novelty === 1) reasons.push("Ещё не пробовали");
    if (c.weakHit === 1) reasons.push("Зона роста по последним тренировкам");
    if (c.dm >= 0.8) reasons.push("Подходящая сложность");
    if (weak.size === 0) reasons.push("Мало данных — оценка по общим правилам");
    const alts = scored
      .filter((o) => o.r.id !== c.r.id && !ordered.slice(0, i + 1).some((p) => p.r.id === o.r.id))
      .slice(0, 2)
      .map((o) => ({
        route: o.r,
        personalState: o.st,
        reason: o.r.sector !== c.r.sector ? "Запасной вариант в соседнем секторе" : "Запасной вариант",
      }));
    const policy = (req.selectionPolicy ?? "").toLowerCase();
    const prob = policy.includes("warm") ? 0.8 : policy.includes("project") ? 0.45 : 0.6;
    return {
      route: c.r,
      personalState: c.st,
      score: Math.round(c.score * 1000) / 1000,
      predictedSendProbability: prob,
      expectedAttempts: policy.includes("project") ? { min: 3, max: 6 } : { min: 1, max: 3 },
      reasons: reasons.slice(0, 3),
      alternatives: alts,
    };
  });

  return { exerciseId: req.id, candidates, relaxations };
}

export function recommend(
  doc: RoutesDoc,
  gymId: string,
  exercises: ExerciseReq[],
  now: number,
): { exercises: ExerciseRecs[]; empty: boolean } {
  const out = exercises.map((e) => recommendForExercise(doc, gymId, e, now));
  return { exercises: out, empty: out.every((e) => e.candidates.length === 0) };
}
