import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  geodeticToEcf,
  gstime,
  propagate,
  twoline2satrec
} from "satellite.js";
import type {
  AccessWindow,
  CartesianOrbitSource,
  GeoPoint,
  GroundAsset,
  KeplerianOrbitSource,
  OrbitRequest,
  OrbitResponse,
  OrbitSample,
  Scenario,
  Sensor,
  Spacecraft
} from "../domain/types";
import { isGroundPointInSensorFov, orbitHeadingAtIndex } from "../domain/sensorFov";
import { fromEnu, geodesicCircle, toEnu } from "../domain/geometry";

type Vector3 = [number, number, number];
type StateVector = { position: Vector3; velocity: Vector3 };
type PropagatePayload = { spacecraft: Spacecraft; scenario: Scenario };
type AccessPayload = PropagatePayload & { groundAssets: GroundAsset[]; sensor?: Sensor };

const MU = 398600.4418;
const MAX_SAMPLES = 500_000;
const cancelled = new Set<string>();

function radians(value: number) {
  return value * Math.PI / 180;
}

function degrees(value: number) {
  return value * 180 / Math.PI;
}

function normalizeRadians(value: number) {
  const tau = Math.PI * 2;
  return ((value % tau) + tau) % tau;
}

function magnitude(vector: Vector3) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function dot(a: Vector3, b: Vector3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function validateScenario(scenario: Scenario) {
  const start = new Date(scenario.startTime).getTime();
  const end = new Date(scenario.endTime).getTime();
  const stepMs = Math.max(1, scenario.sampleStepSeconds) * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("场景时间范围无效");
  const count = Math.floor((end - start) / stepMs) + 1;
  if (count > MAX_SAMPLES) throw new Error(`场景需要 ${count.toLocaleString("zh-CN")} 个轨道样本，超过轻量内核单次 ${MAX_SAMPLES.toLocaleString("zh-CN")} 个的限制`);
  return { start, end, stepMs, count };
}

function sampleFromState(time: Date, state: StateVector): OrbitSample {
  const position = { x: state.position[0], y: state.position[1], z: state.position[2] };
  const geodetic = eciToGeodetic(position, gstime(time));
  return {
    time: time.toISOString(),
    lon: degreesLong(geodetic.longitude),
    lat: degreesLat(geodetic.latitude),
    heightKm: geodetic.height,
    speedKmS: magnitude(state.velocity),
    positionKm: state.position,
    velocityKmS: state.velocity
  };
}

function meanAnomalyFromTrue(trueAnomaly: number, eccentricity: number) {
  const eccentricAnomaly = 2 * Math.atan2(
    Math.sqrt(1 - eccentricity) * Math.sin(trueAnomaly / 2),
    Math.sqrt(1 + eccentricity) * Math.cos(trueAnomaly / 2)
  );
  return eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly);
}

function solveEccentricAnomaly(meanAnomaly: number, eccentricity: number) {
  let eccentricAnomaly = eccentricity < 0.8 ? meanAnomaly : Math.PI;
  for (let index = 0; index < 15; index += 1) {
    const correction = (eccentricAnomaly - eccentricity * Math.sin(eccentricAnomaly) - meanAnomaly)
      / (1 - eccentricity * Math.cos(eccentricAnomaly));
    eccentricAnomaly -= correction;
    if (Math.abs(correction) < 1e-13) break;
  }
  return eccentricAnomaly;
}

function rotatePerifocal(vector: Vector3, raan: number, inclination: number, argumentOfPerigee: number): Vector3 {
  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(inclination);
  const sinI = Math.sin(inclination);
  const cosW = Math.cos(argumentOfPerigee);
  const sinW = Math.sin(argumentOfPerigee);
  return [
    (cosO * cosW - sinO * sinW * cosI) * vector[0] + (-cosO * sinW - sinO * cosW * cosI) * vector[1],
    (sinO * cosW + cosO * sinW * cosI) * vector[0] + (-sinO * sinW + cosO * cosW * cosI) * vector[1],
    sinW * sinI * vector[0] + cosW * sinI * vector[1]
  ];
}

