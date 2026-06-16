import type { LatLon, PlannerDraft, ProjectedPoint, Stripe, StripeMetrics, StripeOverlapAnalysis, StripeOverlapRelation } from "../types";

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

export function bearingDeg(a: LatLon, b: LatLon) {
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const deltaLambda = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  return normalizeBearing((Math.atan2(y, x) * 180) / Math.PI);
}

export function normalizeBearing(value: number) {
  return ((value % 360) + 360) % 360;
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

export function buildStripeCorners(draft: PlannerDraft): LatLon[] {
  const center = normalizeLatLon({ lat: draft.centerLat, lon: draft.centerLon });
  const halfLength = Math.max(0.1, draft.lengthKm) / 2;
  const halfWidth = Math.max(0.1, draft.widthKm) / 2;
  const heading = normalizeBearing(draft.headingDeg);
  const front = destinationPoint(center, heading, halfLength);
  const back = destinationPoint(center, heading + 180, halfLength);
  return [
    destinationPoint(front, heading - 90, halfWidth),
    destinationPoint(front, heading + 90, halfWidth),
    destinationPoint(back, heading + 90, halfWidth),
    destinationPoint(back, heading - 90, halfWidth)
  ];
}

export function measureStripe(points: LatLon[]): StripeMetrics | null {
  if (points.length < 4) return null;
  const unwrapped = unwrapLongitudes(points);
  const projected = unwrapped.map(project);
  const center = unproject(centroid(projected));
  const lengthA = haversineKm(points[0], points[3]);
  const lengthB = haversineKm(points[1], points[2]);
  const widthA = haversineKm(points[0], points[1]);
  const widthB = haversineKm(points[3], points[2]);
  const frontMid = unproject({
    x: (projected[0].x + projected[1].x) / 2,
    y: (projected[0].y + projected[1].y) / 2
  });
  const backMid = unproject({
    x: (projected[2].x + projected[3].x) / 2,
    y: (projected[2].y + projected[3].y) / 2
  });
  const lengthKm = (lengthA + lengthB) / 2;
  const widthKm = (widthA + widthB) / 2;
  return {
    center,
    lengthKm,
    widthKm,
    areaKm2: lengthKm * widthKm,
    headingDeg: bearingDeg(backMid, frontMid)
  };
}

export function pointInPolygon(point: LatLon, polygon: LatLon[]) {
  if (polygon.length < 3) return false;
  const projectedPoint = project(point);
  const projectedPolygon = unwrapLongitudes(polygon).map(project);
  let inside = false;
  for (let index = 0, previous = projectedPolygon.length - 1; index < projectedPolygon.length; previous = index++) {
    const currentPoint = projectedPolygon[index];
    const previousPoint = projectedPolygon[previous];
    const intersects =
      currentPoint.y > projectedPoint.y !== previousPoint.y > projectedPoint.y &&
      projectedPoint.x <
        ((previousPoint.x - currentPoint.x) * (projectedPoint.y - currentPoint.y)) /
          (previousPoint.y - currentPoint.y || Number.EPSILON) +
          currentPoint.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function stripeSampleGrid(stripe: Stripe, spacingKm: number) {
  const metrics = measureStripe(stripe.corners);
  if (!metrics) return [];
  const projected = unwrapLongitudes(stripe.corners).map(project);
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const latStep = Math.max(0.03, spacingKm / 111);
  const lonStep = Math.max(0.03, spacingKm / Math.max(18, 111 * Math.cos((metrics.center.lat * Math.PI) / 180)));
  const samples: LatLon[] = [];
  for (let y = minY; y <= maxY; y += latStep) {
    for (let x = minX; x <= maxX; x += lonStep) {
      const point = unproject({ x, y });
      if (pointInPolygon(point, stripe.corners)) samples.push(point);
      if (samples.length > 1600) return samples;
    }
  }
  return samples.length ? samples : [metrics.center];
}

function overlapRelation(percentA: number, percentB: number, overlapAreaKm2: number): StripeOverlapRelation {
  if (overlapAreaKm2 <= 0.0001 || (percentA < 1 && percentB < 1)) return "separate";
  if (percentA >= 96 && percentB >= 96) return "same";
  if (percentB >= 96) return "a_contains_b";
  if (percentA >= 96) return "b_contains_a";
  return "overlap";
}

export function analyzeStripeOverlap(a: Stripe, b: Stripe, spacingKm = 15): StripeOverlapAnalysis | null {
  const metricsA = measureStripe(a.corners);
  const metricsB = measureStripe(b.corners);
  if (!metricsA || !metricsB) return null;
  const samplesA = stripeSampleGrid(a, spacingKm);
  const samplesB = stripeSampleGrid(b, spacingKm);
  const insideA = samplesB.filter((point) => pointInPolygon(point, a.corners)).length;
  const insideB = samplesA.filter((point) => pointInPolygon(point, b.corners)).length;
  const overlapPercentOfA = samplesA.length ? (insideB / samplesA.length) * 100 : 0;
  const overlapPercentOfB = samplesB.length ? (insideA / samplesB.length) * 100 : 0;
  const overlapAreaKm2 = Math.min(
    metricsA.areaKm2 * (overlapPercentOfA / 100),
    metricsB.areaKm2 * (overlapPercentOfB / 100)
  );
  return {
    id: `${a.id}-${b.id}`,
    stripeAId: a.id,
    stripeBId: b.id,
    stripeAName: a.name ?? a.id,
    stripeBName: b.name ?? b.id,
    relation: overlapRelation(overlapPercentOfA, overlapPercentOfB, overlapAreaKm2),
    overlapAreaKm2,
    overlapPercentOfA,
    overlapPercentOfB,
    areaAKm2: metricsA.areaKm2,
    areaBKm2: metricsB.areaKm2
  };
}

export function analyzeStripeOverlaps(stripes: Stripe[], spacingKm = 15) {
  const visibleStripes = stripes.filter((stripe) => stripe.visible !== false && stripe.corners.length >= 4);
  const results: StripeOverlapAnalysis[] = [];
  for (let aIndex = 0; aIndex < visibleStripes.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < visibleStripes.length; bIndex += 1) {
      const result = analyzeStripeOverlap(visibleStripes[aIndex], visibleStripes[bIndex], spacingKm);
      if (result && result.relation !== "separate") results.push(result);
    }
  }
  return results.sort((a, b) => b.overlapAreaKm2 - a.overlapAreaKm2);
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
