import { analyzeStripeOverlaps, stripeMetrics } from "../domain/geometry";
import { isGroundPointInSensorFov, orbitHeadingAtIndex, sensorMaxGroundRangeKm } from "../domain/sensorFov";
import { cellArea, cellToLatLng, latLngToCell, polygonToCells } from "h3-js";
import RBush from "rbush";
import type { OrbitSample, Sensor, Stripe } from "../domain/types";

type Request =
  | { id: number; type: "overlap"; stripes: Stripe[] }
  | { id: number; type: "coverage"; stripe: Stripe; samples: OrbitSample[]; sensor: Sensor; resolution: number; maxCells: number };

function coverage(request: Extract<Request, { type: "coverage" }>) {
  const metrics = stripeMetrics(request.stripe.corners);
  const sampleCell = latLngToCell(metrics.center.lat, metrics.center.lon, request.resolution);
  const estimatedCells = Math.ceil(metrics.areaKm2 / Math.max(1e-12, cellArea(sampleCell, "km2")));
  if (estimatedCells > request.maxCells) return { ok: false, reason: "too-many", estimatedCells };
  const ring = [...request.stripe.corners.map((point) => [point.lon, point.lat]), [request.stripe.corners[0].lon, request.stripe.corners[0].lat]];
  const cells = polygonToCells([ring], request.resolution, true);
  if (cells.length > request.maxCells) return { ok: false, reason: "too-many", estimatedCells: cells.length };
  const centers = cells.map((cell) => {
    const [lat, lon] = cellToLatLng(cell);
    return { cell, lat, lon, minX: lon, minY: lat, maxX: lon, maxY: lat, count: 0, firstTime: undefined as string | undefined, times: [] as number[] };
  });
  const index = new RBush<(typeof centers)[number]>();
  index.load(centers);
  let horizonClipped = false;
  for (let sampleIndex = 0; sampleIndex < request.samples.length; sampleIndex += 1) {
    const sample = request.samples[sampleIndex];
    const footprint = sensorMaxGroundRangeKm(sample.heightKm, request.sensor);
    const radius = footprint.radiusKm;
    const headingDeg = orbitHeadingAtIndex(request.samples, sampleIndex);
    horizonClipped ||= footprint.horizonClipped;
    if (radius <= 0) continue;
    const time = new Date(sample.time).getTime();
    const latDelta = radius / 110.574 + 0.05;
    const lonScale = Math.max(0.01, Math.cos(sample.lat * Math.PI / 180));
    const lonDelta = Math.min(180, radius / (111.32 * lonScale) + 0.05);
    const south = Math.max(-90, sample.lat - latDelta);
    const north = Math.min(90, sample.lat + latDelta);
    const west = sample.lon - lonDelta;
    const east = sample.lon + lonDelta;
    const candidates = lonDelta >= 180
      ? index.search({ minX: -180, minY: south, maxX: 180, maxY: north })
      : west < -180
        ? [...index.search({ minX: west + 360, minY: south, maxX: 180, maxY: north }), ...index.search({ minX: -180, minY: south, maxX: east, maxY: north })]
        : east > 180
          ? [...index.search({ minX: west, minY: south, maxX: 180, maxY: north }), ...index.search({ minX: -180, minY: south, maxX: east - 360, maxY: north })]
          : index.search({ minX: west, minY: south, maxX: east, maxY: north });
    for (const center of candidates) {
      if (isGroundPointInSensorFov(sample, center, request.sensor, headingDeg)) {
        center.count += 1;
        center.firstTime ??= sample.time;
        center.times.push(time);
      }
    }
  }
  const covered = centers.filter((center) => center.count > 0);
  const revisitGaps: number[] = [];
  for (const center of covered) {
    for (let index = 1; index < center.times.length; index += 1) {
      const gap = center.times[index] - center.times[index - 1];
      if (gap > 120000) revisitGaps.push(gap / 60000);
    }
  }
  return {
    ok: true,
    cells,
    coveredCells: covered.map((center) => center.cell),
    horizonClipped,
    result: {
      id: `coverage-${request.stripe.id}-${Date.now()}`,
      sourceId: request.stripe.id,
      coveragePercent: cells.length ? covered.length / cells.length * 100 : 0,
      firstCoverageTime: covered.map((center) => center.firstTime).filter(Boolean).sort()[0],
      revisitMinutes: revisitGaps.length ? revisitGaps.reduce((sum, value) => sum + value, 0) / revisitGaps.length : undefined,
      coveredCellCount: covered.length,
      totalCellCount: cells.length
    }
  };
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if (request.type === "overlap") self.postMessage({ id: request.id, ok: true, overlaps: analyzeStripeOverlaps(request.stripes) });
    else self.postMessage({ id: request.id, ...coverage(request) });
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
