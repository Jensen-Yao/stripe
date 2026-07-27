import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

test("loads the Chinese planning workbench", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("卫星规划工作台 0.3")).toBeVisible();
  await expect(page.getByText("对象浏览器")).toBeVisible();
  await expect(page.getByRole("button", { name: "属性" })).toBeVisible();
  await expect(page.getByText("场景时间线")).toBeVisible();
  await expect(page.locator(".map-workbench")).toBeVisible();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "test-results/stripe-workbench.png" });
  const image = PNG.sync.read(await page.locator(".map-workbench").screenshot());
  const sampledColors = new Set<string>();
  for (let y = 0; y < image.height; y += 20) {
    for (let x = 0; x < image.width; x += 20) {
      const offset = (y * image.width + x) * 4;
      sampledColors.add(`${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`);
    }
  }
  expect(sampledColors.size).toBeGreaterThan(20);
});

test("propagates a TLE locally and switches to the globe inspection view", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.getByTestId("tab-orbit").click();
  await page.waitForTimeout(100);
  expect(pageErrors).toEqual([]);
  await page.getByTestId("propagate-orbit").click();
  await expect(page.getByText(/轨道传播完成：\d+ 个样本/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("当前状态")).toBeVisible();
  await expect(page.getByText("TEME 位置")).toBeVisible();
  await page.getByRole("button", { name: "三维" }).click();
  await expect(page.getByText("三维地球检查视图：条带编辑已锁定")).toBeVisible();
  await expect(page.locator(".map-workbench canvas").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("opens analysis controls and preserves H3 level 13", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "分析" }).click();
  const level = page.getByLabel("层级 0-13");
  await level.fill("13");
  await expect(level).toHaveValue("13");
  await expect(page.getByText(/不会自动降低层级/)).toBeVisible();
  await expect(page.getByTestId("coverage-fov-summary")).toContainText("矩形 10.0° × 2.0°");
  await expect(page.getByTestId("coverage-fov-summary")).toContainText("等待轨道样本");
});

test("generates editable stripes and reports exact overlap", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  await page.getByRole("button", { name: "生成条带" }).click();
  const rotateHandle = page.locator(".handle-rotate");
  await expect(rotateHandle).toBeVisible();
  await expect.poll(async () => {
    const mapBox = await page.locator(".map-workbench").boundingBox();
    const rotateBox = await rotateHandle.boundingBox();
    if (!mapBox || !rotateBox) return false;
    const centerX = rotateBox.x + rotateBox.width / 2;
    const centerY = rotateBox.y + rotateBox.height / 2;
    return centerX > mapBox.x + 72 && centerX < mapBox.x + mapBox.width - 72
      && centerY > mapBox.y + 72 && centerY < mapBox.y + mapBox.height - 72;
  }).toBe(true);
  const handleBox = await rotateHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + 45, handleBox!.y + 28, { steps: 6 });
  await page.mouse.up();
  await expect(rotateHandle).toBeVisible();
  await page.screenshot({ path: "test-results/stripe-editing.png" });
  await page.getByRole("button", { name: "导入条带并分析" }).click();
  await expect(page.getByText(/已导入 1 条条带，发现 1 组覆盖关系/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/部分重叠|包含|完全重合/).first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});
