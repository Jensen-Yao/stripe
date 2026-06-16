import L from "leaflet";
import { feature, mesh } from "topojson-client";
import countries110m from "world-atlas/countries-110m.json";

type LonLat = [number, number];
type Ring = LonLat[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];
type Line = LonLat[];
type MultiLine = Line[];
type BoundsBox = {
  west: number;
  south: number;
  east: number;
  north: number;
};
type LandShape = {
  rings: Polygon;
  bbox: BoundsBox;
};
type LineShape = {
  points: Line;
  bbox: BoundsBox;
};
type Topology = {
  objects: {
    countries: unknown;
  };
};

type MapLevel = {
  land: LandShape[];
  borders: LineShape[];
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
    land: topoLand(topology).map((rings) => ({ rings, bbox: polygonBounds(rings) })),
    borders: topoBorders(topology).map((points) => ({ points, bbox: pointsBounds(points) }))
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

function pointsBounds(points: Ring | Line): BoundsBox {
  return points.reduce<BoundsBox>(
    (bbox, [lon, lat]) => ({
      west: Math.min(bbox.west, lon),
      south: Math.min(bbox.south, lat),
      east: Math.max(bbox.east, lon),
      north: Math.max(bbox.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
}

function polygonBounds(polygon: Polygon): BoundsBox {
  return polygon.reduce<BoundsBox>((bbox, ring) => {
    const ringBounds = pointsBounds(ring);
    return {
      west: Math.min(bbox.west, ringBounds.west),
      south: Math.min(bbox.south, ringBounds.south),
      east: Math.max(bbox.east, ringBounds.east),
      north: Math.max(bbox.north, ringBounds.north)
    };
  }, { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
}

function crossesDateLine(points: Ring | Line) {
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index][0] - points[index - 1][0]) > 180) return true;
  }
  return false;
}

function bboxOverlaps(a: BoundsBox, b: BoundsBox) {
  return a.east >= b.west && a.west <= b.east && a.north >= b.south && a.south <= b.north;
}

function pointInBounds([lon, lat]: LonLat, bounds: BoundsBox) {
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

function orientation(a: LonLat, b: LonLat, c: LonLat) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: LonLat, b: LonLat, c: LonLat, d: LonLat) {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  return abC * abD <= 0 && cdA * cdB <= 0;
}

function segmentIntersectsBounds(a: LonLat, b: LonLat, bounds: BoundsBox) {
  if (Math.abs(a[0] - b[0]) > 180) return false;
  if (pointInBounds(a, bounds) || pointInBounds(b, bounds)) return true;
  const segmentBox = pointsBounds([a, b]);
  if (!bboxOverlaps(segmentBox, bounds)) return false;
  const southWest: LonLat = [bounds.west, bounds.south];
  const southEast: LonLat = [bounds.east, bounds.south];
  const northEast: LonLat = [bounds.east, bounds.north];
  const northWest: LonLat = [bounds.west, bounds.north];
  return (
    segmentsIntersect(a, b, southWest, southEast) ||
    segmentsIntersect(a, b, southEast, northEast) ||
    segmentsIntersect(a, b, northEast, northWest) ||
    segmentsIntersect(a, b, northWest, southWest)
  );
}

function lineIntersectsBounds(points: Ring | Line, bounds: BoundsBox, close = false) {
  if (points.some((point) => pointInBounds(point, bounds))) return true;
  const count = close ? points.length : points.length - 1;
  for (let index = 0; index < count; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (segmentIntersectsBounds(current, next, bounds)) return true;
  }
  return crossesDateLine(points);
}

function pointInRing(point: LonLat, ring: Ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const before = ring[previous];
    const intersects =
      current[1] > point[1] !== before[1] > point[1] &&
      point[0] < ((before[0] - current[0]) * (point[1] - current[1])) / (before[1] - current[1] || Number.EPSILON) + current[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(point: LonLat, polygon: Polygon) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return polygon.slice(1).every((hole) => !pointInRing(point, hole));
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
    const paddedBounds = L.latLngBounds([south, west], [north, east]).pad(0.06);
    const bounds: BoundsBox = {
      west: paddedBounds.getWest(),
      south: paddedBounds.getSouth(),
      east: paddedBounds.getEast(),
      north: paddedBounds.getNorth()
    };
    const landProbePoints: LonLat[] = [
      [(west + east) / 2, (south + north) / 2],
      [west, south],
      [west, north],
      [east, south],
      [east, north]
    ];

    ctx.beginPath();
    let hasLandPath = false;
    let fillTileAsLand = false;
    level.land.forEach((polygon) => {
      if (!bboxOverlaps(polygon.bbox, bounds)) return;
      const hasBoundaryInTile = polygon.rings.some((ring) => lineIntersectsBounds(ring, bounds, true));
      if (hasBoundaryInTile) {
        polygon.rings.forEach((ring) => drawLine(ctx, zoom, tileX, tileY, worldOffset, ring, true));
        hasLandPath = true;
      } else if (landProbePoints.some((point) => polygonContainsPoint(point, polygon.rings))) {
        fillTileAsLand = true;
      }
    });
    if (fillTileAsLand) {
      ctx.fillStyle = "#d9cf78";
      ctx.fillRect(0, 0, tileSize.x, tileSize.y);
    }
    if (hasLandPath) {
      ctx.fillStyle = "#d9cf78";
      ctx.fill("evenodd");
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = "#6e857b";
      ctx.lineWidth = Math.max(0.75, Math.min(1.45, zoom * 0.28));
      ctx.stroke();
    }

    ctx.beginPath();
    let hasBorderPath = false;
    level.borders.forEach((line) => {
      if (!bboxOverlaps(line.bbox, bounds)) return;
      if (lineIntersectsBounds(line.points, bounds)) {
        drawLine(ctx, zoom, tileX, tileY, worldOffset, line.points, false);
        hasBorderPath = true;
      }
    });
    if (hasBorderPath) {
      ctx.strokeStyle = "rgba(89, 111, 103, 0.72)";
      ctx.lineWidth = Math.max(0.48, Math.min(1, zoom * 0.16));
      ctx.stroke();
    }
  }

  getTileSize() {
    return L.point(TILE_SIZE, TILE_SIZE);
  }
}
