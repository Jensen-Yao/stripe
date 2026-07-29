import { useEffect, useRef, useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PMTiles, Protocol } from "pmtiles";
import type { BaseMapMode, GeoPoint, OrbitSample, Sensor, Spacecraft, Stripe } from "../domain/types";
import { makeId } from "../domain/id";
import { fromEnu, geodesicCircle, haversineKm, scaleStripeAxes, stripeCenter, stripeFrame, toEnu, transformStripe, validateStripePolygon } from "../domain/geometry";
import { closestOrbitSample, createSensorFootprint, formatSensorFov, orbitHeadingAtIndex } from "../domain/sensorFov";
import { useWorkbenchStore } from "../store/workbenchStore";
import { loadAmapSdk, mapLibreZoomToAmapZoom, wgs84ToGcj02, type AmapLayerInstance, type AmapMapInstance, type AmapSdk } from "./amap";
import { FINISH_STRIPE_DRAWING_EVENT } from "./drawingEvents";
import { createAmapGlobeStyle, createOsmStyle, createWorldStyle, fallbackStyle, transparentOverlayStyle } from "./worldStyle";
import "maplibre-gl/dist/maplibre-gl.css";

type DragKind = "corner" | "move" | "rotate" | "stretch-length" | "stretch-width";
type HandleKind = DragKind | "insert";
type HandleDescriptor = { kind: HandleKind; cornerIndex?: number; insertAfter?: number; point: { x: number; y: number }; label: string };
type StripeRenderItem = {
  stripe: Stripe;
  polygon: Array<[number, number]>;
  globePolygon: Array<[number, number, number]>;
  globeBoundary: Array<[number, number, number]>;
  fillColor: [number, number, number, number];
  lineColor: [number, number, number, number];
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number };
};
type OverlapComparisonItem = {
  role: "A" | "B";
  stripe: Stripe;
  polygon: Array<[number, number]>;
  labelPoint: [number, number];
  fillColor: [number, number, number, number];
  lineColor: [number, number, number, number];
};
const OVERLAP_ROLE_COLORS = {
  A: { fill: [37, 131, 196, 42], line: [24, 103, 164, 255] },
  B: { fill: [228, 119, 46, 42], line: [191, 83, 26, 255] }
} as const;
const BASE_LABEL_CHARACTERS = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32));
const CHINA_SOURCE_ID = "china-standard-map";
const CHINA_LAYER_IDS = ["china-standard-fill", "china-standard-provinces", "china-standard-border", "china-standard-maritime"] as const;
const GEOGRAPHIC_CONTEXT_SOURCE_ID = "geographic-context";
const GEOGRAPHIC_CONTEXT_LAYER_IDS = ["geographic-context-countries-fill", "geographic-context-countries-line", "geographic-context-states-line", "geographic-context-lakes-fill", "geographic-context-rivers-line"] as const;
const OFFLINE_CONTEXT_LAYER_IDS = ["countries-fill", "countries-line", "states-line", "lakes-fill", "rivers-line"] as const;
const AMAP_FALLBACK_CONTEXT_LAYER_IDS = ["amap-fallback-countries-fill", "amap-fallback-countries-line", "amap-fallback-states-line", "amap-fallback-lakes-fill", "amap-fallback-rivers-line"] as const;
const H3_MINIMUM_DETAIL_ZOOM = [1, 1, 2, 3, 4, 5, 7, 8.5, 11, 12.5, 13.5, 14.5, 15.5, 16] as const;
const H3_RENDER_WARMUP_CELL = ["8928308280fffff"];
const STRIPE_GLOBE_ALTITUDE_METERS = 1200;
const STRIPE_GLOBE_PARAMETERS = {
  cullMode: "none" as const,
  depthCompare: "less-equal" as const,
  depthWriteEnabled: false
};

let protocolInstalled = false;
const pmtilesProtocol = new Protocol();

function installPmtilesProtocol() {
  if (protocolInstalled) return;
  maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);
  protocolInstalled = true;
}

function pointArray(point: GeoPoint): [number, number] {
  return [point.lon, point.lat];
}

function normalizeViewLon(lon: number) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function pointArrayNear(point: GeoPoint, referenceLon: number): [number, number] {
  let lon = point.lon;
  while (lon - referenceLon > 180) lon -= 360;
  while (lon - referenceLon < -180) lon += 360;
  return [lon, point.lat];
}

function colorChannels(color: string, alpha: number): [number, number, number, number] {
  const value = color.replace("#", "");
  const normalized = value.length === 3 ? value.split("").map((channel) => channel + channel).join("") : value;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return [33, 137, 162, alpha];
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    alpha
  ];
}

