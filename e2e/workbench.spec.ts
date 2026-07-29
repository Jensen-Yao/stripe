import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";

function countStripePixels(buffer: Buffer, bounds?: { left: number; top: number; right: number; bottom: number }) {
  const image = PNG.sync.read(buffer);
  const left = Math.floor((bounds?.left ?? 0) * image.width);
  const top = Math.floor((bounds?.top ?? 0) * image.height);
  const right = Math.ceil((bounds?.right ?? 1) * image.width);
  const bottom = Math.ceil((bounds?.bottom ?? 1) * image.height);
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      if (red > 165 && green > 45 && green < 165 && blue < 135 && red - green > 45) count += 1;
    }
  }
  return count;
}

function countChangedPixels(before: Buffer, after: Buffer, bounds: { left: number; top: number; right: number; bottom: number }) {
  const first = PNG.sync.read(before);
  const second = PNG.sync.read(after);
  expect({ width: first.width, height: first.height }).toEqual({ width: second.width, height: second.height });
  let count = 0;
  for (let y = Math.floor(bounds.top * first.height); y < Math.ceil(bounds.bottom * first.height); y += 1) {
    for (let x = Math.floor(bounds.left * first.width); x < Math.ceil(bounds.right * first.width); x += 1) {
      const offset = (y * first.width + x) * 4;
      const difference = Math.abs(first.data[offset] - second.data[offset])
        + Math.abs(first.data[offset + 1] - second.data[offset + 1])
        + Math.abs(first.data[offset + 2] - second.data[offset + 2]);
      if (difference > 24) count += 1;
    }
  }
  return count;
}

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
  await expect(page.getByText("三维地球规划视图：支持绘制与选择条带，精细变换请切回二维")).toBeVisible();
  await expect(page.locator(".map-workbench canvas").first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("draws and renders a stripe in the globe view", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "三维" }).click();
  await page.getByTitle("绘制多节点条带").click();
  const map = page.locator(".map-workbench");
  const bounds = await map.boundingBox();
  expect(bounds).not.toBeNull();
  const points = [
    [bounds!.width * 0.44, bounds!.height * 0.42],
    [bounds!.width * 0.56, bounds!.height * 0.42],
    [bounds!.width * 0.56, bounds!.height * 0.54],
    [bounds!.width * 0.44, bounds!.height * 0.54]
  ];
  for (const [x, y] of points) await map.click({ position: { x, y } });
  await expect(map).toHaveAttribute("data-draft-point-count", "4");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/4 节点条带已生成/)).toBeVisible();
  await expect(map).toHaveAttribute("data-rendered-stripe-count", "1");
  await expect(page.locator(".map-edit-preview")).toBeHidden();
  const renderedMap = await map.screenshot();
  expect(countStripePixels(renderedMap, { left: 0.38, top: 0.34, right: 0.62, bottom: 0.62 })).toBeGreaterThan(120);
});

