import type { CoordinateOrder, LatLon, Stripe } from "../types";
import { normalizeLatLon } from "./geo";
import { makeId } from "./tle";

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

function pairToLatLon(pair: [number, number], order: CoordinateOrder): LatLon {
  const lon = order === "lonlat" ? pair[0] : pair[1];
  const lat = order === "lonlat" ? pair[1] : pair[0];
  return normalizeLatLon({ lat, lon });
}

function extractRings(value: unknown): [number, number][][] {
  if (!Array.isArray(value)) return [];
  if (value.every(isNumberPair)) return [value as [number, number][]];
  return value.flatMap((item) => extractRings(item));
}

function normalizeText(text: string) {
  return text
    .replace(/，/g, ",")
    .replace(/；/g, ";")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/：/g, ":");
}

function parseJsonLike(text: string) {
  const normalized = normalizeText(text);
  try {
    return JSON.parse(normalized);
  } catch {
    const wrapped = `[${normalized
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(",")}]`;
    return JSON.parse(wrapped);
  }
}

function pairsFromText(text: string): [number, number][] {
  const numbers = normalizeText(text).match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    pairs.push([numbers[index], numbers[index + 1]]);
  }
  return pairs;
}

function stripClosingPoint(points: [number, number][]) {
  if (points.length < 5) return points;
  const first = points[0];
  const last = points[points.length - 1];
  return Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9
    ? points.slice(0, -1)
    : points;
}

function ringChunks(points: [number, number][]) {
  const normalized = stripClosingPoint(points);
  if (normalized.length < 4) return [];
  if (normalized.length === 4) return [normalized];
  if (normalized.length % 4 === 0) {
    const chunks: [number, number][][] = [];
    for (let index = 0; index < normalized.length; index += 4) {
      chunks.push(normalized.slice(index, index + 4));
    }
    return chunks;
  }
  return [normalized.slice(0, 4)];
}

function parseNumericText(text: string): [number, number][][] {
  const rings: [number, number][][] = [];
  const lines = normalizeText(text)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  lines.forEach((line) => {
    const linePairs = pairsFromText(line);
    if (linePairs.length >= 4) rings.push(...ringChunks(linePairs));
  });
  if (rings.length > 1) return rings;

  return normalizeText(text)
    .split(/\n\s*\n+/)
    .flatMap((block) => ringChunks(pairsFromText(block)));
}

export function parseStripeText(text: string, order: CoordinateOrder): Stripe[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let rings: [number, number][][] = [];
  const numericRings = parseNumericText(trimmed);
  if (numericRings.length > 1) {
    rings = numericRings;
  } else {
    try {
      rings = extractRings(parseJsonLike(trimmed));
    } catch {
      rings = numericRings;
    }
  }
  const now = new Date().toISOString();
  const seen = new Set<string>();
  return rings
    .map((ring) => ring.slice(0, 4).map((pair) => pairToLatLon(pair, order)))
    .filter((corners) => corners.length === 4)
    .filter((corners) => {
      const key = JSON.stringify(corners.map((point) => [point.lon.toFixed(6), point.lat.toFixed(6)]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((corners, index) => ({
      id: makeId("stripe"),
      name: `导入条带 ${index + 1}`,
      corners,
      visible: true,
      createdAt: now,
      updatedAt: now
    }));
}
