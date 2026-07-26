import type { AccessWindow, GroundAsset, OrbitResponse, OrbitSample, Scenario, Sensor, Spacecraft } from "../domain/types";

function requestId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function propagateOrbit(spacecraft: Spacecraft, scenario: Scenario) {
  const response = await window.stripeApi.orbitRequest<{
    samples: OrbitSample[];
    engine: string;
    warnings?: string[];
  }>({
    requestId: requestId("propagate"),
    command: "orbit/propagate",
    payload: { spacecraft, scenario }
  });
  if (!response.ok || !response.result) throw new Error(response.error ?? "轨道传播失败");
  return response.result;
}

export async function computeAccess(spacecraft: Spacecraft, scenario: Scenario, groundAssets: GroundAsset[], sensor?: Sensor) {
  const response = await window.stripeApi.orbitRequest<{ windows: AccessWindow[] }>({
    requestId: requestId("access"),
    command: "access/compute",
    payload: { spacecraft, scenario, groundAssets, sensor }
  });
  if (!response.ok || !response.result) throw new Error(response.error ?? "访问窗口计算失败");
  return response.result.windows;
}

export async function checkOrbitEngine() {
  return window.stripeApi.orbitRequest<{ engine: string; version: string; dataReady: boolean }>({
    requestId: requestId("health"),
    command: "health"
  }) as Promise<OrbitResponse<{ engine: string; version: string; dataReady: boolean }>>;
}
