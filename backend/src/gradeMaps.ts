// Шкала грейдов Berta Block -> normalizedDifficulty 0..10.
// Значения-шаблон из examples/integration_config.example.yaml пакета;
// калибровать после накопления истории (см. spec гл. 10).
// Формат raw: "6C/LILA" (technical/color), цвет без технического тоже возможен.

export interface GradeMapping {
  scaleId: string;
  version: string;
  map: Record<string, number>;
}

export const BERTA_V1: GradeMapping = {
  scaleId: "berta_v1",
  version: "berta_v1",
  map: {
    "5/GRÜN": 4.0,
    "5+/GRÜN": 4.5,
    "6A/BLAU": 5.0,
    "6A+/BLAU": 5.3,
    "6B/BLAU": 5.6,
    "6B+/LILA": 6.0,
    "6C/LILA": 6.4,
    "6C+/LILA": 6.8,
  },
};

export interface ParsedGrade {
  technical: string | null;
  gymColor: string | null;
  normalizedDifficulty: number | null;
  mappingVersion: string | null;
}

export function parseGrade(raw: string, scaleId: string | null): ParsedGrade {
  const trimmed = raw.trim();
  if (!trimmed) return { technical: null, gymColor: null, normalizedDifficulty: null, mappingVersion: null };
  const upper = trimmed.toUpperCase();
  let technical: string | null = null;
  let gymColor: string | null = null;
  if (upper.includes("/")) {
    const parts = upper.split("/");
    technical = parts[0]?.trim() || null;
    gymColor = parts[1]?.trim() || null;
  } else if (/^[0-9]/.test(upper)) {
    technical = upper;
  } else {
    gymColor = upper;
  }
  let normalized: number | null = null;
  let version: string | null = null;
  if (scaleId === BERTA_V1.scaleId) {
    const hit = BERTA_V1.map[upper];
    if (typeof hit === "number") {
      normalized = hit;
      version = BERTA_V1.version;
    }
  }
  return { technical, gymColor, normalizedDifficulty: normalized, mappingVersion: version };
}
