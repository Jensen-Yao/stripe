import type { CoordinateOrder, GeoPoint, Stripe } from "./types";
import { makeId } from "./id";
import { haversineKm, normalizePoint, stripeCenter, toEnu } from "./geometry";

type Pair = [number, number];

function pairToPoint(pair: Pair, order: CoordinateOrder): GeoPoint | null {
  const point = order === "lonlat" ? { lon: pair[0], lat: pair[1] } : { lon: pair[1], lat: pair[0] };
  if (!Number.isFinite(point.lon) || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) return null;
  return normalizePoint(point);
}

function isPair(value: unknown): value is Pair {
  return Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every((item) => typeof item === "number" && Number.isFinite(item));
}

function extractRings(value: unknown): Pair[][] {
  if (!Array.isArray(value)) return [];
  if (value.every(isPair)) return [value as Pair[]];
  return value.flatMap(extractRings);
}

function pairsFromText(text: string) {
  const values = text.replace(/[，；]/g, ",").match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const pairs: Pair[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) pairs.push([values[index], values[index + 1]]);
  return pairs;
}

function sortClockwise(points: GeoPoint[]) {
  const center = stripeCenter(points);
  return [...points].sort((a, b) => {
    const localA = toEnu(a, center);
    const localB = toEnu(b, center);
    return Math.atan2(localB.y, localB.x) - Math.atan2(localA.y, localA.x);
  });
}

function isConvex(points: GeoPoint[]) {
  const center = stripeCenter(points);
  const local = points.map((point) => toEnu(point, center));
  const signs = local.map((point, index) => {
    const next = local[(index + 1) % local.length];
    const after = local[(index + 2) % local.length];
    return Math.sign((next.x - point.x) * (after.y - next.y) - (next.y - point.y) * (after.x - next.x));
  }).filter((sign) => sign !== 0);
  return signs.length === 4 && signs.every((sign) => sign === signs[0]);
}

function normalizeRing(ring: Pair[], order: CoordinateOrder): Stripe["corners"] | null {
  const withoutClosing = ring.length > 4 && ring[0][0] === ring.at(-1)?.[0] && ring[0][1] === ring.at(-1)?.[1] ? ring.slice(0, -1) : ring;
  if (withoutClosing.length !== 4) return null;
  const values = withoutClosing.map((pair) => pairToPoint(pair, order));
  if (values.some((point) => point === null)) return null;
  const points = values as GeoPoint[];
  const unique = new Set(points.map((point) => `${point.lon.toFixed(10)},${point.lat.toFixed(10)}`));
  if (unique.size !== 4) return null;
  const sorted = sortClockwise(points);
  if (!isConvex(sorted)) return null;
  if (haversineKm(sorted[0], sorted[1]) > haversineKm(sorted[1], sorted[2])) sorted.push(sorted.shift()!);
  return sorted as Stripe["corners"];
}

function stripesFromRings(rings: Pair[][], order: CoordinateOrder) {
  const now = new Date().toISOString();
  return rings
    .map((ring) => normalizeRing(ring, order))
    .filter((corners): corners is Stripe["corners"] => Boolean(corners))
    .map((corners, index): Stripe => ({
      id: makeId("stripe"),
      name: `导入条带 ${index + 1}`,
      visible: true,
      color: "#e9693f",
      corners,
      createdAt: now,
      updatedAt: now
    }));
}

function parseKml(text: string) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  const rings = Array.from(document.querySelectorAll("coordinates")).map((node) => {
    return node.textContent
      ?.trim()
      .split(/\s+/)
      .map((coordinate) => coordinate.split(",").slice(0, 2).map(Number) as Pair)
      .filter(isPair) ?? [];
  });
  return stripesFromRings(rings, "lonlat");
}

function parseGeoJson(value: Record<string, unknown>) {
  const coordinates: unknown[] = [];
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (record.type === "FeatureCollection" && Array.isArray(record.features)) record.features.forEach(visit);
    else if (record.type === "Feature") visit(record.geometry);
    else if ((record.type === "Polygon" || record.type === "MultiPolygon") && record.coordinates) coordinates.push(record.coordinates);
  };
  visit(value);
  return stripesFromRings(coordinates.flatMap(extractRings), "lonlat");
}

export function parseStripeInput(text: string, order: CoordinateOrder) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("<")) return parseKml(trimmed);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && "type" in parsed) return parseGeoJson(parsed as Record<string, unknown>);
    return stripesFromRings(extractRings(parsed), order);
  } catch {
    const lineRings = trimmed
      .split(/\r?\n/)
      .map(pairsFromText)
      .filter((ring) => ring.length === 4 || ring.length === 5);
    if (lineRings.length) return stripesFromRings(lineRings, order);
    const pairs = pairsFromText(trimmed);
    const chunks: Pair[][] = [];
    for (let index = 0; index + 3 < pairs.length; index += 4) chunks.push(pairs.slice(index, index + 4));
    return stripesFromRings(chunks, order);
  }
}
