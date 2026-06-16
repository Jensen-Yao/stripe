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
  land: MultiPolygon;
  borders: MultiLine;
};
type LevelKey = "110m" | "50m" | "10m";

const TILE_SIZE = 256;

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

function buildLevel(topology: Topology): MapLevel {
  return {
    land: topoLand(topology),
    borders: topoBorders(topology)
  };
}

levelCache.set("110m", buildLevel(countries110m));

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
    const level = buildLevel(module.default);
    levelCache.set(key, level);
    return level;
  }
  const module = await import("world-atlas/countries-10m.json");
  const level = buildLevel(module.default);
  levelCache.set(key, level);
  return level;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
  zoom: number,
  tileX: number,
  tileY: number,
  worldOffset: number,
  points: Ring | Line,
  close: boolean
) {
  let started = false;
  let previous: LonLat | null = null;
  points.forEach(([lon, lat]) => {
    if (previous && Math.abs(lon - previous[0]) > 180) {
      started = false;
    }
    const point = L.CRS.EPSG3857.latLngToPoint(L.latLng(lat, lon + worldOffset), zoom).subtract(
      L.point(tileX * TILE_SIZE, tileY * TILE_SIZE)
    );
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

export class OfflineWorldGridLayer extends L.GridLayer {
  createTile(coords: L.Coords, done: L.DoneCallback) {
    const tile = L.DomUtil.create("canvas", "offline-world-tile");
    const tileSize = this.getTileSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    tile.width = Math.round(tileSize.x * dpr);
    tile.height = Math.round(tileSize.y * dpr);
    tile.style.width = `${tileSize.x}px`;
    tile.style.height = `${tileSize.y}px`;

    this.drawTile(tile, coords, tileSize, dpr)
      .then(() => done(undefined, tile))
      .catch((error) => done(error as Error, tile));

    return tile;
  }

  private async drawTile(tile: HTMLCanvasElement, coords: L.Coords, tileSize: L.Point, dpr: number) {
    const ctx = tile.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#d8e4e1";
    ctx.fillRect(0, 0, tileSize.x, tileSize.y);

    const zoom = coords.z;
    const level = await loadLevel(levelKeyForZoom(zoom));
    const worldTileCount = Math.max(1, Math.round(2 ** zoom));
    const tileX = ((coords.x % worldTileCount) + worldTileCount) % worldTileCount;
    const tileY = coords.y;
    const origin = L.point(tileX * tileSize.x, tileY * tileSize.y);
    const northWest = L.CRS.EPSG3857.pointToLatLng(origin, zoom);
    const southEast = L.CRS.EPSG3857.pointToLatLng(origin.add(tileSize), zoom);
    const worldOffset = 0;
    const west = clamp(northWest.lng, -180, 180);
    const east = clamp(southEast.lng, -180, 180);
    const south = clamp(southEast.lat, -90, 90);
    const north = clamp(northWest.lat, -90, 90);
    if (east <= west || north <= south) return;
    const bounds = L.latLngBounds(
      [south, west],
      [north, east]
    ).pad(0.06);

    ctx.beginPath();
    level.land.forEach((polygon) => {
      polygon.forEach((ring) => {
        if (lineInBounds(ring, bounds)) drawLine(ctx, zoom, tileX, tileY, worldOffset, ring, true);
      });
    });
    ctx.fillStyle = "#d9cf78";
    ctx.fill("evenodd");
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "#6e857b";
    ctx.lineWidth = Math.max(0.75, Math.min(1.45, zoom * 0.28));
    ctx.stroke();

    ctx.beginPath();
    level.borders.forEach((line) => {
      if (lineInBounds(line, bounds)) drawLine(ctx, zoom, tileX, tileY, worldOffset, line, false);
    });
    ctx.strokeStyle = "rgba(89, 111, 103, 0.72)";
    ctx.lineWidth = Math.max(0.48, Math.min(1, zoom * 0.16));
    ctx.stroke();
  }

  getTileSize() {
    return L.point(TILE_SIZE, TILE_SIZE);
  }
}
