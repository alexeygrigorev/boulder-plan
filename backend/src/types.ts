// Общие типы API. Erasable syntax only (interfaces + type aliases).

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

export interface PlanSection {
  heading: string;
  body: string;
}

export interface PlanDay {
  date: string;
  title: string;
  file: string;
  milestone: string;
  week: string;
  format: string | null;
  theme: string | null;
  cue: string | null;
  requiredMinutes: number;
  blocks: PlanBlock[];
  sections: PlanSection[];
}

export interface PlanWeek {
  id: string;
  title: string;
  file: string;
  dates: string;
  format: string | null;
  theme: string | null;
  cue: string | null;
  requiredMinutes?: number;
  sections: PlanSection[];
}

export interface LibraryEntry {
  id: string;
  title: string;
  body: string;
}

export interface ProgressEntry {
  date: string;
  checks: Record<string, boolean>;
  note?: string;
  updatedAt: string;
}
