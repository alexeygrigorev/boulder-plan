/**
 * Разовая миграция дней плана из content/plan.json (сгенерирован из plan/*.md)
 * в days/YYYY-MM-DD.yaml — по одному файлу на день, проще править руками, чем md.
 *
 * Заодно вычищает мусор из чек-листов (по просьбе владельца — только действия):
 * - блоки-пустышки: прогулки («Активное восстановление», «Прогулка B»,
 *   «Восстановление»-ходьба), логистика («Собери сумку», «Подготовь магнезию»,
 *   «Заряди телефон», «Инвентарь», «Отдых дома»);
 * - «не делай»-обороты внутри kept-блоков («никаких тестовых висов» и т.п.).
 * Критерии качества («без срыва стопы», «без боли») и запреты из секции
 * «Когда закончить раньше» НЕ трогаем — это техника и безопасность.
 *
 * id блоков сохраняются оригинальные (с дырками) — ключи checks в прогрессе
 * продолжают указывать на те же блоки.
 *
 * Запуск: npm run md2yaml (см. package.json: tools)
 * Проверяет сам себя: парсит записанный YAML обратно (tools/yaml.ts)
 * и сверяет с моделью один в один.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDayYaml } from "./yaml.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const IN = join(ROOT, "content", "plan.json");
const OUT_DIR = join(ROOT, "days");

interface Block {
  id: string; start: string; end: string; minutes: number;
  kind: string; requirement: string; title: string; text: string;
  intensity: string | null; caution: string | null; section: string;
}
interface Section { heading: string; body: string }
interface Day {
  date: string; title: string; file: string; milestone: string; week: string;
  format: string | null; theme: string | null; cue: string | null;
  requiredMinutes: number; blocks: Block[]; sections: Section[];
}

// --- Правила чистки ---

// Целый блок в мусор, если kind/текст совпали.
function dropBlock(b: Block): string | null {
  const kind = b.kind.toLowerCase();
  if (kind === "активное восстановление") return "прогулка-пустышка";
  if (kind.startsWith("прогулка")) return "прогулка-пустышка";
  if (kind === "восстановление" && /ходьб|прогулк/i.test(b.text)) return "прогулка-пустышка";
  if (kind === "отдых дома") return "прогулка+сборы";
  if (kind === "подготовка" && /собери сумку|подготовь магнезию|заряди телефон|освободи память|положи щётку/i.test(b.text)) {
    return "логистика";
  }
  if (kind === "инвентарь") return "логистика";
  return null;
}

// «Не делай»-обороты: вырезать из текста kept-блока. Порядок важен.
const STRIPS: [RegExp, string][] = [
  [/сегодня хват не тренируется\.?/i, ""],
  [/[;.]?\s*никаких тестовых висов\.?/i, ""],
  [/[;.]?\s*никаких висов на домашнем турнике или кольцах ради «проверки хвата»\.?/i, ""],
  [/[;.]?\s*full crimp не тренируется на фингерборде\.?/i, ""],
  [/\s+и без тестового виса\.?/i, ""],
  [/,\s*не висни на зацепах\.?/i, ""],
  [/,\s*никаких финишных висов\.?/i, ""],
  [/;\s*без отжиманий\/press\.?/i, ""],
  [/,\s*без дополнительной нагрузки на пальцы\.?/i, ""],
  [/;\s*фингерборда нет\.?/i, ""],
  [/\.?\s*Не устраивай дополнительный тест висом\.?/, ""],
  [/;\s*не делать это перед тренировкой\.?/i, ""],
  [/;\s*не истончай кожу и не делай это прямо перед залом\.?/i, ""],
  [/;\s*не ставить телефон в зоне падения\.?/i, ""],
  [/;\s*не использовать металлическую\.?/i, ""],
  [/\.?\s*Не ищи самые жёсткие трассы сета\.?/, ""],
  [/;\s*не пытайся «разбудить хват» вечером\.?/i, ""],
  [/\.?\s*Не выполнять оба\.?/, ""],
  [/\.?\s*Воскресенье остаётся развлечением, не третьим тяжёлым днём\.?/, ""],
  [/\.?\s*Не покупай домашний фингерборд или grip trainer\.?/, ""],
  [/Не пытайся вместить все попытки:\s*([а-яa-z])/g, (_m, c: string) => (c as string).toUpperCase()],
  [/,\s*а не пытайся напрямую переводить цифру другого зала/, ""],
  [/\.?\s*Фингерборда и capacity-круга нет\.?/, ""],
];

function cleanText(t: string): { text: string; stripped: boolean } {
  let out = t;
  let stripped = false;
  // Маркер заметки всегда в конце — откладываем, чтобы чистка не съела точку перед ним.
  let memo = "";
  const mm = out.match(/\s*(📝|✎)\s*$/);
  if (mm) {
    memo = ` ${mm[1]}`;
    out = out.slice(0, mm.index);
  }
  for (const [re, rep] of STRIPS) {
    const next = out.replace(re, rep as string);
    if (next !== out) {
      stripped = true;
      out = next;
    }
  }
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  // Точку в конце — если её нет (…прохода.» уже закрыто, …«Тихие ноги» — нет).
  if (/[A-Za-zА-Яа-яЁё0-9]$/.test(out) || /[^.][»)]$/.test(out)) out += ".";
  return { text: (out + memo).trim(), stripped };
}

// Предложения «Никаких ...» в телах секций + точечные обороты.
// Строки «Осторожность:» (суставы/боль/безопасность) НЕ трогаем целиком —
// чистим только прямые запреты без условной части, остальное решает врач и стоп-правила.
const SEC_NIKAKIKH = /Никаких [^.\n]+\.\s*/gi;
const SEC_STRIPS: [RegExp, string][] = [
  [/full crimp не тренируется на фингерборде\.?/i, ""],
  [/Плечом не отталкивайся от стены;\s*/i, ""],
  [/Фингерборда и (capacity-круга|тяжёлого круга) нет\.?\s*/i, ""],
];

