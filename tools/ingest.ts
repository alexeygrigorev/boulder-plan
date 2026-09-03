/**
 * Парсер исходного ZIP/MD-плана в content/plan.json.
 * Без внешних зависимостей — только node builtins.
 * Запуск: npm run ingest
 * Вход: $PLAN_ZIP (default /tmp/e95eb7a0-c641-4f90-b074-bafda44fc6c5.zip)
 *       или $PLAN_DIR (распакованный bouldering_plan_2026-09_to_2027-03)
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "content", "plan.json");
const ZIP = process.env.PLAN_ZIP ?? "/tmp/e95eb7a0-c641-4f90-b074-bafda44fc6c5.zip";
const DIR_HINTS = [
  process.env.PLAN_DIR ?? "",
  "/data/tmp/opencode/plan-inspect/bouldering_plan_2026-09_to_2027-03",
].filter(Boolean);

const RU_MONTHS: Record<string, string> = {
  "января": "01", "февраля": "02", "марта": "03", "апреля": "04",
  "мая": "05", "июня": "06", "июля": "07", "августа": "08",
  "сентября": "09", "октября": "10", "ноября": "11", "декабря": "12",
};

function findPlanDir(): string {
  for (const d of DIR_HINTS) {
    try { if (d && statSync(d).isDirectory()) return d; } catch { /* next */ }
  }
  if (!existsSync(ZIP)) throw new Error(`Нет ни PLAN_DIR, ни ZIP: ${ZIP}`);
  const tmp = mkdtempSync(join(tmpdir(), "boulder-plan-"));
  execSync(`unzip -o -q ${JSON.stringify(ZIP)} -d ${JSON.stringify(tmp)}`, { stdio: "inherit" });
  const inner = join(tmp, "bouldering_plan_2026-09_to_2027-03");
  if (existsSync(inner)) return inner;
  // найти первый каталог с 00_START
  for (const e of readdirSync(tmp)) {
    const c = join(tmp, e, "00_START");
    try { if (statSync(c).isDirectory()) return join(tmp, e); } catch { /* next */ }
  }
  throw new Error("Не нашёл корень плана в ZIP");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

function ruDateToIso(s: string): string | null {
  const m = s.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${RU_MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
}

function parseMeta(md: string) {
  const get = (re: RegExp) => md.match(re)?.[1]?.trim() ?? null;
  return {
    format: get(/\*\*Формат:\*\*\s*(.+)/),
    theme: get(/\*\*Тема недели:\*\*\s*(.+)/) ?? get(/\*\*Тема:\*\*\s*(.+)/),
    cue: get(/\*\*Главный cue:\*\*\s*(.+)/),
    requiredMinutes: (() => {
      const m = md.match(/\*\*Обязательное время сегодня:\*\*\s*примерно\s+(\d+)/);
      return m ? Number(m[1]) : 0;
    })(),
  };
}

interface Block {
  id: string; start: string; end: string; minutes: number;
  kind: string; requirement: string; title: string; text: string;
  intensity: string | null; caution: string | null; section: string;
}

function toMin(t: string): number {
  const [m, s] = t.split(":").map(Number);
  return m * 60 + s;
}

// Чистка «не делай»: запретительные блоки/секции в данные не попадают.
// Оставляем только «Когда закончить раньше» (острая боль/травма — безопасность).
const DROP_BLOCK_KIND = /^(запрет|сегодня намеренно нет)/i;
const DROP_SECTION = /намеренно нет тренировки хвата/i;
const DROP_ITEM = /^-\s+\[ \]\s*не было /i;

let droppedBlocks = 0, droppedSections = 0, droppedItems = 0;

function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const blocks: Block[] = [];
  let section = "";
  let i = 0, n = 0;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)/);
    if (h) { section = h[1].trim(); continue; }
    const m = line.match(/^- \[ \] \*\*(\d{1,3}:\d{2})\s*[–—-]\s*(\d{1,3}:\d{2})\s*·\s*(.+?)\s*·\s*(обязательно|опционально|по назначению физиотерапевта|выбрать один сценарий)\*\*\s*—\s*(.*)/);
    if (m) {
      const [, start, end, kind, requirement, rest] = m;
      if (DROP_BLOCK_KIND.test(kind.trim())) { droppedBlocks++; continue; }
      // kind вида "Самопроверка" а title после? формат: "время · kind · requirement — text"
      // но часть строк: "время · kind · requirement" где kind="Техника", а заголовка нет — берём kind как title
      const parts = kind.split("·").map((s) => s.trim());
      void parts;
      const chunk: string[] = [];
      // подклейка интенсивности; «Осторожность» не берём — только позитивные инструкции
      let j = i + 1;
      let intensity: string | null = null;
      const caution = null;
      while (j < lines.length) {
        const nl = lines[j];
        if (/^\s*-\s*Интенсивность:/.test(nl)) intensity = nl.replace(/^\s*-\s*Интенсивность:\s*/, "").trim();
        else if (/^\s*-\s*Осторожность:/.test(nl)) { /* пропускаем */ }
        else break;
        j++;
      }
      void chunk;
      n++;
      blocks.push({
        id: `b${String(n).padStart(2, "0")}`,
        start, end,
        minutes: Math.max(0, Math.round((toMin(end) - toMin(start)) / 60)),
        kind: kind.trim(), requirement: requirement.trim(),
        title: kind.trim(), text: rest.trim(),
        intensity, caution, section,
      });
    }
    i++;
  }
  return blocks;
}

