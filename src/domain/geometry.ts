import polygonClipping, { type MultiPolygon, type Pair } from "polygon-clipping";
import RBush from "rbush";
import { Geodesic } from "geographiclib-geodesic";
import type { GeoPoint, Stripe, StripeOverlap } from "./types";

const WGS84_A_KM = 6378.137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const MEAN_EARTH_RADIUS_KM = 6371.0088;

type Vec3 = { x: number; y: number; z: number };
type Vec2 = { x: number; y: number };

export function normalizeLon(lon: number) {
  const value = ((lon + 180) % 360 + 360) % 360 - 180;
  return value === -180 ? 180 : value;
}

export function clampLat(lat: number) {
  return Math.max(-90, Math.min(90, lat));
}

export function normalizePoint(point: GeoPoint): GeoPoint {
  return { lon: normalizeLon(point.lon), lat: clampLat(point.lat), heightKm: point.heightKm ?? 0 };
}

export function geodeticToEcef(point: GeoPoint): Vec3 {
  const lat = (point.lat * Math.PI) / 180;
  const lon = (point.lon * Math.PI) / 180;
  const height = point.heightKm ?? 0;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const radius = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (radius + height) * cosLat * Math.cos(lon),
    y: (radius + height) * cosLat * Math.sin(lon),
    z: (radius * (1 - WGS84_E2) + height) * sinLat
  };
}

export function ecefToGeodetic(vector: Vec3): GeoPoint {
  const lon = Math.atan2(vector.y, vector.x);
  const p = Math.hypot(vector.x, vector.y);
  let lat = Math.atan2(vector.z, p * (1 - WGS84_E2));
  let height = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sinLat = Math.sin(lat);
    const radius = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    height = p / Math.max(1e-12, Math.cos(lat)) - radius;
    lat = Math.atan2(vector.z, p * (1 - (WGS84_E2 * radius) / (radius + height)));
  }
  return normalizePoint({ lon: (lon * 180) / Math.PI, lat: (lat * 180) / Math.PI, heightKm: height });
}

function enuBasis(origin: GeoPoint) {
  const lat = (origin.lat * Math.PI) / 180;
  const lon = (origin.lon * Math.PI) / 180;
  return {
    east: { x: -Math.sin(lon), y: Math.cos(lon), z: 0 },
    north: {
      x: -Math.sin(lat) * Math.cos(lon),
      y: -Math.sin(lat) * Math.sin(lon),
      z: Math.cos(lat)
    },
    up: { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) }
  };
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function toEnu(point: GeoPoint, origin: GeoPoint): Vec3 {
  const inverse = Geodesic.WGS84.Inverse(origin.lat, origin.lon, point.lat, point.lon);
  const distanceKm = (inverse.s12 ?? 0) / 1000;
  const azimuth = ((inverse.azi1 ?? 0) * Math.PI) / 180;
  return {
    x: Math.sin(azimuth) * distanceKm,
    y: Math.cos(azimuth) * distanceKm,
    z: (point.heightKm ?? 0) - (origin.heightKm ?? 0)
  };
}

export function fromEnu(offset: Vec3, origin: GeoPoint): GeoPoint {
  const distanceKm = Math.hypot(offset.x, offset.y);
  if (distanceKm < 1e-12) return normalizePoint({ ...origin, heightKm: (origin.heightKm ?? 0) + offset.z });
  const azimuth = (Math.atan2(offset.x, offset.y) * 180) / Math.PI;
  const direct = Geodesic.WGS84.Direct(origin.lat, origin.lon, azimuth, distanceKm * 1000);
  return normalizePoint({
    lon: direct.lon2 ?? origin.lon,
    lat: direct.lat2 ?? origin.lat,
    heightKm: (origin.heightKm ?? 0) + offset.z
  });
}

export function stripeCenter(corners: readonly GeoPoint[]) {
  const ecef = corners.map(geodeticToEcef);
  const average = ecef.reduce(
    (sum, point) => ({ x: sum.x + point.x / ecef.length, y: sum.y + point.y / ecef.length, z: sum.z + point.z / ecef.length }),
    { x: 0, y: 0, z: 0 }
  );
  const center = ecefToGeodetic(average);
  return { ...center, heightKm: corners.reduce((sum, point) => sum + (point.heightKm ?? 0), 0) / corners.length };
}

