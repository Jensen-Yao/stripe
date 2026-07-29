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
  await expect(page.getByLabel("显示上限")).toHaveValue("500000");
  await expect(page.getByText(/高层级自动进入可辨识比例尺/)).toBeVisible();
  await expect(page.getByTestId("coverage-fov-summary")).toContainText("矩形 10.0° × 2.0°");
  await expect(page.getByTestId("coverage-fov-summary")).toContainText("等待轨道样本");
});

test("offers AMap and falls back to offline map when desktop API is unavailable", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  const offline = page.getByRole("button", { name: "离线", exact: true });
  const amap = page.getByRole("button", { name: "高德地图", exact: true });
  await expect(amap).toBeVisible();
  await page.getByText("地理脉络", { exact: true }).locator("input").uncheck();
  await amap.click();
  await expect(page.getByText(/尚未配置高德地图 Web JS API，已切回离线地图/)).toBeVisible();
  await expect(offline).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-workbench canvas").first()).toBeVisible();
});

test("switches AMap between SDK 2D and a globe basemap", async ({ page }) => {
  await page.route("**/appmaptile**", (route) => route.abort());
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.stripeApi));
  await page.evaluate(() => {
    class FakeAmapMap {
      private readonly container: HTMLElement;

      constructor(container: HTMLElement, options: Record<string, unknown>) {
        this.container = container;
        this.container.dataset.amapViewMode = String(options.viewMode);
        const surface = document.createElement("div");
        surface.className = "amap-maps";
        this.container.appendChild(surface);
      }

      setZoomAndCenter(zoom: number) { this.container.dataset.fakeAmapZoom = zoom.toFixed(2); }
      setMapStyle(style: string) { this.container.dataset.fakeAmapStyle = style; }
      resize() {}
      destroy() { this.container.replaceChildren(); }
    }

    window.stripeApi.getAmapConfig = async () => ({ configured: true, key: "test-key", securityCode: "test-security" });
    (window as unknown as { AMap: { Map: typeof FakeAmapMap } }).AMap = { Map: FakeAmapMap };
  });
  await page.getByTestId("tab-analysis").click();
  await page.getByTestId("basemap-amap").click();
  await expect(page.locator(".amap-base-layer")).toHaveCount(1);
  await expect(page.getByText("中国表达（高德内置）")).toBeVisible();
  await expect(page.getByText("中国表达（高德内置）").locator("input")).toBeDisabled();
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-geographic-context", "visible");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-map-style", "amap://styles/normal");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-sync-zoom", "3.00");
  await page.getByRole("button", { name: "三维" }).click();
  await expect(page.getByText("高德球面检查视图：条带编辑已锁定")).toBeVisible();
  await expect(page.getByTestId("basemap-amap")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-workbench")).toHaveClass(/amap-globe/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "globe");
  await expect.poll(async () => Number(await page.locator(".map-workbench").getAttribute("data-map-zoom"))).toBeGreaterThan(1.8);
  expect(Number(await page.locator(".map-workbench").getAttribute("data-map-zoom"))).toBeLessThan(2.2);
  await expect(page.locator(".amap-base-layer")).not.toHaveClass(/active/);
  await page.getByRole("button", { name: "二维" }).click();
  await expect(page.locator(".map-workbench")).not.toHaveClass(/amap-globe/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "mercator");
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await page.getByText("地理脉络", { exact: true }).locator("input").uncheck();
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-map-style", "amap://styles/light");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-view-mode", "2D");
  await page.getByTestId("basemap-offline").click();
  await expect(page.locator(".amap-base-layer")).not.toHaveClass(/active/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-active-basemap", "offline");
  await page.getByTestId("basemap-osm").click();
  await expect(page.locator(".amap-base-layer")).not.toHaveClass(/active/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-active-basemap", "osm");
});

test("shows geographic context on AMap and keeps offline and OSM globe views complete", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
  await page.route("**/appmaptile**", (route) => route.abort());
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.stripeApi));
  await page.evaluate(() => {
    class FakeAmapMap {
      private readonly container: HTMLElement;
      constructor(container: HTMLElement) {
        this.container = container;
        const surface = document.createElement("div");
        surface.className = "amap-maps";
        this.container.appendChild(surface);
      }
      setZoomAndCenter() {}
      setMapStyle(style: string) { this.container.dataset.fakeAmapStyle = style; }
      resize() {}
      destroy() { this.container.replaceChildren(); }
    }
    window.stripeApi.getAmapConfig = async () => ({ configured: true, key: "test-key", securityCode: "test-security" });
    (window as unknown as { AMap: { Map: typeof FakeAmapMap } }).AMap = { Map: FakeAmapMap };
  });
  await page.getByTestId("tab-analysis").click();
  const geographicContext = page.getByText("地理脉络", { exact: true }).locator("input");
  await expect(geographicContext).toBeChecked();
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-geographic-context", "visible");
  await geographicContext.uncheck();
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-geographic-context", "hidden");
  await geographicContext.check();
  await page.getByTestId("basemap-amap").click();
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-geographic-context", "visible");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-map-style", "amap://styles/normal");
  await geographicContext.uncheck();
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-map-style", "amap://styles/light");
  await geographicContext.check();
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-map-style", "amap://styles/normal");
  await page.getByRole("button", { name: "三维" }).click();
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "globe");
  await page.getByTestId("basemap-offline").click();
  await expect(page.getByTestId("basemap-offline")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "globe");
  await page.getByTestId("basemap-osm").click();
  await expect(page.getByTestId("basemap-osm")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "globe");
  await page.getByRole("button", { name: "二维" }).click();
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "mercator");
  expect(pageErrors).toEqual([]);
});

