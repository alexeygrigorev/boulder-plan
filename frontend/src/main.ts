import { api, auth, AuthError, todayIso, shiftDate, type PlanDay } from "./api";
import { md } from "./md";

const app = document.getElementById("app")!;

type Tab = "today" | "week" | "lib" | "safe";
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
    day = null;
    app.innerHTML = `<header class="top">${navHtml()}</header>
      <h1>Нет плана на ${esc(date)}</h1>
      <p class="meta">План покрывает 2026-09-03 → 2027-03-07. Открой вкладку «Неделя», чтобы выбрать день.</p>
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
  return `<nav class="tabs">${t("today", "Сегодня")}${t("week", "Неделя")}${t("lib", "Библиотека")}${t("safe", "Безопасность")}</nav>`;
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
  else if (tab === "week") void renderWeek();
  else if (tab === "lib") void renderLib();
  else void renderSafe();
}

function renderDay(): void {
  if (!day) {
    void loadDay();
    return;
  }
  const done = day.blocks.filter((b) => checks[b.id]).length;
  const pct = day.blocks.length ? Math.round((done / day.blocks.length) * 100) : 0;
  const stopRules = day.sections.find((s) => /закончить раньше/i.test(s.heading));
  const others = day.sections.filter((s) => !/чек-лист/i.test(s.heading) && s !== stopRules);

  app.innerHTML = `<header class="top">${navHtml()}</header>
    <h1>${esc(day.title)}</h1>${accountHtml()}
    <div class="meta">
      ${day.format ? `<span>· ${esc(day.format)}</span>` : ""}
      ${day.theme ? `<span>· тема: ${esc(day.theme)}</span>` : ""}
      ${day.requiredMinutes ? `<span>· ~${day.requiredMinutes} мин</span>` : ""}
    </div>
    ${day.cue ? `<div class="cue"><strong>Cue:</strong> ${esc(day.cue)}</div>` : ""}
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="proglabel">${done}/${day.blocks.length} · ${pct}%</div>
    <div id="blocks">${day.blocks.map(blockHtml).join("")}</div>
    ${stopRules ? `<div class="safety"><strong>Когда закончить раньше</strong>${md(stopRules.body)}</div>` : ""}
    ${others.map((s) => `<details class="section"><summary>${esc(s.heading)}</summary>${md(s.body)}</details>`).join("")}
    <h3>Заметка дня</h3>
    <textarea class="note" id="note" placeholder="Техника одной фразой, плечо/пальцы/колено 0–10…">${esc(note)}</textarea>
    ${tabsHtml()}`;

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
  wireTabs();

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
    <div class="text">${esc(b.text)}</div>
    ${b.intensity || b.caution
      ? `<div class="detail">${b.intensity ? `Нагрузка: ${esc(b.intensity)}.<br>` : ""}${b.caution ? `Осторожно: ${esc(b.caution)}` : ""}</div>`
      : ""}
    ${b.minutes > 0
      ? `<div class="timer"><span class="t" id="t-${b.id}">${fmtLeft(left)}</span>
        <button data-timer="${b.id}">${running ? "Пауза" : t ? "Дальше" : "Старт"}</button>
        <button data-timer-reset="${b.id}" hidden></button></div>`
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

async function renderWeek(): Promise<void> {
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка недели…</p>${tabsHtml()}`;
  wireTabs();
  try {
    if (!daysCache.length) {
      const r = await api.days();
      daysCache = r.days;
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
  const cur = daysCache.find((d) => d.date === date);
  const weekId = cur?.week ?? "";
  const list = daysCache.filter((d) => d.week === weekId);
  app.innerHTML = `<header class="top">${navHtml()}</header><h1>Неделя ${esc(weekId.replace("week_", "").replace(/_/g, " "))}</h1>${accountHtml()}
    ${list.map((d) => `<button class="listitem" data-date="${d.date}">
      <div class="d">${esc(d.date)} · ${esc(d.title.replace(/^.*?·\s*/, ""))}</div>
      <div class="s">${esc(d.format ?? "")}</div></button>`).join("")}
    ${tabsHtml()}`;
  wireTabs();
  app.querySelectorAll<HTMLButtonElement>("[data-date]").forEach((b) => {
    b.onclick = () => {
      date = b.dataset.date!;
      tab = "today";
      void loadDay();
    };
  });
}

async function renderLib(): Promise<void> {
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка библиотеки…</p>${tabsHtml()}`;
  wireTabs();
  try {
    const items = await api.library();
    app.innerHTML = `<header class="top">${navHtml()}</header><h1>Библиотека</h1>${accountHtml()}
      ${items.map((e) => `<button class="listitem" data-lib="${e.id}">
        <div class="d">${esc(e.id)}</div><div class="s">${esc(e.title)}</div></button>`).join("")}
      <div id="entry"></div>${tabsHtml()}`;
    wireTabs();
    app.querySelectorAll<HTMLButtonElement>("[data-lib]").forEach((b) => {
      b.onclick = () => {
        api.libraryEntry(b.dataset.lib!).then((e) => {
          const box = document.getElementById("entry")!;
          box.innerHTML = `<details class="section" open><summary>${esc(e.id)} — ${esc(e.title)}</summary>${md(e.body)}</details>`;
          box.scrollIntoView({ behavior: "smooth" });
        }).catch((e) => {
          if (needLogin(e)) renderLogin();
        });
      };
    });
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${navHtml()}</header><p>Нет связи с API.</p>${tabsHtml()}`;
    wireTabs();
  }
}

async function renderSafe(): Promise<void> {
  app.innerHTML = `<header class="top">${navHtml()}</header><p>Загрузка…</p>${tabsHtml()}`;
  wireTabs();
  try {
    const doc = await api.doc("02_SAFETY_AND_AUTOREGULATION");
    app.innerHTML = `<header class="top">${navHtml()}</header><h1>${esc(doc.title)}</h1>${accountHtml()}
      <div class="safety">Назначения физиотерапевта всегда важнее плана.</div>
      ${md(doc.body)}${tabsHtml()}`;
    wireTabs();
  } catch (e) {
    if (needLogin(e)) {
      renderLogin();
      return;
    }
    app.innerHTML = `<header class="top">${navHtml()}</header><p>Нет связи с API.</p>${tabsHtml()}`;
    wireTabs();
  }
}

// init: дата из query ?date= для шаринга + вход через shared-Cognito, если включён
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
  void loadDay();
}

void boot();
