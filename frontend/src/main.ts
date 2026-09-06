import {
  api, auth, AuthError, todayIso, shiftDate,
  type PlanDay, type ActivityDay, type GlossaryTerm, type ResourceItem, type PlanWeekFull,
  type DayMetrics, type Gym, type RouteWithPersonal, type RouteCard, type RouteAttempt, type QrResolveOut,
} from "./api";
import { md } from "./md";
import { icon, longDate } from "./ui";

const app = document.getElementById("app")!;

type Tab = "today" | "cal" | "prog" | "lib" | "safe" | "routes" | "doc";
type LibSub = "ex" | "dict" | "vids" | "shop";

let tab: Tab = "today";
let date = todayIso();
let authEnabled = false;
let userEmail: string | null = null;
let day: PlanDay | null = null;
let checks: Record<string, boolean> = {};
let note = "";
let metrics: DayMetrics = {};
let blockNotes: Record<string, string> = {};
let openNote: string | null = null;
let expandedBlock: string | null = null;
let sessionMode = false;
let daysCache: { date: string; title: string; format: string | null; week: string }[] = [];
let saveTimer: number | undefined;
const timers = new Map<string, { left: number; total: number; on: boolean; int?: number }>();

// Библиотека / календарь / прогресс
let libSub: LibSub = "ex";
let openLib: string | null = null;
let libItems: { id: string; title: string }[] = [];
const libEntryCache = new Map<string, { id: string; title: string; body: string; coaching?: string }>();
let glossaryCache: GlossaryTerm[] = [];
let resourcesCache: ResourceItem[] = [];
let dictFilter = "";
let exerciseFilter = "";
let weekCache = new Map<string, PlanWeekFull>();
let activityCache: { from: string; to: string; days: ActivityDay[] } | null = null;
const activityByDate = new Map<string, ActivityDay>();
let calMonth = todayIso().slice(0, 7);

// Трассы (BETA7 scan-only + ручные): выбор зала, QR, карточка, попытки
let gymsCache: Gym[] = [];
let selGym = localStorage.getItem("bp:gym") || "gym_berta";
let routesList: RouteWithPersonal[] = [];
let catalogWarn: string | null = null;
let openRouteId: string | null = null;
const cardCache = new Map<string, RouteCard>();
let routeQuery = "";
let routeFilter = "all";
let qrText = "";
let qrMsg = "";
let failReason = "FOOT_SLIP";
let scanning = false;
let scanStream: MediaStream | null = null;
let scanTimer: number | undefined;
let recoCache: { exerciseId: string; candidates: { route: RouteWithPersonal; score: number; reasons: string[]; alternatives: { route: RouteWithPersonal; reason: string }[] }[]; relaxations: string[] }[] | null = null;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtLeft(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function beep(): void {
  try {
    const Ctx = window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    o.start();
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    o.stop(ctx.currentTime + 0.4);
  } catch {
    /* без звука */
  }
}

// Цвет типа тренировки: свой для календаря и heatmap
function fmtClass(format: string | null): string {
  if (!format) return "fOther";
  if (format.startsWith("Тренировка A")) return "fA";
  if (format.startsWith("Тренировка B")) return "fB";
  if (format.startsWith("Тренировка C")) return "fC";
  if (format.startsWith("Дом")) return "fHome";
  if (format.startsWith("Восстанов")) return "fRec";
  if (format.startsWith("Отдых")) return "fRest";
  if (format.startsWith("Подготов")) return "fPrep";
  return "fOther";
}

function fmtLetter(format: string | null): string {
  if (!format) return "·";
  if (format.startsWith("Тренировка A")) return "A";
  if (format.startsWith("Тренировка B")) return "B";
  if (format.startsWith("Тренировка C")) return "C";
  if (format.startsWith("Дом")) return "д";
  if (format.startsWith("Восстанов")) return "в";
  if (format.startsWith("Отдых")) return "о";
  if (format.startsWith("Подготов")) return "п";
  return "·";
}

function localKey(d: string): string {
  return `bp:${d}`;
}

interface LocalEntry {
  checks: Record<string, boolean>;
  note: string;
  metrics?: DayMetrics;
  blockNotes?: Record<string, string>;
  updatedAt: string;
  dirty: boolean;
}

function readBlockNotes(v: unknown): Record<string, string> {
  if (typeof v !== "object" || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) out[k] = val;
  }
  return out;
}

function readLocal(d: string): LocalEntry | null {
  try {
    const raw = localStorage.getItem(localKey(d));
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<LocalEntry>;
    if (typeof j !== "object" || j === null || typeof j.checks !== "object" || j.checks === null) return null;
    return {
      checks: j.checks as Record<string, boolean>,
      note: typeof j.note === "string" ? j.note : "",
      metrics: typeof j.metrics === "object" && j.metrics !== null ? (j.metrics as DayMetrics) : {},
      blockNotes: readBlockNotes((j as { blockNotes?: unknown }).blockNotes),
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : "",
      dirty: j.dirty === true,
    };
  } catch {
    return null;
  }
}

function writeLocal(d: string, e: { checks: Record<string, boolean>; note: string; metrics?: DayMetrics; blockNotes?: Record<string, string>; updatedAt: string }, dirty: boolean): void {
  try {
    localStorage.setItem(localKey(d), JSON.stringify({ ...e, dirty }));
  } catch {
    /* переполнено — серверная копия остаётся */
  }
}

type SaveState = "saved" | "saving" | "offline";
let saveState: SaveState = "saved";
let pendingSnap: { date: string; checks: Record<string, boolean>; note: string; metrics: DayMetrics; blockNotes: Record<string, string>; updatedAt: string } | null = null;

function paintSaveState(): void {
  const el = document.getElementById("savestate");
  if (!el) return;
  el.textContent =
    saveState === "saving" ? "Сохраняю…" :
    saveState === "offline" ? "Нет связи — сохранено на этом устройстве, отправлю позже." :
    "Сохранено ✓";
}

function apiErrorText(e: unknown): string {
  if (e instanceof AuthError) return "нужен вход";
  if (e instanceof Error && e.message) return e.message;
  return String(e);
}

// Сохранение со снапшотом: раньше отложенный PUT брал глобальную `date`
// на момент срабатывания таймера — правка могла улететь в другой день.
function scheduleSave(): void {
  const snap = {
    date,
    checks: { ...checks },
    note,
    metrics: { ...metrics },
    blockNotes: { ...blockNotes },
    updatedAt: new Date().toISOString(),
  };
  pendingSnap = snap;
  writeLocal(snap.date, snap, true);
  saveState = "saving";
  paintSaveState();
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void doSave(snap), 600);
}

async function doSave(snap: { date: string; checks: Record<string, boolean>; note: string; metrics: DayMetrics; blockNotes: Record<string, string>; updatedAt: string }): Promise<void> {
  try {
    const saved = await api.saveProgress(snap.date, snap.checks, snap.note, snap.metrics, snap.blockNotes);
    const cur = readLocal(snap.date);
    // Гасим dirty только если пользователь ничего не правил поверх снапшота.
    if (cur && cur.updatedAt === snap.updatedAt) {
      writeLocal(snap.date, { ...cur, updatedAt: saved.updatedAt ?? cur.updatedAt }, false);
    }
    activityCache = null; // календарь/прогресс пересчитаются при следующем открытии
    if (pendingSnap?.updatedAt === snap.updatedAt) pendingSnap = null;
    if (saveState === "saving" && !pendingSnap) {
      saveState = "saved";
      paintSaveState();
    }
  } catch (e) {
    // 401 и прочие разберёт следующий foreground-запрос (покажет вход);
    // фоновый сейв не должен выкидывать на логин посреди набора заметки.
    saveState = "offline";
    paintSaveState();
  }
}

// Отправить pending-сейв сейчас (перед сменой дня/вкладки, скрытием страницы).
function flushSave(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (pendingSnap) {
    const snap = pendingSnap;
    pendingSnap = null;
    void doSave(snap);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushSave());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
  });
}

async function ensureActivity(): Promise<void> {
  if (activityCache) return;
  activityCache = await api.activity("2026-09-03", "2027-03-07");
  activityByDate.clear();
  for (const d of activityCache.days) activityByDate.set(d.date, d);
}

function levelOf(a: ActivityDay | undefined, today: string): string {
  if (!a) return "l0";
  if (a.date > today) return "future";
  if (a.requiredTotal === 0) return "l0";
  const r = a.done / a.requiredTotal;
  if (r >= 1) return "l4";
  if (r >= 0.66) return "l3";
  if (r >= 0.33) return "l2";
  if (r > 0) return "l1";
  return a.date < today ? "gap" : "l0";
}

async function loadDay(): Promise<void> {
  const requestedDate = date;
  expandedBlock = null;
  sessionMode = false;
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка…</p>`;
  try {
    const loaded = await api.plan(requestedDate);
    if (requestedDate !== date || tab !== "today") return;
    day = loaded;
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    day = null;
    app.innerHTML = `<header class="top">${topHtml()}</header>
      <h1>Нет плана на ${esc(date)}</h1>
      <p class="meta">План покрывает 2026-09-03 → 07.03.2027. Открой «Календарь», чтобы выбрать день.</p>
      ${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
    return;
  }
  try {
    const p = await api.progress(requestedDate);
    if (requestedDate !== date || tab !== "today") return;
    const local = readLocal(date);
    // Не затираем локальную правку, которая ещё не долетела до сервера:
    // раньше свежий ответ сервера молча убивал заметку/метрики из localStorage.
    if (local?.dirty && (!p.updatedAt || local.updatedAt >= p.updatedAt)) {
      checks = local.checks;
      note = local.note;
      metrics = local.metrics ?? {};
      blockNotes = local.blockNotes ?? {};
      saveState = "offline";
      pendingSnap = { date, checks: { ...checks }, note, metrics: { ...metrics }, blockNotes: { ...blockNotes }, updatedAt: local.updatedAt };
      void doSave(pendingSnap);
    } else {
      checks = p.checks ?? {};
      note = p.note ?? "";
      metrics = p.metrics ?? {};
      blockNotes = readBlockNotes(p.notes);
      writeLocal(date, { checks, note, metrics, blockNotes, updatedAt: p.updatedAt ?? "" }, false);
      if (!readLocal(date)?.dirty && saveState !== "saving") {
        saveState = "saved";
      }
    }
  } catch {
    const local = readLocal(date);
    if (local) {
      checks = local.checks;
      note = local.note;
      metrics = local.metrics ?? {};
      blockNotes = local.blockNotes ?? {};
      if (local.dirty) saveState = "offline";
      else if (!pendingSnap) saveState = "saved";
    } else {
      checks = {};
      note = "";
      metrics = {};
      blockNotes = {};
      if (!pendingSnap) saveState = "saved";
    }
  }
  if (requestedDate === date && tab === "today") render();
}