function parseSections(md: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  const lines = md.split("\n");
  let cur: string | null = null, buf: string[] = [];
  const flush = () => {
    if (!cur) return;
    if (DROP_SECTION.test(cur)) { droppedSections++; return; }
    const kept = buf.filter((l) => {
      if (DROP_ITEM.test(l)) { droppedItems++; return false; }
      return true;
    });
    out.push({ heading: cur, body: kept.join("\n").trim() });
  };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)/);
    if (h) { flush(); cur = h[1].trim(); buf = []; }
    else if (cur) buf.push(line);
  }
  flush();
  return out;
}

function parseLibrary(md: string) {
  const entries: { id: string; title: string; body: string }[] = [];
  const lines = md.split("\n");
  let cur: { id: string; title: string } | null = null, buf: string[] = [];
  // «Что не является ...» — запретительный хвост, в данные не берём
  const flush = () => {
    if (!cur) return;
    const cut = buf.findIndex((l) => /^##\s+Что не является/i.test(l));
    const body = (cut >= 0 ? buf.slice(0, cut) : buf).join("\n").trim();
    if (cut >= 0) droppedSections++;
    entries.push({ ...cur, body });
    buf = [];
  };
  for (const line of lines) {
    const h = line.match(/^###\s+(H\d|T\d+)\s*[—–-]\s*(.+)/);
    if (h) { flush(); cur = { id: h[1], title: h[2].trim() }; }
    else if (cur) buf.push(line);
  }
  flush();
  return entries;
}

const planDir = findPlanDir();
console.log("plan dir:", planDir);
const files = walk(planDir);
console.log("md files:", files.length);

const dayFiles = files.filter((f) =>
  /PRESTART\/\d+_.*\.md$/.test(f) || /week_\d+.*\/0\d_[A-Z]+\.md$/.test(f));
console.log("day files:", dayFiles.length);

const days = dayFiles.map((f) => {
  const md = readFileSync(f, "utf8");
  const title = (md.split("\n")[0] ?? "").replace(/^#\s*/, "").trim();
  const fileIso = basename(f).match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
  const iso = fileIso ?? ruDateToIso(title) ?? "0000-00-00";
  const rel = f.slice(planDir.length + 1);
  const milestone = rel.split("/")[0] ?? "";
  const week = rel.includes("week_") ? (rel.match(/week_\d+_\d{4}-\d{2}-\d{2}/)?.[0] ?? "") : "prestart";
  const meta = parseMeta(md);
  return {
    date: iso, title, file: rel, milestone, week,
    ...meta,
    blocks: parseBlocks(md),
    sections: parseSections(md),
  };
}).sort((a, b) => a.date.localeCompare(b.date));

const weekFiles = files.filter((f) => f.endsWith("00_WEEK_OVERVIEW.md"));
const weeks = weekFiles.map((f) => {
  const md = readFileSync(f, "utf8");
  const title = (md.split("\n")[0] ?? "").replace(/^#\s*/, "").trim();
  const rel = f.slice(planDir.length + 1);
  const id = rel.match(/week_\d+_\d{4}-\d{2}-\d{2}/)?.[0] ?? rel;
  const meta = parseMeta(md);
  const dates = md.match(/\*\*Даты:\*\*\s*(.+)/)?.[1]?.trim() ?? "";
  const sections = parseSections(md);
  return { id, title, file: rel, dates, ...meta, sections, resources: weekResourceIds(sections) };
}).sort((a, b) => a.id.localeCompare(b.id));

const libMd = readFileSync(join(planDir, "00_START", "04_EXERCISE_LIBRARY.md"), "utf8");
const library = parseLibrary(libMd);

// Ручные пояснения «как делать» для домашних комплексов (content/coaching.json: { H1: "...", ... }).
// Исходник краток («ankle rocks», «dead bug»), а пользователю нужно понятное описание.
let coaching: Record<string, string> = {};
try {
  coaching = JSON.parse(readFileSync(join(ROOT, "content", "coaching.json"), "utf8")) as Record<string, string>;
} catch { /* необязательно */ }
for (const entry of library) {
  if (coaching[entry.id]) entry.coaching = coaching[entry.id];
}

// Таблица ресурсов R01–R25 из 07_RESOURCES.md -> [{ id, title, url, type, minutes, task }]
function parseResources(md: string): { id: string; title: string; url: string; type: string; minutes: string; task: string }[] {
  const out: { id: string; title: string; url: string; type: string; minutes: string; task: string }[] = [];
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // | R01 | [title](url) | type | 10 мин | task |
    if (cells.length < 6 || !/^R\d\d$/.test(cells[1] ?? "")) continue;
    const link = cells[2]?.match(/\[([^\]]+)\]\((https?:[^)]+)\)/);
    if (!link) continue;
    out.push({ id: cells[1], title: link[1], url: link[2], type: cells[3] ?? "", minutes: cells[4] ?? "", task: cells[5] ?? "" });
  }
  return out;
}

// Словарь из 11_GLOSSARY.md -> [{ term, explanation }]
function parseGlossary(md: string): { term: string; explanation: string }[] {
  const out: { term: string; explanation: string }[] = [];
  for (const line of md.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !cells[1] || /^термин$/i.test(cells[1]) || /^-+$/.test(cells[1])) continue;
    out.push({ term: cells[1], explanation: cells[2] ?? "" });
  }
  return out;
}

