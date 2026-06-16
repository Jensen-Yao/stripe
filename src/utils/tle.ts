import {
  degreesLat,
  degreesLong,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec
} from "satellite.js";
import type { OrbitSample, SatelliteTle } from "../types";
import { normalizeLatLon } from "./geo";

export function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseManualTles(text: string): SatelliteTle[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const records: SatelliteTle[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const maybeName = lines[index];
    const line1 = maybeName.startsWith("1 ") ? maybeName : lines[index + 1];
    const line2 = maybeName.startsWith("1 ") ? lines[index + 1] : lines[index + 2];
    if (line1?.startsWith("1 ") && line2?.startsWith("2 ")) {
      const noradId = line1.slice(2, 7).trim();
      records.push({
        id: makeId("tle"),
        name: maybeName.startsWith("1 ") ? `SAT ${noradId}` : maybeName,
        noradId,
        line1,
        line2,
        source: "manual",
        fetchedAt: new Date().toISOString()
      });
      index += maybeName.startsWith("1 ") ? 1 : 2;
    }
  }
  return records;
}

export function withIds(records: SatelliteTle[]) {
  return records.map((record) => ({
    ...record,
    id: record.id || makeId("tle")
  }));
}

export function orbitPeriodMinutes(tle: SatelliteTle) {
  const meanMotion = Number(tle.line2.slice(52, 63));
  if (!Number.isFinite(meanMotion) || meanMotion <= 0) return 96;
  return 1440 / meanMotion;
}

export function sampleOrbit(tle: SatelliteTle, centerTime: Date, minutesFromCenter: number) {
  const target = new Date(centerTime.getTime() + minutesFromCenter * 60_000);
  return sampleAt(tle, target);
}

export function sampleAt(tle: SatelliteTle, date: Date): OrbitSample | null {
  try {
    const satrec = twoline2satrec(tle.line1, tle.line2);
    const positionAndVelocity = propagate(satrec, date);
    if (!positionAndVelocity?.position || !positionAndVelocity.velocity) return null;
    const gmst = gstime(date);
    const geodetic = eciToGeodetic(positionAndVelocity.position, gmst);
    const ecf = eciToEcf(positionAndVelocity.position, gmst);
    const velocity = positionAndVelocity.velocity;
    const normalized = normalizeLatLon({
      lat: degreesLat(geodetic.latitude),
      lon: degreesLong(geodetic.longitude)
    });
    return {
      time: date.toISOString(),
      lat: normalized.lat,
      lon: normalized.lon,
      heightKm: geodetic.height,
      speedKmS: Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2),
      eciKm: {
        x: positionAndVelocity.position.x,
        y: positionAndVelocity.position.y,
        z: positionAndVelocity.position.z
      },
      ecfKm: {
        x: ecf.x,
        y: ecf.y,
        z: ecf.z
      },
      crossedDateLine: false
    };
  } catch {
    return null;
  }
}

export function groundTrack(tle: SatelliteTle, centerTime: Date, steps = 160): OrbitSample[] {
  const period = orbitPeriodMinutes(tle);
  const start = -period;
  const end = period;
  const samples: OrbitSample[] = [];
  let previousLon: number | null = null;
  for (let index = 0; index <= steps; index += 1) {
    const minutes = start + ((end - start) * index) / steps;
    const sample = sampleOrbit(tle, centerTime, minutes);
    if (sample) {
      sample.crossedDateLine = previousLon !== null && Math.abs(sample.lon - previousLon) > 180;
      previousLon = sample.lon;
      samples.push(sample);
    }
  }
  return samples;
}
