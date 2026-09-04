// Парсер публичных страниц BETA7 (без API).
// Стратегия из implementation/parser_contract.md: несколько независимых
// источников (og:*, title, h1, semantic spans), confidence по полям,
// warnings при несогласованности. Не привязываемся к minified CSS-классам
// Angular (ng-*) — только к семантическим хукам.
// Класс D (beta-видео, комментарии, чужие профили) не импортируется.

export const BETA7_PARSER_VERSION = "beta7html_v1";

export interface ParsedBeta7Route {
  provider: "beta7";
  externalId: string;
  canonicalUrl: string;
  gymHandle: string | null;
  sector: string | null;
  name: string | null;
  holdDescription: string | null;
  holdColor: string | null;
  gradeRaw: string;
  styles: string[];
  setter: string | null;
  sends: number | null;
  posts: number | null;
  ageText: string | null;
}

export interface ParsedPage<T> {
  status: "ok" | "partial";
  data: T;
  fieldConfidence: Record<string, number>;
  warnings: string[];
  parserVersion: string;
  unknownTokens: string[];
}

// Подтверждено fixtures (title-атрибуты на странице трассы).
const STYLE_EMOJI: Record<string, string> = {
  "💃": "footwork",
  "🧬": "complexity",
  "🔬": "technic",
  "🧘": "balance",
};

export function styleFromEmoji(emoji: string): string | null {
  const base = emoji.replace(/[\uFE0F\u200D\u2640\u2642]/gu, "");
  return STYLE_EMOJI[base] ?? STYLE_EMOJI[emoji] ?? null;
}

function unescapeOnce(s: string): string {
  return s
    .replace(/&#x2F;/gi, "/")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function unescape(s: string): string {
  // Источник местами двойно экранирован (&amp;#x2F;) — два прохода.
  const once = unescapeOnce(s);
  return once === s ? once : unescapeOnce(once);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const t = stripTags(unescape(s)).trim().replace(/\s{2,}/g, " ");
  return t || null;
}

function stripEmoji(s: string): string {
  return s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s{2,}/g, " ").trim();
}

function isGradeToken(tok: string): boolean {
  return /^[0-9][A-Za-z0-9+]*(\/[^\s]+)?$/u.test(tok);
}

function firstGroup(re: RegExp, html: string): string | null {
  const m = re.exec(html);
  return m?.[1] !== undefined ? m[1] : null;
}

