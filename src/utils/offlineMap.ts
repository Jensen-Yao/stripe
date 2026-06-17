import L from "leaflet";

type LonLat = [number, number];
type Ring = LonLat[];
type Polygon = Ring[];
type WorldData = {
  land: Polygon[];
  borders: Ring[];
};

const MAX_DPR = 1.5;
const BUFFER_RATIO = 0.35;
const WORLD_DATA_URL = "./data/offline-world.json";
let worldDataPromise: Promise<WorldData> | null = null;

function loadWorldData() {
  if (!worldDataPromise) {
    worldDataPromise = fetch(WORLD_DATA_URL).then((response) => {
      if (!response.ok) throw new Error(`离线地图数据加载失败：${response.status}`);
      return response.json() as Promise<WorldData>;
    });
  }
  return worldDataPromise;
}

function crossesDateLine(line: Ring) {
  for (let index = 1; index < line.length; index += 1) {
    if (Math.abs(line[index][0] - line[index - 1][0]) > 180) return true;
  }
  return false;
}

function lineIntersectsBounds(line: Ring, bounds: L.LatLngBounds) {
  if (crossesDateLine(line)) return true;
  return line.some(([lon, lat]) => bounds.contains([lat, lon]));
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  map: L.Map,
  origin: L.Point,
  line: Ring,
  close: boolean
) {
  let started = false;
  let previous: LonLat | null = null;
  for (const [lon, lat] of line) {
    if (previous && Math.abs(lon - previous[0]) > 180) {
      started = false;
    }
    const point = map.latLngToLayerPoint([lat, lon]).subtract(origin);
    if (!started) {
      ctx.moveTo(point.x, point.y);
      started = true;
    } else {
      ctx.lineTo(point.x, point.y);
    }
    previous = [lon, lat];
  }
  if (close && started) ctx.closePath();
}

export class OfflineWorldLayer extends L.Layer {
  private canvas?: HTMLCanvasElement;
  private frame: number | null = null;
  private drawVersion = 0;
  private data: WorldData | null = null;

  onAdd(map: L.Map) {
    this.canvas = L.DomUtil.create("canvas", "offline-world-canvas");
    const pane = map.getPane("tilePane") ?? map.getPanes().tilePane;
    pane.appendChild(this.canvas);
    map.on("moveend zoomend resize", this.scheduleForEvent, this);
    map.on("movestart zoomstart", this.clearPendingDraw, this);
    this.schedule(map);
    void loadWorldData().then((data) => {
      this.data = data;
      this.schedule(map);
    });
    return this;
  }

  onRemove(map: L.Map) {
    this.clearPendingDraw();
    map.off("moveend zoomend resize", this.scheduleForEvent, this);
    map.off("movestart zoomstart", this.clearPendingDraw, this);
    this.canvas?.remove();
    this.canvas = undefined;
    return this;
  }

  private clearPendingDraw() {
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  private scheduleForEvent(event: L.LeafletEvent) {
    this.schedule(event.target as L.Map);
  }

  private schedule(map: L.Map) {
    this.clearPendingDraw();
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.draw(map);
    });
  }

  private draw(map: L.Map) {
    if (!this.canvas) return;
    const version = ++this.drawVersion;
    const size = map.getSize();
    const bufferX = Math.round(size.x * BUFFER_RATIO);
    const bufferY = Math.round(size.y * BUFFER_RATIO);
    const canvasSize = L.point(size.x + bufferX * 2, size.y + bufferY * 2);
    const topLeft = map.containerPointToLayerPoint([-bufferX, -bufferY]);
    L.DomUtil.setPosition(this.canvas, topLeft);

    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(canvasSize.x * dpr));
    this.canvas.height = Math.max(1, Math.round(canvasSize.y * dpr));
    this.canvas.style.width = `${canvasSize.x}px`;
    this.canvas.style.height = `${canvasSize.y}px`;

    const ctx = this.canvas.getContext("2d");
    if (!ctx || version !== this.drawVersion) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#d8e4e1";
    ctx.fillRect(0, 0, canvasSize.x, canvasSize.y);

    const bounds = L.latLngBounds(
      map.containerPointToLatLng([-bufferX, size.y + bufferY]),
      map.containerPointToLatLng([size.x + bufferX, -bufferY])
    ).pad(0.04);
    const origin = topLeft;
    const zoom = map.getZoom();
    const data = this.data;
    if (!data) return;

    ctx.beginPath();
    data.land.forEach((polygon) => {
      if (!polygon.some((ring) => lineIntersectsBounds(ring, bounds))) return;
      polygon.forEach((ring) => drawLine(ctx, map, origin, ring, true));
    });
    ctx.fillStyle = "#d9cf78";
    ctx.fill("evenodd");
    ctx.strokeStyle = "#6e857b";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = Math.max(0.8, Math.min(1.35, zoom * 0.22));
    ctx.stroke();

    ctx.beginPath();
    data.borders.forEach((line) => {
      if (lineIntersectsBounds(line, bounds)) drawLine(ctx, map, origin, line, false);
    });
    ctx.strokeStyle = "rgba(89, 111, 103, 0.72)";
    ctx.lineWidth = Math.max(0.45, Math.min(0.9, zoom * 0.13));
    ctx.stroke();
  }
}
