import { test, expect, type Page } from "@playwright/test";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
  if (test.info().status !== test.info().expectedStatus) return;
  expect(pageErrors.get(page) ?? [], "Unexpected browser errors").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Page must fit its viewport").toBe(true);
});

async function openWork(page: Page, salon: string, role: string) {
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("link", { name: new RegExp(`${salon}.*${role}`) }).click();
}

function visibleWorkspace(page: Page) {
  return page.locator('select[aria-label="Выбрать кабинет"]:visible, select[aria-label="Личный или рабочий кабинет"]:visible');
}

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test('unsaved salon preferences survive refresh and failed reload', async ({page}) => {
  await page.goto('/'); await page.getByRole('button',{name:/Клиент Записаться/}).click();
  await page.getByRole('link',{name:'Профиль',exact:true}).click();
  const checkbox=page.locator('.salon-preferences-grid input[type=checkbox]').first();
  await expect(checkbox).toBeVisible(); const original=await checkbox.isChecked(); await checkbox.setChecked(!original);
  await page.evaluate(()=>window.dispatchEvent(new Event('salon-data-changed')));
  await expect(checkbox).toBeChecked({checked:!original});
  await page.route('**/me/salons/*/preferences',route=>route.abort());
  await page.evaluate(()=>window.dispatchEvent(new Event('salon-data-changed')));
  await expect(page.locator('.salon-preferences-grid [role=alert]')).toBeVisible();
  await page.unroute('**/me/salons/*/preferences');
  await page.evaluate(()=>window.dispatchEvent(new Event('salon-data-changed')));
  await expect(checkbox).toBeChecked({checked:!original});
});

test('narrow schedule and keyboard modal preserve unsaved draft after network error', async ({page}) => {
  await page.goto('/'); await page.getByRole('button',{name:/Владелец · Линия/}).click(); await openWork(page,'Линия','владелец');
  await page.setViewportSize({width:320,height:850});
  await page.getByRole('link',{name:'График',exact:true}).click();
  await expect(page.locator('.interval').first()).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('link',{name:'Настройки',exact:true}).click();
  const description=page.getByRole('textbox',{name:'Описание',exact:true});
  await description.fill('Несохранённое описание после сбоя');
  await page.route('**/storefront/draft',route=>route.abort());
  await page.evaluate(()=>window.dispatchEvent(new Event('salon-data-changed')));
  await expect(page.getByRole('button',{name:'Повторить загрузку оформления'})).toBeVisible();
  await page.unroute('**/storefront/draft');
  await page.getByRole('button',{name:'Повторить загрузку оформления'}).click();
  await expect(description).toHaveValue('Несохранённое описание после сбоя');
  const preview=page.getByRole('button',{name:'Предпросмотр',exact:true});await preview.click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  for(let i=0;i<8;i++){await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);}
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(preview).toBeFocused();
});

test('late quote response cannot restore a previous service selection',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:/Клиент Записаться/}).click();
  await page.locator('main a.salon-card[href="/s/line"]').click();
  await page.getByRole('link',{name:'Записаться',exact:true}).click();
  const service=page.getByLabel('Услуга');
  await service.selectOption((await service.locator('option').filter({hasText:'Стрижка и укладка'}).getAttribute('value'))!);
  const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);
  await page.locator('input[type=date]').fill(tomorrow.toLocaleDateString('en-CA'));
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  let started!:()=>void;const pending=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/booking-quotes',async route=>{const response=await route.fetch();started();await gate;await route.fulfill({response});});
  await page.locator('.slots-grid button').first().click();await pending;
  await page.getByLabel('Услуга').selectOption('');
  const response=page.waitForResponse(response=>response.url().endsWith('/booking-quotes'));release();await response;
  await expect(page.getByRole('button',{name:'Подтвердить запись',exact:true})).toHaveCount(0);
  await expect(page.locator('.booking-summary h3')).toHaveText('Выберите время');
});

test('catalog continues to the next page',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:/Клиент Записаться/}).click();
  await page.route('**/public/salons?*',async route=>{
    const response=await route.fetch();const json=await response.json();
    const second=new URL(route.request().url()).searchParams.has('cursor');
    json.data.items=json.data.items.slice(second?1:0,second?2:1);json.data.nextCursor=second?null:'1';
    await route.fulfill({response,json});
  });
  await page.getByRole('button',{name:'Открыть каталог салонов'}).click();
  await expect(page.locator('a.salon-card')).toHaveCount(1);
  await page.getByRole('button',{name:'Показать ещё салоны'}).click();
  await expect(page.locator('a.salon-card')).toHaveCount(2);
  await expect(page.getByRole('button',{name:'Показать ещё салоны'})).toHaveCount(0);
});