function readStartDoc(name: string): string {
  return readFileSync(join(planDir, "00_START", name), "utf8");
}

const resources = parseResources(readStartDoc("07_RESOURCES.md"));
const glossary = parseGlossary(readStartDoc("11_GLOSSARY.md"));

// R-коды недели из секции «Ресурсы» обзора недели
function weekResourceIds(sections: { heading: string; body: string }[]): string[] {
  const sec = sections.find((s) => /ресурс/i.test(s.heading));
  if (!sec) return [];
  const ids = sec.body.match(/R\d\d/g) ?? [];
  return [...new Set(ids)];
}

const docIds = ["02_SAFETY_AND_AUTOREGULATION", "03_WARMUP", "06_FINGERBOARD", "10_FLEXIBLE_SCHEDULING", "09_MILESTONES_TESTS", "05_ROUTE_SELECTION", "07_RESOURCES", "08_SHOPPING", "11_GLOSSARY", "01_HOW_TO_USE", "04_EXERCISE_LIBRARY"];
const docs = docIds.map((id) => {
  const f = files.find((x) => basename(x).startsWith(id));
  if (!f) return null;
  const md = readFileSync(f, "utf8");
  return { id, title: (md.split("\n")[0] ?? "").replace(/^#\s*/, "").trim(), body: md };
}).filter(Boolean);

const plan = {
  meta: {
    title: "Болдеринг-план 26 недель",
    period: { from: "2026-09-03", to: "2027-03-07" },
    generatedAt: new Date().toISOString(),
    days: days.length, weeks: weeks.length,
    source: "bouldering_plan_2026-09_to_2027-03",
  },
  days, weeks, library, docs, resources, glossary,
};

mkdirSync(join(ROOT, "content"), { recursive: true });
writeFileSync(OUT, JSON.stringify(plan, null, 1));
console.log(`wrote ${OUT}: ${days.length} days, ${weeks.length} weeks, library ${library.length}`);
const withBlocks = days.filter((d) => d.blocks.length > 0).length;
console.log(`days with blocks: ${withBlocks}/${days.length}`);
console.log(`dropped prohibitions: ${droppedBlocks} blocks, ${droppedSections} sections, ${droppedItems} items`);
if (withBlocks < days.length * 0.9) {
  console.error("WARN: мало дней с блоками — проверь парсер");
  process.exitCode = 1;
}
