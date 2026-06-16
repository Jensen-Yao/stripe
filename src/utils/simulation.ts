import { degreesToRadians, ecfToLookAngles } from "satellite.js";
import type {
  AccessSample,
  AccessWindow,
  CoverageGrid,
  CoverageGridPoint,
  GroundTarget,
  LatLon,
  SatelliteTle,
  ScenarioSettings,
  SimulationResult,
  Stripe
} from "../types";
import {
  coverageRadiusKm,
  haversineKm,
  measureStripe,
  pointInPolygon,
  project,
  unproject,
  unwrapLongitudes
} from "./geo";
import { makeId, sampleAt } from "./tle";

function clampDateRange(scenario: ScenarioSettings) {
  const start = new Date(scenario.startTime);
  const end = new Date(scenario.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    const now = new Date(scenario.currentTime);
    return {
      start: new Date(now.getTime() - 45 * 60_000),
      end: new Date(now.getTime() + 45 * 60_000)
    };
  }
  return { start, end };
}

export function computeAccessSample(
  tle: SatelliteTle,
  target: GroundTarget,
  date: Date
): AccessSample | null {
  const orbit = sampleAt(tle, date);
  if (!orbit?.ecfKm) return null;
  const lookAngles = ecfToLookAngles(
    {
      latitude: degreesToRadians(target.lat),
      longitude: degreesToRadians(target.lon),
      height: target.heightKm
    },
    orbit.ecfKm
  );
  const azimuthDeg = (lookAngles.azimuth * 180) / Math.PI;
  const elevationDeg = (lookAngles.elevation * 180) / Math.PI;
  return {
    time: date.toISOString(),
    targetId: target.id,
    satelliteId: tle.id,
    azimuthDeg: ((azimuthDeg % 360) + 360) % 360,
    elevationDeg,
    rangeKm: lookAngles.rangeSat,
    visible: elevationDeg >= target.minElevationDeg
  };
}

export function computeAccessWindows(
  tle: SatelliteTle,
  targets: GroundTarget[],
  scenario: ScenarioSettings
) {
  const { start, end } = clampDateRange(scenario);
  const stepMs = Math.max(10, scenario.sampleStepSeconds) * 1000;
  const windows: AccessWindow[] = [];
  const currentSamples: AccessSample[] = [];
  targets
    .filter((target) => target.visible)
    .forEach((target) => {
      let activeStart: Date | null = null;
      let lastVisible: Date | null = null;
      let maxElevation = -90;
      for (let time = start.getTime(); time <= end.getTime(); time += stepMs) {
        const date = new Date(time);
        const sample = computeAccessSample(tle, target, date);
        if (!sample) continue;
        if (Math.abs(new Date(scenario.currentTime).getTime() - time) <= stepMs / 2) {
          currentSamples.push(sample);
        }
        if (sample.visible) {
          if (!activeStart) {
            activeStart = date;
            maxElevation = sample.elevationDeg;
          }
          lastVisible = date;
          maxElevation = Math.max(maxElevation, sample.elevationDeg);
        } else if (activeStart && lastVisible) {
          windows.push({
            id: `access-${tle.id}-${target.id}-${activeStart.toISOString()}`,
            targetId: target.id,
            satelliteId: tle.id,
            startTime: activeStart.toISOString(),
            endTime: lastVisible.toISOString(),
            durationSeconds: Math.max(0, (lastVisible.getTime() - activeStart.getTime()) / 1000),
            maxElevationDeg: maxElevation
          });
          activeStart = null;
          lastVisible = null;
          maxElevation = -90;
        }
      }
      if (activeStart && lastVisible) {
        windows.push({
          id: `access-${tle.id}-${target.id}-${activeStart.toISOString()}`,
          targetId: target.id,
          satelliteId: tle.id,
          startTime: activeStart.toISOString(),
          endTime: lastVisible.toISOString(),
          durationSeconds: Math.max(0, (lastVisible.getTime() - activeStart.getTime()) / 1000),
          maxElevationDeg: maxElevation
        });
      }
    });
  return { accessWindows: windows, currentAccessSamples: currentSamples };
}

