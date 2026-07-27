import type { CoordinateOrder, GeoPoint, Stripe } from "./types";
import { makeId } from "./id";
import { normalizePoint, stripeCenter, toEnu, validateStripePolygon } from "./geometry";

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

function normalizeRing(ring: Pair[], order: CoordinateOrder): Stripe["corners"] | null {
  const withoutClosing = ring.length > 3 && ring[0][0] === ring.at(-1)?.[0] && ring[0][1] === ring.at(-1)?.[1] ? ring.slice(0, -1) : ring;
  if (withoutClosing.length < 3) return null;
  const values = withoutClosing.map((pair) => pairToPoint(pair, order));
  if (values.some((point) => point === null)) return null;
  const points = values as GeoPoint[];
  if (validateStripePolygon(points).valid) return points;
  if (points.length === 4) {
    const sorted = sortClockwise(points);
    if (validateStripePolygon(sorted).valid) return sorted;
  }
  return null;
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
      .filter((ring) => ring.length >= 3);
    if (lineRings.length) return stripesFromRings(lineRings, order);
    const pairs = pairsFromText(trimmed);
    return stripesFromRings(pairs.length >= 3 ? [pairs] : [], order);
  }
}
