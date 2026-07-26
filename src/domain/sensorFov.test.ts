import { describe, expect, it } from "vitest";
import { haversineKm } from "./geometry";
import {
  createSensorFootprint,
  groundRangeForLookAngle,
  isGroundPointInSensorFov,
  orbitHeadingAtIndex
} from "./sensorFov";
import type { OrbitSample, Sensor } from "./types";

const sample: OrbitSample = {
  lon: 0,
  lat: 0,
  heightKm: 500,
  speedKmS: 7.6,
  time: "2026-01-01T00:00:00.000Z"
};

const conicalSensor: Sensor = {
  id: "sensor-conical",
  spacecraftId: "spacecraft-1",
  name: "Conical",
  shape: "conical",
  halfConeDeg: 20,
  crossTrackFovDeg: 10,
  alongTrackFovDeg: 2,
  maxOffNadirDeg: 45,
  maxSlewRateDegS: 1,
  settleTimeSeconds: 5
};

const rectangularSensor: Sensor = { ...conicalSensor, id: "sensor-rectangular", shape: "rectangular" };

describe("sensor field of view geometry", () => {
  it("projects a conical field of view onto a stable ground circle", () => {
    const footprint = createSensorFootprint(sample, conicalSensor, 0, 48);
    const expected = groundRangeForLookAngle(sample.heightKm, conicalSensor.halfConeDeg).radiusKm;
    const distances = footprint.boundary.map((point) => haversineKm(sample, point));
    expect(footprint.boundary).toHaveLength(48);
    expect(Math.min(...distances)).toBeCloseTo(expected, 5);
    expect(Math.max(...distances)).toBeCloseTo(expected, 5);
    expect(footprint.horizonClipped).toBe(false);
  });

  it("clips a requested look angle at the visible Earth horizon", () => {
    const range = groundRangeForLookAngle(500, 89);
    expect(range.horizonClipped).toBe(true);
    expect(range.radiusKm).toBeGreaterThan(2400);
    expect(range.radiusKm).toBeLessThan(2500);
  });

  it("keeps rectangular cross-track and along-track angles independent", () => {
    expect(isGroundPointInSensorFov(sample, { lon: 0.3, lat: 0 }, rectangularSensor, 0)).toBe(true);
    expect(isGroundPointInSensorFov(sample, { lon: 0, lat: 0.3 }, rectangularSensor, 0)).toBe(false);
    expect(isGroundPointInSensorFov(sample, { lon: 0, lat: 0.3 }, rectangularSensor, 90)).toBe(true);
    expect(isGroundPointInSensorFov(sample, { lon: 0.3, lat: 0 }, rectangularSensor, 90)).toBe(false);
  });

  it("orients the footprint from the propagated ground track", () => {
    const samples: OrbitSample[] = [sample, { ...sample, lon: 1, time: "2026-01-01T00:01:00.000Z" }];
    expect(orbitHeadingAtIndex(samples, 0)).toBeCloseTo(90, 6);
    expect(orbitHeadingAtIndex(samples, 1)).toBeCloseTo(90, 6);
  });
});