export function buildStripeCoverageGrid(stripe: Stripe, spacingKm: number): CoverageGrid {
  const metrics = measureStripe(stripe.corners);
  if (!metrics) return { sourceStripeId: stripe.id, spacingKm, points: [] };
  const unwrapped = unwrapLongitudes(stripe.corners);
  const projected = unwrapped.map(project);
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const latStep = Math.max(0.05, spacingKm / 111);
  const lonStep = Math.max(0.05, spacingKm / Math.max(25, 111 * Math.cos((metrics.center.lat * Math.PI) / 180)));
  const points: CoverageGridPoint[] = [];
  for (let y = minY; y <= maxY; y += latStep) {
    for (let x = minX; x <= maxX; x += lonStep) {
      const point = unproject({ x, y });
      if (pointInPolygon(point, stripe.corners)) {
        points.push({
          id: `grid-${stripe.id}-${points.length}`,
          lat: point.lat,
          lon: point.lon,
          covered: false,
          coverageCount: 0
        });
      }
      if (points.length > 900) return { sourceStripeId: stripe.id, spacingKm, points };
    }
  }
  if (!points.length) {
    points.push({
      id: `grid-${stripe.id}-center`,
      lat: metrics.center.lat,
      lon: metrics.center.lon,
      covered: false,
      coverageCount: 0
    });
  }
  return { sourceStripeId: stripe.id, spacingKm, points };
}

function estimateRevisitMinutes(times: string[]) {
  const sorted = times
    .map((time) => new Date(time).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (sorted.length < 2) return undefined;
  let total = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    total += sorted[index] - sorted[index - 1];
  }
  return total / (sorted.length - 1) / 60_000;
}

export function computeCoverageResult(
  tle: SatelliteTle,
  stripe: Stripe | undefined,
  scenario: ScenarioSettings,
  halfConeDeg: number,
  spacingKm: number
) {
  if (!stripe) return {};
  const grid = buildStripeCoverageGrid(stripe, spacingKm);
  if (!grid.points.length) return { coverageGrid: grid, coveragePercent: 0 };
  const { start, end } = clampDateRange(scenario);
  const stepMs = Math.max(10, scenario.sampleStepSeconds) * 1000;
  const coveredTimes: string[] = [];
  for (let time = start.getTime(); time <= end.getTime(); time += stepMs) {
    const date = new Date(time);
    const sample = sampleAt(tle, date);
    if (!sample) continue;
    const radius = coverageRadiusKm(sample.heightKm, halfConeDeg);
    if (radius <= 0) continue;
    grid.points.forEach((point) => {
      if (haversineKm(sample, point) <= radius) {
        point.covered = true;
        point.coverageCount += 1;
        if (!point.firstCoveredTime) point.firstCoveredTime = date.toISOString();
      }
    });
    if (grid.points.some((point) => haversineKm(sample, point) <= radius)) {
      coveredTimes.push(date.toISOString());
    }
  }
  const coveredCount = grid.points.filter((point) => point.covered).length;
  return {
    coverageGrid: grid,
    coveragePercent: (coveredCount / grid.points.length) * 100,
    firstCoverageTime: grid.points
      .map((point) => point.firstCoveredTime)
      .filter((time): time is string => Boolean(time))
      .sort()[0],
    revisitMinutes: estimateRevisitMinutes(coveredTimes)
  };
}

export function computeSimulationResult(
  tle: SatelliteTle | undefined,
  targets: GroundTarget[],
  stripe: Stripe | undefined,
  scenario: ScenarioSettings,
  halfConeDeg: number,
  spacingKm: number
): SimulationResult {
  if (!tle) {
    return {
      generatedAt: new Date().toISOString(),
      accessWindows: [],
      currentAccessSamples: []
    };
  }
  const access = computeAccessWindows(tle, targets, scenario);
  const coverage = computeCoverageResult(tle, stripe, scenario, halfConeDeg, spacingKm);
  return {
    generatedAt: new Date().toISOString(),
    ...access,
    ...coverage
  };
}

export function targetFromCurrentMapCenter(center: LatLon): GroundTarget {
  return {
    id: makeId("target"),
    name: "目标点",
    lat: Number(center.lat.toFixed(6)),
    lon: Number(center.lon.toFixed(6)),
    heightKm: 0,
    minElevationDeg: 10,
    visible: true
  };
}