test("my places search and saved theme work on both layouts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Клиент Записаться/ }).click();
  await expect(page.getByRole("heading", { name: "Мои места", exact: true })).toBeVisible();
  await page.screenshot({ path: `test-results/my-places-light-${test.info().project.name}.png`, fullPage: true });
  await page.getByLabel("Поиск салона").fill("маникюр");
  await expect(page.getByRole("heading", { name: "Результаты поиска" })).toBeVisible();
  await expect(page.locator("a.salon-card").filter({ hasText: "Точка" })).toBeVisible();
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("button", { name: /Тёмная/ }).click();
  await page.getByRole("link", { name: "Мои места", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: /Клиент Записаться/ }).click();
  await expect(page.getByRole("heading", { name: "Знакомое место" })).toBeVisible();
  await page.screenshot({ path: `test-results/my-places-dark-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Открыть каталог салонов" }).click();
  await expect(page.getByRole("heading", { name: "Каталог салонов" })).toBeVisible();
});

test("profile settings focus one salon and can show all", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Клиент Записаться/ }).click();
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await expect(page.locator(".salon-preferences-grid .panel")).toHaveCount(1);
  await page.getByRole("button", { name: "Выбрать салон для настроек" }).click();
  await page.getByLabel("Поиск салона в настройках").fill("лиНиЯ");
  await page.locator(".salon-picker-options").getByRole("button", { name: "Линия · студия волос", exact: true }).click();
  await expect(page.locator(".salon-preferences-grid h3")).toHaveText("Линия · студия волос");
  await page.screenshot({ path: `test-results/profile-salon-${test.info().project.name}.png`, fullPage: true });
  await page.getByRole("button", { name: "Выбрать салон для настроек" }).click();
  await page.locator(".salon-picker-options button").filter({ hasText: "Все салоны" }).click();
  expect(await page.locator(".salon-preferences-grid .panel").count()).toBeGreaterThan(1);
});

test("mobile header switches demo role and booking tabs remain accessible", async ({ page }) => {
  test.skip(test.info().project.name !== "mobile");
  await page.goto("/");
  await page.getByRole("button", { name: /Клиент Записаться/ }).click();
  await expect(page.getByLabel("Выбрать кабинет")).toBeVisible();
  await page.getByRole("link", { name: "Записи", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Мои записи" })).toBeVisible();
  await page.getByRole("tab", { name: "История" }).click();
  await expect(page.getByRole("tab", { name: "История" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "test-results/client-bookings-mobile.png", fullPage: true });
  await page.getByLabel("Выбрать кабинет").selectOption("change-role");
  await expect(page.getByRole("heading", { name: "Познакомимся с приложением" })).toBeVisible();
  await page.getByRole("button", { name: /Владелец · Линия/ }).click();
  const workspace = page.getByLabel("Выбрать кабинет");
  await workspace.selectOption((await workspace.locator("option").filter({ hasText: "Линия" }).getAttribute("value"))!);
  await expect(page.getByRole("heading", { name: "Записи салона" })).toBeVisible();
});

test("owner calendar changes month and filters masters", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Владелец · Линия/ }).click();
  await openWork(page, "Линия", "владелец");
  await expect(page.getByRole("heading", { name: "Записи салона" })).toBeVisible();
  if (test.info().project.name === "mobile") {
    await expect(page.locator(".work-shell .sidebar")).toHaveCSS("position", "fixed");
    const navigation = await page.locator(".sidebar").boundingBox();
    expect(navigation!.y + navigation!.height).toBeGreaterThan(page.viewportSize()!.height - 3);
  }
  await page.getByRole("button", { name: "Предыдущий месяц" }).click();
  expect(await page.locator(".month-days button").count()).toBeGreaterThanOrEqual(28);
  await page.getByRole("button", { name: "Все мастера" }).click();
  await page.getByLabel("Поиск мастера").fill("соФ");
  await expect(page.locator(".staff-filter-menu button").filter({ hasText: "София" })).toBeVisible();
  await page.screenshot({ path: `test-results/owner-calendar-light-${test.info().project.name}.png`, fullPage: true });
  await visibleWorkspace(page).selectOption("personal");
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("button", { name: /Тёмная/ }).click();
  await page.getByRole("link", { name: /Линия.*владелец/ }).click();
  await page.screenshot({ path: `test-results/owner-calendar-dark-${test.info().project.name}.png`, fullPage: true });
});

test("master calendar excludes staff controls and CRM", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Мастер Только свои назначения/ }).click();
  await openWork(page, "Линия", "мастер");
  await expect(page.getByRole("heading", { name: "Мой календарь" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Все мастера" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Клиенты", exact: true })).toHaveCount(0);
  if (test.info().project.name === "mobile") {
    const navigation = page.locator(".work-shell .sidebar");
    await expect(navigation).toHaveCSS("position", "fixed");
    await expect(navigation.getByRole("link", { name: "Календарь" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Мои места" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Мои записи" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Профиль" })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Бонусы" })).toBeVisible();
    await page.setViewportSize({ width: 320, height: 700 });
    for (const name of ["Календарь", "Мои места", "Мои записи", "Бонусы", "Профиль"]) {
      const item = await navigation.getByRole("link", { name, exact: true }).boundingBox();
      expect(item!.x).toBeGreaterThanOrEqual(0);
      expect(item!.x + item!.width).toBeLessThanOrEqual(320);
    }
    await page.screenshot({ path: "test-results/master-navigation-mobile.png" });
    const bottom = await navigation.boundingBox();
    expect(bottom!.y + bottom!.height).toBeGreaterThan(page.viewportSize()!.height - 3);
  }
});

test("client sees loyalty progress and can calculate an appointment", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Клиент Записаться, перенести визит, получить купон",
    })
    .click();
  await page.getByRole("link", { name: "Бонусы", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Программы лояльности", exact: true }),
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
  await expect(page.getByLabel("Награда программы (необязательно)")).toBeVisible();
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
  await page.getByRole("link", { name: "Записи", exact: true }).click();
  await page.getByRole("tab", { name: "История", exact: true }).click();
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
  await openWork(page, "Линия", "владелец");
  await page.getByRole("link", { name: "Лояльность", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Лояльность салона", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Совместная лояльность", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Новая программа" })).toBeVisible();
  await page.screenshot({
    path: `test-results/loyalty-settings-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Клиенты", exact: true }).click();
  await page.getByRole("link").filter({ hasText: "Анна" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Лояльность клиента", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/наград доступно:/)).toBeVisible();
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
    page.getByRole("heading", { name: "Программы лояльности", exact: true }),
  ).toBeVisible();
});

test("client and owner can open Live Window screens", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Клиент Записаться, перенести визит, получить купон",
    })
    .click();
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("link", { name: "Запросы «Живого окна»" }).click();
  await expect(
    page.getByRole("heading", { name: "Ожидаем удобное время" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Мои места", exact: true }).click();
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
  await openWork(page, "Линия", "владелец");
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("link", { name: /Настройки и цепочки «Живого окна»/ }).click();
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
  await openWork(page, "Линия", "владелец");
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
  await openWork(page, "Линия", "владелец");
  await page.getByRole("link", { name: "Настройки", exact: true }).click();

  const timezone = page.getByRole("radiogroup", { name: "Часовой пояс" });
  await expect(timezone.getByText("МСК+2", { exact: true })).toBeVisible();

  const files = page.locator('input[type="file"]');
  const description = page.getByRole("textbox", { name: "Описание", exact: true });
  const unsavedDescription = `Описание перед сменой аватара ${Date.now()}`;
  const contact = page.getByLabel("Публичный контакт", { exact: true });
  const originalContact = await contact.inputValue();
  await contact.fill("Несохранённый контакт при смене аватара");
  await description.fill(unsavedDescription);
  await files.nth(0).setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: tinyPng,
  });
  await expect(page.getByText("Аватар салона обновлён и виден клиентам", { exact: true })).toBeVisible();
  await expect(page.getByAltText("Аватар салона")).toBeVisible();
  await expect(description).toHaveValue(unsavedDescription);
  await expect(contact).toHaveValue("Несохранённый контакт при смене аватара");
  await contact.fill(originalContact);
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
  await expect(page.getByText("Изображение загружено. Сохраните карточку.")).toBeVisible();
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
  await expect(page.getByText("Изображение загружено. Сохраните карточку.")).toBeVisible();
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
  await expect(page).toHaveURL(/\/me\/salons$/);
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
  await openWork(page, "Линия", "мастер");
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

// The server refuses a waitlist request while matching time is still free and returns
// those slots. They must reach the client instead of a bare "время уже есть".
test("waitlist offers the free slots it refuses to queue for", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Владелец · Линия Управление студией волос и партнёрствами",
    })
    .click();
  const workspace = visibleWorkspace(page);
  await workspace.selectOption(
    (await workspace
      .locator("option")
      .filter({ hasText: "Линия" })
      .getAttribute("value"))!,
  );
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.getByRole("link", { name: /Настройки и цепочки «Живого окна»/ }).click();
  const enabled = page.locator("main input[type=checkbox]").first();
  if (!(await enabled.isChecked())) await enabled.check();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Настройки сохранены")).toBeVisible();
  await page.getByRole("button", { name: /Выйти|Сменить роль/ }).filter({ visible: true }).click();
  await expect(page.locator(".login-page")).toBeVisible();

  await page
    .getByRole("button", {
      name: "Клиент Записаться, перенести визит, получить купон",
    })
    .click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await page.getByRole("link", { name: "Мои места", exact: true }).click();
  await page.locator('main a.salon-card[href="/s/line"]').first().click();
  await page
    .locator(".service-row")
    .filter({ hasText: "Стрижка и укладка" })
    .getByRole("link", { name: "Выбрать" })
    .click();
  await page
    .locator("main a, main button")
    .filter({ hasText: /освободится/i })
    .first()
    .click();
  await page.getByRole("button", { name: "Создать запрос" }).click();

  const offered = page.locator(".free-slots .slots-grid a");
  await expect(offered.first()).toBeVisible();
  const href = new URL(
    (await offered.first().getAttribute("href"))!,
    "http://localhost",
  );
  const wanted = (await offered.first().locator("strong").innerText()).trim();
  await offered.first().click();
  await expect(page.locator("main input[type=date]").first()).toHaveValue(
    href.searchParams.get("date")!,
  );

  const chosen = page.locator(".slots-grid button.selected");
  await expect(chosen).toHaveCount(1);
  await expect(chosen.locator("strong")).toHaveText(wanted);
  await expect(
    page.getByRole("button", { name: "Подтвердить запись", exact: true }),
  ).toBeVisible();
});

