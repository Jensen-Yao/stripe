import { bearingDeg, fromEnu, haversineKm, normalizeLon } from "./geometry";
import type { GeoPoint, OrbitSample, Sensor } from "./types";

export const MEAN_EARTH_RADIUS_KM = 6371.0088;

type Vec3 = [number, number, number];

export type SensorFootprint = {
  center: GeoPoint;
  boundary: GeoPoint[];
  headingDeg: number;
  crossTrackRadiusKm: number;
  alongTrackRadiusKm: number;
  maxRadiusKm: number;
  horizonClipped: boolean;
};

function degrees(value: number) {
  return value * Math.PI / 180;
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function scale(vector: Vec3, factor: number): Vec3 {
  return [vector[0] * factor, vector[1] * factor, vector[2] * factor];
}

function add(...vectors: Vec3[]): Vec3 {
  return vectors.reduce<Vec3>((sum, vector) => [sum[0] + vector[0], sum[1] + vector[1], sum[2] + vector[2]], [0, 0, 0]);
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.max(1e-12, Math.hypot(...vector));
  return scale(vector, 1 / length);
}

function localFrame(point: GeoPoint, headingDeg: number) {
  const lat = degrees(point.lat);
  const lon = degrees(point.lon);
  const heading = degrees(headingDeg);
  const up: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
  const north: Vec3 = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const along = add(scale(east, Math.sin(heading)), scale(north, Math.cos(heading)));
  const cross = add(scale(east, Math.cos(heading)), scale(north, -Math.sin(heading)));
  return { up, nadir: scale(up, -1), along, cross };
}

function pointUnitVector(point: GeoPoint): Vec3 {
  const lat = degrees(point.lat);
  const lon = degrees(point.lon);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

function pointFromVector(vector: Vec3): GeoPoint {
  const unit = normalize(vector);
  return {
    lon: normalizeLon(Math.atan2(unit[1], unit[0]) * 180 / Math.PI),
    lat: Math.asin(Math.max(-1, Math.min(1, unit[2]))) * 180 / Math.PI,
    heightKm: 0
  };
}

export function sensorHalfAngles(sensor: Sensor) {
  if (sensor.shape === "conical") {
    const half = Math.max(0, Math.min(89.9, sensor.halfConeDeg));
    return { crossTrackDeg: half, alongTrackDeg: half };
  }
  return {
    crossTrackDeg: Math.max(0, Math.min(89.9, sensor.crossTrackFovDeg / 2)),
    alongTrackDeg: Math.max(0, Math.min(89.9, sensor.alongTrackFovDeg / 2))
  };
}

export function formatSensorFov(sensor: Sensor) {
  return sensor.shape === "conical"
    ? `${(sensor.halfConeDeg * 2).toFixed(1)}\u00b0`
    : `${sensor.crossTrackFovDeg.toFixed(1)}\u00b0 \u00d7 ${sensor.alongTrackFovDeg.toFixed(1)}\u00b0`;
}

export function groundRangeForLookAngle(heightKm: number, halfAngleDeg: number) {
  const altitude = Math.max(0, heightKm);
  const requested = degrees(Math.max(0, Math.min(89.9, halfAngleDeg)));
  const horizon = Math.asin(MEAN_EARTH_RADIUS_KM / (MEAN_EARTH_RADIUS_KM + altitude));
  const effective = Math.min(requested, horizon);
  const argument = Math.max(-1, Math.min(1, ((MEAN_EARTH_RADIUS_KM + altitude) / MEAN_EARTH_RADIUS_KM) * Math.sin(effective)));
  const central = Math.max(0, Math.asin(argument) - effective);
  return {
    radiusKm: central * MEAN_EARTH_RADIUS_KM,
    horizonClipped: requested > horizon,
    effectiveHalfAngleDeg: effective * 180 / Math.PI
  };
}

function rayGroundIntersection(sample: OrbitSample, headingDeg: number, crossAngleDeg: number, alongAngleDeg: number) {
  const frame = localFrame(sample, headingDeg);
  const satellite = scale(frame.up, MEAN_EARTH_RADIUS_KM + Math.max(0, sample.heightKm));
  let crossTangent = Math.tan(degrees(crossAngleDeg));
  let alongTangent = Math.tan(degrees(alongAngleDeg));
  const requestedTangent = Math.hypot(crossTangent, alongTangent);
  const horizon = Math.asin(MEAN_EARTH_RADIUS_KM / (MEAN_EARTH_RADIUS_KM + Math.max(0, sample.heightKm)));
  const horizonTangent = Math.tan(horizon) * (1 - 1e-10);
  const horizonClipped = requestedTangent > horizonTangent;
  if (horizonClipped && requestedTangent > 0) {
    const factor = horizonTangent / requestedTangent;
    crossTangent *= factor;
    alongTangent *= factor;
  }
  const direction = normalize(add(frame.nadir, scale(frame.cross, crossTangent), scale(frame.along, alongTangent)));
  const projection = dot(satellite, direction);
  const discriminant = Math.max(0, projection ** 2 - (dot(satellite, satellite) - MEAN_EARTH_RADIUS_KM ** 2));
  const distance = -projection - Math.sqrt(discriminant);
  return { point: pointFromVector(add(satellite, scale(direction, Math.max(0, distance)))), horizonClipped };
}

export function sensorMaxGroundRangeKm(heightKm: number, sensor: Sensor) {
  const half = sensorHalfAngles(sensor);
  const offAxisDeg = sensor.shape === "conical"
    ? half.crossTrackDeg
    : Math.atan(Math.hypot(Math.tan(degrees(half.crossTrackDeg)), Math.tan(degrees(half.alongTrackDeg)))) * 180 / Math.PI;
  return groundRangeForLookAngle(heightKm, offAxisDeg);
}

export function createSensorFootprint(sample: OrbitSample, sensor: Sensor, headingDeg: number, resolution = 64): SensorFootprint {
  const half = sensorHalfAngles(sensor);
  const boundary: GeoPoint[] = [];
  let horizonClipped = false;
  const append = (crossAngleDeg: number, alongAngleDeg: number) => {
    const intersection = rayGroundIntersection(sample, headingDeg, crossAngleDeg, alongAngleDeg);
    boundary.push(intersection.point);
    horizonClipped ||= intersection.horizonClipped;
  };

  if (sensor.shape === "conical") {
    const count = Math.max(16, resolution);
    const range = groundRangeForLookAngle(sample.heightKm, half.crossTrackDeg);
    horizonClipped ||= range.horizonClipped;
    for (let index = 0; index < count; index += 1) {
      const bearing = degrees(headingDeg + index / count * 360);
      boundary.push(fromEnu({ x: Math.sin(bearing) * range.radiusKm, y: Math.cos(bearing) * range.radiusKm, z: 0 }, sample));
    }
  } else {
    const edgeSegments = Math.max(4, Math.ceil(resolution / 4));
    for (let index = 0; index < edgeSegments; index += 1) append(-half.crossTrackDeg + 2 * half.crossTrackDeg * index / edgeSegments, half.alongTrackDeg);
    for (let index = 0; index < edgeSegments; index += 1) append(half.crossTrackDeg, half.alongTrackDeg - 2 * half.alongTrackDeg * index / edgeSegments);
    for (let index = 0; index < edgeSegments; index += 1) append(half.crossTrackDeg - 2 * half.crossTrackDeg * index / edgeSegments, -half.alongTrackDeg);
    for (let index = 0; index < edgeSegments; index += 1) append(-half.crossTrackDeg, -half.alongTrackDeg + 2 * half.alongTrackDeg * index / edgeSegments);
  }

  const crossRange = groundRangeForLookAngle(sample.heightKm, half.crossTrackDeg);
  const alongRange = groundRangeForLookAngle(sample.heightKm, half.alongTrackDeg);
  const maxRange = sensorMaxGroundRangeKm(sample.heightKm, sensor);
  return {
    center: { lon: sample.lon, lat: sample.lat, heightKm: 0 },
    boundary,
    headingDeg,
    crossTrackRadiusKm: crossRange.radiusKm,
    alongTrackRadiusKm: alongRange.radiusKm,
    maxRadiusKm: boundary.reduce((maximum, point) => Math.max(maximum, haversineKm(sample, point)), maxRange.radiusKm),
    horizonClipped: horizonClipped || crossRange.horizonClipped || alongRange.horizonClipped || maxRange.horizonClipped
  };
}

export function isGroundPointInSensorFov(sample: OrbitSample, groundPoint: GeoPoint, sensor: Sensor, headingDeg: number) {
  const frame = localFrame(sample, headingDeg);
  const groundUp = pointUnitVector(groundPoint);
  const satellite = scale(frame.up, MEAN_EARTH_RADIUS_KM + Math.max(0, sample.heightKm));
  const ground = scale(groundUp, MEAN_EARTH_RADIUS_KM);
  const groundToSatellite = add(satellite, scale(ground, -1));
  if (dot(groundToSatellite, groundUp) < -1e-8) return false;

  const direction = normalize(add(ground, scale(satellite, -1)));
  const nadirComponent = dot(direction, frame.nadir);
  if (nadirComponent <= 0) return false;
  const half = sensorHalfAngles(sensor);
  if (sensor.shape === "conical") {
    const offAxis = Math.acos(Math.max(-1, Math.min(1, nadirComponent)));
    return offAxis <= degrees(half.crossTrackDeg) + 1e-10;
  }
  return Math.abs(dot(direction, frame.cross) / nadirComponent) <= Math.tan(degrees(half.crossTrackDeg)) + 1e-10
    && Math.abs(dot(direction, frame.along) / nadirComponent) <= Math.tan(degrees(half.alongTrackDeg)) + 1e-10;
}

export function closestOrbitSample(samples: readonly OrbitSample[], time: string) {
  if (!samples.length) return undefined;
  const target = new Date(time).getTime();
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (new Date(samples[middle].time).getTime() < target) low = middle + 1;
    else high = middle;
  }
  const right = low;
  const left = Math.max(0, right - 1);
  const closestIndex = Math.abs(new Date(samples[left].time).getTime() - target)
    <= Math.abs(new Date(samples[right].time).getTime() - target) ? left : right;
  return { sample: samples[closestIndex], index: closestIndex };
}

export function orbitHeadingAtIndex(samples: readonly OrbitSample[], index: number) {
  if (samples.length < 2) return 0;
  const from = samples[Math.max(0, Math.min(index, samples.length - 2))];
  const to = samples[Math.max(1, Math.min(index + 1, samples.length - 1))];
  return bearingDeg(from, to);
}
