import { test, expect } from "@playwright/test";

test("client sees loyalty progress and can calculate an appointment", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Клиент Записаться, перенести визит, получить купон",
    })
    .click();
  await page.getByRole("link", { name: "Лояльность", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Бесплатные посещения", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("5 платных посещений").first()).toBeVisible();
  await expect(page.getByRole("progressbar").first()).toBeVisible();
  await page.screenshot({
    path: `test-results/loyalty-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("link", { name: "Выбрать время", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Бесплатное посещение")).toBeVisible();
  const slot = page.locator(".slots-grid button").first();
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(
    page.getByRole("button", { name: "Подтвердить запись", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("К оплате в салоне", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("owner can view loyalty settings and customer progress", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Владелец · Линия Управление студией волос и партнёрствами",
    })
    .click();
  const workspace = page.getByLabel("Личный или рабочий кабинет");
  const option = await workspace
    .locator("option")
    .filter({ hasText: "Линия" })
    .getAttribute("value");
  await workspace.selectOption(option!);
  await page.getByRole("link", { name: "Лояльность", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Программа лояльности", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Накопление включено", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Платных посещений до подарка").first(),
  ).toHaveValue("5");
  await page.screenshot({
    path: `test-results/loyalty-settings-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Клиенты", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "Анна" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Лояльность клиента", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/бесплатных визитов доступно/)).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

// A MAX deep link (?startapp=…) must open the target screen, not the home screen.
// The payload may arrive unsigned, so the app reads it from both places.
test("deep links open the salon storefront and the loyalty screen", async ({
  page,
  request,
}) => {
  const issued = await request.post("/api/v1/demo/identity", {
    data: { persona: "client" },
  });
  expect(issued.ok(), await issued.text()).toBeTruthy();
  const { data } = await issued.json();
  const launch = (payload: string) =>
    `/#WebAppData=${encodeURIComponent(data.initData)}&startapp=${payload}`;

  await page.goto(launch("s_line"));
  await expect(page).toHaveURL(/\/s\/line$/);
  await expect(
    page.getByRole("heading", { name: "Линия · студия волос" }),
  ).toBeVisible();

  await page.goto(launch("loyalty"));
  await expect(page).toHaveURL(/\/me\/loyalty$/);
  await expect(
    page.getByRole("heading", { name: "Бесплатные посещения", exact: true }),
  ).toBeVisible();
});

// A service no master provides never yields a slot on any date, so both sides must say so:
// the publish checklist only requires one covered service.
test("a service nobody provides is flagged to the owner", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Владелец · Линия Управление студией волос и партнёрствами",
    })
    .click();
  const workspace = page.getByLabel("Личный или рабочий кабинет");
  const option = await workspace
    .locator("option")
    .filter({ hasText: "Линия" })
    .getAttribute("value");
  await workspace.selectOption(option!);
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Услуги и мастера", exact: true })
    .click();

  const covered = page
    .locator(".service-row")
    .filter({ hasText: "Стрижка и укладка" });
  await expect(covered).toBeVisible();
  await expect(covered.getByText("Никто не оказывает")).toHaveCount(0);

  // Reruns share the demo database, so only create the service the first time.
  const orphan = page
    .locator(".service-row")
    .filter({ hasText: "Услуга без мастера" })
    .first();
  if ((await orphan.count()) === 0) {
    await page
      .getByRole("button", { name: "Добавить услугу", exact: true })
      .click();
    const form = page.locator(".modal");
    await form.locator("input[type=text]").first().fill("Услуга без мастера");
    await form.locator("input[type=number]").nth(0).fill("30");
    await form.locator("input[type=number]").nth(1).fill("1000");
    await form.getByRole("button", { name: "Сохранить" }).click();
  }
  await expect(orphan.getByText("Никто не оказывает")).toBeVisible();
});
