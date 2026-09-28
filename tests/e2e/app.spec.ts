import { test, expect } from "@playwright/test";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

test("client rates a master after a completed visit and edits the rating", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Клиент Записаться, перенести визит, получить купон",
    })
    .click();
  await page.getByRole("button", { name: "История", exact: true }).click();
  await page.locator("a.booking-card").filter({ hasText: "Завершён" }).first().click();
  await expect(page.getByRole("heading", { name: "Карточка визита" })).toBeVisible();

  const edit = page.getByRole("button", { name: "Изменить оценку" });
  const fiveStars = page.getByRole("radio", { name: "5 из 5 — Отлично" });
  await expect(edit.or(fiveStars)).toBeVisible();
  if (await edit.isVisible()) await edit.click();
  await fiveStars.check();
  await page.getByRole("button", { name: "Сохранить оценку" }).click();
  await expect(page.getByLabel("Оценка 5 из 5")).toBeVisible();

  await page.getByRole("button", { name: "Изменить оценку" }).click();
  await page.getByRole("radio", { name: "5 из 5 — Отлично" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: "4 из 5 — Хорошо" })).toBeChecked();
  await page.getByRole("button", { name: "Сохранить оценку" }).click();
  await expect(page.getByLabel("Оценка 4 из 5")).toBeVisible();
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

test("client and owner can open Live Window screens", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Клиент Записаться, перенести визит, получить купон",
    })
    .click();
  await page.getByRole("link", { name: "Живое окно", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Ожидаем удобное время" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Салоны", exact: true }).click();
  await page.locator("a.salon-card").first().click();
  await page.getByRole("link", { name: /Записаться/ }).first().click();
  await page.getByLabel("Услуга").selectOption({ index: 1 });
  await page
    .getByRole("link", { name: "Сообщить, если освободится" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Сообщить об освободившемся времени" }),
  ).toBeVisible();
  await expect(page.getByText(/не удерживает время/i)).toBeVisible();
  for (const choice of [
    page.locator(".live-window-form .checklist .check").first(),
    page.locator(".live-window-form .inline-actions .check").first(),
  ]) {
    const checkbox = await choice.locator('input[type="checkbox"]').boundingBox();
    const label = await choice.locator("span").boundingBox();
    expect(checkbox).not.toBeNull();
    expect(label).not.toBeNull();
    expect(label!.x - (checkbox!.x + checkbox!.width)).toBeLessThanOrEqual(12);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `test-results/live-window-form-${test.info().project.name}.png`,
    fullPage: true,
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Владелец · Линия/ }).click();
  const workspace = page.getByLabel("Личный или рабочий кабинет");
  const option = await workspace
    .locator("option")
    .filter({ hasText: "Линия" })
    .getAttribute("value");
  await workspace.selectOption(option!);
  await page.getByRole("link", { name: "Живое окно", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Живое окно" })).toBeVisible();
  await expect(
    page.getByText(/предложения отправляются автоматически/i),
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

test("salon media and friendly timezones reach the published storefront", async ({
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
  await page.getByRole("link", { name: "Настройки", exact: true }).click();

  const timezone = page.getByRole("radiogroup", { name: "Часовой пояс" });
  await expect(timezone.getByText("МСК+2", { exact: true })).toBeVisible();

  const files = page.locator('input[type="file"]');
  await files.nth(0).setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(page.getByText("Логотип выбран", { exact: true })).toBeVisible();
  await files.nth(1).setInputFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(page.getByText("Обложка выбрана", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await expect(page.getByText("Черновик сохранён", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Опубликовать сохранённое оформление" })
    .click();
  await expect(page.getByText("Сохранено", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Услуги и мастера", exact: true }).click();
  const service = page.locator(".service-row").filter({ hasText: "Стрижка и укладка" });
  await service.getByRole("button", { name: "Изменить" }).click();
  let dialog = page.getByRole("dialog", { name: "Изменить услугу" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "service.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(service.locator(".service-cover")).toBeVisible();

  const master = page.locator(".staff-editor").filter({ hasText: "Александр" });
  await master.getByRole("button", { name: "Изменить профиль" }).click();
  dialog = page.getByRole("dialog", { name: "Изменить мастера" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "master.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(master.locator(".staff-avatar img")).toBeVisible();

  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("link", { name: "Открыть витрину" }).click();
  await expect(page.getByAltText("Обложка салона")).toBeVisible();
  await expect(page.getByAltText("Логотип")).toBeVisible();
  await expect(page.getByAltText("Обложка услуги «Стрижка и укладка»")).toBeVisible();
  await expect(page.getByAltText("Фото Александр")).toBeVisible();
  await expect(page.getByText(/Часовой пояс: МСК · Москва/)).toBeVisible();

  const saveSalon = page.getByRole("button", { name: "Сохранить", exact: true });
  if (await saveSalon.isVisible()) {
    await saveSalon.click();
    await expect(page.getByText("Салон сохранён", { exact: true })).toBeVisible();
  }
  await page.getByRole("link", { name: /Все салоны/ }).click();
  const familiarSalon = page
    .locator("a.salon-card")
    .filter({ hasText: "Линия · студия волос" });
  await expect(familiarSalon.locator(".cover-image")).toBeVisible();
  await expect(familiarSalon.locator(".salon-card-logo img")).toBeVisible();
  await page.screenshot({
    path: `test-results/catalog-media-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("MAX back closes the Android mini-app at the root screen", async ({
  page,
  request,
}) => {
  const issued = await request.post("/api/v1/demo/identity", {
    data: { persona: "client" },
  });
  expect(issued.ok(), await issued.text()).toBeTruthy();
  const { data } = await issued.json();
  await page.addInitScript((initData: string) => {
    const bridge = { closed: 0, shown: false };
    let onBack: (() => void) | undefined;
    Object.assign(window, {
      __bridge: bridge,
      __pressMaxBack: () => onBack?.(),
    });
    Object.defineProperty(window, "WebApp", {
      configurable: false,
      writable: false,
      value: {
        initData,
        platform: "android",
        ready() {},
        expand() {},
        close() {
          bridge.closed += 1;
        },
        BackButton: {
          show() {
            bridge.shown = true;
          },
          hide() {
            bridge.shown = false;
          },
          onClick(callback: () => void) {
            onBack = callback;
          },
          offClick(callback: () => void) {
            if (onBack === callback) onBack = undefined;
          },
        },
      },
    });
  }, data.initData);

  await page.goto("/");
  await expect(page).toHaveURL(/\/me\/bookings$/);
  await expect.poll(() => page.evaluate(() => (window as any).__bridge.shown)).toBe(true);
  await page.evaluate(() => (window as any).__pressMaxBack());
  await expect.poll(() => page.evaluate(() => (window as any).__bridge.closed)).toBe(1);
});

test("master can replace their own storefront photo", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Мастер Только свои назначения и исходы визитов",
    })
    .click();
  const workspace = page.getByLabel("Личный или рабочий кабинет");
  const option = await workspace
    .locator("option")
    .filter({ hasText: "Линия" })
    .getAttribute("value");
  await workspace.selectOption(option!);
  const card = page.locator(".master-profile-card");
  await expect(card.getByRole("heading", { name: "София" })).toBeVisible();
  await card.locator('input[type="file"]').setInputFiles({
    name: "self-photo.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(card.getByText("Фотография профиля обновлена", { exact: true })).toBeVisible();
  await expect(card.locator(".staff-avatar img")).toBeVisible();
});