function lightenChannels(color: string, alpha: number, mix = 0.16): [number, number, number, number] {
  const value = color.replace("#", "");
  const normalized = value.length === 3 ? value.split("").map((channel) => channel + channel).join("") : value;
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return [33, 137, 162, alpha];
  const channels = [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
  return [
    Math.round(channels[0] + (255 - channels[0]) * mix),
    Math.round(channels[1] + (255 - channels[1]) * mix),
    Math.round(channels[2] + (255 - channels[2]) * mix),
    alpha
  ];
}

function createStripeRenderItem(stripe: Stripe): StripeRenderItem {
  const centerLon = stripeCenter(stripe.corners).lon;
  const polygon = stripe.corners.map((corner) => pointArrayNear(corner, centerLon));
  const globePolygon = polygon.map(([lon, lat]) => [lon, lat, STRIPE_GLOBE_ALTITUDE_METERS] as [number, number, number]);
  const lineColor = lightenChannels(stripe.color, 210, 0.06);
  return {
    stripe,
    polygon,
    globePolygon,
    globeBoundary: [...globePolygon, globePolygon[0]],
    fillColor: lightenChannels(stripe.color, 92, 0.22),
    lineColor,
    bounds: {
      minLon: Math.min(...polygon.map((point) => point[0])),
      maxLon: Math.max(...polygon.map((point) => point[0])),
      minLat: Math.min(...polygon.map((point) => point[1])),
      maxLat: Math.max(...polygon.map((point) => point[1]))
    }
  };
}

function createOverlapComparisonItem(role: "A" | "B", stripe: Stripe): OverlapComparisonItem {
  const center = stripeCenter(stripe.corners);
  const displayCorners = stripe.corners.map((corner) => ({ corner, display: pointArrayNear(corner, center.lon) }));
  const anchor = displayCorners.reduce((best, candidate) => {
    if (role === "A") {
      if (candidate.display[1] !== best.display[1]) return candidate.display[1] > best.display[1] ? candidate : best;
      return candidate.display[0] < best.display[0] ? candidate : best;
    }
    if (candidate.display[1] !== best.display[1]) return candidate.display[1] < best.display[1] ? candidate : best;
    return candidate.display[0] > best.display[0] ? candidate : best;
  });
  const anchorEnu = toEnu(anchor.corner, center);
  const insetAnchor = fromEnu({ x: anchorEnu.x * 0.82, y: anchorEnu.y * 0.82, z: 0 }, center);
  return {
    role,
    stripe,
    polygon: displayCorners.map((item) => item.display),
    labelPoint: pointArrayNear(insetAnchor, center.lon),
    fillColor: [...OVERLAP_ROLE_COLORS[role].fill],
    lineColor: [...OVERLAP_ROLE_COLORS[role].line]
  };
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function assetUrl(path: string) {
  return window.stripeApi?.assetUrl(path) ?? new URL(`./${path}`, window.location.href).href;
}

function styleForBaseMap(
  mode: BaseMapMode,
  archiveUrl: string,
  amapOverviewUrl: string,
  amapSatelliteOverviewUrl: string,
  surfaceRendering: boolean,
  viewMode: "2d" | "3d"
) {
  const projection = viewMode === "3d" ? "globe" : "mercator";
  if (mode === "offline") return createWorldStyle(archiveUrl, projection);
  if (mode === "amap") return viewMode === "3d"
    ? createAmapGlobeStyle(amapOverviewUrl, archiveUrl, surfaceRendering, amapSatelliteOverviewUrl)
    : transparentOverlayStyle;
  return createOsmStyle(archiveUrl, projection);
}

export function MapWorkbench() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const finishDraftRef = useRef<() => void>(() => undefined);
  const undoDraftRef = useRef<() => void>(() => undefined);
  const cancelDraftRef = useRef<() => void>(() => undefined);
  const [draftPointCount, setDraftPointCount] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    installPmtilesProtocol();

    const archiveUrl = assetUrl("maps/world.pmtiles");
    const amapOverviewUrl = assetUrl("maps/amap-overview/");
    const amapSatelliteOverviewUrl = assetUrl("maps/amap-satellite-overview/");
    const archive = new PMTiles(archiveUrl);
    pmtilesProtocol.add(archive);
    const amapContainer = document.createElement("div");
    amapContainer.className = "amap-base-layer";
    amapContainer.setAttribute("aria-hidden", "true");
    container.appendChild(amapContainer);
    const syncAmapDomVisibility = (forcedVisible?: boolean) => {
      const state = useWorkbenchStore.getState();
      const visible = forcedVisible ?? (state.baseMapMode === "amap" && state.viewMode === "2d");
      container.dataset.activeBasemap = visible ? "amap-2d" : state.baseMapMode;
      container.dataset.activeViewMode = state.viewMode;
      container.classList.toggle("amap-active", visible);
      amapContainer.classList.toggle("active", visible);
    };
    syncAmapDomVisibility();
    const initialState = useWorkbenchStore.getState();
    const map = new maplibregl.Map({
      container,
      style: styleForBaseMap(initialState.baseMapMode, archiveUrl, amapOverviewUrl, amapSatelliteOverviewUrl, initialState.layerVisibility.surfaceRendering, initialState.viewMode),
      center: [20, 22],
      zoom: 2,
      minZoom: 1,
      maxZoom: 16,
      attributionControl: false,
      localIdeographFontFamily: "Microsoft YaHei, Noto Sans CJK SC, sans-serif",
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
      validateStyle: false
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    const updateViewDiagnostics = () => {
      container.dataset.mapProjection = String(map.getProjection().type ?? "");
      container.dataset.mapZoom = map.getZoom().toFixed(2);
    };
    map.on("moveend", updateViewDiagnostics);
    map.on("style.load", updateViewDiagnostics);

    let mapLoadFailed = false;
    let styleReady = false;
    let amapMap: AmapMapInstance | null = null;
    let amapSdk: AmapSdk | null = null;
    let amapStandardLayers: AmapLayerInstance[] = [];
    let amapSatelliteLayer: AmapLayerInstance | null = null;
    let amapRoadnetLayer: AmapLayerInstance | null = null;
    let amapActivationId = 0;
    let amapSyncFrame: number | null = null;
    let planarCamera: { center: [number, number]; zoom: number; bearing: number; pitch: number } | null = null;
    map.on("error", (event) => {
      const message = event.error?.message ?? "";
      if (!mapLoadFailed && useWorkbenchStore.getState().baseMapMode === "offline" && /pmtiles|world\.pmtiles/i.test(message)) {
        mapLoadFailed = true;
        styleReady = false;
        map.setStyle(fallbackStyle);
        map.once("style.load", () => {
          styleReady = true;
          ensureStripeLayers();
          syncStripeSource();
        });
        useWorkbenchStore.getState().setStatus("离线地图文件不可用，已切换到空白工程底图");
      }
    });

    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay as unknown as maplibregl.IControl);

    const handleLayer = document.createElement("div");
    handleLayer.className = "map-handle-layer";
    container.appendChild(handleLayer);
    const editPreviewSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    editPreviewSvg.classList.add("map-edit-preview");
    editPreviewSvg.setAttribute("aria-hidden", "true");
    const editPreviewPolygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    editPreviewSvg.appendChild(editPreviewPolygon);
    container.appendChild(editPreviewSvg);

    const h3Worker = new Worker(new URL("../workers/h3.worker.ts", import.meta.url), { type: "module" });
    let h3Chunks: string[][] = [];
    let h3PendingChunks: string[][] = [];
    let h3RequestId = 0;
    let h3IdleRequestId = 0;
    let h3ChunkFrame: number | null = null;
    let h3DisplayedCells = 0;
    let h3EstimatedCells = 0;
    let h3StreamClipped = false;
    let h3StreamComplete = false;
    let h3StreamResolution = 0;
    let previewStripe: Stripe | null = null;
    let draftPoints: GeoPoint[] = [];
    let cityLabels: Array<{ lon: number; lat: number; name: string; population: number }> = [];
    let countryLabels: Array<{ lon: number; lat: number; name: string; rank: number }> = [];
    let chinaLabels: Array<{ lon: number; lat: number; name: string; minZoom: number; kind: string }> = [];
    let textCharacterSet = BASE_LABEL_CHARACTERS;
    let tracksCache: Array<{ spacecraft: Spacecraft; samples: OrbitSample[] }> = [];
    let stripeRenderSourceRef: Stripe[] | null = null;
    let stripeRenderCache: StripeRenderItem[] = [];
    let stripeDeckDataSourceRef: StripeRenderItem[] | null = null;
    let stripeDeckSelectionId: string | undefined;
    let stripeDeckDataCache: StripeRenderItem[] = [];
    let tracksSpacecraftRef: Spacecraft[] | null = null;
    let tracksSamplesRef: Record<string, OrbitSample[]> | null = null;
    let visibleSpacecraftCache: Spacecraft[] = [];
    let footprintCache: Array<{
      spacecraft: Spacecraft;
      sensor: Sensor;
      sample: OrbitSample;
      footprint: ReturnType<typeof createSensorFootprint>;
    }> = [];
    let footprintKey = "";
    let footprintSensorsRef: Sensor[] | null = null;
    let footprintSamplesRef: Record<string, OrbitSample[]> | null = null;
    let groundAssetsRef = useWorkbenchStore.getState().groundAssets;
    let visibleGroundAssets = groundAssetsRef.filter((asset) => asset.visible);
    let groundAreaCache = visibleGroundAssets
      .filter((asset) => asset.kind === "target" && asset.radiusKm > 0)
      .map((asset) => ({ asset, boundary: geodesicCircle(asset.location, asset.radiusKm, 72) }));
    let frame: number | null = null;
    let handleFrame: number | null = null;
    let destroyed = false;
    let handleRenderKey = "";
    let drag:
      | {
          kind: DragKind;
          pointerId: number;
          cornerIndex?: number;
          stripe: Stripe;
          startClient: { x: number; y: number };
          center: GeoPoint;
          centerScreen: { x: number; y: number };
          initialDistance: number;
          axisScreen: { x: number; y: number };
        }
      | null = null;

    const syncAmapAppearance = () => {
      const layers = useWorkbenchStore.getState().layerVisibility;
      const mapStyle = layers.geographicContext ? "amap://styles/normal" : "amap://styles/light";
      amapContainer.dataset.amapGeographicContext = layers.geographicContext ? "visible" : "hidden";
      amapContainer.dataset.amapSurfaceRendering = layers.surfaceRendering ? "visible" : "hidden";
      amapContainer.dataset.amapMapStyle = mapStyle;
      amapMap?.setMapStyle(mapStyle);
      if (!amapMap?.setLayers || !amapSdk?.TileLayer) return;
      if (layers.surfaceRendering) {
        if (!amapSatelliteLayer) {
          amapSatelliteLayer = new amapSdk.TileLayer.Satellite({ zIndex: 1 });
          amapSatelliteLayer.__stripeLayerKind = "satellite";
        }
        if (!amapRoadnetLayer) {
          amapRoadnetLayer = new amapSdk.TileLayer.RoadNet({ zIndex: 2 });
          amapRoadnetLayer.__stripeLayerKind = "roadnet";
        }
        amapMap.setLayers(layers.geographicContext ? [amapSatelliteLayer, amapRoadnetLayer] : [amapSatelliteLayer]);
      } else if (amapStandardLayers.length) {
        amapMap.setLayers(amapStandardLayers);
      }
    };

    const scheduleAmapViewSync = () => {
      if (destroyed || amapSyncFrame !== null || !amapMap || useWorkbenchStore.getState().baseMapMode !== "amap" || useWorkbenchStore.getState().viewMode !== "2d") return;
      amapSyncFrame = window.requestAnimationFrame(() => {
        amapSyncFrame = null;
        if (destroyed || !amapMap || useWorkbenchStore.getState().baseMapMode !== "amap" || useWorkbenchStore.getState().viewMode !== "2d") return;
        const center = map.getCenter();
        const gcjCenter = wgs84ToGcj02(normalizeViewLon(center.lng), center.lat);
        const targetZoom = mapLibreZoomToAmapZoom(map.getZoom());
        amapContainer.dataset.amapSyncZoom = targetZoom.toFixed(2);
        amapContainer.dataset.amapSyncCenter = `${gcjCenter[0].toFixed(6)},${gcjCenter[1].toFixed(6)}`;
        amapMap.setZoomAndCenter(targetZoom, gcjCenter, true);
      });
    };

    const setAmapActive = async (active: boolean) => {
      const activationId = ++amapActivationId;
      syncAmapDomVisibility(active);
      if (!active) return;
      try {
        const configuration = await window.stripeApi.getAmapConfig();
        if (destroyed || activationId !== amapActivationId || useWorkbenchStore.getState().baseMapMode !== "amap" || useWorkbenchStore.getState().viewMode !== "2d") return;
        const sdk = await loadAmapSdk(configuration);
        amapSdk = sdk;
        if (destroyed || activationId !== amapActivationId || useWorkbenchStore.getState().baseMapMode !== "amap" || useWorkbenchStore.getState().viewMode !== "2d") return;
        if (!amapMap) {
          const center = map.getCenter();
          const geographicContext = useWorkbenchStore.getState().layerVisibility.geographicContext;
          amapMap = new sdk.Map(amapContainer, {
            viewMode: "2D",
            zoom: mapLibreZoomToAmapZoom(map.getZoom()),
            center: wgs84ToGcj02(normalizeViewLon(center.lng), center.lat),
            mapStyle: geographicContext ? "amap://styles/normal" : "amap://styles/light",
            showLabel: true,
            animateEnable: false
          });
          amapStandardLayers = amapMap.getLayers?.() ?? [];
          amapStandardLayers.forEach((layer) => { layer.__stripeLayerKind = "standard"; });
        }
        syncAmapAppearance();
        amapMap.resize();
        scheduleAmapViewSync();
        useWorkbenchStore.getState().setStatus(useWorkbenchStore.getState().layerVisibility.surfaceRendering
          ? "高德自然地表影像已加载；中文注记由地理脉络控制，规划对象已对齐"
          : "高德二维地图已加载；规划对象已对齐");
      } catch (error) {
        if (destroyed || activationId !== amapActivationId || useWorkbenchStore.getState().baseMapMode !== "amap" || useWorkbenchStore.getState().viewMode !== "2d") return;
        container.classList.remove("amap-active");
        amapContainer.classList.remove("active");
        useWorkbenchStore.getState().setBaseMapMode("offline");
        useWorkbenchStore.getState().setStatus(`${error instanceof Error ? error.message : "高德地图加载失败"}，已切回离线地图`);
      }
    };

    const refreshCharacterSet = () => {
      const labels = [
        ...countryLabels.map((item) => item.name),
        ...cityLabels.map((item) => item.name),
        ...chinaLabels.map((item) => item.name),
        ...groundAssetsRef.map((item) => item.name),
        ...useWorkbenchStore.getState().stripes.map((item) => item.name),
        "圆锥矩形视场"
      ].join("");
      textCharacterSet = Array.from(new Set([...BASE_LABEL_CHARACTERS, ...labels]));
    };

    const applyProjection = (viewMode: "2d" | "3d", resetCamera = false) => {
      const update = () => {
        if (destroyed || useWorkbenchStore.getState().viewMode !== viewMode) return;
        map.setProjection({ type: viewMode === "3d" ? "globe" : "mercator" });
        map.setMinZoom(viewMode === "3d" ? 0 : 1);
        const applyCamera = () => {
          if (destroyed || useWorkbenchStore.getState().viewMode !== viewMode) return;
          if (resetCamera && viewMode === "3d") {
            const state = useWorkbenchStore.getState();
            const selectedStripe = state.selection?.kind === "stripe"
              ? state.stripes.find((stripe) => stripe.id === state.selection?.id && stripe.visible)
              : undefined;
            const selectedCenter = selectedStripe ? stripeCenter(selectedStripe.corners) : undefined;
            map.jumpTo({
              center: selectedCenter
                ? [normalizeViewLon(selectedCenter.lon), selectedCenter.lat]
                : planarCamera?.center ?? map.getCenter(),
              zoom: selectedStripe ? 3.5 : Math.min(3, Math.max(2, planarCamera?.zoom ?? map.getZoom())),
              pitch: 0,
              bearing: 0
            });
          } else if (resetCamera && viewMode === "2d" && planarCamera) {
            map.jumpTo(planarCamera);
            planarCamera = null;
          } else {
            map.jumpTo({ pitch: 0, bearing: 0 });
          }
          updateViewDiagnostics();
        };
        applyCamera();
        if (resetCamera) map.once("idle", applyCamera);
      };
      update();
    };

    const ensureGeographicContextLayers = () => {
      if (!styleReady) return;
      const state = useWorkbenchStore.getState();
      const usesAmap2d = state.baseMapMode === "amap" && state.viewMode === "2d";
      const usesAmapGlobe = state.baseMapMode === "amap" && state.viewMode === "3d";
      const visibility = state.layerVisibility.geographicContext && !usesAmap2d ? "visible" : "none";
      container.dataset.geographicContext = state.layerVisibility.geographicContext ? "visible" : "hidden";
      if (usesAmap2d) {
        GEOGRAPHIC_CONTEXT_LAYER_IDS.forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        });
        return;
      }
      if (usesAmapGlobe) {
        AMAP_FALLBACK_CONTEXT_LAYER_IDS.forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
        });
        if (map.getLayer("amap-globe-annotations")) {
          map.setLayoutProperty("amap-globe-annotations", "visibility", visibility);
        }
        GEOGRAPHIC_CONTEXT_LAYER_IDS.forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
        });
        return;
      }
      if (map.getSource("amap-fallback-world")) {
        const fallbackVisibility = state.layerVisibility.geographicContext ? "visible" : "none";
        AMAP_FALLBACK_CONTEXT_LAYER_IDS.forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", fallbackVisibility);
        });
      }
      const worldSource = map.getSource("world");
      if (worldSource) {
        OFFLINE_CONTEXT_LAYER_IDS.forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visibility);
        });
        return;
      }
      if (!map.getSource(GEOGRAPHIC_CONTEXT_SOURCE_ID)) {
        map.addSource(GEOGRAPHIC_CONTEXT_SOURCE_ID, {
          type: "vector",
          url: `pmtiles://${archiveUrl}`,
          attribution: "Natural Earth / 阿里云 DataV / PMTiles"
        });
      }
      if (!map.getLayer("geographic-context-countries-fill")) map.addLayer({
        id: "geographic-context-countries-fill", type: "fill", source: GEOGRAPHIC_CONTEXT_SOURCE_ID, "source-layer": "countries",
        paint: { "fill-color": "#c7dfd4", "fill-opacity": 0.24 }
      });
      if (!map.getLayer("geographic-context-countries-line")) map.addLayer({
        id: "geographic-context-countries-line", type: "line", source: GEOGRAPHIC_CONTEXT_SOURCE_ID, "source-layer": "countries",
        paint: { "line-color": "#377b70", "line-opacity": 0.78, "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.55, 8, 1.2] }
      });
      if (!map.getLayer("geographic-context-states-line")) map.addLayer({
        id: "geographic-context-states-line", type: "line", source: GEOGRAPHIC_CONTEXT_SOURCE_ID, "source-layer": "states", minzoom: 3,
        paint: { "line-color": "#6f9e99", "line-opacity": 0.72, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 8, 0.9] }
      });
      if (!map.getLayer("geographic-context-lakes-fill")) map.addLayer({
        id: "geographic-context-lakes-fill", type: "fill", source: GEOGRAPHIC_CONTEXT_SOURCE_ID, "source-layer": "lakes",
        paint: { "fill-color": "#76b8d1", "fill-opacity": 0.82 }
      });
      if (!map.getLayer("geographic-context-rivers-line")) map.addLayer({
        id: "geographic-context-rivers-line", type: "line", source: GEOGRAPHIC_CONTEXT_SOURCE_ID, "source-layer": "rivers",
        paint: { "line-color": "#57a5c3", "line-opacity": 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.35, 8, 1.1] }
      });
      GEOGRAPHIC_CONTEXT_LAYER_IDS.forEach((id) => map.setLayoutProperty(id, "visibility", visibility));
    };

    const ensureChinaStandardLayers = () => {
      if (!styleReady) return;
      const sourceId = map.getSource("world") ? "world" : CHINA_SOURCE_ID;
      if (sourceId === CHINA_SOURCE_ID && !map.getSource(CHINA_SOURCE_ID)) {
        map.addSource(CHINA_SOURCE_ID, {
          type: "vector",
          url: `pmtiles://${archiveUrl}`,
          attribution: "中国行政区划参考：阿里云 DataV；表达依据中国标准地图规范整理"
        });
      }
      if (!map.getLayer("china-standard-fill")) map.addLayer({
        id: "china-standard-fill", type: "fill", source: sourceId, "source-layer": "china_national",
        paint: { "fill-color": "#e7b950", "fill-opacity": 0.1 }
      });
      if (!map.getLayer("china-standard-provinces")) map.addLayer({
        id: "china-standard-provinces", type: "line", source: sourceId, "source-layer": "china_provinces", minzoom: 5,
        paint: { "line-color": "#8f6b2d", "line-opacity": 0.72, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.45, 9, 1] }
      });
      if (!map.getLayer("china-standard-border")) map.addLayer({
        id: "china-standard-border", type: "line", source: sourceId, "source-layer": "china_national",
        paint: { "line-color": "#9f2f26", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 1.2, 8, 2.3] }
      });
      if (!map.getLayer("china-standard-maritime")) map.addLayer({
        id: "china-standard-maritime", type: "line", source: sourceId, "source-layer": "china_maritime",
        paint: { "line-color": "#9f2f26", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1.2, 8, 2], "line-dasharray": [3, 2] }
      });
      const state = useWorkbenchStore.getState();
      const visibility = state.layerVisibility.chinaStandardMap && state.baseMapMode !== "amap" ? "visible" : "none";
      CHINA_LAYER_IDS.forEach((id) => map.setLayoutProperty(id, "visibility", visibility));
    };

    const ensureStripeLayers = () => {
      if (!styleReady) return;
      ensureGeographicContextLayers();
      ensureChinaStandardLayers();
    };

    const syncStripeSource = () => {
      if (!styleReady || !map.isStyleLoaded()) return;
      ensureStripeLayers();
      scheduleHandleUpdate();
    };


    const scheduleRender = () => {
      if (destroyed || frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (destroyed) return;
        render();
      });
    };

    const scheduleHandleUpdate = () => {
      if (destroyed || handleFrame !== null) return;
      handleFrame = window.requestAnimationFrame(() => {
        handleFrame = null;
        if (destroyed) return;
        updateHandles();
      });
    };

    const updateEditPreview = (corners: readonly GeoPoint[] | null, color = "#e9693f") => {
      if (!corners) {
        editPreviewSvg.style.display = "none";
        return;
      }
      const referenceLon = map.getCenter().lng;
      const points = corners.map((corner) => {
        const projected = map.project(pointArrayNear(corner, referenceLon));
        return `${projected.x},${projected.y}`;
      }).join(" ");
      editPreviewPolygon.setAttribute("points", points);
      editPreviewPolygon.setAttribute("fill", color);
      editPreviewPolygon.setAttribute("stroke", color);
      editPreviewSvg.style.display = "block";
    };

    const updateHandles = () => {
      if (drag) return;
      const state = useWorkbenchStore.getState();
      const selectedStripe = state.selection?.kind === "stripe"
        ? state.stripes.find((stripe) => stripe.id === state.selection?.id)
        : undefined;
      const center = map.getCenter();
      const nextHandleKey = selectedStripe && state.toolMode !== "draw-stripe" && state.viewMode === "2d"
        ? `${selectedStripe.id}:${selectedStripe.updatedAt}:${map.getZoom().toFixed(4)}:${center.lng.toFixed(5)}:${center.lat.toFixed(5)}`
        : "none";
      if (nextHandleKey === handleRenderKey) {
        if (nextHandleKey === "none") {
          handleLayer.replaceChildren();
          updateEditPreview(null);
        }
        return;
      }
      handleRenderKey = nextHandleKey;
      handleLayer.replaceChildren();
      if (selectedStripe && selectedStripe.visible && state.layerVisibility.stripes && state.toolMode !== "draw-stripe" && state.viewMode === "2d") {
        updateEditPreview((previewStripe ?? selectedStripe).corners, selectedStripe.color);
        createHandles(previewStripe ?? selectedStripe);
      } else {
        updateEditPreview(null);
      }
    };

    const render = () => {
      const state = useWorkbenchStore.getState();
      if (state.spacecraft !== tracksSpacecraftRef || state.orbitSamples !== tracksSamplesRef) {
        tracksSpacecraftRef = state.spacecraft;
        tracksSamplesRef = state.orbitSamples;
        visibleSpacecraftCache = state.spacecraft.filter((spacecraft) => spacecraft.visible);
        tracksCache = visibleSpacecraftCache
          .map((spacecraft) => ({ spacecraft, samples: state.orbitSamples[spacecraft.id] ?? [] }))
          .filter((item) => item.samples.length > 1);
      }
      if (state.groundAssets !== groundAssetsRef) {
        groundAssetsRef = state.groundAssets;
        visibleGroundAssets = groundAssetsRef.filter((asset) => asset.visible);
        groundAreaCache = visibleGroundAssets
          .filter((asset) => asset.kind === "target" && asset.radiusKm > 0)
          .map((asset) => ({ asset, boundary: geodesicCircle(asset.location, asset.radiusKm, 72) }));
        refreshCharacterSet();
      }
      if (state.stripes !== stripeRenderSourceRef) {
        stripeRenderSourceRef = state.stripes;
        stripeRenderCache = state.stripes.filter((stripe) => stripe.visible).map(createStripeRenderItem);
        refreshCharacterSet();
      }
      const selectedStripeId = state.selection?.kind === "stripe" ? state.selection.id : undefined;
      if (stripeDeckDataSourceRef !== stripeRenderCache || stripeDeckSelectionId !== selectedStripeId) {
        stripeDeckDataSourceRef = stripeRenderCache;
        stripeDeckSelectionId = selectedStripeId;
        stripeDeckDataCache = stripeRenderCache.filter((item) => item.stripe.id !== selectedStripeId);
      }
      const selectedStripe = selectedStripeId
        ? state.stripes.find((stripe) => stripe.id === selectedStripeId)
        : undefined;
      const usesDomEditPreview = state.viewMode === "2d"
        && state.toolMode !== "draw-stripe"
        && Boolean(selectedStripe?.visible)
        && state.layerVisibility.stripes;
      const stripeDeckDisplayData = usesDomEditPreview ? stripeDeckDataCache : stripeRenderCache;
      container.dataset.visibleStripeCount = state.layerVisibility.stripes ? String(stripeRenderCache.length) : "0";
      container.dataset.renderedStripeCount = state.layerVisibility.stripes ? String(stripeDeckDisplayData.length) : "0";
      container.dataset.draftPointCount = String(draftPoints.length);
      let stripePathsForView = stripeDeckDisplayData.length > 300 ? [] : stripeDeckDisplayData;
      if (stripeDeckDisplayData.length > 300) {
        const mapBounds = map.getBounds();
        const viewCenterLon = map.getCenter().lng;
        const west = mapBounds.getWest();
        const east = mapBounds.getEast();
        const south = mapBounds.getSouth();
        const north = mapBounds.getNorth();
        const visibleIds = new Set(stripeDeckDisplayData.filter((item) => {
          const itemCenterLon = (item.bounds.minLon + item.bounds.maxLon) / 2;
          let shift = 0;
          while (itemCenterLon + shift - viewCenterLon > 180) shift -= 360;
          while (itemCenterLon + shift - viewCenterLon < -180) shift += 360;
          return item.bounds.maxLon + shift >= west && item.bounds.minLon + shift <= east
            && item.bounds.maxLat >= south && item.bounds.minLat <= north;
        }).map((item) => item.stripe.id));
        stripePathsForView = visibleIds.size <= 300
          ? stripeDeckDisplayData.filter((item) => visibleIds.has(item.stripe.id))
          : [];
      }
      const spacecraftPoints = visibleSpacecraftCache
        .map((spacecraft) => {
          const closest = closestOrbitSample(state.orbitSamples[spacecraft.id] ?? [], state.scenario.currentTime);
          return closest ? { ...closest.sample, spacecraft } : null;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const footprintDescriptors = visibleSpacecraftCache
        .map((spacecraft) => {
          const sensor = state.sensors.find((item) => item.spacecraftId === spacecraft.id);
          const samples = state.orbitSamples[spacecraft.id] ?? [];
          const closest = closestOrbitSample(samples, state.scenario.currentTime);
          if (!sensor || !closest) return null;
          return { spacecraft, sensor, samples, closest };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      const nextFootprintKey = footprintDescriptors.map((item) => `${item.spacecraft.id}:${item.closest.sample.time}`).join("|");
      if (nextFootprintKey !== footprintKey || state.sensors !== footprintSensorsRef || state.orbitSamples !== footprintSamplesRef) {
        footprintKey = nextFootprintKey;
        footprintSensorsRef = state.sensors;
        footprintSamplesRef = state.orbitSamples;
        footprintCache = footprintDescriptors.map(({ spacecraft, sensor, samples, closest }) => ({
          spacecraft,
          sensor,
          sample: closest.sample,
          footprint: createSensorFootprint(closest.sample, sensor, orbitHeadingAtIndex(samples, closest.index), 48)
        }));
      }
      const sensorFootprints = footprintCache;
      const activeOverlap = state.activeOverlapId
        ? state.overlaps.find((item) => item.id === state.activeOverlapId)
        : undefined;
      const overlapComparison = activeOverlap
        ? ([
            ["A", state.stripes.find((stripe) => stripe.id === activeOverlap.stripeAId)],
            ["B", state.stripes.find((stripe) => stripe.id === activeOverlap.stripeBId)]
          ] as const)
            .filter((entry): entry is readonly ["A" | "B", Stripe] => Boolean(entry[1]?.visible))
            .map(([role, stripe]) => createOverlapComparisonItem(role, stripe))
        : [];

      overlay.setProps({
        layers: [
          new PolygonLayer({
            id: "stripe-plans",
            data: state.layerVisibility.stripes ? stripeDeckDisplayData : [],
            getPolygon: (item) => state.viewMode === "3d" ? item.globePolygon : item.polygon,
            getFillColor: (item) => item.fillColor,
            getLineColor: (item) => item.lineColor,
            getLineWidth: 1.4,
            lineWidthUnits: "pixels",
            filled: true,
            stroked: false,
            pickable: false,
            wrapLongitude: false,
            parameters: state.viewMode === "3d" ? STRIPE_GLOBE_PARAMETERS : undefined
          }),
          new PathLayer<StripeRenderItem>({
            id: "stripe-plan-edges",
            data: state.layerVisibility.stripes ? stripePathsForView : [],
            getPath: (item) => state.viewMode === "3d" ? item.globeBoundary : [...item.polygon, item.polygon[0]],
            getColor: (item) => item.lineColor,
            getWidth: 1.4,
            widthUnits: "pixels",
            widthMinPixels: 1,
            pickable: false,
            wrapLongitude: false,
            parameters: state.viewMode === "3d" ? STRIPE_GLOBE_PARAMETERS : undefined
          }),
          new PolygonLayer({
            id: "overlap-comparison-polygons",
            data: state.layerVisibility.stripes ? overlapComparison : [],
            getPolygon: (item) => item.polygon,
            getFillColor: (item) => item.fillColor,
            getLineColor: (item) => item.lineColor,
            getLineWidth: 3,
            lineWidthUnits: "pixels",
            filled: true,
            stroked: true,
            pickable: false,
            wrapLongitude: false
          }),
          new ScatterplotLayer({
            id: "overlap-comparison-markers",
            data: state.layerVisibility.stripes ? overlapComparison : [],
            getPosition: (item) => item.labelPoint,
            getRadius: 14,
            radiusUnits: "pixels",
            getFillColor: (item) => item.lineColor,
            getLineColor: [255, 255, 255, 255],
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            filled: true,
            stroked: true,
            pickable: false
          }),
          new TextLayer({
            id: "overlap-comparison-roles",
            data: state.layerVisibility.stripes ? overlapComparison : [],
            getPosition: (item) => item.labelPoint,
            getText: (item) => item.role,
            getSize: 15,
            getColor: [255, 255, 255, 255],
            getTextAnchor: "middle",
            getAlignmentBaseline: "center",
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            fontWeight: 700,
            billboard: true,
            pickable: false
          }),
          new TextLayer({
            id: "overlap-comparison-names",
            data: state.layerVisibility.stripes ? overlapComparison : [],
            getPosition: (item) => item.labelPoint,
            getText: (item) => `${item.role} · ${item.stripe.name}`,
            getSize: 12,
            getPixelOffset: [0, 23],
            getColor: (item) => item.lineColor,
            getTextAnchor: "middle",
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            fontSettings: { sdf: true, fontSize: 64, buffer: 4, radius: 12 },
            outlineColor: [255, 255, 255, 245],
            outlineWidth: 3,
            billboard: true,
            pickable: false
          }),
          new PolygonLayer({
            id: "ground-target-areas",
            data: state.layerVisibility.groundAssets ? groundAreaCache : [],
            getPolygon: (item) => item.boundary.map(pointArray),
            getFillColor: [222, 135, 63, 32],
            getLineColor: [188, 91, 35, 210],
            getLineWidth: 1.5,
            lineWidthUnits: "pixels",
            filled: true,
            stroked: true,
            pickable: true,
            wrapLongitude: true,
            onClick: (info) => info.object && useWorkbenchStore.getState().setSelection({ kind: "groundAsset", id: info.object.asset.id })
          }),
          new PolygonLayer({
            id: "sensor-footprints",
            data: state.layerVisibility.coverage ? sensorFootprints : [],
            getPolygon: (item) => item.footprint.boundary.map(pointArray),
            getFillColor: [45, 157, 255, 42],
            getLineColor: [17, 111, 174, 235],
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            filled: true,
            stroked: true,
            pickable: false,
            wrapLongitude: true
          }),
          new PathLayer<{ spacecraft: Spacecraft; samples: OrbitSample[] }>({
            id: "ground-tracks",
            data: state.layerVisibility.groundTracks ? tracksCache : [],
            getPath: (item) => item.samples.map(pointArray),
            getColor: (item) => {
              const color = item.spacecraft.color.replace("#", "");
              return [Number.parseInt(color.slice(0, 2), 16), Number.parseInt(color.slice(2, 4), 16), Number.parseInt(color.slice(4, 6), 16), 210];
            },
            getWidth: 1.6,
            widthUnits: "pixels",
            wrapLongitude: true
          }),
          new ScatterplotLayer({
            id: "spacecraft-points",
            data: state.layerVisibility.satellites ? spacecraftPoints : [],
            getPosition: (item) => [item.lon, item.lat],
            getRadius: 6,
            radiusUnits: "pixels",
            getFillColor: [45, 157, 255, 255],
            getLineColor: [11, 49, 75, 255],
            lineWidthUnits: "pixels",
            getLineWidth: 2,
            stroked: true,
            pickable: true,
            onClick: (info) => info.object && useWorkbenchStore.getState().setSelection({ kind: "spacecraft", id: info.object.spacecraft.id })
          }),
          new TextLayer({
            id: "sensor-footprint-labels",
            data: state.layerVisibility.coverage ? sensorFootprints : [],
            getPosition: (item) => [item.sample.lon, item.sample.lat],
            getText: (item) => `${item.sensor.shape === "conical" ? "圆锥" : "矩形"} FOV ${formatSensorFov(item.sensor)}`,
            getSize: 11,
            getPixelOffset: [0, 19],
            getColor: [16, 71, 104, 245],
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            fontSettings: { sdf: true, fontSize: 64, buffer: 4, radius: 12 },
            outlineColor: [235, 247, 251, 245],
            outlineWidth: 3,
            billboard: true,
            pickable: false
          }),
          new ScatterplotLayer({
            id: "ground-assets",
            data: state.layerVisibility.groundAssets ? visibleGroundAssets : [],
            getPosition: (asset) => pointArray(asset.location),
            getRadius: 5,
            radiusUnits: "pixels",
            getFillColor: (asset) => asset.kind === "station" ? [44, 135, 93, 255] : [207, 111, 55, 255],
            getLineColor: [255, 255, 255, 245],
            lineWidthUnits: "pixels",
            getLineWidth: 1.5,
            stroked: true,
            pickable: true,
            onClick: (info) => info.object && useWorkbenchStore.getState().setSelection({ kind: "groundAsset", id: info.object.id })
          }),
          new TextLayer({
            id: "china-standard-labels",
            data: state.layerVisibility.chinaStandardMap && state.baseMapMode !== "amap" ? chinaLabels.filter((item) => map.getZoom() >= item.minZoom) : [],
            getPosition: (item) => [item.lon, item.lat],
            getText: (item) => item.name,
            getSize: (item) => item.kind === "focus" ? 12 : 11,
            getColor: [132, 42, 34, 235],
            getPixelOffset: [0, -2],
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            fontSettings: { sdf: true, fontSize: 64, buffer: 4, radius: 12 },
            outlineColor: [255, 248, 232, 245],
            outlineWidth: 2,
            billboard: true,
            pickable: false
          }),
          new TextLayer({
            id: "country-labels",
            data: countryLabels.filter((country) => country.rank <= (map.getZoom() < 3 ? 2 : map.getZoom() < 4.5 ? 4 : 7)),
            getPosition: (country) => [country.lon, country.lat],
            getText: (country) => country.name,
            getSize: (country) => country.rank <= 2 ? 14 : country.rank <= 4 ? 12 : 11,
            getColor: [52, 60, 58, 225],
            getTextAnchor: "middle",
            getAlignmentBaseline: "center",
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            fontSettings: { sdf: true, fontSize: 64, buffer: 4, radius: 12 },
            outlineColor: [240, 242, 232, 235],
            outlineWidth: 2,
            billboard: true,
            visible: state.baseMapMode === "offline" && map.getZoom() >= 1.5
          }),
          new TextLayer({
            id: "city-labels",
            data: cityLabels.filter((city) => city.population >= (map.getZoom() < 4 ? 5_000_000 : map.getZoom() < 6 ? 1_000_000 : 500_000)),
            getPosition: (city) => [city.lon, city.lat],
            getText: (city) => city.name,
            getSize: (city) => city.population >= 5_000_000 ? 13 : 11,
            getColor: [63, 72, 74, 215],
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            billboard: true,
            visible: state.baseMapMode === "offline" && map.getZoom() >= 2.5
          }),
          new TextLayer({
            id: "ground-labels",
            data: state.layerVisibility.groundAssets ? visibleGroundAssets : [],
            getPosition: (asset) => pointArray(asset.location),
            getText: (asset) => asset.kind === "target" && asset.radiusKm > 0 ? `${asset.name}  R ${asset.radiusKm.toFixed(1)} km` : asset.name,
            getSize: 12,
            getPixelOffset: [0, -13],
            getColor: [33, 43, 48, 230],
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            billboard: true
          }),
          new H3HexagonLayer({
            id: "h3-render-warmup",
            data: H3_RENDER_WARMUP_CELL,
            getHexagon: (cell) => cell,
            getFillColor: [0, 0, 0, 0],
            filled: true,
            stroked: false,
            highPrecision: "auto",
            opacity: 0,
            pickable: false
          }),
          new H3HexagonLayer({
            id: "coverage-cells",
            data: state.layerVisibility.coverage ? state.coverageCells : [],
            getHexagon: (cell) => cell,
            getFillColor: [39, 155, 92, 92],
            getLineColor: [26, 110, 66, 180],
            getLineWidth: 0.6,
            lineWidthUnits: "pixels",
            filled: true,
            stroked: true,
            highPrecision: true,
            pickable: false
          }),
          ...(state.layerVisibility.h3 && state.h3.visible ? h3Chunks : []).map((cells, index) => new H3HexagonLayer({
            id: `h3-grid-${index}`,
            data: cells,
            getHexagon: (cell) => cell,
            getFillColor: [42, 117, 142, 7],
            getLineColor: [42, 117, 142, state.h3.resolution >= 10 ? 205 : 145],
            getLineWidth: state.h3.resolution >= 10 ? 0.8 : 1,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 0.75,
            filled: true,
            extruded: false,
            stroked: true,
            highPrecision: "auto",
            pickable: false
          })),
          new PathLayer({
            id: "draft-line",
            data: draftPoints.length ? [{ points: draftPoints }] : [],
            getPath: (item) => item.points.map(pointArray),
            getColor: [224, 91, 54, 255],
            getWidth: 2,
            widthUnits: "pixels",
            widthMinPixels: 1
          }),
          new PolygonLayer({
            id: "draft-polygon",
            data: draftPoints.length >= 3 ? [{ points: draftPoints }] : [],
            getPolygon: (item) => item.points.map(pointArray),
            getFillColor: [224, 91, 54, 30],
            getLineColor: [224, 91, 54, 0],
            filled: true,
            stroked: false,
            wrapLongitude: true
          }),
          new ScatterplotLayer({
            id: "draft-points",
            data: draftPoints,
            getPosition: pointArray,
            getRadius: 4,
            radiusUnits: "pixels",
            getFillColor: [255, 250, 239, 255],
            getLineColor: [224, 91, 54, 255],
            getLineWidth: 2,
            lineWidthUnits: "pixels",
            stroked: true
          })
        ]
      });

      updateHandles();
    };

    const createHandles = (stripe: Stripe) => {
      const viewLon = map.getCenter().lng;
      const displayPoint = (point: GeoPoint) => pointArrayNear(point, viewLon);
      const screens = stripe.corners.map((corner) => map.project(displayPoint(corner)));
      const frame = stripeFrame(stripe.corners);
      const centerPoint = map.project(displayPoint(frame.center));
      const middleAlong = (frame.minAlong + frame.maxAlong) / 2;
      const middleAcross = (frame.minAcross + frame.maxAcross) / 2;
      const framePoint = (alongDistance: number, acrossDistance: number) => fromEnu({
        x: frame.along.x * alongDistance + frame.across.x * acrossDistance,
        y: frame.along.y * alongDistance + frame.across.y * acrossDistance,
        z: 0
      }, frame.center);
      const front = map.project(displayPoint(framePoint(frame.maxAlong, middleAcross)));
      const side = map.project(displayPoint(framePoint(middleAlong, frame.maxAcross)));
      const minY = Math.min(...screens.map((point) => point.y));
      const maxY = Math.max(...screens.map((point) => point.y));
      const rotateX = Math.max(28, Math.min(container.clientWidth - 28, centerPoint.x));
      let rotateY: number;
      let rotateAnchorY: number;
      if (minY - 36 >= 28) {
        rotateY = minY - 34;
        rotateAnchorY = minY;
      } else if (maxY + 36 <= container.clientHeight - 28) {
        rotateY = maxY + 34;
        rotateAnchorY = maxY;
      } else {
        const direction = centerPoint.y > 70 ? -1 : 1;
        rotateY = Math.max(28, Math.min(container.clientHeight - 28, centerPoint.y + direction * 44));
        rotateAnchorY = centerPoint.y + direction * 12;
      }
      const stem = document.createElement("div");
      stem.className = "rotate-handle-stem";
      stem.style.left = `${rotateX}px`;
      stem.style.top = `${Math.min(rotateY, rotateAnchorY)}px`;
      stem.style.height = `${Math.abs(rotateY - rotateAnchorY)}px`;
      handleLayer.appendChild(stem);
      const descriptors: HandleDescriptor[] = [
        ...screens.map((point, cornerIndex) => ({ kind: "corner" as const, cornerIndex, point, label: "" })),
        ...screens.map((point, index) => ({ kind: "insert" as const, insertAfter: index, point: midpoint(point, screens[(index + 1) % screens.length]), label: "" })),
        { kind: "move", point: centerPoint, label: "✥" },
        { kind: "rotate", point: { x: rotateX, y: rotateY }, label: "↻" },
        { kind: "stretch-length", point: front, label: "" },
        { kind: "stretch-width", point: side, label: "" }
      ];
      for (const descriptor of descriptors) {
        const element = document.createElement("button");
        element.className = `map-edit-handle handle-${descriptor.kind}`;
        element.type = "button";
        element.textContent = descriptor.label;
        element.title = { corner: "拖动节点；右键删除", insert: "拖动以插入节点", move: "移动条带", rotate: "旋转条带", "stretch-length": "沿主轴拉伸", "stretch-width": "沿副轴拉伸" }[descriptor.kind];
        element.style.left = `${descriptor.point.x}px`;
        element.style.top = `${descriptor.point.y}px`;
        element.addEventListener("pointerdown", (event) => {
          if (descriptor.kind !== "insert") {
            beginDrag(event, descriptor as HandleDescriptor & { kind: DragKind }, stripe);
            return;
          }
          const insertAfter = descriptor.insertAfter ?? 0;
          const midpointGeo = stripeCenter([stripe.corners[insertAfter], stripe.corners[(insertAfter + 1) % stripe.corners.length]]);
          const corners = [...stripe.corners];
          corners.splice(insertAfter + 1, 0, midpointGeo);
          const expanded = { ...stripe, corners, updatedAt: new Date().toISOString() };
          beginDrag(event, { kind: "corner", cornerIndex: insertAfter + 1, point: descriptor.point, label: "" }, expanded);
        });
        if (descriptor.kind === "corner") element.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (stripe.corners.length <= 3 || descriptor.cornerIndex === undefined) {
            useWorkbenchStore.getState().setStatus("条带至少保留 3 个节点");
            return;
          }
          const corners = stripe.corners.filter((_point, index) => index !== descriptor.cornerIndex);
          useWorkbenchStore.getState().commitStripe(stripe.id, { ...stripe, corners, updatedAt: new Date().toISOString() });
          useWorkbenchStore.getState().setStatus(`已删除节点，当前 ${corners.length} 个节点`);
        });
        handleLayer.appendChild(element);
      }
    };

    const beginDrag = (event: PointerEvent, descriptor: HandleDescriptor & { kind: DragKind }, stripe: Stripe) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const element = event.currentTarget as HTMLElement;
      element.setPointerCapture(event.pointerId);
      const center = stripeCenter(stripe.corners);
      const centerScreen = map.project(pointArrayNear(center, map.getCenter().lng));
      const axisX = descriptor.point.x - centerScreen.x;
      const axisY = descriptor.point.y - centerScreen.y;
      const axisLength = Math.max(1, Math.hypot(axisX, axisY));
      drag = {
        kind: descriptor.kind,
        pointerId: event.pointerId,
        cornerIndex: descriptor.cornerIndex,
        stripe,
        startClient: { x: event.clientX, y: event.clientY },
        center,
        centerScreen,
        initialDistance: axisLength,
        axisScreen: { x: axisX / axisLength, y: axisY / axisLength }
      };
      map.dragPan.disable();
      map.doubleClickZoom.disable();
      element.addEventListener("pointermove", onDragMove);
      element.addEventListener("pointerup", endDrag, { once: true });
      element.addEventListener("pointercancel", cancelDrag, { once: true });
    };

    const onDragMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const rect = container.getBoundingClientRect();
      const mapPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      let corners = drag.stripe.corners;
      if (drag.kind === "corner" && drag.cornerIndex !== undefined) {
        const lngLat = map.unproject([mapPoint.x, mapPoint.y]);
        const next = [...corners];
        next[drag.cornerIndex] = { lon: lngLat.lng, lat: lngLat.lat };
        corners = next;
      } else if (drag.kind === "move") {
        const startLngLat = map.unproject([drag.startClient.x - rect.left, drag.startClient.y - rect.top]);
        const currentLngLat = map.unproject([mapPoint.x, mapPoint.y]);
        const start = toEnu({ lon: startLngLat.lng, lat: startLngLat.lat }, drag.center);
        const current = toEnu({ lon: currentLngLat.lng, lat: currentLngLat.lat }, drag.center);
        corners = transformStripe(corners, { translateEastKm: current.x - start.x, translateNorthKm: current.y - start.y });
      } else if (drag.kind === "rotate") {
        const startAngle = Math.atan2(drag.startClient.y - rect.top - drag.centerScreen.y, drag.startClient.x - rect.left - drag.centerScreen.x);
        const nextAngle = Math.atan2(mapPoint.y - drag.centerScreen.y, mapPoint.x - drag.centerScreen.x);
        corners = transformStripe(corners, { rotationDeg: ((nextAngle - startAngle) * 180) / Math.PI });
      } else {
        const projectedDistance = (mapPoint.x - drag.centerScreen.x) * drag.axisScreen.x + (mapPoint.y - drag.centerScreen.y) * drag.axisScreen.y;
        const factor = Math.max(0.05, Math.min(20, projectedDistance / drag.initialDistance));
        corners = scaleStripeAxes(corners, drag.kind === "stretch-length" ? factor : 1, drag.kind === "stretch-width" ? factor : 1);
      }
      previewStripe = { ...drag.stripe, corners, updatedAt: new Date().toISOString() };
      updateEditPreview(corners);
    };

    const endDrag = (event: PointerEvent) => {
      const element = event.currentTarget as HTMLElement;
      element.removeEventListener("pointermove", onDragMove);
      if (drag && previewStripe) {
        const validation = validateStripePolygon(previewStripe.corners);
        if (validation.valid) useWorkbenchStore.getState().commitStripe(drag.stripe.id, previewStripe);
        else useWorkbenchStore.getState().setStatus(`${validation.reason}，本次编辑未保存`);
      }
      drag = null;
      previewStripe = null;
      updateEditPreview(null);
      map.dragPan.enable();
      map.doubleClickZoom.enable();
      handleRenderKey = "";
      scheduleHandleUpdate();
    };

    const cancelDrag = (event: PointerEvent) => {
      const element = event.currentTarget as HTMLElement;
      element.removeEventListener("pointermove", onDragMove);
      drag = null;
      previewStripe = null;
      updateEditPreview(null);
      map.dragPan.enable();
      map.doubleClickZoom.enable();
      handleRenderKey = "";
      scheduleHandleUpdate();
    };

    const updateH3Status = () => {
      const visible = h3DisplayedCells.toLocaleString("zh-CN");
      const total = h3EstimatedCells.toLocaleString("zh-CN");
      const suffix = h3StreamComplete && !h3PendingChunks.length ? "" : "，正在渐进显示";
      useWorkbenchStore.getState().setStatus(h3StreamClipped
        ? `H3 ${h3StreamResolution} 级：显示中心区域 ${visible} / 预计 ${total} 个网格，层级未降低${suffix}`
        : `H3 ${h3StreamResolution} 级：${visible} 个网格${suffix}`);
    };

    const scheduleH3Chunk = () => {
      if (destroyed || h3ChunkFrame !== null || !h3PendingChunks.length) return;
      const requestId = h3RequestId;
      h3ChunkFrame = window.requestAnimationFrame(() => {
        h3ChunkFrame = null;
        if (destroyed || requestId !== h3RequestId) return;
        const chunk = h3PendingChunks.shift();
        if (!chunk) return;
        h3Chunks = [...h3Chunks, chunk];
        h3DisplayedCells += chunk.length;
        scheduleRender();
        updateH3Status();
        scheduleH3Chunk();
      });
    };

    const updateH3 = () => {
      const state = useWorkbenchStore.getState();
      h3RequestId += 1;
      if (h3ChunkFrame !== null) {
        window.cancelAnimationFrame(h3ChunkFrame);
        h3ChunkFrame = null;
      }
      h3PendingChunks = [];
      h3DisplayedCells = 0;
      h3EstimatedCells = 0;
      h3StreamClipped = false;
      h3StreamComplete = false;
      h3StreamResolution = state.h3.resolution;
      if (!state.h3.visible || !state.layerVisibility.h3) {
        if (h3Chunks.length) {
          h3Chunks = [];
          scheduleRender();
        }
        return;
      }
      if (h3Chunks.length) {
        h3Chunks = [];
        scheduleRender();
      }
      const bounds = map.getBounds();
      const rawWest = bounds.getWest();
      const rawEast = bounds.getEast();
      const fullWorld = rawEast - rawWest >= 360;
      const west = fullWorld ? -180 : normalizeViewLon(rawWest);
      const east = fullWorld ? 180 : normalizeViewLon(rawEast);
      h3Worker.postMessage({
        id: h3RequestId,
        resolution: state.h3.resolution,
        maxCells: state.h3.displayMaxCells,
        bounds: { west, south: Math.max(-85, bounds.getSouth()), east, north: Math.min(85, bounds.getNorth()) }
      });
    };

    const ensureH3DetailZoom = () => {
      const state = useWorkbenchStore.getState();
      if (!state.h3.visible || !state.layerVisibility.h3) return false;
      const minimumZoom = H3_MINIMUM_DETAIL_ZOOM[state.h3.resolution] ?? 16;
      if (map.getZoom() >= minimumZoom - 0.05) return false;
      const selectedStripe = state.selection?.kind === "stripe"
        ? state.stripes.find((stripe) => stripe.id === state.selection?.id)
        : undefined;
      const center = selectedStripe ? pointArrayNear(stripeCenter(selectedStripe.corners), map.getCenter().lng) : map.getCenter().toArray();
      useWorkbenchStore.getState().setStatus(`H3 ${state.h3.resolution} 级正在定位到可辨识比例尺`);
      map.easeTo({ center, zoom: minimumZoom, duration: 320 });
      return true;
    };

    const updateH3AfterMapIdle = () => {
      const idleRequestId = ++h3IdleRequestId;
      const run = () => {
        if (!destroyed && idleRequestId === h3IdleRequestId) updateH3();
      };
      if (map.areTilesLoaded()) run();
      else map.once("idle", run);
    };

    const focusSelectionWhenOutside = () => {
      const state = useWorkbenchStore.getState();
      let point: GeoPoint | undefined;
      if (state.selection?.kind === "stripe") {
        const stripe = state.stripes.find((item) => item.id === state.selection?.id);
        if (stripe) {
          const center = stripeCenter(stripe.corners);
          const displayCorners = stripe.corners.map((corner) => pointArrayNear(corner, center.lon));
          const projectedCorners = displayCorners.map((corner) => map.project(corner));
          const margin = 72;
          const fullyVisible = projectedCorners.every((projected) => projected.x >= margin
            && projected.x <= container.clientWidth - margin
            && projected.y >= margin
            && projected.y <= container.clientHeight - margin);
          if (fullyVisible) return;
          const longitudes = displayCorners.map((corner) => corner[0]);
          const latitudes = displayCorners.map((corner) => corner[1]);
          map.fitBounds([
            [Math.min(...longitudes), Math.min(...latitudes)],
            [Math.max(...longitudes), Math.max(...latitudes)]
          ], { padding: 128, maxZoom: state.viewMode === "3d" && state.baseMapMode !== "amap" ? 3.5 : 8, duration: 240 });
          return;
        }
      } else if (state.selection?.kind === "groundAsset") {
        point = state.groundAssets.find((item) => item.id === state.selection?.id)?.location;
      } else if (state.selection?.kind === "spacecraft") {
        const sample = closestOrbitSample(state.orbitSamples[state.selection.id] ?? [], state.scenario.currentTime);
        if (sample) point = sample.sample;
      }
      if (!point) return;
      const display = pointArrayNear(point, map.getCenter().lng);
      const projected = map.project(display);
      const margin = 48;
      if (projected.x >= margin && projected.x <= container.clientWidth - margin && projected.y >= margin && projected.y <= container.clientHeight - margin) return;
      map.easeTo({
        center: display,
        zoom: state.viewMode === "3d" && state.baseMapMode !== "amap" ? Math.min(3.5, Math.max(2, map.getZoom())) : Math.max(4, map.getZoom()),
        duration: 280
      });
    };

    const focusActiveOverlap = () => {
      const state = useWorkbenchStore.getState();
      const overlap = state.overlaps.find((item) => item.id === state.activeOverlapId);
      if (!overlap) return;
      const stripeA = state.stripes.find((item) => item.id === overlap.stripeAId);
      const stripeB = state.stripes.find((item) => item.id === overlap.stripeBId);
      if (!stripeA || !stripeB) return;
      const referenceLon = stripeCenter(stripeA.corners).lon;
      const points = [...stripeA.corners, ...stripeB.corners].map((corner) => pointArrayNear(corner, referenceLon));
      const projected = points.map((point) => map.project(point));
      const margin = 88;
      const fullyVisible = projected.every((point) => point.x >= margin
        && point.x <= container.clientWidth - margin
        && point.y >= margin
        && point.y <= container.clientHeight - margin);
      if (fullyVisible) return;
      map.fitBounds([
        [Math.min(...points.map((point) => point[0])), Math.min(...points.map((point) => point[1]))],
        [Math.max(...points.map((point) => point[0])), Math.max(...points.map((point) => point[1]))]
      ], { padding: 128, maxZoom: state.viewMode === "3d" && state.baseMapMode !== "amap" ? 3.5 : 8, duration: 260 });
    };

    h3Worker.onmessage = (event) => {
      if (destroyed || event.data.id !== h3RequestId) return;
      if (event.data.ok) {
        h3EstimatedCells = event.data.estimatedCells;
        h3StreamClipped ||= event.data.clipped;
        h3StreamResolution = useWorkbenchStore.getState().h3.resolution;
        if (event.data.kind === "chunk") {
          const renderChunkSize = 10_000;
          for (let index = 0; index < event.data.cells.length; index += renderChunkSize) {
            h3PendingChunks.push(event.data.cells.slice(index, index + renderChunkSize));
          }
          scheduleH3Chunk();
        } else {
          h3StreamComplete = true;
          if (!h3PendingChunks.length) updateH3Status();
        }
      } else {
        h3Chunks = [];
        if (event.data.reason === "too-many") {
          useWorkbenchStore.getState().setStatus(`当前范围预计 ${event.data.estimatedCells.toLocaleString("zh-CN")} 个 H3 网格，请缩小地图范围；层级不会自动降低`);
        }
      }
      scheduleRender();
    };

    const finishDraft = () => {
      const state = useWorkbenchStore.getState();
      const validation = validateStripePolygon(draftPoints);
      if (!validation.valid) {
        state.setStatus(validation.reason ?? "条带边界无效");
        return;
      }
      const timestamp = new Date().toISOString();
      state.addStripe({
        id: makeId("stripe"),
        name: `条带 ${state.stripes.length + 1}`,
        visible: true,
        color: "#e9693f",
        corners: draftPoints,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      const count = draftPoints.length;
      draftPoints = [];
      setDraftPointCount(0);
      state.setToolMode("select");
      state.setStatus(`${count} 节点条带已生成，可继续插入、删除、移动、旋转和拉伸节点`);
      scheduleRender();
    };

    const undoDraft = () => {
      if (!draftPoints.length) return;
      draftPoints = draftPoints.slice(0, -1);
      setDraftPointCount(draftPoints.length);
      useWorkbenchStore.getState().setStatus(`已撤回节点，当前 ${draftPoints.length} 个节点`);
      scheduleRender();
    };

    const cancelDraft = () => {
      draftPoints = [];
      setDraftPointCount(0);
      const state = useWorkbenchStore.getState();
      state.setToolMode("select");
      state.setStatus("已取消本次条带绘制");
      scheduleRender();
    };

    finishDraftRef.current = finishDraft;
    undoDraftRef.current = undoDraft;
    cancelDraftRef.current = cancelDraft;

    const stripeContainsPoint = (stripe: Stripe, point: GeoPoint) => {
      const ring = stripe.corners.map((corner) => pointArrayNear(corner, point.lon));
      let inside = false;
      for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const current = ring[index];
        const before = ring[previous];
        const crosses = (current[1] > point.lat) !== (before[1] > point.lat)
          && point.lon < ((before[0] - current[0]) * (point.lat - current[1])) / (before[1] - current[1]) + current[0];
        if (crosses) inside = !inside;
      }
      return inside;
    };

    const onMapClick = (event: maplibregl.MapMouseEvent) => {
      const state = useWorkbenchStore.getState();
      if (state.toolMode !== "draw-stripe") {
        const point = { lon: event.lngLat.lng, lat: event.lngLat.lat };
        const stripe = [...state.stripes].reverse().find((item) => item.visible && stripeContainsPoint(item, point));
        if (stripe) {
          state.setSelection({ kind: "stripe", id: stripe.id });
          state.setToolMode("select");
        }
        return;
      }
      const next = { lon: event.lngLat.lng, lat: event.lngLat.lat };
      if (draftPoints.length >= 3) {
        const first = map.project(pointArrayNear(draftPoints[0], map.getCenter().lng));
        if (Math.hypot(first.x - event.point.x, first.y - event.point.y) <= 14) {
          finishDraft();
          return;
        }
      }
      if (!draftPoints.length || haversineKm(draftPoints.at(-1)!, next) > 0.01) {
        draftPoints = [...draftPoints, next];
        setDraftPointCount(draftPoints.length);
      }
      state.setStatus(`已记录 ${draftPoints.length} 个节点；点击“完成绘制”、首节点、画笔按钮或按 Enter 完成`);
      scheduleRender();
    };

    const onMapDoubleClick = (event: maplibregl.MapMouseEvent) => {
      if (useWorkbenchStore.getState().toolMode !== "draw-stripe") return;
      event.preventDefault();
      finishDraft();
    };

    const onMapContextMenu = (event: maplibregl.MapMouseEvent) => {
      if (useWorkbenchStore.getState().toolMode !== "draw-stripe") return;
      event.preventDefault();
      finishDraft();
    };

    const onDrawingKeyDown = (event: KeyboardEvent) => {
      if (useWorkbenchStore.getState().toolMode !== "draw-stripe") return;
      if (event.key === "Enter") {
        event.preventDefault();
        finishDraft();
      } else if (event.key === "Backspace") {
        event.preventDefault();
        undoDraft();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelDraft();
      }
    };

    const onFinishDrawingRequest = () => {
      if (useWorkbenchStore.getState().toolMode !== "draw-stripe") return;
      if (!draftPoints.length) cancelDraft();
      else finishDraft();
    };

    type StyleRequest = { baseMapMode: BaseMapMode; viewMode: "2d" | "3d"; resetCamera: boolean };
    let styleRequestFrame: number | null = null;
    let styleTransitionActive = false;
    let styleTransitionTimeout: number | null = null;
    let pendingStyleRequest: StyleRequest | null = null;
    const scheduleNextStyleRequest = () => {
      if (destroyed || styleTransitionActive || styleRequestFrame !== null || !pendingStyleRequest) return;
      styleRequestFrame = window.requestAnimationFrame(() => {
        styleRequestFrame = null;
        if (destroyed || styleTransitionActive || !pendingStyleRequest) return;
        const request = pendingStyleRequest;
        pendingStyleRequest = null;
        styleTransitionActive = true;
        styleReady = false;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (styleTransitionTimeout !== null) {
            window.clearTimeout(styleTransitionTimeout);
            styleTransitionTimeout = null;
          }
          styleTransitionActive = false;
          const current = useWorkbenchStore.getState();
          if (current.baseMapMode === request.baseMapMode && current.viewMode === request.viewMode) {
            styleReady = true;
            applyProjection(request.viewMode, request.resetCamera);
            ensureStripeLayers();
            syncStripeSource();
            void setAmapActive(current.baseMapMode === "amap" && current.viewMode === "2d");
          }
          scheduleNextStyleRequest();
        };
        map.once("style.load", finish);
        styleTransitionTimeout = window.setTimeout(finish, 12000);
        try {
          map.setStyle(styleForBaseMap(
            request.baseMapMode,
            archiveUrl,
            amapOverviewUrl,
            amapSatelliteOverviewUrl,
            useWorkbenchStore.getState().layerVisibility.surfaceRendering,
            request.viewMode
          ));
          applyProjection(request.viewMode, request.resetCamera);
        } catch (error) {
          finish();
          useWorkbenchStore.getState().setStatus(error instanceof Error ? "底图切换失败：" + error.message : "底图切换失败，已保留当前地图");
        }
      });
    };
    const requestStyleChange = (request: StyleRequest) => {
      pendingStyleRequest = request;
      scheduleNextStyleRequest();
    };

    const unsubscribe = useWorkbenchStore.subscribe((state, previous) => {
      const selectedStripeId = state.selection?.kind === "stripe" ? state.selection.id : undefined;
      const changedStripeIndexes = state.stripes === previous.stripes || state.stripes.length !== previous.stripes.length
        ? []
        : state.stripes.flatMap((stripe, index) => stripe === previous.stripes[index] ? [] : [index]);
      const onlySelectedStripeChanged = changedStripeIndexes.length === 1
        && state.stripes[changedStripeIndexes[0]].id === selectedStripeId;
      if (onlySelectedStripeChanged && stripeRenderSourceRef === previous.stripes) {
        const changedStripe = state.stripes[changedStripeIndexes[0]];
        const renderIndex = stripeRenderCache.findIndex((item) => item.stripe.id === changedStripe.id);
        if (renderIndex >= 0) {
          stripeRenderCache = [...stripeRenderCache];
          if (changedStripe.visible) stripeRenderCache[renderIndex] = createStripeRenderItem(changedStripe);
          else stripeRenderCache.splice(renderIndex, 1);
          stripeRenderSourceRef = state.stripes;
          stripeDeckDataSourceRef = stripeRenderCache;
        }
      }
      const deckLayersChanged = state.scenario.currentTime !== previous.scenario.currentTime
        || state.spacecraft !== previous.spacecraft
        || state.sensors !== previous.sensors
        || state.orbitSamples !== previous.orbitSamples
        || (state.stripes !== previous.stripes && !onlySelectedStripeChanged)
        || state.selection !== previous.selection
        || state.groundAssets !== previous.groundAssets
        || state.coverageCells !== previous.coverageCells
        || state.overlaps !== previous.overlaps
        || state.activeOverlapId !== previous.activeOverlapId
        || state.layerVisibility !== previous.layerVisibility
        || state.baseMapMode !== previous.baseMapMode
        || state.viewMode !== previous.viewMode;
      if (deckLayersChanged) scheduleRender();
      const geographicContextChanged = state.layerVisibility.geographicContext !== previous.layerVisibility.geographicContext;
      const surfaceRenderingChanged = state.layerVisibility.surfaceRendering !== previous.layerVisibility.surfaceRendering;
      if ((geographicContextChanged || surfaceRenderingChanged) && state.baseMapMode === "amap" && state.viewMode === "2d") syncAmapAppearance();
      if ((geographicContextChanged || state.layerVisibility.chinaStandardMap !== previous.layerVisibility.chinaStandardMap) && styleReady && map.isStyleLoaded()) {
        ensureStripeLayers();
      }
      const baseMapChanged = state.baseMapMode !== previous.baseMapMode;
      const viewChanged = state.viewMode !== previous.viewMode;
      const wantsAmap = state.baseMapMode === "amap" && state.viewMode === "2d";
      const needsStyleChange = baseMapChanged
        || (viewChanged && state.baseMapMode === "amap")
        || (surfaceRenderingChanged && state.baseMapMode === "amap" && state.viewMode === "3d");
      if (baseMapChanged || viewChanged || (surfaceRenderingChanged && state.baseMapMode === "amap" && state.viewMode === "3d")) {
        if (!needsStyleChange) syncAmapDomVisibility(wantsAmap);
        if (viewChanged && state.viewMode === "3d") {
          const center = map.getCenter();
          planarCamera = {
            center: [normalizeViewLon(center.lng), center.lat],
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch()
          };
        }
        container.classList.toggle("amap-globe", state.baseMapMode === "amap" && state.viewMode === "3d");
        map.setMaxZoom(state.viewMode === "3d" ? 8 : 16);
        if (needsStyleChange) {
          void setAmapActive(false);
          requestStyleChange({ baseMapMode: state.baseMapMode, viewMode: state.viewMode, resetCamera: viewChanged });
        } else if (viewChanged) {
          applyProjection(state.viewMode, true);
        }
        if (viewChanged) {
          useWorkbenchStore.getState().setStatus(state.viewMode === "3d"
            ? state.baseMapMode === "amap"
              ? "高德球面规划视图：支持绘制与选择条带，精细变换请切回二维"
              : "三维地球规划视图：支持绘制与选择条带，精细变换请切回二维"
            : "二维地图编辑视图");
        }
      }
      if (state.stripes !== previous.stripes || state.layerVisibility.stripes !== previous.layerVisibility.stripes) syncStripeSource();
      if (state.selection !== previous.selection) syncStripeSource();
      if (state.selection !== previous.selection || state.stripes !== previous.stripes || state.toolMode !== previous.toolMode) scheduleHandleUpdate();
      if (state.h3.visible !== previous.h3.visible || state.h3.resolution !== previous.h3.resolution || state.h3.displayMaxCells !== previous.h3.displayMaxCells || state.layerVisibility.h3 !== previous.layerVisibility.h3) {
        if (!ensureH3DetailZoom()) updateH3();
      }
      if (state.toolMode !== "draw-stripe" && previous.toolMode === "draw-stripe") {
        draftPoints = [];
        setDraftPointCount(0);
        map.doubleClickZoom.enable();
      } else if (state.toolMode === "draw-stripe" && previous.toolMode !== "draw-stripe") {
        setDraftPointCount(0);
        map.doubleClickZoom.disable();
      }
      if (state.selection !== previous.selection || state.stripes.length > previous.stripes.length) focusSelectionWhenOutside();
      if (state.activeOverlapId !== previous.activeOverlapId) focusActiveOverlap();
    });
    map.on("click", onMapClick);
    map.on("dblclick", onMapDoubleClick);
    map.on("contextmenu", onMapContextMenu);
    map.on("move", scheduleAmapViewSync);
    window.addEventListener("keydown", onDrawingKeyDown);
    window.addEventListener(FINISH_STRIPE_DRAWING_EVENT, onFinishDrawingRequest);
    map.on("movestart", () => {
      if (!drag) {
        handleLayer.style.visibility = "hidden";
        editPreviewSvg.style.visibility = "hidden";
      }
    });
    map.on("moveend", () => {
      handleLayer.style.visibility = "visible";
      editPreviewSvg.style.visibility = "visible";
      handleRenderKey = "";
      scheduleHandleUpdate();
      updateH3AfterMapIdle();
      scheduleRender();
    });
    map.on("zoomend", scheduleRender);
    map.once("load", () => {
      if (destroyed) return;
      styleReady = true;
      const state = useWorkbenchStore.getState();
      syncAmapDomVisibility();
      container.classList.toggle("amap-globe", state.baseMapMode === "amap" && state.viewMode === "3d");
      applyProjection(state.viewMode, state.viewMode === "3d");
      ensureStripeLayers();
      syncStripeSource();
      render();
      void setAmapActive(state.baseMapMode === "amap" && state.viewMode === "2d");
      if (!ensureH3DetailZoom()) updateH3AfterMapIdle();
    });
    fetch(assetUrl("maps/cities.json"))
      .then((response) => response.ok ? response.json() : [])
      .then((cities) => {
        if (destroyed) return;
        cityLabels = Array.isArray(cities) ? cities : [];
        refreshCharacterSet();
        scheduleRender();
      })
      .catch(() => undefined);
    fetch(assetUrl("maps/country-labels.json"))
      .then((response) => response.ok ? response.json() : [])
      .then((countries) => {
        if (destroyed) return;
        countryLabels = Array.isArray(countries)
          ? countries.filter((country) => !/中华民国|台湾|臺灣|Taiwan|Republic of China/i.test(String(country?.name ?? "")))
          : [];
        refreshCharacterSet();
        scheduleRender();
      })
      .catch(() => undefined);
    fetch(assetUrl("maps/china-standard-labels.json"))
      .then((response) => response.ok ? response.json() : [])
      .then((labels) => {
        if (destroyed) return;
        chinaLabels = Array.isArray(labels) ? labels : [];
        refreshCharacterSet();
        scheduleRender();
      })
      .catch(() => undefined);

    return () => {
      destroyed = true;
      h3IdleRequestId += 1;
      h3RequestId += 1;
      unsubscribe();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (handleFrame !== null) window.cancelAnimationFrame(handleFrame);
      if (h3ChunkFrame !== null) window.cancelAnimationFrame(h3ChunkFrame);
      if (amapSyncFrame !== null) window.cancelAnimationFrame(amapSyncFrame);
      if (styleRequestFrame !== null) window.cancelAnimationFrame(styleRequestFrame);
      if (styleTransitionTimeout !== null) window.clearTimeout(styleTransitionTimeout);
      h3Worker.terminate();
      window.removeEventListener("keydown", onDrawingKeyDown);
      window.removeEventListener(FINISH_STRIPE_DRAWING_EVENT, onFinishDrawingRequest);
      finishDraftRef.current = () => undefined;
      undoDraftRef.current = () => undefined;
      cancelDraftRef.current = () => undefined;
      amapActivationId += 1;
      amapMap?.destroy();
      amapContainer.remove();
      map.remove();
      handleLayer.remove();
      editPreviewSvg.remove();
    };
  }, []);

  return <div className="map-workbench-shell">
    <div className="map-workbench" ref={containerRef} />
    {draftPointCount > 0 && <div className="drawing-command-bar" role="toolbar" aria-label="条带绘制">
      <strong>{draftPointCount} 个节点</strong>
      <button type="button" title="撤回上一个节点" aria-label="撤回上一个节点" onClick={() => undoDraftRef.current()}><Undo2 size={15} /></button>
      <button type="button" title="取消绘制" aria-label="取消绘制" onClick={() => cancelDraftRef.current()}><X size={15} /></button>
      <button className="drawing-finish-command" type="button" disabled={draftPointCount < 3} onClick={() => finishDraftRef.current()}><Check size={15} />完成绘制</button>
    </div>}
  </div>;
}
