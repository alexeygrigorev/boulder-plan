import {
  api, auth, AuthError, todayIso, shiftDate,
  type PlanDay, type ActivityDay, type GlossaryTerm, type ResourceItem, type PlanWeekFull,
} from "./api";
import { md } from "./md";

const app = document.getElementById("app")!;

type Tab = "today" | "cal" | "prog" | "lib" | "safe";
type LibSub = "ex" | "dict" | "vids" | "shop";

let tab: Tab = "today";
let date = todayIso();
let authEnabled = false;
let userEmail: string | null = null;
let day: PlanDay | null = null;
let checks: Record<string, boolean> = {};
let note = "";
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
let weekCache = new Map<string, PlanWeekFull>();
let activityCache: { from: string; to: string; days: ActivityDay[] } | null = null;
const activityByDate = new Map<string, ActivityDay>();
let calMonth = todayIso().slice(0, 7);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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

function scheduleSave(): void {
  localStorage.setItem(localKey(date), JSON.stringify({ checks, note }));
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    api.saveProgress(date, checks, note).catch(() => {
      /* офлайн — останется в localStorage */
    });
  }, 600);
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
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка…</p>`;
  try {
    day = await api.plan(date);
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    day = null;
    app.innerHTML = `<header class="top">${navHtml()}</header>
      <h1>Нет плана на ${esc(date)}</h1>
      <p class="meta">План покрывает 2026-09-03 → 07.03.2027. Открой «Календарь», чтобы выбрать день.</p>
      ${tabsHtml()}`;
    wireTabs();
    return;
  }
  try {
    const p = await api.progress(date);
    checks = p.checks ?? {};
    note = p.note ?? "";
    localStorage.setItem(localKey(date), JSON.stringify({ checks, note }));
  } catch {
    try {
      const raw = localStorage.getItem(localKey(date));
      if (raw) {
        const j = JSON.parse(raw) as { checks: Record<string, boolean>; note: string };
        checks = j.checks ?? {};
        note = j.note ?? "";
      } else {
        checks = {};
        note = "";
      }
    } catch {
      checks = {};
      note = "";
    }
  }
  render();
}

function navHtml(): string {
  return `<div class="dateline">
    <button id="prev" aria-label="Предыдущий день">‹</button>
    <div class="datewrap"><input type="date" id="date" value="${esc(date)}" min="2026-09-03" max="2027-03-07" /></div>
    <button id="next" aria-label="Следующий день">›</button>
    <button id="today" class="primary">Сегодня</button>
  </div>`;
}

function tabsHtml(): string {
  const t = (id: Tab, label: string) =>
    `<button data-tab="${id}" class="${tab === id ? "active" : ""}">${label}</button>`;
  return `<nav class="tabs">${t("today", "Сегодня")}${t("cal", "Календарь")}${t("prog", "Прогресс")}${t("lib", "Библиотека")}${t("safe", "Безопасность")}</nav>`;
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
  app.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.tab as Tab;
      render();
    };
  });
}

function render(): void {
  if (tab === "today") renderDay();
  else if (tab === "cal") void renderCal();
  else if (tab === "prog") void renderProg();
  else if (tab === "lib") void renderLib();
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

function renderDay(): void {
  if (!day) {
    void loadDay();
    return;
  }
  const d = day;
  const done = d.blocks.filter((b) => checks[b.id]).length;
  const pct = d.blocks.length ? Math.round((done / d.blocks.length) * 100) : 0;
  const stopRules = d.sections.find((s) => /закончить раньше/i.test(s.heading));
  const others = d.sections.filter((s) => !/чек-лист/i.test(s.heading) && s !== stopRules);

  app.innerHTML = `<header class="top">${navHtml()}</header>
    <h1>${esc(d.title)}</h1>${accountHtml()}
    <div class="meta">
      ${d.format ? `<span>· ${esc(d.format)}</span>` : ""}
      ${d.theme ? `<span>· тема: ${esc(d.theme)}</span>` : ""}
      ${d.requiredMinutes ? `<span>· ~${d.requiredMinutes} мин</span>` : ""}
    </div>
    ${d.cue ? `<div class="cue"><strong>Cue:</strong> ${esc(d.cue)}</div>` : ""}
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="proglabel">${done}/${d.blocks.length} · ${pct}%</div>
    <div id="blocks">${d.blocks.map(blockHtml).join("")}</div>
    <div id="weekres"><p class="meta">Загрузка материалов недели…</p></div>
    ${stopRules ? `<div class="safety"><strong>Когда закончить раньше</strong>${md(stopRules.body)}</div>` : ""}
    ${others.map((s) => `<details class="section"><summary>${esc(s.heading)}</summary>${md(s.body)}</details>`).join("")}
    <h3>Заметка дня</h3>
    <textarea class="note" id="note" placeholder="Техника одной фразой, плечо/пальцы/колено 0–10…">${esc(note)}</textarea>
    ${tabsHtml()}`;

  wireDayNav();
  wireTabs();
  wireBlocks();

  // Материалы недели подгружаются отдельно, чтобы день открывался сразу
  if (d.week && d.week !== "prestart") {
    weekResourcesHtml(d.week).then(async (cards) => {
      const box = document.getElementById("weekres");
      if (!box || !weekCache.get(d.week)) return;
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

function wireDayNav(): void {
  (document.getElementById("prev") as HTMLButtonElement).onclick = () => {
    date = shiftDate(date, -1);
    void loadDay();
  };
  (document.getElementById("next") as HTMLButtonElement).onclick = () => {
    date = shiftDate(date, 1);
    void loadDay();
  };
  (document.getElementById("today") as HTMLButtonElement).onclick = () => {
    date = todayIso();
    void loadDay();
  };
  (document.getElementById("date") as HTMLInputElement).onchange = (e) => {
    date = (e.target as HTMLInputElement).value || date;
    void loadDay();
  };
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
      scheduleSave();
      renderDay();
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-timer]").forEach((b) => {
    b.onclick = () => toggleTimer(b.dataset.timer!);
  });
}

function blockHtml(b: PlanDay["blocks"][number]): string {
  const t = timers.get(b.id);
  const left = t ? t.left : b.minutes * 60;
  const running = t?.on ?? false;
  return `<div class="block ${checks[b.id] ? "done" : ""}">
    <div class="row1">
      <button class="check" data-check="${b.id}" aria-label="Отметить блок">${checks[b.id] ? "✓" : "○"}</button>
      <div><span class="time">${esc(b.start)}–${esc(b.end)}</span>
        <span class="kind"> · ${esc(b.kind)}</span>
        <div class="chips"><span class="chip req">${esc(b.requirement)}</span><span class="chip">${esc(b.section)}</span></div>
      </div>
    </div>
    <div class="text">${md(b.text)}</div>
    ${b.intensity || b.caution
      ? `<div class="detail">${b.intensity ? `Нагрузка: ${esc(b.intensity)}.<br>` : ""}${b.caution ? `Осторожно: ${esc(b.caution)}` : ""}</div>`
      : ""}
    ${b.minutes > 0
      ? `<div class="timer"><span class="t" id="t-${b.id}">${fmtLeft(left)}</span>
        <button data-timer="${b.id}">${running ? "Пауза" : t ? "Дальше" : "Старт"}</button></div>`
      : ""}
  </div>`;
}

function toggleTimer(id: string): void {
  const block = day?.blocks.find((b) => b.id === id);
  if (!block) return;
  let st = timers.get(id);
  if (!st) {
    st = { left: block.minutes * 60, total: block.minutes * 60, on: false };
    timers.set(id, st);
  }
  if (st.on) {
    st.on = false;
    if (st.int) window.clearInterval(st.int);
  } else {
    if (st.left <= 0) st.left = st.total;
    st.on = true;
    st.int = window.setInterval(() => {
      st!.left = Math.max(0, st!.left - 1);
      const el = document.getElementById(`t-${id}`);
      if (el) el.textContent = fmtLeft(st!.left);
      if (st!.left <= 0) {
        st!.on = false;
        if (st!.int) window.clearInterval(st!.int);
        beep();
        renderDay();
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
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка календаря…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    await ensureActivity();
    if (!daysCache.length) daysCache = (await api.days()).days;
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${navHtml()}</header><p>Нет связи с API.</p>${tabsHtml()}`;
    wireTabs();
    return;
  }
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
    cells += `<button class="mcell ${lvl} ${iso === date ? "sel" : ""}" data-date="${iso}">
      <span class="mnum">${dd}</span>${star}
      <span class="mdot ${fmtClass(a.format)}">${fmtLetter(a.format)}</span>
      ${a.requiredMinutes ? `<span class="mmin">${a.requiredMinutes}′</span>` : ""}
    </button>`;
  }
  const cur = daysCache.find((d) => d.date === date);
  const weekId = cur?.week ?? "";
  const list = daysCache.filter((d) => d.week === weekId);
  const weekLabel = weekId === "prestart" ? "Подготовка" : weekId.replace("week_", "").replace(/_/g, " ");
  app.innerHTML = `<header class="top">${navHtml()}</header>
    <h1>Календарь</h1>${accountHtml()}
    <div class="monline">
      <button id="mprev" aria-label="Прошлый месяц">‹</button>
      <strong>${monthTitle(calMonth)}</strong>
      <button id="mnext" aria-label="Следующий месяц">›</button>
    </div>
    <div class="mweek">${["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="mgrid">${cells}</div>
    <div class="legend">
      <span><i class="sw fA"></i>A · техника</span>
      <span><i class="sw fB"></i>B · проект</span>
      <span><i class="sw fC"></i>C · fun</span>
      <span><i class="sw fHome"></i>дом</span>
      <span><i class="sw fRec"></i>восст.</span>
      <span>★ — день закрыт</span>
    </div>
    <h3>Неделя: ${esc(weekLabel)}</h3>
    ${list.map((d) => {
      const a = activityByDate.get(d.date);
      const mark = a && a.requiredTotal > 0 && a.done >= a.requiredTotal ? "✓ " : "";
      return `<button class="listitem" data-date="${d.date}">
        <div class="d">${mark}${esc(d.date)} · ${esc(d.title.replace(/^.*?·\s*/, ""))}</div>
        <div class="s">${esc(d.format ?? "")}${a && a.requiredMinutes ? ` · ~${a.requiredMinutes} мин` : ""}${a ? ` · ${a.done}/${a.requiredTotal}` : ""}</div>
      </button>`;
    }).join("")}
    ${tabsHtml()}`;
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
  app.querySelectorAll<HTMLButtonElement>("[data-date]").forEach((b) => {
    b.onclick = () => {
      date = b.dataset.date!;
      tab = "today";
      void loadDay();
    };
  });
}

