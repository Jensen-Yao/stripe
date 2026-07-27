import { expect, test } from "@playwright/test";

test("draws an arbitrary polygon and edits target radius", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.getByTitle("绘制多节点条带（双击或回车完成）").click();
  const map = page.locator(".map-workbench");
  const box = await map.boundingBox();
  expect(box).not.toBeNull();
  const points = [
    [0.42, 0.34], [0.60, 0.31], [0.68, 0.49], [0.53, 0.43], [0.38, 0.53]
  ];
  for (const [x, y] of points) await page.mouse.click(box!.x + box!.width * x, box!.y + box!.height * y);
  await page.keyboard.press("Enter");
  await expect(page.getByText(/5 节点条带已生成/)).toBeVisible();
  await expect(page.getByText("周长 / 节点")).toBeVisible();
  await expect(page.locator(".vertex-row").first()).toBeHidden();
  await page.locator(".vertex-editor summary").click();
  await expect(page.locator(".vertex-row")).toHaveCount(5);

  await page.getByText("北京目标", { exact: true }).click();
  const radius = page.getByLabel("目标半径 km");
  await expect(radius).toHaveValue("25");
  await radius.fill("80");
  await expect(radius).toHaveValue("80");
  expect(pageErrors).toEqual([]);
});

test("exposes the China standard map expression layer", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  const standardLayer = page.getByText("中国标准表达", { exact: true });
  await expect(standardLayer).toBeVisible();
  await expect(standardLayer.locator("input")).toBeChecked();
  await expect(page.getByText(/台湾省、钓鱼岛、南海诸岛/)).toBeVisible();
  const countryLabels = await page.request.get("/maps/country-labels.json");
  expect(countryLabels.ok()).toBe(true);
  const labels = await countryLabels.json() as Array<{ name?: string }>;
  expect(labels.some((label) => /中华民国|台湾|臺灣|Taiwan|Republic of China/i.test(label.name ?? ""))).toBe(false);
  await page.getByLabel("中心经度").fill("121");
  await page.getByLabel("中心纬度").fill("23.7");
  await page.getByLabel("长度 km").fill("50");
  await page.getByLabel("宽度 km").fill("10");
  await page.getByRole("button", { name: "生成条带" }).click();
  await expect(page.locator(".handle-rotate")).toBeVisible();
  await page.keyboard.press("Delete");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/taiwan-standard-label.png" });
});

test("identifies overlap operands as named A and B stripes", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  await page.getByRole("button", { name: "生成条带" }).click();
  await page.getByLabel("中心经度").fill("116.2");
  await page.getByRole("button", { name: "生成条带" }).click();
  await page.getByRole("button", { name: "运行精确重叠分析" }).click();

  const result = page.getByTestId("overlap-result").first();
  await expect(result).toBeVisible();
  await expect(result).toContainText("A");
  await expect(result).toContainText("条带 1");
  await expect(result).toContainText("B");
  await expect(result).toContainText("条带 2");
  await expect(result).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: "test-results/overlap-a-b-labels.png" });
});