// Вложенная строка чек-листа внутри тела секции (сценарии воскресенья дублируют
// пункты): `- [ ] **00:00–15:00 · Kind · req** — текст`. Чистим как блок.
const EMBED = /^(\s*-\s*\[ \] \*\*\d{1,3}:\d{2}\s*[–—-]\s*\d{1,3}:\d{2}\s*·\s*(.+?)\s*·\s*(обязательно|опционально|по назначению физиотерапевта|выбрать один сценарий)\*\*\s*[–—-]\s*)(.*)$/;

function cleanSectionBody(body: string): { body: string; changed: boolean; droppedEmbedded: number } {
  let out = body;
  let changed = false;
  let droppedEmbedded = 0;
  const lines = out.split("\n");
  const kept: string[] = [];
  for (let line of lines) {
    if (/^-\s+\[ \]\s*не было /i.test(line)) {
      changed = true;
      continue; // как DROP_ITEM в ingest: «не было ...» не показываем
    }
    const em = line.match(EMBED);
    if (em) {
      const kind = (em[2] ?? "").trim();
      const text = em[4] ?? "";
      if (dropBlock({ kind, text } as Block)) {
        changed = true;
        droppedEmbedded++;
        continue;
      }
      const c = cleanText(text);
      if (c.stripped) changed = true;
      line = `${em[1] ?? ""}${c.text}`;
    }
    let next = line.replace(SEC_NIKAKIKH, "");
    for (const [re, rep] of SEC_STRIPS) next = next.replace(re, rep);
    // Опустевшая строка «Осторожность:» — целиком в мусор.
    if (/^(\s*-\s*)?(\*\*)?Осторожность:(\*\*)?\s*$/.test(next)) {
      changed = true;
      continue;
    }
    next = next.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+$/, "");
    if (next !== line) changed = true;
    kept.push(next);
  }
  out = kept.join("\n").trim();
  return { body: out, changed: changed || out !== body, droppedEmbedded };
}

