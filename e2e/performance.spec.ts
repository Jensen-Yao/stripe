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

async function rotateSelectedStripe(page: import("@playwright/test").Page) {
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
  return { dragTasks, editTasks };
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
  await page.locator(".import-area").fill(JSON.stringify([stripes[0]]));
  await page.getByRole("button", { name: "导入条带并分析" }).click();
  await expect(page.getByText("已导入 1 条条带")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks = []; });
  await dragMap(page);
  const baselineTasks = await page.evaluate(() => (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks ?? []);
  const baselineMaximum = Math.max(0, ...baselineTasks);
  const baselineEdit = await rotateSelectedStripe(page);
  const baselineDragMaximum = Math.max(0, ...baselineEdit.dragTasks);
  const baselineEditMaximum = Math.max(0, ...baselineEdit.editTasks);
  await page.getByRole("button", { name: "撤销" }).click();
  await page.waitForTimeout(300);

  await page.locator(".import-area").fill(JSON.stringify(stripes.slice(1)));
  await page.getByRole("button", { name: "导入条带并分析" }).click();
  await expect(page.getByText("已导入 999 条条带，发现 0 组覆盖关系")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks = []; });

  await dragMap(page);

  const longTasks = await page.evaluate(() => (window as Window & { __stripeLongTasks?: number[] }).__stripeLongTasks ?? []);
  const maximum = Math.max(0, ...longTasks);
  expect(longTasks.length, `1000 条带比基线增加过多长任务：基线 ${baselineTasks.length}，负载 ${longTasks.length}`).toBeLessThanOrEqual(baselineTasks.length + 3);
  expect(maximum, `1000 条带最长任务 ${maximum.toFixed(1)} ms，单条基线 ${baselineMaximum.toFixed(1)} ms`).toBeLessThanOrEqual(Math.min(220, Math.max(140, baselineMaximum + 80)));

  const loadedEdit = await rotateSelectedStripe(page);
  const dragTasks = loadedEdit.dragTasks;
  const editTasks = loadedEdit.editTasks;
  const dragMaximum = Math.max(0, ...dragTasks);
  const editMaximum = Math.max(0, ...editTasks);
  expect(dragMaximum, `1000 条拖动预览 ${dragMaximum.toFixed(1)} ms，单条基线 ${baselineDragMaximum.toFixed(1)} ms`).toBeLessThanOrEqual(Math.max(100, baselineDragMaximum + 40));
  expect(editTasks.length, `条带编辑长任务过多：单条 ${baselineEdit.editTasks.length}，1000 条 ${editTasks.map((value) => value.toFixed(1)).join(", ")} ms`).toBeLessThanOrEqual(baselineEdit.editTasks.length + 2);
  expect(editMaximum, `1000 条编辑提交 ${editMaximum.toFixed(1)} ms，单条基线 ${baselineEditMaximum.toFixed(1)} ms`).toBeLessThanOrEqual(Math.min(200, Math.max(100, baselineEditMaximum + 40)));
});
