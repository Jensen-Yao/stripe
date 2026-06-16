import L from "leaflet";
import { feature, mesh } from "topojson-client";
import countries110m from "world-atlas/countries-110m.json";

type LonLat = [number, number];
type Ring = LonLat[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];
type Line = LonLat[];
type MultiLine = Line[];
type Topology = {
  objects: {
    countries: unknown;
  };
};

type MapLevel = {
  maxZoom: number;
  land: MultiPolygon;
  borders: MultiLine;
};
type LevelKey = "110m" | "50m" | "10m";

function topoLand(topology: Topology) {
  const item = feature(topology as never, topology.objects.countries as never) as unknown as GeoJSON.FeatureCollection;
  return item.features.flatMap((entry) => {
    const geometry = entry.geometry;
    if (!geometry) return [];
    if (geometry.type === "Polygon") return [geometry.coordinates as Polygon];
    if (geometry.type === "MultiPolygon") return geometry.coordinates as MultiPolygon;
    return [];
  });
}

function topoBorders(topology: Topology) {
  const item = mesh(topology as never, topology.objects.countries as never, (a, b) => a !== b) as unknown as GeoJSON.MultiLineString;
  return item.coordinates as MultiLine;
}

const levelCache = new Map<LevelKey, MapLevel>();

function buildLevel(topology: Topology, maxZoom: number): MapLevel {
  return {
    maxZoom,
    land: topoLand(topology),
    borders: topoBorders(topology)
  };
}

levelCache.set("110m", buildLevel(countries110m, 2.2));

function levelKeyForZoom(zoom: number): LevelKey {
  if (zoom <= 2.2) return "110m";
  if (zoom <= 4.5) return "50m";
  return "10m";
}

async function loadLevel(key: LevelKey) {
  const cached = levelCache.get(key);
  if (cached) return cached;
  if (key === "50m") {
    const module = await import("world-atlas/countries-50m.json");
    const level = buildLevel(module.default, 4.5);
    levelCache.set(key, level);
    return level;
  }
  const module = await import("world-atlas/countries-10m.json");
  const level = buildLevel(module.default, Infinity);
  levelCache.set(key, level);
  return level;
}

function crossesDateLine(points: Ring | Line) {
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index][0] - points[index - 1][0]) > 180) return true;
  }
  return false;
}

function lineInBounds(points: Ring | Line, bounds: L.LatLngBounds) {
  return points.some(([lon, lat]) => bounds.contains([lat, lon])) || crossesDateLine(points);
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  map: L.Map,
  topLeft: L.Point,
  points: Ring | Line,
  close: boolean
) {
  let started = false;
  let previous: LonLat | null = null;
  points.forEach(([lon, lat]) => {
    if (previous && Math.abs(lon - previous[0]) > 180) {
      started = false;
    }
    const point = map.latLngToLayerPoint([lat, lon]).subtract(topLeft);
    if (!started) {
      ctx.moveTo(point.x, point.y);
      started = true;
    } else {
      ctx.lineTo(point.x, point.y);
    }
    previous = [lon, lat];
  });
  if (close && started) ctx.closePath();
}

export class OfflineWorldCanvasLayer extends L.Layer {
  private canvas?: HTMLCanvasElement;
  private frame: number | null = null;
  private drawVersion = 0;

  onAdd(map: L.Map) {
    this.canvas = L.DomUtil.create("canvas", "offline-world-canvas");
    const pane = map.getPane("overlayPane") ?? map.getPanes().overlayPane;
    pane.appendChild(this.canvas);
    this.attachEvents(map);
    this.schedule(map);
    return this;
  }

  onRemove(map: L.Map) {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.detachEvents(map);
    this.canvas?.remove();
    this.canvas = undefined;
    return this;
  }

  private attachEvents(map: L.Map) {
    map.on("moveend zoomend resize", this.scheduleForEvent, this);
    map.on("zoomstart movestart", this.hideDuringMove, this);
    map.on("moveend zoomend", this.showAfterMove, this);
  }

  private detachEvents(map: L.Map) {
    map.off("moveend zoomend resize", this.scheduleForEvent, this);
    map.off("zoomstart movestart", this.hideDuringMove, this);
    map.off("moveend zoomend", this.showAfterMove, this);
  }

  private scheduleForEvent(event: L.LeafletEvent) {
    this.schedule(event.target as L.Map);
  }

  private hideDuringMove() {
    if (this.canvas) this.canvas.style.opacity = "0.72";
  }

  private showAfterMove(event: L.LeafletEvent) {
    if (this.canvas) this.canvas.style.opacity = "1";
    this.schedule(event.target as L.Map);
  }

  private schedule(map: L.Map) {
    if (this.frame !== null) window.cancelAnimationFrame(this.frame);
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      void this.draw(map);
    });
  }

  private async draw(map: L.Map) {
    if (!this.canvas) return;
    const version = ++this.drawVersion;
    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(size.x * dpr));
    this.canvas.height = Math.max(1, Math.round(size.y * dpr));
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.canvas.style.transform = "translate3d(0,0,0)";

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.fillStyle = "#d8e4e1";
    ctx.fillRect(0, 0, size.x, size.y);

    const zoom = map.getZoom();
    const level = await loadLevel(levelKeyForZoom(zoom));
    if (version !== this.drawVersion || !this.canvas) return;
    const bounds = map.getBounds().pad(0.08);

    ctx.beginPath();
    level.land.forEach((polygon) => {
      polygon.forEach((ring) => {
        if (lineInBounds(ring, bounds)) drawLine(ctx, map, topLeft, ring, true);
      });
    });
    ctx.fillStyle = "#d9cf78";
    ctx.fill("evenodd");
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#6e857b";
    ctx.lineWidth = Math.max(0.8, Math.min(1.5, zoom * 0.28));
    ctx.stroke();

    ctx.beginPath();
    level.borders.forEach((line) => {
      if (lineInBounds(line, bounds)) drawLine(ctx, map, topLeft, line, false);
    });
    ctx.strokeStyle = "rgba(89, 111, 103, 0.72)";
    ctx.lineWidth = Math.max(0.5, Math.min(1, zoom * 0.16));
    ctx.stroke();
  }
}