function wireDayNavLite(): void {
  const prev = document.getElementById("prev") as HTMLButtonElement | null;
  if (prev) prev.onclick = () => {
    date = shiftDate(date, -1);
    tab = "today";
    void loadDay();
  };
  const next = document.getElementById("next") as HTMLButtonElement | null;
  if (next) next.onclick = () => {
    date = shiftDate(date, 1);
    tab = "today";
    void loadDay();
  };
  const t = document.getElementById("today") as HTMLButtonElement | null;
  if (t) t.onclick = () => {
    date = todayIso();
    calMonth = date.slice(0, 7);
    tab = "today";
    void loadDay();
  };
  const inp = document.getElementById("date") as HTMLInputElement | null;
  if (inp) inp.onchange = (e) => {
    date = (e.target as HTMLInputElement).value || date;
    calMonth = date.slice(0, 7);
    tab = "today";
    void loadDay();
  };
}

// ---------- Прогресс: heatmap как на Гитхабе ----------

async function renderProg(): Promise<void> {
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка прогресса…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    await ensureActivity();
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${navHtml()}</header><p>Нет связи с API.</p>${tabsHtml()}`;
    wireTabs();
    return;
  }
  const days = activityCache!.days;
  const today = todayIso();
  const full = days.filter((d) => d.requiredTotal > 0 && d.done >= d.requiredTotal && d.date <= today).length;
  const req = days.filter((d) => d.requiredTotal > 0 && d.date <= today).length;
  const mins = days.filter((d) => d.date <= today).reduce((s, d) => s + (d.done > 0 ? d.requiredMinutes : 0), 0);

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

  app.innerHTML = `<header class="top">${navHtml()}</header>
    <h1>Прогресс</h1>${accountHtml()}
    <div class="meta"><span>★ ${full} из ${req} дней</span><span>· ~${mins} мин в зале и дома</span></div>
    <div class="heatwrap"><div class="heat">${heat}</div></div>
    <div class="legend"><span>дырки — дни без отметок</span><span>★ — всё обязательное сделано</span></div>
    ${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  app.querySelectorAll<HTMLButtonElement>("[data-date]").forEach((b) => {
    b.onclick = () => {
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
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка библиотеки…</p>${tabsHtml()}`;
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
    app.innerHTML = `<header class="top">${navHtml()}</header><p>Нет связи с API.</p>${tabsHtml()}`;
    wireTabs();
    return;
  }
  const sub = (id: LibSub, label: string) =>
    `<button class="subchip ${libSub === id ? "active" : ""}" data-libsub="${id}">${label}</button>`;
  let body = "";
  if (libSub === "ex") {
    body = libItems.map((e) => {
      const open = openLib === e.id;
      const entry = libEntryCache.get(e.id);
      return `<button class="listitem" data-lib="${e.id}">
          <div class="d">${open ? "▾" : "▸"} ${esc(e.id)}</div><div class="s">${esc(e.title)}</div>
        </button>${open && entry ? libEntryHtml(entry) : open ? `<p class="meta">Загрузка…</p>` : ""}`;
    }).join("");
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
  app.innerHTML = `<header class="top">${navHtml()}</header><h1>Библиотека</h1>${accountHtml()}
    <div class="subchips">${sub("ex", "Упражнения")}${sub("dict", "Словарь")}${sub("vids", "Видео")}${sub("shop", "Покупки")}</div>
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

async function renderSafe(): Promise<void> {
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка…</p>${tabsHtml()}`;
  wireTabs();
  wireDayNavLite();
  try {
    const doc = await api.doc("02_SAFETY_AND_AUTOREGULATION");
    app.innerHTML = `<header class="top">${navHtml()}</header><h1>${esc(doc.title)}</h1>${accountHtml()}
      <div class="safety">Назначения физиотерапевта всегда важнее плана.</div>
      ${md(doc.body)}${tabsHtml()}`;
    wireTabs();
    wireDayNavLite();
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${navHtml()}</header><p>Нет связи с API.</p>${tabsHtml()}`;
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
  const lib = params.get("lib");
  if (lib) {
    tab = "lib";
    libSub = "ex";
    openLib = lib.toUpperCase();
  }
  calMonth = date.slice(0, 7);
  render();
}

void boot();