export function stripeFromParameters(center: GeoPoint, lengthKm: number, widthKm: number, headingDeg: number) {
  const heading = (headingDeg * Math.PI) / 180;
  const halfLength = Math.max(0.001, lengthKm) / 2;
  const halfWidth = Math.max(0.001, widthKm) / 2;
  const forward = { x: Math.sin(heading), y: Math.cos(heading) };
  const right = { x: Math.cos(heading), y: -Math.sin(heading) };
  const local: Vec2[] = [
    { x: forward.x * halfLength - right.x * halfWidth, y: forward.y * halfLength - right.y * halfWidth },
    { x: forward.x * halfLength + right.x * halfWidth, y: forward.y * halfLength + right.y * halfWidth },
    { x: -forward.x * halfLength + right.x * halfWidth, y: -forward.y * halfLength + right.y * halfWidth },
    { x: -forward.x * halfLength - right.x * halfWidth, y: -forward.y * halfLength - right.y * halfWidth }
  ];
  return local.map((point) => ({ ...fromEnu({ x: point.x, y: point.y, z: 0 }, center), heightKm: center.heightKm ?? 0 })) as Stripe["corners"];
}

export function transformStripe(
  corners: Stripe["corners"],
  transform: { translateEastKm?: number; translateNorthKm?: number; rotationDeg?: number; scaleX?: number; scaleY?: number }
) {
  const center = stripeCenter(corners);
  const angle = ((transform.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scaleX = transform.scaleX ?? 1;
  const scaleY = transform.scaleY ?? 1;
  return corners.map((corner) => {
    const local = toEnu(corner, center);
    const scaledX = local.x * scaleX;
    const scaledY = local.y * scaleY;
    return { ...fromEnu(
      {
        x: scaledX * cos - scaledY * sin + (transform.translateEastKm ?? 0),
        y: scaledX * sin + scaledY * cos + (transform.translateNorthKm ?? 0),
        z: local.z
      },
      center
    ), heightKm: corner.heightKm ?? 0 };
  }) as Stripe["corners"];
}

export function scaleStripeAxes(corners: Stripe["corners"], lengthFactor: number, widthFactor: number) {
  const center = stripeCenter(corners);
  const local = corners.map((corner) => toEnu(corner, center));
  const front = { x: (local[0].x + local[1].x) / 2, y: (local[0].y + local[1].y) / 2 };
  const back = { x: (local[2].x + local[3].x) / 2, y: (local[2].y + local[3].y) / 2 };
  const length = Math.max(1e-9, Math.hypot(front.x - back.x, front.y - back.y));
  const along = { x: (front.x - back.x) / length, y: (front.y - back.y) / length };
  const across = { x: along.y, y: -along.x };
  return local.map((point) => {
    const alongDistance = point.x * along.x + point.y * along.y;
    const acrossDistance = point.x * across.x + point.y * across.y;
    return { ...fromEnu(
      {
        x: along.x * alongDistance * lengthFactor + across.x * acrossDistance * widthFactor,
        y: along.y * alongDistance * lengthFactor + across.y * acrossDistance * widthFactor,
        z: point.z
      },
      center
    ), heightKm: corners[0].heightKm ?? 0 };
  }) as Stripe["corners"];
}

export function haversineKm(a: GeoPoint, b: GeoPoint) {
  return (Geodesic.WGS84.Inverse(a.lat, a.lon, b.lat, b.lon).s12 ?? 0) / 1000;
}

export function bearingDeg(a: GeoPoint, b: GeoPoint) {
  return ((Geodesic.WGS84.Inverse(a.lat, a.lon, b.lat, b.lon).azi1 ?? 0) + 360) % 360;
}

function laea(point: GeoPoint, origin: GeoPoint): Vec2 {
  const lat = (point.lat * Math.PI) / 180;
  const lon = (point.lon * Math.PI) / 180;
  const lat0 = (origin.lat * Math.PI) / 180;
  const lon0 = (origin.lon * Math.PI) / 180;
  const dLon = ((lon - lon0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const denominator = 1 + Math.sin(lat0) * Math.sin(lat) + Math.cos(lat0) * Math.cos(lat) * Math.cos(dLon);
  const k = Math.sqrt(2 / Math.max(1e-12, denominator));
  return {
    x: MEAN_EARTH_RADIUS_KM * k * Math.cos(lat) * Math.sin(dLon),
    y: MEAN_EARTH_RADIUS_KM * k * (Math.cos(lat0) * Math.sin(lat) - Math.sin(lat0) * Math.cos(lat) * Math.cos(dLon))
  };
}

function ringArea(ring: readonly number[][][][]) {
  return ring.reduce((total, polygon) => {
    return total + polygon.reduce((polygonArea, line, ringIndex) => {
      let area = 0;
      for (let index = 0; index < line.length; index += 1) {
        const current = line[index];
        const next = line[(index + 1) % line.length];
        area += current[0] * next[1] - next[0] * current[1];
      }
      const absolute = Math.abs(area) / 2;
      return polygonArea + (ringIndex === 0 ? absolute : -absolute);
    }, 0);
  }, 0);
}

export function stripeMetrics(corners: Stripe["corners"]) {
  const center = stripeCenter(corners);
  const projected = corners.map((corner) => laea(corner, center));
  const polygon = [[projected.map((point) => [point.x, point.y])]];
  const edgeA = (haversineKm(corners[0], corners[1]) + haversineKm(corners[2], corners[3])) / 2;
  const edgeB = (haversineKm(corners[1], corners[2]) + haversineKm(corners[3], corners[0])) / 2;
  const lengthAlongB = edgeB >= edgeA;
  const frontPair = lengthAlongB ? [corners[0], corners[1]] : [corners[1], corners[2]];
  const backPair = lengthAlongB ? [corners[2], corners[3]] : [corners[3], corners[0]];
  const front = stripeCenter(frontPair);
  const back = stripeCenter(backPair);
  return {
    center,
    lengthKm: Math.max(edgeA, edgeB),
    widthKm: Math.min(edgeA, edgeB),
    areaKm2: ringArea(polygon),
    headingDeg: bearingDeg(back, front)
  };
}

type StripeIndexItem = { minX: number; minY: number; maxX: number; maxY: number; stripe: Stripe };

function stripeBounds(stripe: Stripe): StripeIndexItem[] {
  const lons = stripe.corners.map((point) => normalizeLon(point.lon));
  const lats = stripe.corners.map((point) => point.lat);
  const minY = Math.min(...lats);
  const maxY = Math.max(...lats);
  const minX = Math.min(...lons);
  const maxX = Math.max(...lons);
  if (maxX - minX <= 180) return [{ minX, minY, maxX, maxY, stripe }];
  const positive = lons.map((lon) => (lon < 0 ? lon + 360 : lon));
  return [
    { minX: Math.min(...positive), minY, maxX: 360, maxY, stripe },
    { minX: -180, minY, maxX: Math.max(...lons.filter((lon) => lon < 0), -180), maxY, stripe }
  ];
}

export function analyzeStripePair(a: Stripe, b: Stripe): StripeOverlap | null {
  const center = stripeCenter([...a.corners, ...b.corners]);
  const ringA: Pair[] = a.corners.map((point) => laea(point, center)).map((point) => [point.x, point.y]);
  const ringB: Pair[] = b.corners.map((point) => laea(point, center)).map((point) => [point.x, point.y]);
  const polygonA: MultiPolygon = [[ringA]];
  const polygonB: MultiPolygon = [[ringB]];
  const areaA = ringArea(polygonA);
  const areaB = ringArea(polygonB);
  const clipped = polygonClipping.intersection(polygonA, polygonB);
  const overlapAreaKm2 = ringArea(clipped);
  if (overlapAreaKm2 <= 1e-8 || areaA <= 0 || areaB <= 0) return null;
  const overlapPercentOfA = (overlapAreaKm2 / areaA) * 100;
  const overlapPercentOfB = (overlapAreaKm2 / areaB) * 100;
  const sameA = overlapPercentOfA >= 99.999;
  const sameB = overlapPercentOfB >= 99.999;
  return {
    id: [a.id, b.id].sort().join(":"),
    stripeAId: a.id,
    stripeBId: b.id,
    relation: sameA && sameB ? "same" : sameB ? "a_contains_b" : sameA ? "b_contains_a" : "overlap",
    overlapAreaKm2,
    overlapPercentOfA,
    overlapPercentOfB
  };
}

export function analyzeStripeOverlaps(stripes: readonly Stripe[]) {
  const tree = new RBush<StripeIndexItem>();
  const candidates = stripes.filter((stripe) => stripe.visible).flatMap(stripeBounds);
  tree.load(candidates);
  const seen = new Set<string>();
  const overlaps: StripeOverlap[] = [];
  for (const item of candidates) {
    for (const other of tree.search(item)) {
      if (item.stripe.id === other.stripe.id) continue;
      const key = [item.stripe.id, other.stripe.id].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      const overlap = analyzeStripePair(item.stripe, other.stripe);
      if (overlap) overlaps.push(overlap);
    }
  }
  return overlaps.sort((a, b) => b.overlapAreaKm2 - a.overlapAreaKm2);
}

export function coordinatesForOutput(corners: readonly GeoPoint[], order: "lonlat" | "latlon") {
  return corners.map((point) => {
    const lon = Number(normalizeLon(point.lon).toFixed(8));
    const lat = Number(clampLat(point.lat).toFixed(8));
    return order === "lonlat" ? [lon, lat] : [lat, lon];
  });
}
