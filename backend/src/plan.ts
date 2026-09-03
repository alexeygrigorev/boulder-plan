// Загрузка content/plan.json с кэшем. Путь: $PLAN_PATH или ../content/plan.json.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanDay, PlanWeek, LibraryEntry, ResourceItem, GlossaryTerm } from "./types.ts";

interface PlanFile {
  meta: { title: string; period: { from: string; to: string }; days: number; weeks: number };
  days: PlanDay[];
  weeks: PlanWeek[];
  library: LibraryEntry[];
  docs: { id: string; title: string; body: string }[];
  resources: ResourceItem[];
  glossary: GlossaryTerm[];
}

let cache: PlanFile | null = null;

export function planPath(): string {
  if (process.env.PLAN_PATH && existsSync(process.env.PLAN_PATH)) return process.env.PLAN_PATH;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, "..", "..", "content", "plan.json");
  if (existsSync(candidate)) return candidate;
  const cwdCandidate = join(process.cwd(), "content", "plan.json");
  return cwdCandidate;
}

export function loadPlan(): PlanFile {
  if (cache) return cache;
  const raw = readFileSync(planPath(), "utf8");
  cache = JSON.parse(raw) as PlanFile;
  return cache;
}

export function clearPlanCache(): void {
  cache = null;
}