// --- YAML-эмиттер (ровно то подмножество, что понимает tools/yaml.ts) ---

function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function lit(key: string, text: string, ind: string): string {
  if (!text) return `${ind}${key}: ''\n`;
  const body = text.split("\n").map((l) => (l ? `${ind}  ${l.replace(/\s+$/, "")}` : "")).join("\n");
  return `${ind}${key}: |\n${body}\n`;
}

function emitDay(d: Day): string {
  const L: string[] = [];
  L.push(`date: ${q(d.date)}`);
  L.push(`title: ${q(d.title)}`);
  L.push(`source: ${q(d.file)}`);
  L.push(`milestone: ${q(d.milestone)}`);
  L.push(`week: ${q(d.week)}`);
  L.push(`format: ${d.format === null ? "null" : q(d.format)}`);
  L.push(`theme: ${d.theme === null ? "null" : q(d.theme)}`);
  L.push(`cue: ${d.cue === null ? "null" : q(d.cue)}`);
  L.push(`requiredMinutes: ${d.requiredMinutes}`);
  L.push(`blocks:`);
  for (const b of d.blocks) {
    L.push(`  - id: ${q(b.id)}`);
    L.push(`    start: ${q(b.start)}`);
    L.push(`    end: ${q(b.end)}`);
    L.push(`    kind: ${q(b.kind)}`);
    L.push(`    requirement: ${q(b.requirement)}`);
    L.push(`    section: ${q(b.section)}`);
    L.push(`    intensity: ${b.intensity === null ? "null" : q(b.intensity)}`);
    L.push(lit("text", b.text, "    ").trimEnd());
  }
  L.push(`sections:`);
  for (const s of d.sections) {
    L.push(`  - heading: ${q(s.heading)}`);
    L.push(lit("body", s.body, "    ").trimEnd());
  }
  return L.join("\n") + "\n";
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

// --- Миграция ---

const plan = JSON.parse(readFileSync(IN, "utf8")) as { days: Day[] };
mkdirSync(OUT_DIR, { recursive: true });

const dropReasons = new Map<string, number>();
const dropDates = new Set<string>();
let strippedBlocks = 0;
let changedSections = 0;
let droppedSections = 0;
let droppedEmbedded = 0;
const report: string[] = [];

for (const src of plan.days) {
  const blocks: Block[] = [];
  for (const b of src.blocks) {
    const reason = dropBlock(b);
    if (reason) {
      dropReasons.set(reason, (dropReasons.get(reason) ?? 0) + 1);
      dropDates.add(src.date);
      continue;
    }
    const { text, stripped } = cleanText(b.text);
    if (stripped) {
      strippedBlocks++;
      report.push(`[${src.date} ${b.id} ${b.kind}] «${b.text}»  =>  «${text}»`);
    }
    blocks.push({ ...b, text });
  }
  const sections: Section[] = [];
  for (const s of src.sections) {
    if (/^чек-лист по минутам$/i.test(s.heading.trim())) continue; // дублирует blocks
    const { body, changed, droppedEmbedded: de } = cleanSectionBody(s.body);
    droppedEmbedded += de;
    if (!body) {
      droppedSections++;
      continue;
    }
    if (changed) {
      changedSections++;
      report.push(`[${src.date} §${s.heading}] changed`);
    }
    sections.push({ heading: s.heading, body });
  }
  const day: Day = { ...src, blocks, sections };
  const yaml = emitDay(day);
  const file = join(OUT_DIR, `${src.date}.yaml`);
  writeFileSync(file, yaml);

  // Самопроверка: парсим обратно и сверяем один в один.
  const back = parseDayYaml(yaml, `${src.date}.yaml`) as unknown as Record<string, unknown>;
  const expect: Record<string, unknown> = {
    date: day.date, title: day.title, source: day.file, milestone: day.milestone,
    week: day.week, format: day.format, theme: day.theme, cue: day.cue,
    requiredMinutes: day.requiredMinutes,
    blocks: day.blocks.map((b) => ({
      id: b.id, start: b.start, end: b.end, kind: b.kind,
      requirement: b.requirement, section: b.section, intensity: b.intensity, text: b.text,
    })),
    sections: day.sections.map((s) => ({ heading: s.heading, body: s.body })),
  };
  if (stable(back) !== stable(expect)) {
    console.error(`РАСХОЖДЕНИЕ round-trip: ${src.date}`);
    process.exitCode = 1;
  }
}

console.log(`days: ${plan.days.length} -> ${OUT_DIR}`);
console.log("dropped blocks:", [...dropReasons.entries()].map(([k, v]) => `${k} ${v}`).join(", "));
console.log(`days with dropped blocks: ${dropDates.size}`);
console.log(`stripped block texts: ${strippedBlocks}, changed sections: ${changedSections}, dropped sections: ${droppedSections}, dropped embedded lines: ${droppedEmbedded}`);
writeFileSync(join(ROOT, ".tmp", "clean-report.txt"), report.join("\n") + "\n");
console.log(`report: .tmp/clean-report.txt (${report.length} записей)`);

// Страховка от кривой чистки: проверяем ЗАПИСАННЫЕ yaml, а не модель в памяти.
const FORBIDDEN = /собери сумку|подготовь магнезию|заряди телефон|освободи память|положи щётку|никаких тестовых висов|сегодня хват не тренируется|full crimp не тренируется|без тестового виса|не висни на зацепах|никаких финишных висов|без отжиманий\/press|без дополнительной нагрузки на пальцы|фингерборда нет|не устраивай дополнительный тест|не делать это перед тренировкой|не истончай кожу|не ставить телефон в зоне падения|не использовать металлическую|не ищи самые жёсткие|разбудить хват|не выполнять оба|не третьим тяжёлым|не покупай домашний фингерборд|не пытайся вместить|напрямую переводить цифру|capacity-круга нет/i;
let bad = 0;
const noRequired: string[] = [];
for (const f of readdirSync(OUT_DIR).filter((x: string) => x.endsWith(".yaml")).sort()) {
  const doc = parseDayYaml(readFileSync(join(OUT_DIR, f), "utf8"), f) as unknown as {
    blocks: { id: string; kind: string; requirement: string; text: string }[];
  };
  if (!doc.blocks.length) {
    console.error(`ПУСТОЙ ДЕНЬ без блоков: ${f}`);
    bad++;
  }
  if (!doc.blocks.some((b) => b.requirement === "обязательно")) noRequired.push(f.slice(0, 10));
  const ids = new Set<string>();
  for (const b of doc.blocks) {
    if (!/^b\d+$/.test(b.id) || ids.has(b.id)) {
      console.error(`ПЛОХОЙ id блока ${b.id} в ${f}`);
      bad++;
    }
    ids.add(b.id);
    const kl = b.kind.toLowerCase();
    if (kl === "активное восстановление" || kl.startsWith("прогулка") || kl === "отдых дома" || kl === "инвентарь" ||
      (kl === "восстановление" && /ходьб|прогулк/i.test(b.text))) {
      console.error(`ОСТАЛСЯ МУСОРНЫЙ БЛОК [${f} ${b.id} ${b.kind}]`);
      bad++;
    }
    if (FORBIDDEN.test(b.text)) {
      console.error(`ОСТАЛСЯ ЗАПРЕТ [${f} ${b.id} ${b.kind}]: ${b.text.slice(0, 120)}`);
      bad++;
    }
  }
}
console.log(`дней без обязательных блоков (relaxed/сценарии): ${noRequired.length}`);
if (bad) {
  console.error(`ОШИБКА чистки: ${bad} проблем`);
  process.exitCode = 1;
}
if (process.exitCode) console.error("Миграция завершилась с ошибками — смотри выше");