function keplerianState(source: KeplerianOrbitSource, time: Date): StateVector {
  const a = source.semiMajorAxisKm;
  const e = source.eccentricity;
  if (!(a > 0) || e < 0 || e >= 1) throw new Error("轻量内核当前支持偏心率 0 至 1 的椭圆轨道");
  const epoch = new Date(source.epoch).getTime();
  if (!Number.isFinite(epoch)) throw new Error("轨道历元无效");
  const initialAnomaly = radians(source.anomalyDeg);
  const initialMean = source.anomalyType === "mean" ? initialAnomaly : meanAnomalyFromTrue(initialAnomaly, e);
  const meanMotion = Math.sqrt(MU / (a * a * a));
  const mean = normalizeRadians(initialMean + meanMotion * ((time.getTime() - epoch) / 1000));
  const eccentricAnomaly = solveEccentricAnomaly(mean, e);
  const root = Math.sqrt(1 - e * e);
  const radius = a * (1 - e * Math.cos(eccentricAnomaly));
  const positionPqw: Vector3 = [a * (Math.cos(eccentricAnomaly) - e), a * root * Math.sin(eccentricAnomaly), 0];
  const velocityFactor = Math.sqrt(MU * a) / radius;
  const velocityPqw: Vector3 = [-velocityFactor * Math.sin(eccentricAnomaly), velocityFactor * root * Math.cos(eccentricAnomaly), 0];
  return {
    position: rotatePerifocal(positionPqw, radians(source.raanDeg), radians(source.inclinationDeg), radians(source.argumentOfPerigeeDeg)),
    velocity: rotatePerifocal(velocityPqw, radians(source.raanDeg), radians(source.inclinationDeg), radians(source.argumentOfPerigeeDeg))
  };
}

function cartesianToKeplerian(source: CartesianOrbitSource): KeplerianOrbitSource {
  if (source.frame === "ITRF") throw new Error("轻量内核暂不传播 ITRF 状态矢量，请先转换为 GCRF/EME2000，或启用可选科学引擎");
  const r = source.positionKm;
  const v = source.velocityKmS;
  const rMag = magnitude(r);
  const vMag = magnitude(v);
  const h = cross(r, v);
  const hMag = magnitude(h);
  if (rMag <= 0 || hMag <= 0) throw new Error("ECI 状态矢量无效");
  const node: Vector3 = [-h[1], h[0], 0];
  const nodeMag = magnitude(node);
  const rv = dot(r, v);
  const eccentricityVector: Vector3 = [
    ((vMag * vMag - MU / rMag) * r[0] - rv * v[0]) / MU,
    ((vMag * vMag - MU / rMag) * r[1] - rv * v[1]) / MU,
    ((vMag * vMag - MU / rMag) * r[2] - rv * v[2]) / MU
  ];
  const eccentricity = magnitude(eccentricityVector);
  const semiMajorAxisKm = 1 / (2 / rMag - vMag * vMag / MU);
  if (!(semiMajorAxisKm > 0) || eccentricity >= 1) throw new Error("轻量内核当前只传播椭圆 ECI 状态矢量");
  const inclination = Math.acos(Math.max(-1, Math.min(1, h[2] / hMag)));
  const raan = nodeMag > 1e-12 ? Math.atan2(node[1], node[0]) : 0;
  let argumentOfPerigee = 0;
  let trueAnomaly = 0;
  if (eccentricity > 1e-10 && nodeMag > 1e-12) {
    argumentOfPerigee = Math.atan2(dot(cross(node, eccentricityVector), h) / (nodeMag * eccentricity * hMag), dot(node, eccentricityVector) / (nodeMag * eccentricity));
    trueAnomaly = Math.atan2(dot(cross(eccentricityVector, r), h) / (eccentricity * rMag * hMag), dot(eccentricityVector, r) / (eccentricity * rMag));
  } else if (nodeMag > 1e-12) {
    trueAnomaly = Math.atan2(dot(cross(node, r), h) / (nodeMag * rMag * hMag), dot(node, r) / (nodeMag * rMag));
  } else {
    trueAnomaly = Math.atan2(r[1], r[0]);
  }
  return {
    type: "keplerian",
    epoch: source.epoch,
    semiMajorAxisKm,
    eccentricity,
    inclinationDeg: degrees(inclination),
    raanDeg: degrees(normalizeRadians(raan)),
    argumentOfPerigeeDeg: degrees(normalizeRadians(argumentOfPerigee)),
    anomalyDeg: degrees(normalizeRadians(trueAnomaly)),
    anomalyType: "true",
    frame: source.frame
  };
}

