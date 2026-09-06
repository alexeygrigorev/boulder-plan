import { test, expect } from "@playwright/test";

test("session advances and saves checks, wellbeing and notes to the selected day", async ({
  page,
}) => {
  await page.goto("/?date=2026-09-08");
  await page.locator("#session-start").click();
  await expect(page.locator("#block-b01")).toHaveClass(/expanded/);
  await page.locator('[data-check="b01"]').click();
  await expect(page.locator("#block-b02")).toHaveClass(/expanded/);
  await page.getByLabel("Плечо", { exact: true }).selectOption("2");
  await page.locator("#note").fill("Тихие ноги — вес переношу плавно.");
  // Navigation before the debounce expires must still save to September 8.
  await page.locator('[data-weekdate="2026-09-09"]').click();
  await expect(page.locator("#note")).toHaveValue("");
  await page.locator('[data-weekdate="2026-09-08"]').click();
  await expect(page.locator("#note")).toHaveValue(
    "Тихие ноги — вес переношу плавно.",
  );
  await expect(page.locator('[data-check="b01"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Плечо", { exact: true })).toHaveValue("2");
  await page.reload();
  await expect(page.locator("#note")).toHaveValue(
    "Тихие ноги — вес переношу плавно.",
  );
});

test("timers are scoped to the day and cannot pull the user away from another screen", async ({
  page,
}) => {
  await page.goto("/?date=2026-09-10");
  await page.clock.install();
  await page.locator('[data-timer="b01"]').click();
  await page.clock.fastForward(2000);
  await expect(page.locator("#t-b01")).toHaveText("02:58");
  await page.locator("#next").click();
  await expect(page.locator('[data-timer="b01"]')).toContainText("Старт");
  await page.locator('nav [data-tab="lib"]').click();
  await expect(page.locator("#exercise-search")).toBeVisible();
  await page.clock.fastForward(180000);
  await expect(page.locator("#exercise-search")).toBeVisible();
});

test("route collection supports manual creation, filtering, attempts and return to results", async ({
  page,
}) => {
  await page.goto("/?tab=routes&date=2026-09-08");
  await page.getByText("Добавить вручную", { exact: true }).click();
  await page.locator("#m-name").fill("Зелёный баланс");
  await page.locator("#m-sector").fill("Плита");
  await page.locator("#m-grade").fill("5A");
  await page.locator("#m-add").click();
  await expect(page.locator(".route-card")).toBeVisible();
  await page.locator('[data-st="PROJECTING"]').click();
  await expect(page.locator('[data-st="PROJECTING"]')).toHaveClass(/active/);
  await page.locator('[data-att="FAILED"]').click();
  await expect(page.locator(".att")).toHaveCount(1);
  await page.locator("#route-back").click();
  await page.locator('[data-routefilter="project"]').click();
  await page.locator("#route-search").fill("Зелёный");
  await expect(page.locator(".route-tile")).toHaveCount(1);
  await page.locator(".route-tile").click();
  await expect(page.locator(".att")).toHaveCount(1);
  await page.locator("#route-back").click();
  await page.locator("#route-search").fill("несуществующая трасса");
  await expect(page.locator("#route-results")).toContainText(
    "Таких трасс пока нет",
  );
});

test("exercise search, calendar navigation and deep links remain usable", async ({
  page,
}) => {
  await page.goto("/?tab=lib&date=2026-09-08");
  await page.locator("#exercise-search").fill("T01");
  await expect(page.locator("[data-exercise]:visible")).toHaveCount(1);
  await page.locator('[data-lib="T01"]').click();
  await expect(page.locator(".acc")).toBeVisible();
  await page.locator('nav [data-tab="cal"]').click();
  await expect(page.locator(".calendar-panel")).toBeVisible();
  await page.locator('.mgrid [data-date="2026-09-15"]').click();
  await expect(page).toHaveURL(/date=2026-09-15/);
  await expect(page.locator("#blocks")).toBeVisible();
  await page.reload();
  await expect(page.locator(".week-day.selected")).toHaveAttribute(
    "data-weekdate",
    "2026-09-15",
  );
});

test("slow day responses cannot overwrite another tab", async ({ page }) => {
  await page.route("**/api/plan?date=2026-09-09", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/?date=2026-09-08");
  await page.locator("#blocks").waitFor();
  await page.locator("#next").click();
  await page.locator('[data-tab="safe"]').click();
  await expect(page.locator('[data-screen="safe"]')).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.locator("#blocks")).toHaveCount(0);
});

for (const width of [360, 390, 768, 1440]) {
  test(`all primary screens fit ${width}px and produce no browser errors`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const [tab, ready] of [
      ["today", "#blocks"],
      ["cal", ".calendar-panel"],
      ["routes", "#route-search"],
      ["prog", ".heat"],
      ["lib", "#exercise-search"],
      ["safe", ".safety"],
    ]) {
      await page.goto(`/?tab=${tab}&date=2026-09-08`);
      await page.locator(ready).waitFor();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test("offline edits survive a reload and reconcile after connectivity returns", async ({
  page,
}) => {
  await page.goto("/?date=2026-09-12");
  await page.locator("#blocks").waitFor();
  await page.route("**/api/progress", (route) => route.abort());
  await page.locator("#note").fill("Локальная заметка без связи");
  await expect(page.locator("#savestate")).toContainText("Нет связи");
  await page.reload();
  await expect(page.locator("#note")).toHaveValue(
    "Локальная заметка без связи",
  );
  await page.unroute("**/api/progress");
  await page.reload();
  await expect(page.locator("#note")).toHaveValue(
    "Локальная заметка без связи",
  );
  await expect(page.locator("#savestate")).toContainText("Сохранено");
});

test("failed day requests offer a working retry and out-of-plan dates offer recovery", async ({
  page,
}) => {
  await page.route("**/api/plan?date=2026-09-08", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.goto("/?date=2026-09-08");
  await expect(
    page.getByRole("heading", { name: "Не удалось загрузить день" }),
  ).toBeVisible();
  await page.unroute("**/api/plan?date=2026-09-08");
  await page.locator("#retry-day").click();
  await expect(page.locator("#blocks")).toBeVisible();
  await page.goto("/?date=2028-01-01");
  await page.getByRole("button", { name: "Открыть план", exact: true }).click();
  await expect(page.locator(".calendar-panel")).toBeVisible();
});
