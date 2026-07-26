import { expect, test } from "@playwright/test";

async function dragMap(page: import("@playwright/test").Page) {
  const map = page.locator(".map-workbench");
  const box = await map.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.55, box!.y + box!.height * 0.5);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(
      box!.x + box!.width * (0.55 + 0.1 * step / 12),
      box!.y + box!.height * (0.5 + 0.08 * step / 12)
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}

test("keeps 1000-stripe interaction within the headless rendering budget", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks = [];
    new PerformanceObserver((list) => {
      const values = (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks!;
      for (const entry of list.getEntries()) values.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();

  const stripes = Array.from({ length: 1000 }, (_, index) => {
    const column = index % 40;
    const row = Math.floor(index / 40);
    const lon = 104 + column * 0.18;
    const lat = 35 + row * 0.14;
    return [[lon, lat], [lon + 0.1, lat], [lon + 0.1, lat + 0.06], [lon, lat + 0.06]];
  });
  await page.locator(".import-area").fill(JSON.stringify(stripes));
  await page.getByRole("button", { name: "导入条带并分析" }).click();
  await expect(page.getByText(/已导入 1,?000 条条带，发现 0 组覆盖关系/)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks = []; });

  await dragMap(page);

  const longTasks = await page.evaluate(() => (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks ?? []);
  const maximum = Math.max(0, ...longTasks);
  expect(longTasks.length, `交互期间长任务过多：${longTasks.map((value) => value.toFixed(1)).join(", ")} ms`).toBeLessThanOrEqual(2);
  expect(maximum, `交互期间最长任务 ${maximum.toFixed(1)} ms`).toBeLessThan(75);

  await page.evaluate(() => { (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks = []; });
  const rotate = page.locator(".handle-rotate");
  await expect(rotate).toBeVisible();
  const rotateBox = await rotate.boundingBox();
  expect(rotateBox).not.toBeNull();
  await page.mouse.move(rotateBox!.x + rotateBox!.width / 2, rotateBox!.y + rotateBox!.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(rotateBox!.x + 4 * step, rotateBox!.y + 2 * step);
    await page.waitForTimeout(16);
  }
  const dragTasks = await page.evaluate(() => (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks ?? []);
  await page.evaluate(() => { (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks = []; });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const editTasks = await page.evaluate(() => (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks ?? []);
  const dragMaximum = Math.max(0, ...dragTasks);
  const editMaximum = Math.max(0, ...editTasks);
  expect(dragMaximum, `拖动预览最长任务 ${dragMaximum.toFixed(1)} ms`).toBeLessThan(75);
  expect(editTasks.length, `条带编辑长任务过多：${editTasks.map((value) => value.toFixed(1)).join(", ")} ms`).toBeLessThanOrEqual(2);
  expect(editMaximum, `条带编辑最长任务 ${editMaximum.toFixed(1)} ms`).toBeLessThan(75);
});
