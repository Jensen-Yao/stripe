const PI = Math.PI;
const AXIS = 6378245;
const ECCENTRICITY_SQUARED = 0.006693421622965943;

export type AmapConfiguration = {
  configured: boolean;
  key?: string;
  securityCode?: string;
  source?: string;
};

export type AmapMapInstance = {
  setZoomAndCenter(zoom: number, center: [number, number], immediately?: boolean): void;
  setMapStyle(style: string): void;
  getLayers?(): AmapLayerInstance[];
  setLayers?(layers: AmapLayerInstance[]): void;
  resize(): void;
  destroy(): void;
};

type AmapConstructor = new (container: HTMLElement, options: Record<string, unknown>) => AmapMapInstance;
export type AmapLayerInstance = { __stripeLayerKind?: "standard" | "satellite" | "roadnet" };
type AmapLayerConstructor = new (options?: Record<string, unknown>) => AmapLayerInstance;
type AmapTileLayerNamespace = AmapLayerConstructor & {
  Satellite: AmapLayerConstructor;
  RoadNet: AmapLayerConstructor;
};
export type AmapSdk = { Map: AmapConstructor; TileLayer?: AmapTileLayerNamespace };

declare global {
  interface Window {
    AMap?: AmapSdk;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

function outsideChina(lon: number, lat: number) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLatitude(x: number, y: number) {
  let value = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return value;
}

function transformLongitude(x: number, y: number) {
  let value = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  value += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  value += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return value;
}

export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || outsideChina(lon, lat)) return [lon, lat];
  let deltaLat = transformLatitude(lon - 105, lat - 35);
  let deltaLon = transformLongitude(lon - 105, lat - 35);
  const latitudeRadians = lat / 180 * PI;
  const sinLatitude = Math.sin(latitudeRadians);
  const magic = 1 - ECCENTRICITY_SQUARED * sinLatitude * sinLatitude;
  const sqrtMagic = Math.sqrt(magic);
  deltaLat = deltaLat * 180 / ((AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * sqrtMagic) * PI);
  deltaLon = deltaLon * 180 / (AXIS / sqrtMagic * Math.cos(latitudeRadians) * PI);
  return [lon + deltaLon, lat + deltaLat];
}

export function mapLibreZoomToAmapZoom(zoom: number) {
  // MapLibre uses a 512 px world at zoom 0; AMap uses the standard 256 px XYZ world.
  return Math.max(2, Math.min(20, zoom + 1));
}

let sdkPromise: Promise<AmapSdk> | null = null;

export function loadAmapSdk(configuration: AmapConfiguration): Promise<AmapSdk> {
  if (window.AMap?.Map) return Promise.resolve(window.AMap);
  if (!configuration.configured || !configuration.key || !configuration.securityCode) {
    return Promise.reject(new Error("尚未配置高德地图 Web JS API"));
  }
  if (sdkPromise) return sdkPromise;

  const key = configuration.key;
  const securityCode = configuration.securityCode;
  window._AMapSecurityConfig = { securityJsCode: securityCode };
  sdkPromise = new Promise<AmapSdk>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      script.remove();
      reject(new Error("高德地图服务连接超时"));
    }, 20_000);
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.addEventListener("load", () => {
      window.clearTimeout(timeout);
      if (window.AMap?.Map) resolve(window.AMap);
      else reject(new Error("高德地图 SDK 初始化失败"));
    }, { once: true });
    script.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("无法加载高德地图在线服务"));
    }, { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    sdkPromise = null;
    throw error;
  });
  return sdkPromise;
}