export function parseRoutePage(
  html: string,
  externalId: string,
  canonicalUrl: string,
): ParsedPage<ParsedBeta7Route> {
  const warnings: string[] = [];
  const fieldConfidence: Record<string, number> = { externalId: 1 };
  const unknownTokens: string[] = [];

  const ogUrl = firstGroup(/<meta property="og:url" content="([^"]+)"/, html);
  if (ogUrl && ogUrl !== canonicalUrl) warnings.push("og:url differs from QR canonical URL");

  const title = cleanText(firstGroup(/<title>(.*?)<\/title>/s, html));
  const description = cleanText(firstGroup(/<meta name="description" content="(.*?)"\s*\/?>/s, html));
  const h1 = firstGroup(/<h1.*?>(.*?)<\/h1>/s, html) ?? "";

  // Имя + грейд из title: "name emoji grade • ...".
  let name: string | null = null;
  let gradeFromTitle: string | null = null;
  if (title) {
    const head = title.split("•")[0]?.trim() ?? "";
    const toks = head.split(/\s+/);
    const last = toks[toks.length - 1] ?? "";
    if (isGradeToken(last)) {
      gradeFromTitle = last;
      name = stripEmoji(toks.slice(0, -1).join(" ")) || null;
    } else {
      name = stripEmoji(head) || null;
      warnings.push("grade not found in title");
    }
  } else {
    warnings.push("title missing");
  }

  // Грейд: кросс-чек title × description × .fb спан (что есть).
  const fbGrade = cleanText(firstGroup(/<span class="fb[^"]*">([^<]*)<\/span>/, html));
  const gradeFromDesc = description
    ? (description.split(/\s+/).find((t) => isGradeToken(t) && /[A-Za-z/]/u.test(t)) ?? null)
    : null;
  let gradeRaw = gradeFromTitle ?? gradeFromDesc ?? fbGrade ?? "";
  const grades = [gradeFromTitle, gradeFromDesc, fbGrade].filter((g): g is string => Boolean(g));
  if (new Set(grades).size > 1) {
    warnings.push(`grade mismatch: ${grades.join(" vs ")}`);
  }
  if (!gradeRaw) warnings.push("grade missing");
  fieldConfidence.gradeRaw = !gradeRaw ? 0 : new Set(grades).size === 1 && grades.length > 1 ? 0.98 : 0.85;

  // Стили: слова из description + title-атрибуты в h1.
  const styles: string[] = [];
  if (description) {
    const lead = /^([\sa-z]+?)\s+boulder/u.exec(description)?.[1] ?? "";
    for (const w of lead.split(/\s+/)) {
      const t = w.trim().toLowerCase();
      if (t && !styles.includes(t)) styles.push(t);
    }
  }
  for (const m of h1.matchAll(/<span class="style[^"]*"[^>]*title="([^"]*)"/g)) {
    const t = (m[1] ?? "").trim().toLowerCase().replace(/^technique$/, "technic");
    if (t && !styles.includes(t)) styles.push(t);
  }
  fieldConfidence.styles = styles.length ? 0.85 : 0;
  if (!styles.length) warnings.push("styles not found");

  // Setter + gym + sector из description; cross-check по семантическим спанам.
  let setter: string | null = null;
  let gymHandle: string | null = null;
  let sector: string | null = null;
  if (description) {
    const handles = [...description.matchAll(/@([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? "");
    setter = handles[0] || null;
    gymHandle = handles[1] || null;
    sector = /\(([A-Za-zÄÖÜäöüß0-9 ]+)\)/.exec(description)?.[1]?.trim() || null;
  }
  const setterSpan = cleanText(firstGroup(/<span[^>]*class="user name[^"]*"[^>]*>([^<]*)<\/span>/, html));
  if (setterSpan && setter && setterSpan !== setter) warnings.push(`setter mismatch: ${setter} vs ${setterSpan}`);
  if (!setter && setterSpan) setter = setterSpan;
  const sectorSpan = cleanText(
    firstGroup(/<span class="sector[^"]*">([^<]*)<\/span>/, html) ??
      firstGroup(/<span class="additional-location-information[^"]*">([^<]*)<\/span>/, html),
  );
  if (sectorSpan && sector && sectorSpan !== sector) warnings.push(`sector mismatch: ${sector} vs ${sectorSpan}`);
  if (!sector) sector = sectorSpan;
  fieldConfidence.setter = setter ? (setterSpan && setterSpan === setter ? 0.95 : 0.85) : 0;
  fieldConfidence.sector = sector ? 0.9 : 0;
  fieldConfidence.gymHandle = gymHandle ? 0.95 : 0;
  if (!setter) warnings.push("setter not found");
  if (!gymHandle) warnings.push("gym handle not found");

  // Зацепы из h1: имена цветов + типы.
  const holdColors = [...h1.matchAll(/<span class="names[^"]*">(?:.*?)<span class="color[^"]*">([^<]*)<\/span>/gs)]
    .map((m) => cleanText(m[1]))
    .filter((x): x is string => Boolean(x));
  const holdTypes = cleanText(firstGroup(/<span class="holdtypes[^"]*">([^<]*)<\/span>/, h1));
  const holdColor = holdColors.length ? holdColors.join(" / ") : null;
  const holdDescription = [holdColor, holdTypes].filter(Boolean).join(" ") || name;
  fieldConfidence.holds = holdDescription ? 0.85 : 0;

  // Внешние счётчики — только как metrics, не как сложность (spec 14.2).
  const sends = description ? Number(/(\d+)\s+sends/.exec(description)?.[1] ?? NaN) : NaN;
  const posts = description ? Number(/(\d+)\s+posts/.exec(description)?.[1] ?? NaN) : NaN;

  const ageText = cleanText(firstGroup(/<time[^>]*>([^<]*)<\/time>/, html));
  if (!name) warnings.push("route name not found");

  return {
    status: warnings.length ? "partial" : "ok",
    data: {
      provider: "beta7",
      externalId,
      canonicalUrl,
      gymHandle,
      sector,
      name,
      holdDescription,
      holdColor,
      gradeRaw,
      styles,
      setter,
      sends: Number.isFinite(sends) ? sends : null,
      posts: Number.isFinite(posts) ? posts : null,
      ageText,
    },
    fieldConfidence,
    warnings,
    parserVersion: BETA7_PARSER_VERSION,
    unknownTokens,
  };
}

export interface ParsedCatalogRef {
  externalId: string;
  canonicalUrl: string;
  sector: string | null;
  gradeRaw: string;
  holdDescription: string | null;
  holdColor: string | null;
  styles: string[];
  setter: string | null;
  ageText: string | null;
}

export function parseCatalogPage(html: string): ParsedPage<ParsedCatalogRef[]> {
  const warnings: string[] = [];
  const unknownTokens: string[] = [];
  const refs: ParsedCatalogRef[] = [];

  const anchors = [...html.matchAll(/<a [^>]*href="(\/route\/[^"]+)"[^>]*>(.*?)<\/a>/gs)];
  if (!anchors.length) warnings.push("no route cards found");
  for (const a of anchors) {
    const href = a[1] ?? "";
    const body = a[2] ?? "";
    const idMatch = /^\/route\/([^/?#]+)/u.exec(href);
    if (!idMatch?.[1]) {
      warnings.push(`skipped card with bad href ${href.slice(0, 60)}`);
      continue;
    }
    const externalId = decodeURIComponent(idMatch[1]);
    const gradeRaw = cleanText(firstGroup(/<span class="fb[^"]*">([^<]*)<\/span>/, body)) ?? "";
    const setter = cleanText(firstGroup(/<span[^>]*class="user name[^"]*"[^>]*>([^<]*)<\/span>/, body));
    const holdColor = cleanText(firstGroup(/<span class="names[^"]*">(?:.*?)<span class="color[^"]*">([^<]*)<\/span>/s, body));
    const holdTypes = cleanText(firstGroup(/<span class="holdtypes[^"]*">([^<]*)<\/span>/, body));
    const sector = cleanText(firstGroup(/<span class="additional-location-information[^"]*">([^<]*)<\/span>/, body));
    const ageText = cleanText(firstGroup(/<time[^>]*>([^<]*)<\/time>/, body));
    const styles: string[] = [];
    for (const m of body.matchAll(/<span class="style[^"]*"[^>]*>([^<]*)<\/span>/g)) {
      const emoji = (m[1] ?? "").trim();
      if (!emoji) continue;
      const mapped = styleFromEmoji(emoji);
      if (mapped && !styles.includes(mapped)) styles.push(mapped);
      else if (!mapped && !unknownTokens.includes(emoji)) unknownTokens.push(emoji);
    }
    refs.push({
      externalId,
      canonicalUrl: `https://beta7.app/route/${encodeURIComponent(externalId)}`,
      sector,
      gradeRaw,
      holdDescription: [holdColor, holdTypes].filter(Boolean).join(" ") || null,
      holdColor,
      styles,
      setter,
      ageText,
    });
  }
  if (unknownTokens.length) warnings.push(`unknown style tokens: ${unknownTokens.join(" ")}`);
  return {
    status: warnings.length ? "partial" : "ok",
    data: refs,
    fieldConfidence: { cards: refs.length ? 0.9 : 0 },
    warnings,
    parserVersion: BETA7_PARSER_VERSION,
    unknownTokens,
  };
}