test("the timezone carousel keeps the chosen zone on screen", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Владелец · Линия Управление студией волос и партнёрствами",
    })
    .click();
  const workspace = visibleWorkspace(page);
  const option = await workspace
    .locator("option")
    .filter({ hasText: "Линия" })
    .getAttribute("value");
  await workspace.selectOption(option!);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();
  await page.locator(".timezone-picker").waitFor();

  const offscreen = async () =>
    await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>(".timezone-picker")!;
      const chosen = strip.querySelector("input:checked")!
        .parentElement as HTMLElement;
      const view = strip.getBoundingClientRect();
      const item = chosen.getBoundingClientRect();
      return item.left < view.left - 1 || item.right > view.right + 1
        ? chosen.innerText.replace(/\s+/g, " ").trim()
        : null;
    });

  await page.locator(".timezone-picker input").first().focus();
  const lost: string[] = [];
  for (let step = 0; step < 10; step++) {
    await page.keyboard.press("ArrowRight");
    const missing = await offscreen();
    if (missing) lost.push(missing);
  }
  expect(lost).toEqual([]);
  expect(await offscreen()).toBeNull();
});

test("a long salon name never pushes the workspace off screen", async ({
  page,
}) => {
  const long = "Суперэкстрамегапарикмахерскаястудияквинтэссенция";
  const original = "Линия · студия волос";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Владелец · Линия Управление студией волос и партнёрствами",
    })
    .click();
  const workspace = visibleWorkspace(page);
  const option = await workspace
    .locator("option")
    .filter({ hasText: "Линия" })
    .getAttribute("value");
  await workspace.selectOption(option!);
  await page.getByRole("link", { name: "Настройки", exact: true }).click();

  const name = page.getByLabel("Название");
  await name.fill(long);
  await page
    .getByRole("button", { name: "Сохранить", exact: true })
    .first()
    .click();
  try {
    await expect(page.locator(".mobile-workspace-select option:checked")).toContainText(long.slice(0, 12));
    for (const screen of ["Журнал", "Клиенты", "Календарь"]) {
      await page.getByRole("link", { name: screen, exact: true }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    }
  } finally {
    await page.getByRole("link", { name: "Настройки", exact: true }).click();
    await page.getByLabel("Название").fill(original);
    await page
      .getByRole("button", { name: "Сохранить", exact: true })
      .first()
      .click();
    await expect(page.locator(".mobile-workspace-select option:checked")).toContainText(original);
  }
});