function fmtDateRu(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function navHtml(): string {
  return `<div class="dateline">
    <button id="prev" aria-label="Предыдущий день">‹</button>
    <div class="datewrap"><button id="datebtn" aria-label="Открыть календарь">${fmtDateRu(date)}</button></div>
    <button id="next" aria-label="Следующий день">›</button>
    <button id="today" class="primary">Сегодня</button>
  </div>`;
}

function goCal(): void {
  flushSave();
  calMonth = date.slice(0, 7);
  tab = "cal";
  render();
}

function brandHtml(): string {
  return `<div class="brand"><span class="blogo">${icon("mountain")}</span>
    <span class="bname">boulder<span class="brand-light"> / plan</span></span>
    <span class="brand-caption">Маленькие шаги. Новые вершины.</span></div>`;
}

function topHtml(): string {
  return `${brandHtml()}<button class="health-link" data-tab="safe" aria-label="Безопасность">${icon("safe")}<span>Здоровье</span></button>${tab === "today" ? navHtml() : `<button id="datebtn" class="datechip">${fmtDateRu(date)}</button>`}`;
}

function tabsHtml(): string {
  const t = (id: Tab, label: string) =>
    `<button data-tab="${id}" class="${tab === id ? "active" : ""}" ${tab === id ? 'aria-current="page"' : ''}><span class="ti">${icon(id)}</span><span class="tl">${label}</span></button>`;
  return `<nav class="tabs" aria-label="Основная навигация"><div class="nav-brand">${icon("mountain")}<span>boulder / plan</span></div>${t("today", "Мой день")}${t("cal", "План")}${t("routes", "Трассы")}${t("prog", "Прогресс")}${t("lib", "Библиотека")}<div class="nav-footer">26 недель<br><span>Сентябрь 2026 — март 2027</span></div></nav>`;
}

function renderLogin(error = ""): void {
  app.innerHTML = `<h1>Болдер-план</h1>
    <p class="meta">Тренировки 03.09.2026 → 07.03.2027</p>
    ${error ? `<div class="safety">${esc(error)}</div>` : ""}
    <button class="listitem" id="login"><div class="d">Войти через Google</div>
    <div class="s">доступ только для datatalks.club</div></button>`;
  (document.getElementById("login") as HTMLButtonElement).onclick = () => {
    auth.beginLogin(window.location.pathname + window.location.search).catch((e) => {
      renderLogin(e instanceof Error ? e.message : "Вход не удался");
    });
  };
}

function accountHtml(): string {
  if (!authEnabled) return "";
  return `<div class="meta"><span>${esc(userEmail ?? "")}</span>
    <button id="logout" style="padding:4px 10px;font-size:13px">Выйти</button></div>`;
}

function wireAccount(): void {
  const b = document.getElementById("logout") as HTMLButtonElement | null;
  if (b) b.onclick = () => void auth.logout();
}

function needLogin(e: unknown): boolean {
  return e instanceof AuthError;
}

function wireTabs(): void {
  wireAccount();
  app.dataset.screen = tab;
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
    b.onclick = () => {
      flushSave();
      if (tab === "routes") stopScanner();
      tab = b.dataset.tab as Tab;
      window.scrollTo(0, 0);
      render();
    };
  });
}

function render(): void {
  if (tab === "today") renderDay();
  else if (tab === "cal") void renderCal();
  else if (tab === "routes") void renderRoutes();
  else if (tab === "prog") void renderProg();
  else if (tab === "lib") void renderLib();
  else if (tab === "doc") void renderDoc();
  else void renderSafe();
}

function resCard(r: ResourceItem): string {
  return `<div class="res">
    <div class="d"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.id)} — ${esc(r.title)}</a></div>
    <div class="s">${esc(r.type)} · ${esc(r.minutes)}${r.task ? ` · ${esc(r.task)}` : ""}</div>
  </div>`;
}

async function weekResourcesHtml(weekId: string): Promise<string> {
  try {
    let w = weekCache.get(weekId);
    if (!w) {
      w = await api.week(weekId);
      weekCache.set(weekId, w);
    }
    if (!w.resources.length) return "";
    if (!resourcesCache.length) resourcesCache = await api.resources();
    const items = w.resources
      .map((id) => resourcesCache.find((r) => r.id === id))
      .filter((r): r is ResourceItem => Boolean(r));
    if (!items.length) return "";
    return `<h3>Что посмотреть на неделе</h3>${items.map(resCard).join("")}`;
  } catch {
    return "";
  }
}

function weekSectionsHtml(w: PlanWeekFull): string {
  return w.sections
    .filter((s) => !/ресурс/i.test(s.heading))
    .map((s) => `<details class="section"><summary>${esc(s.heading)}</summary>${md(s.body)}</details>`)
    .join("");
}

// «Готово, когда»: критерии из плана — настоящие галочки, а не буллеты.
// Ключи sec:done:{i} не пересекаются с id блоков, на подсчёт прогресса не влияют.
function doneCriteriaHtml(s: { heading: string; body: string }): string {
  const items: string[] = [];
  const rest: string[] = [];
  for (const line of s.body.split("\n")) {
    const m = /^-\s+\[[ xX]?\]\s*(.*)$/.exec(line);
    if (m) items.push(m[1]);
    else if (line.trim()) rest.push(line);
  }
  if (!items.length) return `<details class="section"><summary>${esc(s.heading)}</summary>${md(s.body)}</details>`;
  return `<details class="section" open><summary>${esc(s.heading)}</summary>
    ${rest.length ? md(rest.join("\n")) : ""}
    ${items.map((t, i) => {
      const key = `sec:done:${i}`;
      const on = !!checks[key];
      return `<div class="seccheck${on ? " on" : ""}">
        <button class="check" data-seccheck="${key}" aria-label="Отметить пункт">${on ? "✓" : "○"}</button>
        <div class="stext">${md(t)}</div>
      </div>`;
    }).join("")}
  </details>`;
}

// Библиотека трасс внизу тренировочного дня: QR + сканер + список зала.
// Тяжёлая работа (карточка, попытки) живёт во вкладке «Трассы», отсюда — прыжки туда.
function dayRoutesHtml(): string {
  const gym = gymsCache.find((g) => g.id === selGym);
  const canScan = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined";
  return `<h3>Трассы · ${esc(gym?.name ?? "")}</h3>
  ${catalogWarn ? `<div class="cue">${esc(catalogWarn)}</div>` : ""}
  <input class="search" id="dayqr" placeholder="Ссылка с QR трассы…" value="${esc(qrText)}" inputmode="url" />
  <div class="subchips">
    <button class="subchip active" id="dayqrgo">Распознать</button>
    ${canScan ? `<button class="subchip" id="dayqrscan">📷 Сканировать</button>` : ""}
    <button class="subchip" id="daylib">Библиотека трасс →</button>
  </div>
  ${qrMsg ? `<div class="cue">${esc(qrMsg)}</div>` : ""}
  ${routesList.map((it) => {
    const r = it.route;
    const st = it.personalState;
    return `<button class="listitem" data-dayroute="${esc(r.id)}">
      <div class="d">${esc(routeTitle(r))}${st?.sent ? " ✓" : ""}</div>
      <div class="s">${esc([r.sector, r.grade.raw || "без грейда"].filter(Boolean).join(" · "))}${st ? ` · ${esc(statusRu(st.status))}` : ""}</div>
    </button>`;
  }).join("") || `<p class="meta">Пока пусто — отсканируй QR у стены.</p>`}`;
}

function wireDayRoutes(): void {
  const qi = document.getElementById("dayqr") as HTMLInputElement | null;
  if (qi) qi.oninput = () => {
    qrText = qi.value;
  };
  const go = document.getElementById("dayqrgo") as HTMLButtonElement | null;
  if (go) go.onclick = () => {
    flushSave();
    tab = "routes";
    void doResolve();
  };
  const sc = document.getElementById("dayqrscan") as HTMLButtonElement | null;
  if (sc) {
    sc.onclick = () => {
      flushSave();
      tab = "routes";
      void renderRoutes().then(() => toggleScan());
    };
  }
  const lib = document.getElementById("daylib") as HTMLButtonElement | null;
  if (lib) {
    lib.onclick = () => {
      flushSave();
      tab = "routes";
      void renderRoutes();
    };
  }
  app.querySelectorAll<HTMLButtonElement>("[data-dayroute]").forEach((b) => {
    b.onclick = () => {
      flushSave();
      tab = "routes";
      void openCard(b.dataset.dayroute!);
    };
  });
}

async function paintDayRoutes(daySnapshot: string): Promise<void> {
  try {
    if (!gymsCache.length) gymsCache = (await api.gyms()).gyms;
    if (!gymsCache.some((g) => g.id === selGym)) selGym = gymsCache[0]?.id ?? "gym_berta";
    const res = await api.gymRoutes(selGym);
    if (daySnapshot !== date || tab !== "today") return;
    routesList = res.items;
    catalogWarn = res.catalog.warning;
    const box = document.getElementById("dayroutes");
    if (!box) return;
    box.innerHTML = dayRoutesHtml();
    wireDayRoutes();
  } catch {
    if (daySnapshot !== date || tab !== "today") return;
    const box = document.getElementById("dayroutes");
    if (box) box.innerHTML = `<p class="meta">Трассы не загрузились — открой вкладку «Трассы».</p>`;
  }
}