test("keeps a saved stripe visible when switching between planar and globe views", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("tab-analysis").click();
  await page.getByRole("button", { name: "生成条带" }).click();
  const map = page.locator(".map-workbench");
  await expect(map).toHaveAttribute("data-visible-stripe-count", "1");

  await page.getByRole("button", { name: "三维" }).click();
  await expect(map).toHaveAttribute("data-map-projection", "globe");
  await expect(map).toHaveAttribute("data-map-zoom", "3.50");
  await expect(map).toHaveAttribute("data-rendered-stripe-count", "1");
  const globeMap = await map.screenshot();
  const stripeToggle = page.getByText("条带", { exact: true }).locator("input");
  await stripeToggle.uncheck();
  const globeWithoutStripe = await map.screenshot();
  expect(countChangedPixels(globeMap, globeWithoutStripe, { left: 0.44, top: 0.2, right: 0.56, bottom: 0.55 })).toBeGreaterThan(500);
  await stripeToggle.check();

  await page.getByRole("button", { name: "二维" }).click();
  await expect(map).toHaveAttribute("data-map-projection", "mercator");
  await page.getByRole("button", { name: "三维" }).click();
  await expect(map).toHaveAttribute("data-map-zoom", "3.50");
  const restoredGlobeMap = await map.screenshot();
  await stripeToggle.uncheck();
  const restoredGlobeWithoutStripe = await map.screenshot();
  expect(countChangedPixels(restoredGlobeMap, restoredGlobeWithoutStripe, { left: 0.44, top: 0.2, right: 0.56, bottom: 0.55 })).toBeGreaterThan(500);
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
    class FakeTileLayer {
      readonly __stripeLayerKind?: string;
      constructor(kind: string) {
        this.__stripeLayerKind = kind;
      }
    }
    class FakeAmapMap {
      private readonly container: HTMLElement;
      private layers: Array<{ __stripeLayerKind?: string }>;

      constructor(container: HTMLElement, options: Record<string, unknown>) {
        this.container = container;
        this.container.dataset.amapViewMode = String(options.viewMode);
        const surface = document.createElement("div");
        surface.className = "amap-maps";
        this.container.appendChild(surface);
        this.layers = [{ __stripeLayerKind: "standard" }];
      }

      setZoomAndCenter(zoom: number) { this.container.dataset.fakeAmapZoom = zoom.toFixed(2); }
      setMapStyle(style: string) { this.container.dataset.fakeAmapStyle = style; }
      getLayers() { return this.layers; }
      setLayers(layers: Array<{ __stripeLayerKind?: string }>) {
        this.layers = layers;
        this.container.dataset.fakeAmapLayerCount = String(layers.length);
        this.container.dataset.fakeAmapLayerKinds = layers.map((layer) => layer.__stripeLayerKind ?? "unknown").join(",");
      }
      resize() {}
      destroy() { this.container.replaceChildren(); }
    }

    window.stripeApi.getAmapConfig = async () => ({ configured: true, key: "test-key", securityCode: "test-security" });
    (window as unknown as { AMap: { Map: typeof FakeAmapMap; TileLayer: { Satellite: typeof FakeTileLayer; RoadNet: typeof FakeTileLayer } } }).AMap = {
      Map: FakeAmapMap,
      TileLayer: {
        Satellite: class extends FakeTileLayer { constructor() { super("satellite"); } },
        RoadNet: class extends FakeTileLayer { constructor() { super("roadnet"); } }
      }
    };
  });
  await page.getByTestId("tab-analysis").click();
  await page.getByTestId("basemap-amap").click();
  await expect(page.locator(".amap-base-layer")).toHaveCount(1);
  await expect(page.getByTestId("amap-surface-render")).toBeVisible();
  await expect(page.getByText("中国表达（高德内置）")).toBeVisible();
  await expect(page.getByText("中国表达（高德内置）").locator("input")).toBeDisabled();
  await expect(page.locator(".amap-base-layer")).toHaveClass(/active/);
  await expect(page.locator(".map-workbench")).toHaveAttribute("data-geographic-context", "visible");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-map-style", "amap://styles/normal");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-sync-zoom", "3.00");
  await page.getByTestId("amap-surface-render").click();
  await expect(page.getByTestId("amap-surface-render")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-surface-rendering", "visible");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-fake-amap-layer-count", "2");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-fake-amap-layer-kinds", "satellite,roadnet");
  await page.getByTestId("amap-surface-render").click();
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-amap-surface-rendering", "hidden");
  await expect(page.locator(".amap-base-layer")).toHaveAttribute("data-fake-amap-layer-count", "1");
  await page.getByRole("button", { name: "三维" }).click();
  await expect(page.getByText("高德球面规划视图：支持绘制与选择条带，精细变换请切回二维")).toBeVisible();
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
  await page.getByRole("button", { name: "生成条带" }).click();
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
  const map = page.locator(".map-workbench");
  const stripeToggle = page.getByText("条带", { exact: true }).locator("input");
  await expect(map).toHaveAttribute("data-map-projection", "globe");
  await expect(map).toHaveAttribute("data-map-zoom", "3.50");
  await expect(map).toHaveAttribute("data-rendered-stripe-count", "1");
  const amapGlobe = await map.screenshot();
  await stripeToggle.uncheck();
  const amapGlobeWithoutStripe = await map.screenshot();
  expect(countChangedPixels(amapGlobe, amapGlobeWithoutStripe, { left: 0.44, top: 0.2, right: 0.56, bottom: 0.55 })).toBeGreaterThan(100);
  await stripeToggle.check();
  await page.getByTestId("basemap-offline").click();
  await expect(page.getByTestId("basemap-offline")).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveAttribute("data-map-projection", "globe");
  await expect(map).toHaveAttribute("data-rendered-stripe-count", "1");
  const offlineGlobe = await map.screenshot();
  await stripeToggle.uncheck();
  const offlineGlobeWithoutStripe = await map.screenshot();
  expect(countChangedPixels(offlineGlobe, offlineGlobeWithoutStripe, { left: 0.44, top: 0.2, right: 0.56, bottom: 0.55 })).toBeGreaterThan(100);
  await stripeToggle.check();
  await page.getByTestId("basemap-osm").click();
  await expect(page.getByTestId("basemap-osm")).toHaveAttribute("aria-pressed", "true");
  await expect(map).toHaveAttribute("data-map-projection", "globe");
  await expect(map).toHaveAttribute("data-rendered-stripe-count", "1");
  const osmGlobe = await map.screenshot();
  await stripeToggle.uncheck();
  const osmGlobeWithoutStripe = await map.screenshot();
  expect(countChangedPixels(osmGlobe, osmGlobeWithoutStripe, { left: 0.44, top: 0.2, right: 0.56, bottom: 0.55 })).toBeGreaterThan(100);
  await stripeToggle.check();
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