test("coalesces rapid base-map changes without freezing the workbench", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  await page.evaluate(() => {
    for (const testId of ["basemap-osm", "basemap-offline", "basemap-osm", "basemap-offline", "basemap-osm"]) {
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
    }
    document.querySelector<HTMLButtonElement>(".view-switch button:nth-child(2)")?.click();
    document.querySelector<HTMLButtonElement>("[data-testid=basemap-offline]")?.click();
  });
  await expect(page.getByTestId("basemap-offline")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "globe");
  await page.getByRole("button", { name: "二维" }).click();
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-map-projection", "mercator");
  expect(pageErrors).toEqual([]);
});

test("keeps level 9 H3 visible by clipping oversized views", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __h3LongTasks?: number[] }).__h3LongTasks = [];
    new PerformanceObserver((list) => {
      const values = (window as Window & { __h3LongTasks?: number[] }).__h3LongTasks!;
      for (const entry of list.getEntries()) values.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  });
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  await page.getByRole("button", { name: "生成条带" }).click();
  await page.evaluate(() => { (window as Window & { __h3LongTasks?: number[] }).__h3LongTasks = []; });
  await page.getByLabel("层级 0-13").fill("9");
  await page.getByText("显示网格", { exact: true }).locator("input").check();
  await expect(page.getByText(/H3 9 级：/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".map-workbench canvas").first()).toBeVisible();
  await page.waitForTimeout(500);
  const longTasks = await page.evaluate(() => (window as Window & { __h3LongTasks?: number[] }).__h3LongTasks ?? []);
  const loadingSpikes = longTasks.filter((value) => value > 220);
  expect(loadingSpikes.length, `H3 渐进显示出现持续峰值：${longTasks.map((value) => value.toFixed(1)).join(", ")} ms`).toBeLessThanOrEqual(1);
  expect(Math.max(0, ...longTasks), `H3 渐进显示最长任务：${longTasks.map((value) => value.toFixed(1)).join(", ")} ms`).toBeLessThanOrEqual(450);
  await page.screenshot({ path: "test-results/h3-level-9-visible.png" });
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