function renderDay(): void {
  if (!day) {
    void loadDay();
    return;
  }
  const d = day;
  const required = d.blocks.filter((b) => !/опционально|по желанию|relaxed/i.test(b.requirement));
  const done = required.filter((b) => checks[b.id]).length;
  const pct = required.length ? Math.round((done / required.length) * 100) : 100;
  const next = required.find((b) => !checks[b.id]);
  const remaining = required.filter((b) => !checks[b.id]).reduce((n, b) => n + b.minutes, 0);
  const stopRules = d.sections.find((s) => /закончить раньше/i.test(s.heading));
  const others = d.sections.filter((s) => !/чек-лист/i.test(s.heading) && s !== stopRules);
  const isWorkout = (d.format ?? "").startsWith("Тренировка");
  const doneCriteria = others.find((s) => /готово, когда/i.test(s.heading));
  const restSections = others.filter((s) => s !== doneCriteria);
  const title = d.theme || d.format || "Время для себя";
  const active = expandedBlock ?? next?.id;

  app.innerHTML = `<header class="top">${topHtml()}</header>
    <div class="page-intro"><div><p class="eyebrow">${date === todayIso() ? "МОЙ ДЕНЬ" : "ПЛАН ДНЯ"} / ${esc(longDate(date))}</p>
    <h1 class="daytitle">${esc(title)}</h1><p class="page-description">${esc(d.format ?? "Свободный день")} · ${d.requiredMinutes ? `около ${d.requiredMinutes} минут` : "в своём темпе"}</p></div>
    <span class="intro-mark">${icon(isWorkout ? "mountain" : "today")}</span></div>${accountHtml()}
    <div id="weekstrip" class="weekstrip" aria-label="Дни недели"></div>
    <div class="day-layout"><div class="day-main">
    <section class="session-hero ${!next ? "complete" : ""}">
      <div class="hero-top"><span class="eyebrow">${next ? (done ? "ПРОДОЛЖАЕМ" : "ВСЁ НАЧИНАЕТСЯ С ОДНОГО ШАГА") : "НА СЕГОДНЯ ВСЁ"}</span><span>${done} / ${required.length}</span></div>
      <h2>${next ? esc(next.kind) : "Хорошая работа."}</h2>
      <p>${next ? `${remaining} мин обязательных шагов осталось. Можно начать прямо сейчас.` : "Все обязательные шаги отмечены. Запиши, что получилось сегодня."}</p>
      <div class="hero-bottom"><button class="primary" id="session-start">${next ? (sessionMode ? "К текущему шагу" : done ? "Продолжить занятие" : "Начать занятие") : "Записать итог"}${icon("arrow")}</button><span>${icon("clock")} ${d.requiredMinutes} мин по плану</span></div>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Обязательные шаги"><div style="width:${pct}%"></div></div>
      <div class="proglabel">${done} из ${required.length} обязательных шагов выполнено</div>
    </section>
    ${d.cue ? `<div class="focus-note"><span>${icon("mountain")}</span><div><span class="eyebrow">ФОКУС ДНЯ</span><p>${esc(d.cue)}</p></div></div>` : ""}
    <div class="section-heading"><h3>Твой маршрут на сегодня</h3><span>${d.blocks.length} шагов</span></div>
    <div id="blocks">${d.blocks.map((b) => blockHtml(b, isWorkout, active === b.id)).join("")}</div>
    ${doneCriteria ? doneCriteriaHtml(doneCriteria) : ""}
    <section class="journal"><label for="note"><h3>Что заберёшь из этого дня?</h3></label><p class="hint">Одно наблюдение, маленькая победа или идея на следующий раз.</p>
    <textarea class="note" id="note" placeholder="Сегодня получилось…">${esc(note)}</textarea>
    <div class="meta" id="savestate" role="status" aria-live="polite"></div></section>
    </div><aside class="day-aside">
    <section class="wellbeing"><div class="section-heading"><h3>Как ты себя чувствуешь?</h3>${icon("safe")}</div>
    <p class="hint">Боль: 0–10 · энергия: 1–5</p><div class="meters" id="meters">${metersHtml()}</div>
    <button class="text-button" data-tab="safe">Самочувствие и правила остановки ${icon("arrow")}</button></section>
    ${isWorkout ? `<button class="route-shortcut" data-tab="routes">${icon("routes")}<span><strong>Уже у стены?</strong><small>Открой трассу и запиши попытку</small></span>${icon("arrow")}</button>` : ""}
    ${stopRules ? `<details class="section safety"><summary>Когда закончить раньше</summary>${md(stopRules.body)}</details>` : ""}
    <details class="section"><summary>Материалы и план недели</summary><div id="weekres"><p class="meta">Загрузка материалов недели…</p></div></details>
    ${restSections.map((s) => `<details class="section"><summary>${esc(s.heading)}</summary>${md(s.body)}</details>`).join("")}
    ${isWorkout ? `<details class="section"><summary>Трассы этого дня</summary><div id="dayroutes"><p class="meta">Загрузка трасс…</p></div></details>` : ""}
    </aside></div>${tabsHtml()}`;
  document.getElementById("session-start")!.onclick = () => {
    if (!next) { document.getElementById("note")!.focus(); return; }
    sessionMode = true;
    expandedBlock = next.id;
    renderDay();
    document.getElementById(`block-${next.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  void paintWeekStrip(d.date);
  wireDayNav();
  wireTabs();
  wireBlocks();
  wireMeters();
  paintSaveState();
  if (isWorkout) void paintDayRoutes(d.date);

  // Материалы недели подгружаются отдельно, чтобы день открывался сразу
  if (d.week && d.week !== "prestart") {
    weekResourcesHtml(d.week).then(async (cards) => {
      const box = document.getElementById("weekres");
      if (!box || date !== d.date || !weekCache.get(d.week)) return;
      const w = weekCache.get(d.week)!;
      box.innerHTML = cards + weekSectionsHtml(w);
    }).catch(() => {
      const box = document.getElementById("weekres");
      if (box) box.innerHTML = "";
    });
  } else {
    const box = document.getElementById("weekres");
    if (box) box.innerHTML = "";
  }
}

async function paintWeekStrip(snapshot: string): Promise<void> {
  try {
    if (!daysCache.length) daysCache = (await api.days()).days;
    const box = document.getElementById("weekstrip");
    if (!box || snapshot !== date) return;
    const offset = (new Date(`${snapshot}T12:00:00`).getDay() + 6) % 7;
    const start = shiftDate(snapshot, -offset);
    box.innerHTML = Array.from({ length: 7 }, (_, i) => {
      const iso = shiftDate(start, i);
      const item = daysCache.find((d) => d.date === iso);
      return `<button data-weekdate="${iso}" ${item ? "" : "disabled"} class="week-day ${iso === snapshot ? "selected" : ""}" ${iso === snapshot ? 'aria-current="date"' : ''} aria-label="${esc(longDate(iso))}: ${esc(item?.format ?? "Нет плана")}"><span>${["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"][i]}</span><strong>${Number(iso.slice(-2))}</strong><i class="day-dot ${fmtClass(item?.format ?? null)}"></i></button>`;
    }).join("");
    box.querySelectorAll<HTMLButtonElement>("[data-weekdate]").forEach((b) => {
      b.onclick = () => { flushSave(); date = b.dataset.weekdate!; void loadDay(); };
    });
  } catch { /* Day remains usable without the index. */ }
}

function wireDayNav(): void {
  (document.getElementById("prev") as HTMLButtonElement).onclick = () => {
    flushSave();
    date = shiftDate(date, -1);
    void loadDay();
  };
  (document.getElementById("next") as HTMLButtonElement).onclick = () => {
    flushSave();
    date = shiftDate(date, 1);
    void loadDay();
  };
  (document.getElementById("today") as HTMLButtonElement).onclick = () => {
    flushSave();
    date = todayIso();
    void loadDay();
  };
  (document.getElementById("datebtn") as HTMLButtonElement).onclick = () => goCal();
  (document.getElementById("note") as HTMLTextAreaElement).oninput = (e) => {
    note = (e.target as HTMLTextAreaElement).value;
    scheduleSave();
  };
}

function wireBlocks(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-check]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.check!;
      checks[id] = !checks[id];
      if (checks[id] && expandedBlock === id) expandedBlock = null;
      const timer = timers.get(`${date}:${id}`);
      if (checks[id] && timer?.on) { timer.on = false; window.clearInterval(timer.int); }
      scheduleSave();
      renderDay();
      const target = sessionMode ? day?.blocks.find((b) => !checks[b.id] && !/опционально|по желанию|relaxed/i.test(b.requirement))?.id : id;
      if (target) app.querySelector<HTMLButtonElement>(`[data-check="${target}"]`)?.focus({ preventScroll: !sessionMode });
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-expand]").forEach((b) => {
    b.onclick = () => {
      expandedBlock = b.getAttribute("aria-expanded") === "true" ? "none" : b.dataset.expand!;
      renderDay();
      app.querySelector<HTMLButtonElement>(`[data-expand="${b.dataset.expand}"]`)?.focus({ preventScroll: true });
    };
  });
  // Критерии «Готово, когда»: переключаем на месте, <details> не сворачиваем.
  app.querySelectorAll<HTMLButtonElement>("[data-seccheck]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.seccheck!;
      checks[id] = !checks[id];
      scheduleSave();
      const on = !!checks[id];
      b.textContent = on ? "✓" : "○";
      b.closest(".seccheck")?.classList.toggle("on", on);
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-timer]").forEach((b) => {
    b.onclick = () => toggleTimer(b.dataset.timer!);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-notetoggle]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.notetoggle!;
      openNote = openNote === id ? null : id;
      renderDay();
      const ta = document.querySelector<HTMLTextAreaElement>(`[data-blocknote="${id}"]`);
      if (ta) {
        ta.focus();
        ta.selectionStart = ta.value.length;
      }
    };
  });
  app.querySelectorAll<HTMLTextAreaElement>("[data-blocknote]").forEach((ta) => {
    ta.oninput = () => {
      const id = ta.dataset.blocknote!;
      if (ta.value.trim()) blockNotes[id] = ta.value;
      else delete blockNotes[id];
      scheduleSave();
    };
  });
}

const METER_DEFS: { key: keyof DayMetrics; label: string; min: number; max: number }[] = [
  { key: "shoulder", label: "Плечо", min: 0, max: 10 },
  { key: "fingers", label: "Пальцы", min: 0, max: 10 },
  { key: "knee", label: "Колено", min: 0, max: 10 },
  { key: "energy", label: "Энергия", min: 1, max: 5 },
];

function meterHtml(key: keyof DayMetrics, label: string, min: number, max: number): string {
  const v = metrics[key];
  const val = v === undefined ? `<strong class="emptyval">${min}–${max}</strong>` : `<strong id="mv-${key}">${v}</strong>`;
  return `<div class="meter"><span>${label}</span>
    <button data-meter="${key}" data-min="${min}" data-max="${max}" data-d="-1" aria-label="${label} меньше">−</button>
    ${val}
    <button data-meter="${key}" data-min="${min}" data-max="${max}" data-d="1" aria-label="${label} больше">+</button>
  </div>`;
}

// Фиксированный порядок шкал: пересортировка при каждом тапе дезориентирует
// (ряд, по которому только что тапнули, прыгает на другое место).
function metersHtml(): string {
  return METER_DEFS.map((m) => meterHtml(m.key, m.label, m.min, m.max)).join("");
}

function paintMeters(): void {
  const box = document.getElementById("meters");
  if (!box) return;
  box.innerHTML = metersHtml();
  wireMeters();
}

function wireMeters(): void {
  app.querySelectorAll<HTMLButtonElement>("[data-meter]").forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.meter as keyof DayMetrics;
      const min = Number(b.dataset.min);
      const max = Number(b.dataset.max);
      const d = Number(b.dataset.d);
      const cur = metrics[key];
      const next = cur === undefined ? (d > 0 ? min : max) : Math.min(max, Math.max(min, cur + d));
      if (next === cur) return;
      metrics[key] = next;
      scheduleSave();
      paintMeters(); // порядок фиксированный — ничего не прыгает
    };
  });
}

function blockHtml(b: PlanDay["blocks"][number], showTimeline: boolean, expanded = true): string {
  const t = timers.get(`${date}:${b.id}`);
  const left = t ? t.left : b.minutes * 60;
  const running = t?.on ?? false;
  // На нетренировочных днях «таймлайн» 00:00–05:00 бессмысленен (это минуты
  // от начала рутины, а не время дня) — показываем длительность.
  const timeChip = showTimeline
    ? `<span class="time">${b.minutes} мин <span class="timeline-offset">· ${esc(b.start)}–${esc(b.end)} от начала</span></span>`
    : b.minutes > 0 ? `<span class="time">${b.minutes} мин</span>` : "";
  const bn = blockNotes[b.id] ?? "";
  // Заметка — только где план явно просит (маркер 📝 в тексте задачи)
  // или где заметка уже есть.
  const wantsNote = bn !== "" || b.text.includes("📝");
  const noteOpen = openNote === b.id || bn !== "";
  const preview = bn.length > 42 ? bn.slice(0, 42) + "…" : bn;
  const isOpt = /опционально|по желанию|relaxed/i.test(b.requirement);
  const on = !!checks[b.id];
  return `<div id="block-${b.id}" class="block ${on ? "done" : ""} ${expanded ? "expanded" : "collapsed"}">
    <div class="row1">
      <button class="check" data-check="${b.id}" aria-label="Отметить блок: ${esc(b.kind)}" aria-pressed="${on}">${on ? "✓" : "○"}</button>
      <div class="bmain"><button class="block-disclosure" data-expand="${b.id}" aria-expanded="${expanded}" aria-controls="detail-${b.id}"><span class="kind">${esc(b.kind)}</span><span class="disclosure-arrow">${expanded ? "−" : "+"}</span></button>${timeChip}
        <div class="chips"><span class="chip ${isOpt ? "opt" : "req"}">${isOpt ? "○" : "●"} ${esc(b.requirement)}</span>${b.section !== "Чек-лист по минутам" ? `<span class="chip">${esc(b.section)}</span>` : ""}</div>
      </div>
    </div>
    <div id="detail-${b.id}" ${expanded ? "" : "hidden"}><div class="text">${md(b.text)}</div>
    ${b.intensity || b.caution
      ? `<div class="detail">${b.intensity ? `Нагрузка: ${esc(b.intensity)}.<br>` : ""}${b.caution ? `Осторожно: ${esc(b.caution)}` : ""}</div>`
      : ""}
    ${b.minutes > 0
      ? `<div class="timer"><span class="t" id="t-${b.id}" title="Осталось">${fmtLeft(left)}</span>
        <button data-timer="${b.id}">${running ? "⏸ Пауза" : t ? "▶ Дальше" : "▶ Старт"}</button></div>`
      : ""}
    <div class="bnote">
      ${wantsNote ? `<button class="notetoggle" data-notetoggle="${b.id}">${bn ? `✎ ${esc(preview)}` : "✎ Заметка…"}</button>` : ""}
      ${noteOpen && wantsNote ? `<textarea class="blocknote" data-blocknote="${b.id}" rows="2" placeholder="Заметка к этой задаче…">${esc(bn)}</textarea>` : ""}
    </div></div>
  </div>`;
}

function toggleTimer(id: string): void {
  const block = day?.blocks.find((b) => b.id === id);
  if (!block) return;
  const timerDate = date;
  const timerKey = `${date}:${id}`;
  let st = timers.get(timerKey);
  if (!st) {
    st = { left: block.minutes * 60, total: block.minutes * 60, on: false };
    timers.set(timerKey, st);
  }
  if (st.on) {
    st.on = false;
    if (st.int) window.clearInterval(st.int);
  } else {
    if (st.left <= 0) st.left = st.total;
    st.on = true;
    const deadline = Date.now() + st.left * 1000;
    st.int = window.setInterval(() => {
      st!.left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const el = document.getElementById(`t-${id}`);
      if (el && date === timerDate) el.textContent = fmtLeft(st!.left);
      if (st!.left <= 0) {
        st!.on = false;
        if (st!.int) window.clearInterval(st!.int);
        beep();
        if (tab === "today" && date === timerDate) renderDay();
      }
    }, 1000);
  }
  renderDay();
}

// ---------- Календарь (свой, месячный) ----------

const MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthTitle(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}

async function renderCal(): Promise<void> {
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка календаря…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  // Отметки прогресса — необязательны: сетка строится по плану из /api/days,
  // раньше падение /api/activity убивало весь календарь.
  let activityWarn = "";
  try {
    await ensureActivity();
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    activityWarn = apiErrorText(e);
  }
  try {
    if (!daysCache.length) daysCache = (await api.days()).days;
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    const msg = apiErrorText(e);
    app.innerHTML = `<header class="top">${topHtml()}</header>
      <h1>Календарь</h1>
      <p>Нет связи с API: ${esc(msg)}</p>
      <button class="listitem" id="retry"><div class="d">Попробовать снова</div></button>
      ${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
    (document.getElementById("retry") as HTMLButtonElement).onclick = () => void renderCal();
    return;
  }
  if (tab !== "cal") return;
  const [y, mo] = calMonth.split("-").map(Number);
  const first = new Date(y, mo - 1, 1);
  const lead = (first.getDay() + 6) % 7; // понедельник первый
  const dim = new Date(y, mo, 0).getDate();
  const today = todayIso();
  let cells = "";
  for (let i = 0; i < lead; i++) cells += `<div class="mcell empty"></div>`;
  for (let dd = 1; dd <= dim; dd++) {
    const iso = `${calMonth}-${String(dd).padStart(2, "0")}`;
    const a = activityByDate.get(iso);
    if (!a) {
      cells += `<div class="mcell empty"><span class="mnum">${dd}</span></div>`;
      continue;
    }
    const lvl = levelOf(a, today);
    const star = lvl === "l4" ? `<span class="mstar">★</span>` : "";
    cells += `<button class="mcell ${lvl} kind-${a.kind} ${iso === date ? "sel" : ""}" data-date="${iso}" aria-label="${esc(longDate(iso))}: ${esc(a.format ?? "Свободный день")}, ${a.done} из ${a.requiredTotal}" ${iso === date ? 'aria-current="date"' : ""}>
      <span class="mnum">${dd}</span>${star}
      <span class="mdot ${fmtClass(a.format)}">${fmtLetter(a.format)}</span>
      ${a.requiredMinutes ? `<span class="mmin">${a.requiredMinutes}′</span>` : ""}
    </button>`;
  }
  const cur = daysCache.find((d) => d.date === date && d.date.startsWith(calMonth)) ?? daysCache.find((d) => d.date.startsWith(calMonth));
  const weekId = cur?.week ?? "";
  const list = daysCache.filter((d) => d.week === weekId);
  const weekLabel = weekId === "prestart" ? "Подготовка" : weekId.replace("week_", "").replace(/_/g, " ");
  app.innerHTML = `<header class="top">${topHtml()}</header>
    <p class="eyebrow">ТВОЙ ПЛАН</p><h1>Неделя за неделей.</h1><p class="page-description">Чередуй нагрузку и восстановление. Выбери день, чтобы открыть занятие.</p>${accountHtml()}
    ${activityWarn ? `<div class="cue">Отметки прогресса не загрузились (${esc(activityWarn)}) — сетка по плану, галочки подтянутся позже.
      <div class="subchips"><button class="subchip" id="actretry">Обновить отметки</button></div></div>` : ""}
    <div class="calendar-layout"><section class="calendar-panel"><div class="monline">
      <button id="mprev" aria-label="Прошлый месяц">‹</button>
      <strong>${monthTitle(calMonth)}</strong>
      <button id="mnext" aria-label="Следующий месяц">›</button>
    </div>
    <div class="mweek">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="mgrid">${cells}</div>
    <div class="legend">
      <span><i class="sw fA"></i>A · техника вт</span>
      <span><i class="sw fB"></i>B · проект чт</span>
      <span><i class="sw fHome"></i>дом</span>
      <span><i class="ksw sun"></i>вс — relaxed</span>
      <span>★ — день закрыт</span>
    </div>
    </section><section class="week-agenda"><p class="eyebrow">БЛИЖЕ К ЦЕЛИ</p><h3>${weekId === "prestart" ? "Подготовка к старту" : `Неделя ${esc(weekLabel.split(" ")[0])}`}</h3>
    ${list.map((d) => {
      const a = activityByDate.get(d.date);
      const doneDay = !!a && a.requiredTotal > 0 && a.done >= a.requiredTotal;
      const mark = doneDay ? "✓ " : "";
      const isToday = d.date === todayIso();
      return `<button class="listitem${isToday ? " today" : ""}" data-date="${d.date}">
        <div class="agenda-date">${esc(longDate(d.date))}${isToday ? " · сегодня" : ""}</div><div class="d">${mark}${esc(d.format ?? "Свободный день")}</div>
        <div class="s">${esc(d.format ?? "Свободный день")}${a && a.requiredMinutes ? ` · ~${a.requiredMinutes} мин` : ""}${a && a.requiredTotal > 0 ? ` · готово ${a.done} из ${a.requiredTotal}` : ""}</div>
      </button>`;
    }).join("")}
    </section></div>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  (document.getElementById("mprev") as HTMLButtonElement).onclick = () => {
    calMonth = shiftMonth(calMonth, -1);
    void renderCal();
  };
  (document.getElementById("mnext") as HTMLButtonElement).onclick = () => {
    calMonth = shiftMonth(calMonth, 1);
    void renderCal();
  };
  const actretry = document.getElementById("actretry") as HTMLButtonElement | null;
  if (actretry) actretry.onclick = () => {
    activityCache = null;
    void renderCal();
  };
  app.querySelectorAll<HTMLButtonElement>("[data-date]").forEach((b) => {
    b.onclick = () => {
      flushSave();
      date = b.dataset.date!;
      tab = "today";
      void loadDay();
    };
  });
}

function wireDayNavLite(): void {
  const prev = document.getElementById("prev") as HTMLButtonElement | null;
  if (prev) prev.onclick = () => {
    flushSave();
    date = shiftDate(date, -1);
    tab = "today";
    void loadDay();
  };
  const next = document.getElementById("next") as HTMLButtonElement | null;
  if (next) next.onclick = () => {
    flushSave();
    date = shiftDate(date, 1);
    tab = "today";
    void loadDay();
  };
  const t = document.getElementById("today") as HTMLButtonElement | null;
  if (t) t.onclick = () => {
    flushSave();
    date = todayIso();
    calMonth = date.slice(0, 7);
    tab = "today";
    void loadDay();
  };
  const inp = document.getElementById("datebtn") as HTMLButtonElement | null;
  if (inp) inp.onclick = () => goCal();
}

// ---------- Трассы: зал, QR/scan-only, карточка, попытки, рекомендации ----------

function newAttemptId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `att-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  }
}

// Своё фото трассы: ужимаем на клиенте (≤800px, JPEG), чтобы пролезть в лимит API.
function fileToPhotoUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, 800 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.68));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("not an image"));
    };
    img.src = url;
  });
}