function stateAt(spacecraft: Spacecraft, time: Date, cartesianElements?: KeplerianOrbitSource): StateVector {
  const source = spacecraft.orbit;
  if (source.type === "tle") {
    const satrec = twoline2satrec(source.line1.trim(), source.line2.trim());
    const result = propagate(satrec, time);
    if (!result?.position || !result.velocity) throw new Error("TLE 在所选时刻无法传播");
    return {
      position: [result.position.x, result.position.y, result.position.z],
      velocity: [result.velocity.x, result.velocity.y, result.velocity.z]
    };
  }
  if (source.type === "keplerian") return keplerianState(source, time);
  if (source.type === "cartesian") return keplerianState(cartesianElements ?? cartesianToKeplerian(source), time);
  throw new Error(`${source.type.toUpperCase()} 文件需要安装可选科学引擎后传播`);
}

async function propagateSpacecraft(requestId: string, payload: PropagatePayload) {
  const { start, end, stepMs, count } = validateScenario(payload.scenario);
  const samples: OrbitSample[] = [];
  const source = payload.spacecraft.orbit;
  const cartesianElements = source.type === "cartesian" ? cartesianToKeplerian(source) : undefined;
  let satrec: ReturnType<typeof twoline2satrec> | undefined;
  if (source.type === "tle") {
    if (!source.line1.trim().startsWith("1 ") || !source.line2.trim().startsWith("2 ")) throw new Error("TLE 必须包含有效的第一行和第二行");
    satrec = twoline2satrec(source.line1.trim(), source.line2.trim());
  }
  for (let index = 0, timeMs = start; timeMs <= end; index += 1, timeMs += stepMs) {
    if (cancelled.has(requestId)) throw new Error("计算已取消");
    const time = new Date(timeMs);
    let state: StateVector;
    if (satrec) {
      const result = propagate(satrec, time);
      if (!result?.position || !result.velocity) continue;
      state = {
        position: [result.position.x, result.position.y, result.position.z],
        velocity: [result.velocity.x, result.velocity.y, result.velocity.z]
      };
    } else {
      state = stateAt(payload.spacecraft, time, cartesianElements);
    }
    samples.push(sampleFromState(time, state));
    if (index > 0 && index % 1000 === 0) {
      self.postMessage({ requestId, ok: true, progress: index / count } satisfies OrbitResponse);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const warnings = payload.spacecraft.profile === "research"
    ? ["轻量核心使用 SGP4 或二体传播；研究级摄动模型需要可选科学引擎"]
    : undefined;
  return { samples, engine: source.type === "tle" ? "satellite.js SGP4/SDP4" : "WGS84 二体传播", warnings };
}

function lookAngles(sample: OrbitSample, asset: GroundAsset) {
  if (!sample.positionKm) throw new Error("轨道样本缺少惯性坐标");
  const time = new Date(sample.time);
  const observer = {
    longitude: radians(asset.location.lon),
    latitude: radians(asset.location.lat),
    height: asset.location.heightKm ?? 0
  };
  const satelliteEcf = eciToEcf({ x: sample.positionKm[0], y: sample.positionKm[1], z: sample.positionKm[2] }, gstime(time));
  const look = ecfToLookAngles(observer, satelliteEcf);
  return { elevationDeg: degrees(look.elevation), azimuthDeg: degrees(normalizeRadians(look.azimuth)), rangeKm: look.rangeSat };
}

function targetEvaluationPoints(asset: GroundAsset, sample: OrbitSample, fixedBoundary: GeoPoint[]) {
  if (asset.kind !== "target" || asset.radiusKm <= 0) return [asset.location];
  const toward = toEnu(sample, asset.location);
  const distance = Math.hypot(toward.x, toward.y);
  const nearest = distance > 1e-9
    ? fromEnu({ x: toward.x / distance * asset.radiusKm, y: toward.y / distance * asset.radiusKm, z: 0 }, asset.location)
    : asset.location;
  return [asset.location, nearest, ...fixedBoundary];
}

function interpolateCrossing(previous: { sample: OrbitSample; elevationDeg: number }, current: { sample: OrbitSample; elevationDeg: number }, threshold: number) {
  const denominator = current.elevationDeg - previous.elevationDeg;
  const fraction = Math.abs(denominator) < 1e-12 ? 0 : Math.max(0, Math.min(1, (threshold - previous.elevationDeg) / denominator));
  const start = new Date(previous.sample.time).getTime();
  const end = new Date(current.sample.time).getTime();
  return new Date(start + (end - start) * fraction).toISOString();
}

async function computeAccessWindows(requestId: string, payload: AccessPayload) {
  const propagated = await propagateSpacecraft(requestId, payload);
  const windows: AccessWindow[] = [];
  for (const asset of payload.groundAssets) {
    const fixedBoundary = asset.kind === "target" && asset.radiusKm > 0 ? geodesicCircle(asset.location, asset.radiusKm, 16) : [];
    let active: { startTime: string; max: ReturnType<typeof lookAngles> } | null = null;
    let previous: { sample: OrbitSample; elevationDeg: number; visible: boolean } | null = null;
    for (let index = 0; index < propagated.samples.length; index += 1) {
      if (cancelled.has(requestId)) throw new Error("计算已取消");
      const sample = propagated.samples[index];
      const evaluationPoints = targetEvaluationPoints(asset, sample, fixedBoundary);
      const looks = evaluationPoints.map((location) => lookAngles(sample, { ...asset, location }));
      const look = looks.reduce((best, candidate) => candidate.elevationDeg > best.elevationDeg ? candidate : best);
      const headingDeg = payload.sensor ? orbitHeadingAtIndex(propagated.samples, index) : 0;
      const sensorVisible = !payload.sensor || evaluationPoints.some((location) => isGroundPointInSensorFov(sample, location, payload.sensor!, headingDeg));
      const visible = look.elevationDeg >= asset.minElevationDeg && sensorVisible;
      if (visible && !active) {
        const startTime = previous && !previous.visible
          ? interpolateCrossing(previous, { sample, elevationDeg: look.elevationDeg }, asset.minElevationDeg)
          : sample.time;
        active = { startTime, max: look };
      } else if (visible && active && look.elevationDeg > active.max.elevationDeg) {
        active.max = look;
      } else if (!visible && active) {
        const endTime = previous
          ? interpolateCrossing(previous, { sample, elevationDeg: look.elevationDeg }, asset.minElevationDeg)
          : sample.time;
        windows.push({
          id: `access-${payload.spacecraft.id}-${asset.id}-${windows.length + 1}`,
          spacecraftId: payload.spacecraft.id,
          targetId: asset.id,
          startTime: active.startTime,
          endTime,
          durationSeconds: Math.max(0, (new Date(endTime).getTime() - new Date(active.startTime).getTime()) / 1000),
          maxElevationDeg: active.max.elevationDeg,
          azimuthDeg: active.max.azimuthDeg,
          rangeKm: active.max.rangeKm,
          sensorConstrained: Boolean(payload.sensor)
        });
        active = null;
      }
      previous = { sample, elevationDeg: look.elevationDeg, visible };
      if (index > 0 && index % 2000 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (active) {
      const endTime = propagated.samples.at(-1)?.time ?? active.startTime;
      windows.push({
        id: `access-${payload.spacecraft.id}-${asset.id}-${windows.length + 1}`,
        spacecraftId: payload.spacecraft.id,
        targetId: asset.id,
        startTime: active.startTime,
        endTime,
        durationSeconds: Math.max(0, (new Date(endTime).getTime() - new Date(active.startTime).getTime()) / 1000),
        maxElevationDeg: active.max.elevationDeg,
        azimuthDeg: active.max.azimuthDeg,
        rangeKm: active.max.rangeKm,
        sensorConstrained: Boolean(payload.sensor)
      });
    }
  }
  return { windows };
}

async function handle(request: OrbitRequest): Promise<OrbitResponse> {
  try {
    if (request.command === "health") {
      return { requestId: request.requestId, ok: true, result: { engine: "Stripe 轻量轨道内核", version: "0.3.6", dataReady: true } };
    }
    if (request.command === "orbit/propagate") {
      const result = await propagateSpacecraft(request.requestId, request.payload as PropagatePayload);
      return { requestId: request.requestId, ok: true, result };
    }
    if (request.command === "access/compute") {
      const result = await computeAccessWindows(request.requestId, request.payload as AccessPayload);
      return { requestId: request.requestId, ok: true, result };
    }
    return { requestId: request.requestId, ok: false, error: `轻量轨道内核暂不支持命令：${request.command}` };
  } catch (error) {
    return { requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    cancelled.delete(request.requestId);
  }
}

self.onmessage = async (event: MessageEvent<OrbitRequest>) => {
  const request = event.data;
  if (request.command === "job/cancel") {
    const target = (request.payload as { requestId?: string } | undefined)?.requestId;
    if (target) cancelled.add(target);
    return;
  }
  self.postMessage(await handle(request));
};

// Keep these transforms in the bundle: they are used by the optional file-orbit adapter.
void geodeticToEcf;
