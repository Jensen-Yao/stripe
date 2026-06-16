import type { LatLon, ProjectedPoint } from "../types";

const RADIUS_KM = 6371.0088;
const MAX_MERCATOR_LAT = 85.05112878;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLon(lon: number) {
  let value = ((lon + 180) % 360 + 360) % 360 - 180;
  if (value === -180) value = 180;
  return Number(value.toFixed(8));
}

export function normalizeLatLon(point: LatLon): LatLon {
  return {
    lat: clamp(point.lat, -90, 90),
    lon: normalizeLon(point.lon)
  };
}

export function unwrapLongitudes(points: LatLon[]): LatLon[] {
  if (!points.length) return [];
  const unwrapped = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = unwrapped[index - 1].lon;
    let lon = points[index].lon;
    while (lon - previous > 180) lon -= 360;
    while (lon - previous < -180) lon += 360;
    unwrapped.push({ ...points[index], lon });
  }
  return unwrapped;
}

export function project(point: LatLon): ProjectedPoint {
  const lat = clamp(point.lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: point.lon,
    y: (0.5 * Math.log((1 + sin) / (1 - sin)) * 180) / Math.PI
  };
}

export function unproject(point: ProjectedPoint): LatLon {
  const lat = (Math.atan(Math.sinh((point.y * Math.PI) / 180)) * 180) / Math.PI;
  return normalizeLatLon({ lat, lon: point.x });
}

export function centroid(points: ProjectedPoint[]): ProjectedPoint {
  if (!points.length) return { x: 0, y: 0 };
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 }
  );
  return { x: sum.x / points.length, y: sum.y / points.length };
}

export function rotatePoints(points: ProjectedPoint[], angleDeg: number, pivot = centroid(points)) {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((point) => {
    const dx = point.x - pivot.x;
    const dy = point.y - pivot.y;
    return {
      x: pivot.x + dx * cos - dy * sin,
      y: pivot.y + dx * sin + dy * cos
    };
  });
}

export function scalePoints(
  points: ProjectedPoint[],
  scaleX: number,
  scaleY: number,
  pivot = centroid(points)
) {
  return points.map((point) => ({
    x: pivot.x + (point.x - pivot.x) * scaleX,
    y: pivot.y + (point.y - pivot.y) * scaleY
  }));
}

export function translatePoints(points: ProjectedPoint[], delta: ProjectedPoint) {
  return points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
}

export function splitDateLinePath(points: LatLon[], close = false): LatLon[][] {
  const input = close && points.length ? [...points, points[0]] : [...points];
  if (input.length < 2) return [input];
  const segments: LatLon[][] = [[normalizeLatLon(input[0])]];
  for (let index = 1; index < input.length; index += 1) {
    const previous = input[index - 1];
    const current = input[index];
    const delta = current.lon - previous.lon;
    if (Math.abs(delta) > 180) {
      const crossingLon = delta > 0 ? -180 : 180;
      const oppositeLon = delta > 0 ? 180 : -180;
      const adjustedCurrentLon = delta > 0 ? current.lon - 360 : current.lon + 360;
      const ratio = (crossingLon - previous.lon) / (adjustedCurrentLon - previous.lon);
      const crossingLat = previous.lat + (current.lat - previous.lat) * ratio;
      segments[segments.length - 1].push({ lon: crossingLon, lat: crossingLat });
      segments.push([{ lon: oppositeLon, lat: crossingLat }, normalizeLatLon(current)]);
    } else {
      segments[segments.length - 1].push(normalizeLatLon(current));
    }
  }
  return segments;
}

export function haversineKm(a: LatLon, b: LatLon) {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = ((b.lat - a.lat) * Math.PI) / 180;
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * RADIUS_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function destinationPoint(start: LatLon, bearingDeg: number, distanceKm: number): LatLon {
  const angularDistance = distanceKm / RADIUS_KM;
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (start.lat * Math.PI) / 180;
  const lon1 = (start.lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );
  return normalizeLatLon({ lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI });
}

export function coverageRadiusKm(heightKm: number, halfConeDeg: number) {
  const alpha = clamp(halfConeDeg, 0, 89.999) * (Math.PI / 180);
  const horizonAngle = Math.acos(RADIUS_KM / (RADIUS_KM + Math.max(0, heightKm)));
  const centralAngle = Math.min(Math.asin(((RADIUS_KM + heightKm) / RADIUS_KM) * Math.sin(alpha)) - alpha, horizonAngle);
  return Math.max(0, centralAngle * RADIUS_KM);
}

export function coverageCircle(center: LatLon, radiusKm: number, steps = 96): LatLon[] {
  return Array.from({ length: steps + 1 }, (_value, index) =>
    destinationPoint(center, (index / steps) * 360, radiusKm)
  );
}

export function coordinatesForOutput(points: LatLon[], order: "lonlat" | "latlon") {
  return points.map((point) => {
    const normalized = normalizeLatLon(point);
    const lon = Number(normalized.lon.toFixed(6));
    const lat = Number(normalized.lat.toFixed(6));
    return order === "lonlat" ? [lon, lat] : [lat, lon];
  });
}