async function saveRoutePhoto(routeId: string, photoUrl: string | null): Promise<void> {
  try {
    await api.enrichRoute(routeId, { photoUrl });
    cardCache.delete(routeId);
    qrMsg = photoUrl ? "Фото прикреплено." : "Фото убрано.";
    await openCard(routeId);
  } catch {
    qrMsg = "Фото не сохранилось (нужен https или файл поменьше).";
    renderRoutesView();
  }
}

function routeTitle(r: RouteWithPersonal["route"]): string {
  return r.name || r.holdDescription || (r.canonicalUrl ? "BETA7-трасса" : "Ручная трасса");
}

function statusRu(s: string): string {
  return { DISCOVERED: "Увидел", WANT_TO_TRY: "Хочу", PLANNED: "В плане", PROJECTING: "Проект", SENT: "Сделал", FLASHED: "Флеш", SKIPPED: "Пропуск" }[s] ?? s;
}

const ATT_RESULT_RU: Record<string, string> = {
  FAILED: "Не вышло", SENT: "Сделал", FLASHED: "Флеш", ABORTED: "Прервал", SKIPPED: "Пропустил",
};

const FAIL_REASONS_RU: [string, string][] = [
  ["START", "Старт"], ["MOVE_UNCLEAR", "Не понял движение"], ["FOOT_SLIP", "Сорвались ноги"],
  ["HOLD_FAILURE", "Не удержал зацеп"], ["POWER", "Сила"], ["ENDURANCE", "Выносливость"],
  ["REACH", "Размах"], ["FEAR", "Страшно"], ["FATIGUE", "Устал"],
  ["PAIN_OR_DISCOMFORT", "Боль"], ["OTHER", "Другое"],
];
const FAIL_RU: Record<string, string> = Object.fromEntries(FAIL_REASONS_RU);

let armedDelAtt: string | null = null;
let armedDelTimer: number | undefined;

// История попыток: все, по сессиям (датам). Дата кликабельна — прыжок в день,
// у каждой попытки время и × (в два тапа) на случайный тап.
function attemptsHtml(list: RouteAttempt[]): string {
  if (!list.length) return `<div class="s meta">Попыток пока нет.</div>`;
  const groups = new Map<string, RouteAttempt[]>();
  const sorted = [...list].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  for (const a of sorted) {
    const k = a.workoutDate ?? "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }
  return [...groups.entries()].map(([d, items]) => `
    <div class="sess">
      ${d
        ? `<button class="sessdate" data-godate="${d}">Сессия · ${fmtDateRu(d)} · ${items.length}</button>`
        : `<span class="sessdate dim">Без даты · ${items.length}</span>`}
      ${items.map((a) => `
        <div class="att">
          <span class="attnum">#${a.attemptNumber}</span>
          <span class="attres">${esc(ATT_RESULT_RU[a.result] ?? a.result)}</span>
          ${a.failureReason ? `<span class="attfail">${esc(FAIL_RU[a.failureReason] ?? a.failureReason)}</span>` : ""}
          <span class="atttime">${esc(a.recordedAt.slice(11, 16))}</span>
          <button class="attx${armedDelAtt === a.id ? " armed" : ""}" data-delatt="${a.id}" aria-label="Удалить попытку">${
            armedDelAtt === a.id ? "Убрать?" : "×"}</button>
        </div>`).join("")}
    </div>`).join("");
}

async function renderRoutes(): Promise<void> {
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка трасс…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    if (!gymsCache.length) gymsCache = (await api.gyms()).gyms;
    if (!gymsCache.some((g) => g.id === selGym)) selGym = gymsCache[0]?.id ?? "gym_berta";
    const res = await api.gymRoutes(selGym);
    routesList = res.items;
    catalogWarn = res.catalog.warning;
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${topHtml()}</header><p>Нет связи с API: ${esc(apiErrorText(e))}</p>${tabsHtml()}`;
    wireTabs();
    return;
  }
  renderRoutesView();
}

function renderRoutesView(): void {
  if (tab !== "routes") return;
  const gym = gymsCache.find((g) => g.id === selGym);
  const canScan = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined";
  const card = openRouteId ? cardCache.get(openRouteId) : undefined;
  app.innerHTML = `<header class="top">${topHtml()}</header>
    <p class="eyebrow">В ЗАЛЕ</p><h1>Каждая попытка считается.</h1><p class="page-description">Найди свою трассу. Попробуй. Запомни, что сработало.</p>${accountHtml()}
    ${card ? `<button id="route-back" class="text-button">← К коллекции трасс</button>${routeCardHtml(card)}` : ""}
    <div ${card ? "hidden" : ""}>
    <div class="subchips scrollx">${gymsCache.map((g) =>
      `<button class="subchip ${g.id === selGym ? "active" : ""}" data-gym="${esc(g.id)}">${esc(g.name)}</button>`).join("")}</div>
    ${catalogWarn ? `<div class="cue">${esc(catalogWarn)}</div>` : ""}
    ${gym?.provider === "beta7" ? `<details class="section slim"><summary>Как это работает</summary><p class="hint">QR у стартового зацепа → карточка трассы. Каталог пополняется после разрешения BETA7.</p></details>` : ""}
    <section class="route-entry"><h3>Добавь трассу у стены</h3><p class="hint">Сканируй QR-код или вставь ссылку с него.</p>
    <div class="qrrow">
      <input class="search" id="qrtext" placeholder="https://beta7.app/route/…" value="${esc(qrText)}" inputmode="url" aria-label="Ссылка с QR-кода трассы" />
      ${canScan ? `<button class="iconbtn${scanning ? " active" : ""}" id="qrscan" aria-label="${scanning ? "Остановить камеру" : "Сканировать камерой"}">📷</button>` : ""}
    </div>
    <button class="primary blockbtn" id="qrgo">Открыть трассу ${icon("arrow")}</button>
    ${scanning ? `<video id="scanvid" playsinline muted style="width:100%;border-radius:12px;background:#000"></video>` : ""}
    ${qrMsg ? `<div class="cue" role="status">${esc(qrMsg)}</div>` : ""}</section>
    <h3>Подобрать под тренировку</h3>
    <div class="subchips"><button class="subchip" id="reco">Разминка · техника · проект</button>
    <button class="subchip" id="sync">Обновить каталог</button></div>
    <div id="recoout">${recoCache ? recoHtml(recoCache) : ""}</div>
    <div class="section-heading"><h3>Твоя коллекция</h3><span>${routesList.length} трасс</span></div>
    <input class="search" type="search" id="route-search" placeholder="Название, сектор или грейд…" aria-label="Найти трассу" value="${esc(routeQuery)}" />
    <div class="subchips scrollx">${[["all", "Все"], ["project", "В работе"], ["want", "Хочу попробовать"], ["sent", "Пройдены"]].map(([id, label]) => `<button class="subchip ${routeFilter === id ? "active" : ""}" data-routefilter="${id}" aria-pressed="${routeFilter === id}">${label}</button>`).join("")}</div>
    <div id="route-results" class="route-grid"></div>
    <details class="section"><summary>Добавить вручную</summary>
      <input class="search" id="m-sector" aria-label="Сектор" placeholder="Сектор" />
      <input class="search" id="m-name" aria-label="Название или зацепы" placeholder="Название / зацепы" />
      <input class="search" id="m-grade" aria-label="Грейд" placeholder="Грейд, напр. 6C/LILA" />
      <input class="search" id="m-styles" aria-label="Стили" placeholder="Стили через запятую: footwork, balance" />
      <button class="subchip active" id="m-add">Добавить в ${esc(gym?.name ?? "")}</button>
    </details>
    </div>${card && qrMsg ? `<div class="cue" role="status">${esc(qrMsg)}</div>` : ""}${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  app.querySelectorAll<HTMLButtonElement>("[data-gym]").forEach((b) => {
    b.onclick = () => {
      selGym = b.dataset.gym!;
      localStorage.setItem("bp:gym", selGym);
      openRouteId = null;
      recoCache = null;
      void renderRoutes();
    };
  });
  const back = document.getElementById("route-back");
  if (back) back.onclick = () => { openRouteId = null; qrMsg = ""; renderRoutesView(); };
  paintRouteResults();
  const search = document.getElementById("route-search") as HTMLInputElement;
  search.oninput = () => { routeQuery = search.value; paintRouteResults(); };
  app.querySelectorAll<HTMLButtonElement>("[data-routefilter]").forEach((b) => {
    b.onclick = () => {
      routeFilter = b.dataset.routefilter!;
      app.querySelectorAll<HTMLButtonElement>("[data-routefilter]").forEach((item) => {
        item.classList.toggle("active", item.dataset.routefilter === routeFilter);
        item.setAttribute("aria-pressed", String(item.dataset.routefilter === routeFilter));
      });
      paintRouteResults();
    };
  });
  const qi = document.getElementById("qrtext") as HTMLInputElement;
  qi.oninput = () => {
    qrText = qi.value;
  };
  (document.getElementById("qrgo") as HTMLButtonElement).onclick = () => void doResolve();
  const qs = document.getElementById("qrscan") as HTMLButtonElement | null;
  if (qs) qs.onclick = () => void toggleScan();
  if (scanning) void attachScanner();
  app.querySelectorAll<HTMLButtonElement>("[data-route]").forEach((b) => {
    b.onclick = () => void openCard(b.dataset.route!);
  });
  if (card) wireCard(card);
  (document.getElementById("reco") as HTMLButtonElement).onclick = () => void doReco();
  (document.getElementById("sync") as HTMLButtonElement).onclick = () => void doSync();
  app.querySelectorAll<HTMLButtonElement>("[data-recoroute]").forEach((b) => {
    b.onclick = () => void openCard(b.dataset.recoroute!);
  });
  (document.getElementById("m-add") as HTMLButtonElement).onclick = () => void doManualAdd();
}

function paintRouteResults(): void {
  const box = document.getElementById("route-results");
  if (!box) return;
  const items = routesList.filter(({ route: r, personalState: st }) => {
    const matches = [routeTitle(r), r.sector, r.grade.raw, ...r.styles].join(" ").toLowerCase().includes(routeQuery.trim().toLowerCase());
    return matches && (routeFilter === "all" || (routeFilter === "project" && st?.status === "PROJECTING") || (routeFilter === "want" && st?.status === "WANT_TO_TRY") || (routeFilter === "sent" && st?.sent));
  });
  box.innerHTML = items.map(({ route: r, personalState: st }) => `<button class="route-tile" data-route="${esc(r.id)}"><span class="route-grade">${esc(r.grade.raw || "?")}</span><span class="route-info"><strong>${esc(routeTitle(r))}</strong><small>${esc(r.sector || "Сектор не указан")}${st ? ` · ${esc(statusRu(st.status))}` : ""}</small><small>${st?.totalAttempts ?? 0} попыток${r.styles.length ? ` · ${esc(r.styles.slice(0, 2).join(" · "))}` : ""}</small></span>${icon("arrow")}</button>`).join("") || `<div class="empty-state">${icon("routes")}<h3>${routesList.length ? "Таких трасс пока нет" : "Твоя первая трасса ждёт"}</h3><p>${routesList.length ? "Попробуй другой запрос или фильтр." : "Открой QR-код у стартового зацепа или добавь трассу вручную."}</p></div>`;
  box.querySelectorAll<HTMLButtonElement>("[data-route]").forEach((b) => { b.onclick = () => void openCard(b.dataset.route!); });
}

function routeCardHtml(c: RouteCard): string {
  const r = c.route;
  const st = c.personalState;
  const secs = st ? Math.floor(st.totalTimeSeconds / 60) : 0;
  const stats: [string, string][] = [
    ["WANT_TO_TRY", "Хочу"], ["PROJECTING", "Проект"], ["SENT", "Сделал"], ["FLASHED", "Флеш"], ["SKIPPED", "Пропуск"],
  ];
  return `<div class="acc route-card">
    <p class="eyebrow">${esc(r.grade.raw || "БЕЗ ГРЕЙДА")}</p><h2>${esc(routeTitle(r))}</h2>
    <div class="attempt-entry"><span class="eyebrow">ЗАПИСАТЬ ПОПЫТКУ · ${esc(fmtDateRu(date))}</span>
    <div class="attempt-actions"><button data-att="FAILED">Не получилось</button><button class="primary" data-att="SENT">Сделал ✓</button><button data-att="FLASHED">Флеш</button></div></div>
    <div class="s meta">${esc([r.gymName, r.sector, r.grade.raw || "грейд не указан"].filter(Boolean).join(" · "))}</div>
    ${r.photoUrl ? `<img class="routephoto" src="${esc(r.photoUrl)}" alt="Фото трассы" loading="lazy" />
    ${r.photoSource === "beta7" ? `<div class="s meta">Фото сектора с сайта — не конкретной трассы</div>` : ""}` : ""}
    <details class="section slim"><summary>${r.photoUrl ? "Изменить фото" : "Добавить фото трассы"}</summary>
      <input class="search" id="ph-url" aria-label="Ссылка на фото" placeholder="Вставь ссылку на фото…" value="" inputmode="url" />
      <div class="subchips">
        <button class="subchip" id="ph-save">Прикрепить ссылку</button>
        <button class="subchip" id="ph-pick">📷 Снять / выбрать…</button>
        ${r.photoUrl ? `<button class="subchip" id="ph-del">Убрать фото</button>` : ""}
      </div>
      <input type="file" id="ph-file" accept="image/*" style="display:none" />
    </details>
    ${r.styles.length ? `<div class="terms">${r.styles.map((s) => `<span class="term">${esc(s)}</span>`).join("")}</div>` : ""}
    ${r.setter ? `<div class="s meta">Постановщик: ${esc(r.setter)}</div>` : ""}
    ${!r.sector || !r.grade.raw ? `<div class="cue">Деталей мало — дополни:
      <input class="search" id="e-sector" aria-label="Сектор" placeholder="Сектор" value="${esc(r.sector ?? "")}" />
      <input class="search" id="e-grade" aria-label="Грейд" placeholder="Грейд" value="${esc(r.grade.raw ?? "")}" />
      <button class="subchip active" id="e-save">Сохранить</button></div>` : ""}
    <div class="meta"><span>Попыток: всего ${st?.totalAttempts ?? c.attempts.length}</span><span>· ~${secs} мин</span></div>
    <p class="eyebrow">В КОЛЛЕКЦИИ</p><div class="subchips">${stats.map(([v, l]) =>
      `<button class="subchip ${st?.status === v ? "active" : ""}" data-st="${v}">${l}</button>`).join("")}</div>
    <div class="meta"><span>Почему не получилось:</span>
      <select aria-label="Почему не получилось" id="failreason" class="subchip">
        ${FAIL_REASONS_RU.map(([v, l]) =>
          `<option value="${v}" ${failReason === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button class="subchip" id="tm-toggle">${c.timers.some((t) => t.status === "RUNNING") ? "Пауза таймера" : "Начать таймер"}</button>
    </div>
    <h3>Попытки</h3>
    ${attemptsHtml(c.attempts)}
    ${r.canonicalUrl ? `<div class="s"><a href="${esc(r.canonicalUrl)}" target="_blank" rel="noopener">Открыть в BETA7</a></div>` : ""}
  </div>`;
}

function wireCard(c: RouteCard): void {
  app.querySelectorAll<HTMLButtonElement>("[data-st]").forEach((b) => {
    b.onclick = () => void doState(b.dataset.st!);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-att]").forEach((b) => {
    b.onclick = () => void doAttempt(b.dataset.att!);
  });
  app.querySelectorAll<HTMLButtonElement>("[data-delatt]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.delatt!;
      if (armedDelAtt !== id) {
        // Первый тап — взвести, второй в течение 3 сек — удалить.
        armedDelAtt = id;
        window.clearTimeout(armedDelTimer);
        armedDelTimer = window.setTimeout(() => {
          armedDelAtt = null;
          renderRoutesView();
        }, 3000);
        renderRoutesView();
        return;
      }
      window.clearTimeout(armedDelTimer);
      armedDelAtt = null;
      void (async () => {
        try {
          await api.deleteAttempt(id);
          qrMsg = "Попытка удалена.";
        } catch {
          qrMsg = "Не удалилось.";
        }
        await refreshCard();
      })();
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-godate]").forEach((b) => {
    b.onclick = () => {
      const d = b.dataset.godate!;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
      flushSave();
      date = d;
      tab = "today";
      void loadDay();
    };
  });
  const fr = document.getElementById("failreason") as HTMLSelectElement | null;
  if (fr) fr.onchange = () => {
    failReason = fr.value;
  };
  const tm = document.getElementById("tm-toggle") as HTMLButtonElement | null;
  if (tm) tm.onclick = () => void doTimer();
  const phSave = document.getElementById("ph-save") as HTMLButtonElement | null;
  if (phSave) {
    phSave.onclick = () => {
      const v = (document.getElementById("ph-url") as HTMLInputElement).value.trim();
      if (!v) {
        qrMsg = "Вставь ссылку на фото или сними камерой.";
        renderRoutesView();
        return;
      }
      void saveRoutePhoto(c.route.id, v);
    };
  }
  const phPick = document.getElementById("ph-pick") as HTMLButtonElement | null;
  if (phPick) {
    phPick.onclick = () => {
      (document.getElementById("ph-file") as HTMLInputElement).click();
    };
  }
  const phFile = document.getElementById("ph-file") as HTMLInputElement | null;
  if (phFile) {
    phFile.onchange = () => {
      const f = phFile.files?.[0];
      if (!f) return;
      void fileToPhotoUrl(f).then(
        (dataUrl) => saveRoutePhoto(c.route.id, dataUrl),
        () => {
          qrMsg = "Файл не похож на фото.";
          renderRoutesView();
        },
      );
    };
  }
  const phDel = document.getElementById("ph-del") as HTMLButtonElement | null;
  if (phDel) phDel.onclick = () => void saveRoutePhoto(c.route.id, null);
  const es = document.getElementById("e-save") as HTMLButtonElement | null;
  if (es) {
    es.onclick = async () => {
      try {
        await api.enrichRoute(c.route.id, {
          sector: (document.getElementById("e-sector") as HTMLInputElement).value,
          gradeRaw: (document.getElementById("e-grade") as HTMLInputElement).value,
        });
        cardCache.delete(c.route.id);
        await openCard(c.route.id);
      } catch (e) {
        qrMsg = e instanceof Error ? e.message : "Не сохранилось";
        renderRoutesView();
      }
    };
  }
}

async function openCard(id: string): Promise<void> {
  try {
    openRouteId = id;
    cardCache.set(id, await api.routeCard(id));
    qrMsg = "";
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Карточка не открылась";
  }
  stopScanner();
  renderRoutesView();
  window.scrollTo(0, 0);
}

async function refreshCard(): Promise<void> {
  if (!openRouteId) return;
  try {
    cardCache.set(openRouteId, await api.routeCard(openRouteId));
    const res = await api.gymRoutes(selGym);
    routesList = res.items;
  } catch { /* покажем что есть */ }
  renderRoutesView();
}

async function doResolve(): Promise<void> {
  const payload = qrText.trim();
  if (!payload) {
    qrMsg = "Вставь ссылку с QR-кода.";
    renderRoutesView();
    return;
  }
  try {
    // На сервер уходит только строковый payload (декодирование — локально).
    const out: QrResolveOut = await api.resolveQr(payload, selGym);
    if (out.route) {
      openRouteId = out.route.id;
      cardCache.delete(out.route.id);
      try {
        cardCache.set(out.route.id, await api.routeCard(out.route.id));
      } catch { /* карточка из resolve */ }
      const res = await api.gymRoutes(selGym);
      routesList = res.items;
    }
    qrMsg = out.warnings.join(" ") || "Трасса распознана.";
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Не распозналось — добавь вручную ниже.";
  }
  renderRoutesView();
}

async function toggleScan(): Promise<void> {
  if (scanning) {
    stopScanner();
    renderRoutesView();
    return;
  }
  try {
    await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then((s) => {
      s.getTracks().forEach((t) => t.stop());
    });
  } catch {
    qrMsg = "Нет доступа к камере — вставь ссылку вручную.";
    renderRoutesView();
    return;
  }
  scanning = true;
  qrMsg = "Наведи камеру на QR у стартового зацепа.";
  renderRoutesView();
}

function stopScanner(): void {
  scanning = false;
  if (scanTimer) window.clearInterval(scanTimer);
  scanTimer = undefined;
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

async function attachScanner(): Promise<void> {
  const BD = (window as unknown as { BarcodeDetector?: new () => { detect(v: HTMLVideoElement): Promise<{ rawValue: string }[]> } }).BarcodeDetector;
  const video = document.getElementById("scanvid") as HTMLVideoElement | null;
  if (!BD || !video) return;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = scanStream;
    await video.play();
    const det = new BD();
    let last = "";
    let lastAt = 0;
    scanTimer = window.setInterval(async () => {
      try {
        const found = await det.detect(video);
        const val = found[0]?.rawValue ?? "";
        if (val && (val !== last || Date.now() - lastAt > 3000)) {
          last = val;
          lastAt = Date.now();
          try {
            if (navigator.vibrate) navigator.vibrate(60);
          } catch { /* noop */ }
          qrText = val;
          stopScanner();
          await doResolve();
        }
      } catch { /* следующий кадр */ }
    }, 500);
  } catch {
    scanning = false;
    qrMsg = "Камера не запустилась — вставь ссылку вручную.";
    renderRoutesView();
  }
}

async function doState(status: string): Promise<void> {
  if (!openRouteId) return;
  try {
    // Повторный клик по активному статусу снимает его (назад в «Увидел»).
    const cur = cardCache.get(openRouteId)?.personalState?.status;
    await api.setRouteState(openRouteId, cur === status ? "DISCOVERED" : status);
    await refreshCard();
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Статус не сохранился";
    renderRoutesView();
  }
}

let attemptBusy = false;
let lastAttemptTap = 0;
const ATTEMPT_DEBOUNCE_MS = 3000;

async function doAttempt(result: string): Promise<void> {
  if (!openRouteId) return;
  // Двойной тап = случайное нажатие: слишком быстрые клики не считаем.
  if (attemptBusy) return;
  if (Date.now() - lastAttemptTap < ATTEMPT_DEBOUNCE_MS) {
    qrMsg = "Слишком быстро подряд — не считаю, это похоже на случайный тап.";
    renderRoutesView();
    return;
  }
  attemptBusy = true;
  lastAttemptTap = Date.now();
  try {
    await api.addAttempt({
      routeId: openRouteId,
      clientAttemptId: newAttemptId(),
      result,
      failureReason: result === "FAILED" ? failReason : null,
      workoutDate: date,
    });
    qrMsg = result === "SENT" ? "Есть send! 🎉" : result === "FLASHED" ? "Флеш! 🔥" : "Попытка записана.";
    await refreshCard();
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Попытка не записалась";
    renderRoutesView();
  } finally {
    attemptBusy = false;
  }
}

async function doTimer(): Promise<void> {
  if (!openRouteId) return;
  try {
    const card = cardCache.get(openRouteId);
    const running = card?.timers.some((t) => t.status === "RUNNING");
    if (running) await api.timerStop(openRouteId, date);
    else await api.timerStart(openRouteId, date);
    await refreshCard();
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Таймер не переключился";
    renderRoutesView();
  }
}

async function doManualAdd(): Promise<void> {
  const v = (id: string): string => (document.getElementById(id) as HTMLInputElement).value.trim();
  try {
    const created = await api.createRoute({
      gymId: selGym,
      sector: v("m-sector"),
      name: v("m-name"),
      gradeRaw: v("m-grade"),
      styles: v("m-styles").split(",").map((s) => s.trim()).filter(Boolean),
    });
    openRouteId = created.route.id;
    cardCache.delete(created.route.id);
    const res = await api.gymRoutes(selGym);
    routesList = res.items;
    qrMsg = "Трасса добавлена вручную.";
    await refreshCard();
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Не добавилось";
    renderRoutesView();
  }
}

async function doSync(): Promise<void> {
  qrMsg = "Качаю свежие трассы с сайта…";
  renderRoutesView();
  try {
    const run = await api.syncGym(selGym);
    const res = await api.gymRoutes(selGym);
    routesList = res.items;
    catalogWarn = res.catalog.warning;
    qrMsg = `Готово: новых ${run.discovered}, обновлено ${run.updated}. Каталог частичный — дальше каталог растёт от твоих сканов.`;
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Не обновилось";
  }
  renderRoutesView();
}

function recoHtml(list: NonNullable<typeof recoCache>): string {
  return list.map((ex) => `<div class="res"><div class="d">${esc(ex.exerciseId)}</div>
    ${ex.relaxations.length ? `<div class="s">Ослабили: ${esc(ex.relaxations.join("; "))}</div>` : ""}
    ${ex.candidates.map((c) => `<div class="s">• <button class="term" data-recoroute="${esc(c.route.route.id)}">${esc(routeTitle(c.route.route))}</button>
      ${esc(c.route.route.grade.raw || "")} — ${esc(c.reasons.join("; ") || "по общим правилам")}
      ${c.alternatives.length ? `<br>Замена: ${esc(routeTitle(c.alternatives[0]!.route.route))}` : ""}</div>`).join("") ||
    `<div class="s">Нет подходящих — иди к стене и сканируй QR.</div>`}
  </div>`).join("");
}

async function doReco(): Promise<void> {
  try {
    const out = await api.recommend(selGym, [
      { id: "Разминка", targetCount: 3, difficulty: { min: 3.5, max: 4.5 }, targetStyles: [], excludeSent: false, selectionPolicy: "warmup" },
      { id: "Техника", targetCount: 4, difficulty: { min: 4.8, max: 5.7 }, targetStyles: ["footwork", "balance", "technic"], selectionPolicy: "skill_development" },
      { id: "Проект", targetCount: 1, difficulty: { min: 6.0, max: 6.8 }, targetStyles: [], selectionPolicy: "project" },
    ]);
    recoCache = out.exercises;
    qrMsg = "";
  } catch (e) {
    qrMsg = e instanceof Error ? e.message : "Не подобралось";
  }
  renderRoutesView();
}

// ---------- Прогресс: heatmap как на Гитхабе ----------

async function renderProg(): Promise<void> {
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка прогресса…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    await ensureActivity();
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    const msg = apiErrorText(e);
    app.innerHTML = `<header class="top">${topHtml()}</header>
      <h1>Прогресс</h1>
      <p>Нет связи с API: ${esc(msg)}</p>
      <button class="listitem" id="retry"><div class="d">Попробовать снова</div>
      <div class="s">Отметки дня при этом продолжают сохраняться</div></button>
      ${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
    (document.getElementById("retry") as HTMLButtonElement).onclick = () => void renderProg();
    return;
  }
  if (tab !== "prog") return;
  const days = activityCache!.days;
  const today = todayIso();
  const full = days.filter((d) => d.requiredTotal > 0 && d.done >= d.requiredTotal && d.date <= today).length;
  const req = days.filter((d) => d.requiredTotal > 0 && d.date <= today).length;
  const activeDays = days.filter((d) => d.date <= today && d.done > 0).length;

  // Серия: закрытые дни подряд; незакрытое сегодня серию не ломает.
  const reqPast = days
    .filter((d) => d.requiredTotal > 0 && d.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  let streak = 0;
  for (const d of reqPast) {
    if (d.done >= d.requiredTotal) streak++;
    else if (d.date === today) continue;
    else break;
  }

  // Колонки-недели, строки Пн..Вс
  const byDate = new Map(days.map((d) => [d.date, d]));
  const start = new Date("2026-09-03T12:00:00");
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // назад до понедельника
  const end = new Date("2027-03-07T12:00:00");
  const cols: string[][] = [];
  const cur = new Date(start);
  let col: string[] = [];
  let lastMonth = "";
  const labels: { col: number; text: string }[] = [];
  while (cur <= end) {
    const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
    col.push(iso);
    if (cur.getDay() === 1 || iso === "2026-09-03") {
      const m = `${MONTHS[cur.getMonth()].slice(0, 3)}`;
      if (m !== lastMonth) {
        labels.push({ col: cols.length, text: iso === "2026-09-03" ? "сен" : m });
        lastMonth = m;
      }
      if (col.length === 7 || cur >= end) {
        // начало новой колонки со следующего понедельника — текущую закрываем в конце цикла
      }
    }
    if (col.length === 7) {
      cols.push(col);
      col = [];
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (col.length) {
    while (col.length < 7) col.push("");
    cols.push(col);
  }
  const heat = cols.map((c, ci) => {
    const lab = labels.find((l) => l.col === ci);
    return `<div class="hcol">${lab ? `<span class="hlab">${lab.text}</span>` : `<span class="hlab"></span>`}${
      c.map((iso) => {
        if (!iso || !byDate.has(iso)) return `<span class="hcell out"></span>`;
        const a = byDate.get(iso)!;
        const lvl = levelOf(a, today);
        const star = lvl === "l4" ? "★" : "";
        const title = `${iso}: ${a.done}/${a.requiredTotal}`;
        return iso > today
          ? `<span class="hcell future" title="${title}"></span>`
          : `<button class="hcell ${lvl}" data-date="${iso}" title="${title}" aria-label="${title}">${star}</button>`;
      }).join("")
    }</div>`;
  }).join("");

  app.innerHTML = `<header class="top">${topHtml()}</header>
    <p class="eyebrow">ТВОЙ ПУТЬ</p><h1>Регулярность меняет всё.</h1><p class="page-description">Каждый отмеченный шаг — часть твоего движения вперёд.</p>${accountHtml()}
    <div class="statcards">
      <div class="statcard"><span class="sval">${full}<small> / ${req}</small></span><span class="slab">дней закрыто</span></div>
      <div class="statcard"><span class="sval">${activeDays}</span><span class="slab">дней с занятиями</span></div>
      <div class="statcard"><span class="sval">${streak}</span><span class="slab">серия дней</span></div>
    </div>
    <div class="section-heading"><h3>26 недель практики</h3><span>Сентябрь → март</span></div><div class="heatwrap"><div class="heat">${heat}</div></div>
    <div class="legend"><span>Пунктир — день без отметок</span><span>★ — всё обязательное сделано</span></div>
    <h3>Последние дни</h3>
    ${days.filter((d) => d.date <= today).slice(-7).reverse().map((d) => `<button class="listitem progress-day" data-date="${d.date}"><span><span class="d">${esc(longDate(d.date))}</span><span class="s">${esc(d.format ?? "Свободный день")}</span></span><span class="progress-count">${d.done} / ${d.requiredTotal}${d.requiredTotal > 0 && d.done >= d.requiredTotal ? " ✓" : ""}</span></button>`).join("") || `<div class="empty-state"><h3>Твой путь скоро начнётся</h3><p>Здесь появятся отметки с первого дня плана.</p></div>`}
    ${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  app.querySelectorAll<HTMLButtonElement>("[data-date]").forEach((b) => {
    b.onclick = () => {
      flushSave();
      date = b.dataset.date!;
      tab = "today";
      void loadDay();
    };
  });
}

// ---------- Библиотека ----------

function matchedTerms(text: string): GlossaryTerm[] {
  const low = text.toLowerCase();
  return glossaryCache.filter((g) => g.term.length > 2 && low.includes(g.term.toLowerCase()));
}

async function renderLib(): Promise<void> {
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка библиотеки…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    if (!libItems.length) libItems = await api.library();
    if (!glossaryCache.length) glossaryCache = await api.glossary();
    if (openLib && !libEntryCache.has(openLib)) {
      libEntryCache.set(openLib, await api.libraryEntry(openLib));
    }
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${topHtml()}</header><p>Нет связи с API: ${esc(apiErrorText(e))}</p>${tabsHtml()}`;
    wireTabs();
    return;
  }
  const sub = (id: LibSub, label: string) =>
    `<button class="subchip ${libSub === id ? "active" : ""}" data-libsub="${id}">${label}</button>`;
  let body = "";
  if (libSub === "ex") {
    body = `<input type="search" class="search" id="exercise-search" aria-label="Найти упражнение" placeholder="Найти по названию или коду, например тихие ноги…" value="${esc(exerciseFilter)}" />` + libItems.map((e) => {
      const open = openLib === e.id;
      const entry = libEntryCache.get(e.id);
      const visible = `${e.id} ${e.title}`.toLowerCase().includes(exerciseFilter.trim().toLowerCase());
      return `<div data-exercise="${esc(`${e.id} ${e.title}`.toLowerCase())}" ${visible ? "" : "hidden"}><button class="listitem exercise-item" data-lib="${e.id}" aria-expanded="${open}">
          <span class="exercise-code">${esc(e.id)}</span><span class="d">${esc(e.title)}</span><span>${open ? "−" : "+"}</span>
        </button>${open && entry ? libEntryHtml(entry) : open ? `<p class="meta">Загрузка…</p>` : ""}</div>`;
    }).join("") + `<p id="exercise-empty" class="empty-state" hidden>Ничего не найдено. Попробуй название техники или код упражнения.</p>`;
  } else if (libSub === "dict") {
    const q = dictFilter.trim().toLowerCase();
    const terms = glossaryCache.filter((g) =>
      !q || g.term.toLowerCase().includes(q) || g.explanation.toLowerCase().includes(q));
    body = `<input class="search" id="dictq" placeholder="Найти термин…" value="${esc(dictFilter)}" />
      ${terms.map((g) => `<div class="termrow"><div class="d">${esc(g.term)}</div><div class="s">${esc(g.explanation)}</div></div>`).join("") ||
      `<p class="meta">Ничего не найдено</p>`}`;
  } else if (libSub === "vids") {
    try {
      if (!resourcesCache.length) resourcesCache = await api.resources();
    } catch { /* уже показано */ }
    body = resourcesCache.map(resCard).join("");
  } else {
    try {
      const doc = await api.doc("08_SHOPPING");
      body = md(doc.body);
    } catch (e) {
      if (needLogin(e)) {
        renderLogin();
        return;
      }
      body = `<p class="meta">Нет связи с API.</p>`;
    }
  }
  if (tab !== "lib") return;
  app.innerHTML = `<header class="top">${topHtml()}</header><p class="eyebrow">УЧИСЬ В СВОЁМ ТЕМПЕ</p><h1>Меньше силы. Больше техники.</h1><p class="page-description">Упражнения, подсказки и материалы — под рукой, когда нужны.</p>${accountHtml()}
    <div class="subchips scrollx">${sub("ex", "Упражнения")}${sub("dict", "Словарь")}${sub("vids", "Видео")}${sub("shop", "Покупки")}</div>
    <div id="libbody">${body}</div>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  app.querySelectorAll<HTMLButtonElement>("[data-libsub]").forEach((b) => {
    b.onclick = () => {
      libSub = b.dataset.libsub as LibSub;
      void renderLib();
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-lib]").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.lib!;
      openLib = openLib === id ? null : id;
      history.replaceState(null, "", openLib ? `?lib=${openLib}` : location.pathname);
      void renderLib();
    };
  });
  const exerciseSearch = document.getElementById("exercise-search") as HTMLInputElement | null;
  const filterExercises = () => {
    let count = 0;
    app.querySelectorAll<HTMLElement>("[data-exercise]").forEach((item) => {
      item.hidden = !item.dataset.exercise!.includes(exerciseFilter.trim().toLowerCase());
      if (!item.hidden) count++;
    });
    const empty = document.getElementById("exercise-empty");
    if (empty) empty.hidden = count > 0;
  };
  if (exerciseSearch) {
    exerciseSearch.oninput = () => { exerciseFilter = exerciseSearch.value; filterExercises(); };
    filterExercises();
  }
  const dq = document.getElementById("dictq") as HTMLInputElement | null;
  if (dq) dq.oninput = (e) => {
    dictFilter = (e.target as HTMLInputElement).value;
    const pos = (e.target as HTMLInputElement).selectionStart ?? 0;
    void renderLib().then(() => {
      const el = document.getElementById("dictq") as HTMLInputElement | null;
      if (el) {
        el.focus();
        try { el.setSelectionRange(pos, pos); } catch { /* noop */ }
      }
    });
  };
  app.querySelectorAll<HTMLButtonElement>("[data-term]").forEach((b) => {
    b.onclick = () => {
      dictFilter = b.dataset.term!;
      libSub = "dict";
      void renderLib();
    };
  });
}

function libEntryHtml(entry: { id: string; title: string; body: string; coaching?: string }): string {
  const terms = matchedTerms(`${entry.title} ${entry.body} ${entry.coaching ?? ""}`).slice(0, 8);
  return `<div class="acc">
    ${entry.coaching ? `<div class="coach"><strong>Как делать</strong>${md(entry.coaching)}</div>` : ""}
    ${terms.length ? `<div class="terms">Термины: ${terms.map((g) =>
      `<button class="term" data-term="${esc(g.term)}" title="${esc(g.explanation)}">${esc(g.term)}</button>`).join("")}</div>` : ""}
    <div class="accbody">${md(entry.body)}</div>
  </div>`;
}

// Внутренние документы плана ([текст](doc:ID) в md): просмотр с кнопкой «назад».
let openDocId: string | null = null;
let docReturn: Tab = "today";
const docCache = new Map<string, { id: string; title: string; body: string }>();

function openDoc(id: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(id)) return;
  flushSave();
  if (tab !== "doc") docReturn = tab;
  openDocId = id;
  tab = "doc";
  render();
}

async function renderDoc(): Promise<void> {
  const id = openDocId;
  if (!id) {
    tab = docReturn;
    render();
    return;
  }
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    let doc = docCache.get(id);
    if (!doc) {
      doc = await api.doc(id);
      docCache.set(id, doc);
    }
    app.innerHTML = `<header class="top">${topHtml()}</header>
      <button class="subchip" id="docback">‹ Назад</button>
      <h1>${esc(doc.title)}</h1>
      ${md(doc.body)}
      ${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
    (document.getElementById("docback") as HTMLButtonElement).onclick = () => {
      tab = docReturn;
      render();
    };
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${topHtml()}</header>
      <button class="subchip" id="docback">‹ Назад</button>
      <h1>Документ</h1>
      <p>Не открылось: ${esc(apiErrorText(e))}</p>${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
    (document.getElementById("docback") as HTMLButtonElement).onclick = () => {
      tab = docReturn;
      render();
    };
  }
}

// Делегированные клики по [data-doc] из md(): блоки, секции, библиотека.
if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.("[data-doc]") as HTMLElement | null;
    if (!el || !el.dataset.doc) return;
    e.preventDefault();
    openDoc(el.dataset.doc);
  });
}

async function renderSafe(): Promise<void> {
  app.innerHTML = `<header class="top">${topHtml()}</header><p>Загрузка…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    const doc = await api.doc("02_SAFETY_AND_AUTOREGULATION");
    if (tab !== "safe") return;
    app.innerHTML = `<header class="top">${topHtml()}</header><h1>${esc(doc.title)}</h1>${accountHtml()}
      <div class="safety">Назначения физиотерапевта всегда важнее плана.</div>
      ${md(doc.body)}${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${topHtml()}</header><p>Нет связи с API: ${esc(apiErrorText(e))}</p>${tabsHtml()}`;
    wireTabs();
  }
}

// init: диплинки ?date=, ?lib= + вход через shared-Cognito, если включён
async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (location.pathname === "/auth/callback") {
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      renderLogin(params.get("error_description") || "Вход не удался — попробуй ещё раз");
      return;
    }
    try {
      const to = await auth.completeLogin(code, state);
      history.replaceState(null, "", to);
    } catch (e) {
      renderLogin(e instanceof Error ? e.message : "Вход не удался");
      return;
    }
  }
  let enabled = false;
  try {
    enabled = (await auth.getConfig()).enabled;
  } catch {
    enabled = false;
  }
  authEnabled = enabled;
  if (enabled) {
    if (!auth.getToken()) {
      renderLogin();
      return;
    }
    try {
      userEmail = (await api.me()).email;
    } catch {
      renderLogin();
      return;
    }
  }
  const q = params.get("date");
  if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) date = q;
  const t = params.get("tab");
  if (t === "cal" || t === "prog" || t === "lib" || t === "safe" || t === "routes") tab = t;
  const mo = params.get("month");
  if (mo && /^\d{4}-\d{2}$/.test(mo)) calMonth = mo;
  else calMonth = date.slice(0, 7);
  const lib = params.get("lib");
  if (lib) {
    tab = "lib";
    libSub = "ex";
    openLib = lib.toUpperCase();
  }
  render();
}

void boot();
