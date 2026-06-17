import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import type {
  BaseMapMode,
  CoordinateOrder,
  CoverageSettings,
  GroundTarget,
  H3GridSettings,
  LatLon,
  LayerVisibility,
  OrbitSample,
  PlannerDraft,
  ProjectState,
  SatelliteTle,
  ScenarioSettings,
  SimulationResult,
  Stripe,
  StripeOverlapAnalysis,
  ToolMode,
  WorkbenchTab
} from "./types";
import {
  buildStripeCorners,
  coordinatesForOutput,
  coverageCircle,
  coverageRadiusKm,
  analyzeStripeOverlaps,
  measureStripe,
  normalizeLatLon,
  project,
  rotatePoints,
  scalePoints,
  splitDateLinePath,
  translatePoints,
  unproject,
  unwrapLongitudes
} from "./utils/geo";
import {
  buildStripeCoverageGrid,
  computeAccessSample,
  computeSimulationResult,
  targetFromCurrentMapCenter
} from "./utils/simulation";
import { OfflineWorldLayer } from "./utils/offlineMap";
import { groundTrack, makeId, orbitPeriodMinutes, parseManualTles, sampleAt, withIds } from "./utils/tle";
import { parseStripeText } from "./utils/stripeImport";

const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   26166.47439209  .00016717  00000+0  30136-3 0  9997
2 25544  51.6313 331.6938 0003417 113.3422 246.7928 15.50065061517066`;

const DEFAULT_TLES = parseManualTles(ISS_TLE);

const DEFAULT_VISIBILITY: LayerVisibility = {
  stripes: true,
  satellites: true,
  groundTrack: true,
  subpoint: true,
  coverage: true,
  targets: true,
  accessHighlights: true,
  h3Grid: false
};

function toLatLng(point: LatLon): L.LatLngExpression {
  return [point.lat, point.lon];
}

function westLon(bounds: L.LatLngBounds) {
  return Math.max(-180, bounds.getWest());
}

function eastLon(bounds: L.LatLngBounds) {
  return Math.min(180, bounds.getEast());
}

function toDateTimeLocalValue(date: Date) {
  const pad = (value: number, size = 2) => value.toString().padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseDateTimeLocal(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function defaultScenario(): ScenarioSettings {
  const now = new Date();
  return {
    startTime: new Date(now.getTime() - 90 * 60_000).toISOString(),
    endTime: new Date(now.getTime() + 90 * 60_000).toISOString(),
    currentTime: now.toISOString(),
    playbackSpeed: 60,
    sampleStepSeconds: 60
  };
}

function stripeOutput(stripe: Stripe | undefined, order: CoordinateOrder) {
  if (!stripe) return "[]";
  return JSON.stringify(coordinatesForOutput(stripe.corners, order));
}

function trackSegments(samples: OrbitSample[]) {
  const segments: LatLon[][] = [[]];
  samples.forEach((sample) => {
    if (sample.crossedDateLine && segments[segments.length - 1].length) {
      segments.push([]);
    }
    segments[segments.length - 1].push({ lat: sample.lat, lon: sample.lon });
  });
  return segments.filter((segment) => segment.length > 1);
}

function uniqueTles(records: SatelliteTle[]) {
  const byKey = new Map<string, SatelliteTle>();
  records.forEach((record) => {
    const key = `${record.noradId ?? ""}-${record.line1}-${record.line2}`;
    byKey.set(key, record);
  });
  return Array.from(byKey.values());
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}分${remainSeconds}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}时${minutes % 60}分`;
}

function formatDateShort(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function secondsBetween(a: string, b: string) {
  return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 1000);
}

function scenarioProgress(scenario: ScenarioSettings) {
  const start = new Date(scenario.startTime).getTime();
  const end = new Date(scenario.endTime).getTime();
  const current = new Date(scenario.currentTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.min(100, Math.max(0, ((current - start) / (end - start)) * 100));
}

function currentOffsetMinutes(scenario: ScenarioSettings) {
  return (new Date(scenario.currentTime).getTime() - new Date(scenario.startTime).getTime()) / 60_000;
}

function scenarioTotalMinutes(scenario: ScenarioSettings) {
  return Math.max(1, secondsBetween(scenario.startTime, scenario.endTime) / 60);
}

function plannerFromStripe(stripe: Stripe | undefined): PlannerDraft | null {
  if (!stripe) return null;
  const metrics = measureStripe(stripe.corners);
  if (!metrics) return null;
  return {
    centerLat: Number(metrics.center.lat.toFixed(6)),
    centerLon: Number(metrics.center.lon.toFixed(6)),
    lengthKm: Number(metrics.lengthKm.toFixed(2)),
    widthKm: Number(metrics.widthKm.toFixed(2)),
    headingDeg: Number(metrics.headingDeg.toFixed(2))
  };
}

function relationLabel(relation: StripeOverlapAnalysis["relation"]) {
  return {
    separate: "分离",
    overlap: "部分重叠",
    a_contains_b: "A 包含 B",
    b_contains_a: "B 包含 A",
    same: "基本重合"
  }[relation];
}

function renderStripePreview(layer: L.LayerGroup | null, corners: LatLon[], renderer?: L.Renderer) {
  if (!layer) return;
  layer.clearLayers();
  splitDateLinePath(unwrapLongitudes(corners), true).forEach((segment) => {
    L.polygon(segment.map(toLatLng), {
      color: "#b22f25",
      fillColor: "#f1a25f",
      fillOpacity: 0.18,
      weight: 2,
      dashArray: "5 5",
      renderer
    }).addTo(layer);
  });
}

function h3CellBudget(resolution: number) {
  if (resolution >= 12) return 700;
  if (resolution >= 10) return 1200;
  if (resolution >= 8) return 1800;
  if (resolution >= 6) return 2600;
  return 3600;
}

export function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const offlineLayerRef = useRef<OfflineWorldLayer | null>(null);
  const osmLayerRef = useRef<L.TileLayer | null>(null);
  const stripeLayerRef = useRef<L.LayerGroup | null>(null);
  const stripePreviewLayerRef = useRef<L.LayerGroup | null>(null);
  const orbitLayerRef = useRef<L.LayerGroup | null>(null);
  const objectLayerRef = useRef<L.LayerGroup | null>(null);
  const simulationLayerRef = useRef<L.LayerGroup | null>(null);
  const h3LayerRef = useRef<L.LayerGroup | null>(null);
  const canvasRendererRef = useRef<L.Renderer | null>(null);
  const stripePreviewFrameRef = useRef<number | null>(null);
  const stripePreviewCornersRef = useRef<LatLon[] | null>(null);
  const toolModeRef = useRef<ToolMode>("draw");
  const stripeCountRef = useRef(0);

  const [activeTab, setActiveTab] = useState<WorkbenchTab>("scene");
  const [baseMapMode, setBaseMapMode] = useState<BaseMapMode>("offline");
  const [coordinateOrder, setCoordinateOrder] = useState<CoordinateOrder>("lonlat");
  const [toolMode, setToolMode] = useState<ToolMode>("draw");
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(DEFAULT_VISIBILITY);
  const [h3Grid, setH3Grid] = useState<H3GridSettings>({ show: false, resolution: 3 });
  const [scenario, setScenario] = useState<ScenarioSettings>(() => defaultScenario());
  const [isPlaying, setIsPlaying] = useState(false);
  const [stripes, setStripes] = useState<Stripe[]>([]);
  const [activeStripeId, setActiveStripeId] = useState<string | undefined>();
  const [draftCorners, setDraftCorners] = useState<LatLon[]>([]);
  const [stripeImportText, setStripeImportText] = useState("[[116.0,40.0],[117.0,40.0],[117.0,39.5],[116.0,39.5]]");
  const [plannerDraft, setPlannerDraft] = useState<PlannerDraft>({
    centerLat: 0,
    centerLon: 0,
    lengthKm: 500,
    widthKm: 50,
    headingDeg: 0
  });
  const [manualTle, setManualTle] = useState(ISS_TLE);
  const [tles, setTles] = useState<SatelliteTle[]>(DEFAULT_TLES);
  const [selectedTleId, setSelectedTleId] = useState<string | undefined>(DEFAULT_TLES[0]?.id);
  const [tleSearch, setTleSearch] = useState("ISS");
  const [tleGroup, setTleGroup] = useState("stations");
  const [tleNorad, setTleNorad] = useState("");
  const [spaceTrackUser, setSpaceTrackUser] = useState("");
  const [spaceTrackPassword, setSpaceTrackPassword] = useState("");
  const [coverage, setCoverage] = useState<CoverageSettings>({ show: true, halfConeDeg: 20 });
  const [groundTargets, setGroundTargets] = useState<GroundTarget[]>([
    {
      id: makeId("target"),
      name: "北京目标",
      lat: 39.9042,
      lon: 116.4074,
      heightKm: 0,
      minElevationDeg: 10,
      visible: true
    }
  ]);
  const [activeTargetId, setActiveTargetId] = useState<string | undefined>();
  const [coverageSpacingKm, setCoverageSpacingKm] = useState(120);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [status, setStatus] = useState("工作台已就绪。可绘制条带、导入 TLE 或运行动画仿真。");

  const activeStripe = stripes.find((stripe) => stripe.id === activeStripeId) ?? stripes[0];
  const selectedTle = tles.find((tle) => tle.id === selectedTleId) ?? tles[0];
  const currentTime = useMemo(() => new Date(scenario.currentTime), [scenario.currentTime]);
  const currentSample = selectedTle ? sampleAt(selectedTle, currentTime) : null;
  const periodMinutes = selectedTle ? orbitPeriodMinutes(selectedTle) : 96;
  const track = useMemo(
    () =>
      selectedTle && layerVisibility.satellites && layerVisibility.groundTrack
        ? groundTrack(selectedTle, currentTime, 96)
        : [],
    [selectedTle, currentTime.getTime(), layerVisibility.satellites, layerVisibility.groundTrack]
  );
  const exportText = stripeOutput(activeStripe, coordinateOrder);
  const stripeMetrics = useMemo(() => (activeStripe ? measureStripe(activeStripe.corners) : null), [activeStripe]);
  const stripeOverlapAnalyses = useMemo<StripeOverlapAnalysis[]>(
    () => analyzeStripeOverlaps(stripes, 12),
    [stripes]
  );
  const coverageRadius = currentSample ? coverageRadiusKm(currentSample.heightKm, coverage.halfConeDeg) : 0;
  const currentAccessSamples = useMemo(() => {
    if (!selectedTle) return [];
    return groundTargets
      .filter((target) => target.visible)
      .map((target) => computeAccessSample(selectedTle, target, currentTime))
      .filter((sample): sample is NonNullable<typeof sample> => Boolean(sample));
  }, [selectedTle, groundTargets, currentTime.getTime()]);
  const visibleAccessNow = currentAccessSamples.filter((sample) => sample.visible);

  function scheduleStripePreview(corners: LatLon[]) {
    stripePreviewCornersRef.current = corners;
    if (stripePreviewFrameRef.current !== null) return;
    stripePreviewFrameRef.current = window.requestAnimationFrame(() => {
      stripePreviewFrameRef.current = null;
      if (stripePreviewCornersRef.current) {
        renderStripePreview(
          stripePreviewLayerRef.current,
          stripePreviewCornersRef.current,
          canvasRendererRef.current ?? undefined
        );
      }
    });
  }

  function clearStripePreview() {
    if (stripePreviewFrameRef.current !== null) {
      window.cancelAnimationFrame(stripePreviewFrameRef.current);
      stripePreviewFrameRef.current = null;
    }
    stripePreviewCornersRef.current = null;
    stripePreviewLayerRef.current?.clearLayers();
  }

  function resetMapView() {
    const map = mapRef.current;
    if (!map) return;
    map.setView([18, 20], 2, { animate: false });
    map.invalidateSize(false);
    setStatus("地图视图已重置。");
  }

  useEffect(() => {
    toolModeRef.current = toolMode;
  }, [toolMode]);

  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      setScenario((value) => {
        const nextTime = new Date(new Date(value.currentTime).getTime() + value.playbackSpeed * 1000);
        const end = new Date(value.endTime);
        if (nextTime > end) {
          window.setTimeout(() => setIsPlaying(false), 0);
          return { ...value, currentTime: value.endTime };
        }
        return { ...value, currentTime: nextTime.toISOString() };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isPlaying]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;
    const mapElement = mapElementRef.current;

    const map = L.map(mapElement, {
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
      minZoom: 2,
      maxBounds: [[-85.05112878, -720], [85.05112878, 720]],
      maxBoundsViscosity: 0.35
    }).setView([24, 20], 2);
    mapRef.current = map;
    canvasRendererRef.current = L.canvas({ padding: 0.35 });

    L.control.zoom({ position: "bottomright", zoomInTitle: "放大", zoomOutTitle: "缩小" }).addTo(map);
    L.control
      .attribution({ position: "bottomleft" })
      .addAttribution("Natural Earth 离线地图 | OSM 在线底图")
      .addTo(map);

    const offlineLayer = new OfflineWorldLayer();
    offlineLayer.addTo(map);
    offlineLayerRef.current = offlineLayer;

    osmLayerRef.current = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "OpenStreetMap"
    });

    stripeLayerRef.current = L.layerGroup().addTo(map);
    stripePreviewLayerRef.current = L.layerGroup().addTo(map);
    orbitLayerRef.current = L.layerGroup().addTo(map);
    objectLayerRef.current = L.layerGroup().addTo(map);
    simulationLayerRef.current = L.layerGroup().addTo(map);
    h3LayerRef.current = L.layerGroup().addTo(map);

    let resizeFrame: number | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        map.invalidateSize(false);
      });
    });
    resizeObserver.observe(mapElement);

    map.on("click", (event) => {
      if (toolModeRef.current !== "draw") return;
      const point = normalizeLatLon({ lat: event.latlng.lat, lon: event.latlng.lng });
      setDraftCorners((current) => {
        const next = [...current, point];
        if (next.length === 4) {
          const now = new Date().toISOString();
          stripeCountRef.current += 1;
          const stripe: Stripe = {
            id: makeId("stripe"),
            name: `条带 ${stripeCountRef.current}`,
            corners: next,
            visible: true,
            createdAt: now,
            updatedAt: now
          };
          setStripes((items) => [...items, stripe]);
          setActiveStripeId(stripe.id);
          setToolMode("select");
          setActiveTab("stripe");
          setStatus("四角条带已生成，可继续拖动角点、中心点、旋转手柄或拉伸手柄。");
          return [];
        }
        setStatus(`已记录 ${next.length}/4 个角点。`);
        return next;
      });
    });

    return () => {
      resizeObserver.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      clearStripePreview();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !offlineLayerRef.current || !osmLayerRef.current) return;
    if (baseMapMode === "offline") {
      if (map.hasLayer(osmLayerRef.current)) map.removeLayer(osmLayerRef.current);
      if (!map.hasLayer(offlineLayerRef.current)) offlineLayerRef.current.addTo(map);
    } else {
      if (map.hasLayer(offlineLayerRef.current)) map.removeLayer(offlineLayerRef.current);
      if (!map.hasLayer(osmLayerRef.current)) osmLayerRef.current.addTo(map);
    }
  }, [baseMapMode]);

  useEffect(() => {
    const layer = stripeLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!layerVisibility.stripes) return;

    if (draftCorners.length) {
      L.polyline(draftCorners.map(toLatLng), {
        color: "#c75635",
        dashArray: "6 6",
        weight: 2,
        renderer: canvasRendererRef.current ?? undefined
      }).addTo(layer);
      draftCorners.forEach((corner, index) => {
        L.circleMarker(toLatLng(corner), {
          radius: 5,
          color: "#c75635",
          fillColor: "#fff8ea",
          fillOpacity: 1,
          weight: 2,
          renderer: canvasRendererRef.current ?? undefined
        })
          .bindTooltip(`${index + 1}`)
          .addTo(layer);
      });
    }

    stripes
      .filter((stripe) => stripe.visible !== false)
      .forEach((stripe) => {
        const isActive = stripe.id === activeStripe?.id;
        const corners = stripe.corners;
        const unwrapped = unwrapLongitudes(corners);
        splitDateLinePath(unwrapped, true).forEach((segment) => {
          L.polygon(segment.map(toLatLng), {
            color: isActive ? "#c6462e" : "#476b6f",
            fillColor: isActive ? "#ed8e48" : "#5aa0a7",
            fillOpacity: isActive ? 0.32 : 0.22,
            weight: isActive ? 3 : 2,
            renderer: canvasRendererRef.current ?? undefined
          })
            .on("click", () => {
              setActiveStripeId(stripe.id);
              setToolMode("select");
              setActiveTab("stripe");
            })
            .addTo(layer);
        });

        if (!isActive) return;
        corners.forEach((corner, cornerIndex) => {
          const marker = L.marker(toLatLng(corner), {
            draggable: true,
            icon: L.divIcon({
              className: "corner-marker",
              html: `<span>${cornerIndex + 1}</span>`,
              iconSize: [24, 24],
              iconAnchor: [12, 12]
            })
          }).addTo(layer);
          marker.on("drag", () => {
            const position = marker.getLatLng();
            const nextCorners = [...corners];
            nextCorners[cornerIndex] = normalizeLatLon({ lat: position.lat, lon: position.lng });
            scheduleStripePreview(nextCorners);
          });
          marker.on("dragend", () => {
            const position = marker.getLatLng();
            updateStripe(stripe.id, (current) => {
              const nextCorners = [...current.corners];
              nextCorners[cornerIndex] = normalizeLatLon({ lat: position.lat, lon: position.lng });
              return { ...current, corners: nextCorners, updatedAt: new Date().toISOString() };
            });
            clearStripePreview();
          });
        });

        const projected = unwrapLongitudes(corners).map(project);
        const center = projected.reduce(
          (acc, point) => ({ x: acc.x + point.x / projected.length, y: acc.y + point.y / projected.length }),
          { x: 0, y: 0 }
        );
        const centerLatLon = unproject(center);
        const centerMarker = L.marker(toLatLng(centerLatLon), {
          draggable: true,
          icon: L.divIcon({
            className: "center-marker",
            html: "<span>移</span>",
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          })
        }).addTo(layer);
        let moveStartCenter = centerLatLon;
        let moveStartCorners = unwrapLongitudes(corners).map(project);
        centerMarker.on("dragstart", () => {
          moveStartCenter = normalizeLatLon({
            lat: centerMarker.getLatLng().lat,
            lon: centerMarker.getLatLng().lng
          });
          moveStartCorners = unwrapLongitudes(corners).map(project);
        });
        centerMarker.on("drag", () => {
          const nextCenter = normalizeLatLon({
            lat: centerMarker.getLatLng().lat,
            lon: centerMarker.getLatLng().lng
          });
          const delta = {
            x: project(nextCenter).x - project(moveStartCenter).x,
            y: project(nextCenter).y - project(moveStartCenter).y
          };
          scheduleStripePreview(translatePoints(moveStartCorners, delta).map(unproject));
        });
        centerMarker.on("dragend", () => {
          const nextCenter = normalizeLatLon({
            lat: centerMarker.getLatLng().lat,
            lon: centerMarker.getLatLng().lng
          });
          const delta = {
            x: project(nextCenter).x - project(moveStartCenter).x,
            y: project(nextCenter).y - project(moveStartCenter).y
          };
          updateStripe(stripe.id, (current) => ({
            ...current,
            corners: translatePoints(moveStartCorners, delta).map(unproject),
            updatedAt: new Date().toISOString()
          }));
          clearStripePreview();
        });

        const rotateAnchor = unproject({ x: center.x, y: center.y - 30 });
        const rotateMarker = L.marker(toLatLng(rotateAnchor), {
          draggable: true,
          icon: L.divIcon({
            className: "rotate-marker",
            html: "<span aria-hidden=\"true\">↻</span>",
            iconSize: [34, 34],
            iconAnchor: [17, 17]
          })
        }).addTo(layer);
        L.polyline([toLatLng(centerLatLon), toLatLng(rotateAnchor)], {
          color: "#34596a",
          dashArray: "3 5",
          weight: 1,
          opacity: 0.64,
          renderer: canvasRendererRef.current ?? undefined
        }).addTo(layer);
        let rotateStartAngle = Math.atan2(project(rotateAnchor).y - center.y, project(rotateAnchor).x - center.x);
        let rotateStartCorners = unwrapLongitudes(corners).map(project);
        rotateMarker.on("dragstart", () => {
          rotateStartAngle = Math.atan2(project(rotateAnchor).y - center.y, project(rotateAnchor).x - center.x);
          rotateStartCorners = unwrapLongitudes(corners).map(project);
        });
        rotateMarker.on("drag", () => {
          const next = project({ lat: rotateMarker.getLatLng().lat, lon: rotateMarker.getLatLng().lng });
          const nextAngle = Math.atan2(next.y - center.y, next.x - center.x);
          const deltaDeg = ((nextAngle - rotateStartAngle) * 180) / Math.PI;
          scheduleStripePreview(rotatePoints(rotateStartCorners, deltaDeg, center).map(unproject));
        });
        rotateMarker.on("dragend", () => {
          const next = project({ lat: rotateMarker.getLatLng().lat, lon: rotateMarker.getLatLng().lng });
          const nextAngle = Math.atan2(next.y - center.y, next.x - center.x);
          const deltaDeg = ((nextAngle - rotateStartAngle) * 180) / Math.PI;
          updateStripe(stripe.id, (current) => ({
            ...current,
            corners: rotatePoints(unwrapLongitudes(current.corners).map(project), deltaDeg, center).map(unproject),
            updatedAt: new Date().toISOString()
          }));
          clearStripePreview();
        });

        [
          { label: "宽", dx: 34, dy: 0, axis: "x" },
          { label: "长", dx: 0, dy: -34, axis: "y" }
        ].forEach((handle) => {
          const startPoint = { x: center.x + handle.dx, y: center.y + handle.dy };
          const marker = L.marker(toLatLng(unproject(startPoint)), {
            draggable: true,
            icon: L.divIcon({
              className: "stretch-marker",
              html: `<span>${handle.label}</span>`,
              iconSize: [26, 26],
              iconAnchor: [13, 13]
            })
          }).addTo(layer);
          let stretchStartCorners = unwrapLongitudes(corners).map(project);
          let stretchStartPointer = startPoint;
          marker.on("dragstart", () => {
            stretchStartCorners = unwrapLongitudes(corners).map(project);
            stretchStartPointer = project({
              lat: marker.getLatLng().lat,
              lon: marker.getLatLng().lng
            });
          });
          const calculateStretch = () => {
            const currentPointer = project({
              lat: marker.getLatLng().lat,
              lon: marker.getLatLng().lng
            });
            const startDistance =
              handle.axis === "x"
                ? Math.abs(stretchStartPointer.x - center.x)
                : Math.abs(stretchStartPointer.y - center.y);
            const currentDistance =
              handle.axis === "x"
                ? Math.abs(currentPointer.x - center.x)
                : Math.abs(currentPointer.y - center.y);
            const factor = Math.min(5, Math.max(0.08, currentDistance / Math.max(0.001, startDistance)));
            return scalePoints(
              stretchStartCorners,
              handle.axis === "x" ? factor : 1,
              handle.axis === "y" ? factor : 1,
              center
            ).map(unproject);
          };
          marker.on("drag", () => {
            scheduleStripePreview(calculateStretch());
          });
          marker.on("dragend", () => {
            updateStripe(stripe.id, (current) => ({
              ...current,
              corners: calculateStretch(),
              updatedAt: new Date().toISOString()
            }));
            clearStripePreview();
          });
        });
      });
  }, [stripes, draftCorners, activeStripe?.id, layerVisibility.stripes]);

  useEffect(() => {
    const layer = orbitLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!selectedTle || !currentSample || !layerVisibility.satellites) return;

    if (layerVisibility.groundTrack) {
      trackSegments(track).forEach((segment) => {
        L.polyline(segment.map(toLatLng), {
          color: "#2468a9",
          weight: 2,
          opacity: 0.84,
          renderer: canvasRendererRef.current ?? undefined
        }).addTo(layer);
      });
    }

    if (coverage.show && layerVisibility.coverage && coverageRadius > 0) {
      splitDateLinePath(coverageCircle(currentSample, coverageRadius), true).forEach((segment) => {
        L.polygon(segment.map(toLatLng), {
          color: "#7650a8",
          fillColor: "#7650a8",
          fillOpacity: 0.08,
          weight: 2,
          dashArray: "8 5",
          renderer: canvasRendererRef.current ?? undefined
        }).addTo(layer);
      });
    }

    if (layerVisibility.subpoint) {
      L.circleMarker(toLatLng(currentSample), {
        radius: 7,
        color: "#123f67",
        fillColor: "#38a0ff",
        fillOpacity: 1,
        weight: 2,
        renderer: canvasRendererRef.current ?? undefined
      })
        .bindTooltip(`${selectedTle.name}<br>${currentSample.lat.toFixed(3)}, ${currentSample.lon.toFixed(3)}`, {
          permanent: false,
          direction: "top"
        })
        .addTo(layer);
    }
  }, [
    selectedTle,
    currentSample,
    track,
    coverage.show,
    coverage.halfConeDeg,
    coverageRadius,
    layerVisibility.satellites,
    layerVisibility.groundTrack,
    layerVisibility.coverage,
    layerVisibility.subpoint
  ]);

  useEffect(() => {
    const layer = objectLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!layerVisibility.targets) return;

    groundTargets
      .filter((target) => target.visible)
      .forEach((target) => {
        const access = currentAccessSamples.find((sample) => sample.targetId === target.id);
        const marker = L.marker(toLatLng(target), {
          draggable: true,
          icon: L.divIcon({
            className: access?.visible ? "target-marker target-visible" : "target-marker",
            html: `<span>${target.name.slice(0, 2)}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
          })
        }).addTo(layer);
        marker
          .bindTooltip(
            `${target.name}<br>仰角 ${access ? access.elevationDeg.toFixed(1) : "--"}°，斜距 ${
              access ? access.rangeKm.toFixed(0) : "--"
            } km`,
            { direction: "top" }
          )
          .on("click", () => {
            setActiveTargetId(target.id);
            setActiveTab("objects");
          });
        marker.on("dragend", () => {
          const position = marker.getLatLng();
          updateTarget(target.id, {
            lat: Number(position.lat.toFixed(6)),
            lon: Number(position.lng.toFixed(6))
          });
        });
      });
  }, [groundTargets, currentAccessSamples, layerVisibility.targets]);

  useEffect(() => {
    const layer = simulationLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!simulationResult) return;

    if (layerVisibility.accessHighlights) {
      visibleAccessNow.forEach((sample) => {
        const target = groundTargets.find((item) => item.id === sample.targetId);
        if (!target || !currentSample) return;
        L.polyline([toLatLng(target), toLatLng(currentSample)], {
          color: "#1d7b50",
          weight: 2,
          dashArray: "5 6",
          opacity: 0.72,
          renderer: canvasRendererRef.current ?? undefined
        }).addTo(layer);
      });
    }

    if (simulationResult.coverageGrid && layerVisibility.coverage) {
      const points = simulationResult.coverageGrid.points;
      const stride = Math.max(1, Math.ceil(points.length / 450));
      points.filter((_point, index) => index % stride === 0).forEach((point) => {
        L.circleMarker(toLatLng(point), {
          radius: 2.6,
          color: point.covered ? "#1f8a55" : "#9c6d5a",
          fillColor: point.covered ? "#28a96a" : "#d9a27a",
          fillOpacity: point.covered ? 0.78 : 0.42,
          weight: 1,
          renderer: canvasRendererRef.current ?? undefined
        }).addTo(layer);
      });
    }
  }, [simulationResult, visibleAccessNow, groundTargets, currentSample, layerVisibility.accessHighlights, layerVisibility.coverage]);

  useEffect(() => {
    const map = mapRef.current;
    const layer = h3LayerRef.current;
    if (!map || !layer) return;
    let cancelled = false;
    let frame: number | null = null;
    let redrawVersion = 0;
    const redraw = async () => {
      const version = ++redrawVersion;
      layer.clearLayers();
      if (!h3Grid.show || !layerVisibility.h3Grid) return;
      const { cellArea, cellToBoundary, latLngToCell, polygonToCells } = await import("h3-js");
      if (cancelled || version !== redrawVersion) return;
      const bounds = map.getBounds().pad(0.08);
      const zoom = map.getZoom();
      const center = bounds.getCenter();
      const northWest = bounds.getNorthWest();
      const northEast = bounds.getNorthEast();
      const southEast = bounds.getSouthEast();
      const southWest = bounds.getSouthWest();
      const widthKm = map.distance([center.lat, westLon(bounds)], [center.lat, eastLon(bounds)]) / 1000;
      const heightKm = map.distance(northWest, southWest) / 1000;
      const sampleCell = latLngToCell(center.lat, center.lng, h3Grid.resolution);
      const estimatedCells = Math.max(1, (widthKm * heightKm) / Math.max(0.000001, cellArea(sampleCell, "km2")));
      const maxExactCells = h3CellBudget(h3Grid.resolution);
      if (estimatedCells > maxExactCells) {
        setStatus(
          `H3 ${h3Grid.resolution} 级当前约 ${Math.round(estimatedCells).toLocaleString("zh-CN")} 个网格，超过流畅显示上限 ${maxExactCells.toLocaleString("zh-CN")}。请放大到更小区域后显示。`
        );
        return;
      }
      const ring = [
        [northWest.lng, northWest.lat],
        [northEast.lng, northEast.lat],
        [southEast.lng, southEast.lat],
        [southWest.lng, southWest.lat],
        [northWest.lng, northWest.lat]
      ];
      const cells = polygonToCells([ring], h3Grid.resolution, true);
      const lines: L.LatLngExpression[][] = [];
      cells.forEach((cell) => {
        const boundary = cellToBoundary(cell, true).map(([lon, lat]) => ({ lat, lon }));
        lines.push([...boundary, boundary[0]].map(toLatLng));
      });
      if (!lines.length) return;
      L.polyline(lines, {
        color: "#2a6f88",
        opacity: h3Grid.resolution >= 10 ? 0.58 : 0.42,
        weight: h3Grid.resolution >= 10 ? 0.8 : 1,
        interactive: false,
        renderer: canvasRendererRef.current ?? undefined
      }).addTo(layer);
    };
    const scheduleRedraw = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = null;
        void redraw();
      });
    };
    scheduleRedraw();
    const clearDuringMove = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      layer.clearLayers();
    };
    map.on("movestart zoomstart", clearDuringMove);
    map.on("moveend zoomend", scheduleRedraw);
    return () => {
      cancelled = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      map.off("movestart zoomstart", clearDuringMove);
      map.off("moveend zoomend", scheduleRedraw);
    };
  }, [h3Grid.show, h3Grid.resolution, layerVisibility.h3Grid]);

  function updateScenario(patch: Partial<ScenarioSettings>) {
    setScenario((value) => ({ ...value, ...patch }));
  }

  function setScenarioCurrentFromOffset(minutes: number) {
    const start = new Date(scenario.startTime);
    updateScenario({ currentTime: new Date(start.getTime() + minutes * 60_000).toISOString() });
  }

  function updateStripe(id: string, updater: (stripe: Stripe) => Stripe) {
    setStripes((items) => items.map((stripe) => (stripe.id === id ? updater(stripe) : stripe)));
  }

  function updateTarget(id: string, patch: Partial<GroundTarget>) {
    setGroundTargets((items) => items.map((target) => (target.id === id ? { ...target, ...patch } : target)));
  }

  function rotateActive(deltaDeg: number) {
    if (!activeStripe) return;
    updateStripe(activeStripe.id, (stripe) => ({
      ...stripe,
      corners: rotatePoints(unwrapLongitudes(stripe.corners).map(project), deltaDeg).map(unproject),
      updatedAt: new Date().toISOString()
    }));
  }

  function scaleActive(scaleX: number, scaleY: number) {
    if (!activeStripe) return;
    updateStripe(activeStripe.id, (stripe) => ({
      ...stripe,
      corners: scalePoints(unwrapLongitudes(stripe.corners).map(project), scaleX, scaleY).map(unproject),
      updatedAt: new Date().toISOString()
    }));
  }

  function deleteActive() {
    if (!activeStripe) return;
    setStripes((items) => items.filter((stripe) => stripe.id !== activeStripe.id));
    setActiveStripeId(undefined);
    setStatus("已删除当前条带。");
  }

  function generateStripeFromDraft() {
    const now = new Date().toISOString();
    const corners = buildStripeCorners(plannerDraft);
    if (activeStripe) {
      updateStripe(activeStripe.id, (stripe) => ({ ...stripe, corners, updatedAt: now, visible: true }));
      setStatus("已按参数更新当前条带。");
    } else {
      const stripe: Stripe = {
        id: makeId("stripe"),
        name: "参数条带",
        corners,
        visible: true,
        createdAt: now,
        updatedAt: now
      };
      setStripes((items) => [...items, stripe]);
      setActiveStripeId(stripe.id);
      setStatus("已按参数生成新条带。");
    }
  }

  function importStripesFromText() {
    const imported = parseStripeText(stripeImportText, coordinateOrder);
    if (!imported.length) {
      setStatus("没有识别到有效条带坐标。请使用 [[经度,纬度],...] 或每行四个点的格式。");
      return;
    }
    const startIndex = stripes.length;
    const namedImported = imported.map((stripe, index) => ({ ...stripe, name: `导入条带 ${startIndex + index + 1}` }));
    const next = [...stripes, ...namedImported];
    const analyses = analyzeStripeOverlaps(next, 12);
    setStripes(next);
    setActiveStripeId(imported[0].id);
    setActiveTab("stripe");
    setStatus(
      analyses.length
        ? `已导入 ${imported.length} 条条带，发现 ${analyses.length} 组覆盖/重叠关系。`
        : `已导入 ${imported.length} 条条带，暂未发现覆盖/重叠关系。`
    );
  }

  function readActiveStripeToDraft() {
    const draft = plannerFromStripe(activeStripe);
    if (!draft) {
      setStatus("当前没有可读取的条带。");
      return;
    }
    setPlannerDraft(draft);
    setStatus("已从当前条带读取中心、长宽和方位角。");
  }

  function useSatelliteSubpointForDraft() {
    if (!currentSample) {
      setStatus("当前没有有效卫星位置。");
      return;
    }
    setPlannerDraft((value) => ({
      ...value,
      centerLat: Number(currentSample.lat.toFixed(6)),
      centerLon: Number(currentSample.lon.toFixed(6))
    }));
    setActiveTab("stripe");
    setStatus("已使用当前卫星星下点作为条带中心。");
  }

  async function copyOutput() {
    await navigator.clipboard.writeText(exportText);
    setStatus("四角坐标数组已复制。");
  }

  async function copySimulationCsv() {
    if (!simulationResult) {
      setStatus("请先运行仿真。");
      return;
    }
    const rows = [
      ["类型", "对象", "开始", "结束", "持续秒", "最大仰角"],
      ...simulationResult.accessWindows.map((window) => {
        const target = groundTargets.find((item) => item.id === window.targetId);
        return [
          "访问窗口",
          target?.name ?? window.targetId,
          window.startTime,
          window.endTime,
          window.durationSeconds.toFixed(0),
          window.maxElevationDeg.toFixed(2)
        ];
      })
    ];
    const text = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    await navigator.clipboard.writeText(text);
    setStatus("仿真窗口 CSV 已复制。");
  }

  function addManualTles() {
    const records = parseManualTles(manualTle);
    if (!records.length) {
      setStatus("没有识别到有效 TLE。");
      return;
    }
    setTles((items) => {
      const merged = uniqueTles([...records, ...items]);
      setSelectedTleId(records[0].id);
      return merged;
    });
    setStatus(`已加入 ${records.length} 条手动 TLE。`);
  }

  async function fetchCelesTrak() {
    try {
      setStatus("正在从 CelesTrak 拉取 TLE...");
      const records = withIds(
        await window.stripeApi!.fetchCelesTrak({
          group: tleGroup,
          noradId: tleNorad,
          search: tleSearch
        })
      );
      if (!records.length) {
        setStatus("CelesTrak 没有返回匹配 TLE。");
        return;
      }
      setTles((items) => uniqueTles([...records, ...items]));
      setSelectedTleId(records[0].id);
      setStatus(`CelesTrak 返回 ${records.length} 条 TLE。`);
    } catch (error) {
      setStatus(`CelesTrak 拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function saveSpaceTrackCredentials() {
    if (!spaceTrackUser || !spaceTrackPassword) {
      setStatus("请输入 Space-Track 用户名和密码。");
      return;
    }
    await window.stripeApi!.saveSpaceTrackCredentials({
      username: spaceTrackUser,
      password: spaceTrackPassword
    });
    setSpaceTrackPassword("");
    setStatus("Space-Track 登录信息已加密保存到本机。");
  }

  async function fetchSpaceTrack() {
    try {
      setStatus("正在从 Space-Track 拉取 TLE...");
      const records = withIds(
        await window.stripeApi!.fetchSpaceTrack({
          noradId: tleNorad,
          search: tleSearch
        })
      );
      if (!records.length) {
        setStatus("Space-Track 没有返回匹配 TLE。");
        return;
      }
      setTles((items) => uniqueTles([...records, ...items]));
      setSelectedTleId(records[0].id);
      setStatus(`Space-Track 返回 ${records.length} 条 TLE。`);
    } catch (error) {
      setStatus(`Space-Track 拉取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function addTargetAtMapCenter() {
    const map = mapRef.current;
    const center = map ? normalizeLatLon({ lat: map.getCenter().lat, lon: map.getCenter().lng }) : { lat: 0, lon: 0 };
    const target = { ...targetFromCurrentMapCenter(center), name: `目标 ${groundTargets.length + 1}` };
    setGroundTargets((items) => [...items, target]);
    setActiveTargetId(target.id);
    setActiveTab("objects");
    setStatus("已在地图中心新增目标点，可拖动目标点调整位置。");
  }

  function runSimulation() {
    const result = computeSimulationResult(
      selectedTle,
      groundTargets,
      activeStripe,
      scenario,
      coverage.halfConeDeg,
      coverageSpacingKm
    );
    setSimulationResult(result);
    setActiveTab("simulation");
    setStatus(
      `仿真完成：${result.accessWindows.length} 个访问窗口，覆盖率 ${
        result.coveragePercent === undefined ? "--" : result.coveragePercent.toFixed(1)
      }%。`
    );
  }

  function previewCoverageGrid() {
    if (!activeStripe) {
      setStatus("请先选择一个条带。");
      return;
    }
    setSimulationResult({
      generatedAt: new Date().toISOString(),
      accessWindows: [],
      currentAccessSamples: currentAccessSamples,
      coverageGrid: buildStripeCoverageGrid(activeStripe, coverageSpacingKm)
    });
    setStatus("已生成条带覆盖采样网格预览。");
  }

  async function exportProject() {
    const payload: ProjectState = {
      stripes,
      tles,
      selectedTleId,
      coordinateOrder,
      baseMapMode,
      coverage,
      scenario,
      layerVisibility,
      groundTargets,
      h3Grid
    };
    const result = await window.stripeApi!.exportProject(payload);
    if (!result.canceled) setStatus(`项目已导出：${result.filePath}`);
  }

  async function importProject() {
    const result = await window.stripeApi!.importProject();
    if (result.canceled || !result.data) return;
    const data = result.data as Partial<ProjectState>;
    setStripes(data.stripes ?? []);
    setTles(data.tles?.length ? data.tles : DEFAULT_TLES);
    setSelectedTleId(data.selectedTleId ?? data.tles?.[0]?.id ?? DEFAULT_TLES[0]?.id);
    setCoordinateOrder(data.coordinateOrder ?? "lonlat");
    setBaseMapMode(data.baseMapMode ?? "offline");
    setCoverage(data.coverage ?? { show: true, halfConeDeg: 20 });
    setScenario(data.scenario ?? defaultScenario());
    setLayerVisibility({ ...DEFAULT_VISIBILITY, ...(data.layerVisibility ?? {}) });
    setGroundTargets(data.groundTargets ?? []);
    setH3Grid(data.h3Grid ?? { show: false, resolution: 3 });
    setStatus(`项目已导入：${result.filePath}`);
  }

  function setVisibility(key: keyof LayerVisibility, value: boolean) {
    setLayerVisibility((current) => ({ ...current, [key]: value }));
  }

  function renderSceneTab() {
    return (
      <section className="panel-section">
        <h2>场景时间</h2>
        <label className="row">
          <span>开始时间</span>
          <input
            type="datetime-local"
            step="1"
            value={toDateTimeLocalValue(new Date(scenario.startTime))}
            onChange={(event) => updateScenario({ startTime: parseDateTimeLocal(event.target.value).toISOString() })}
          />
        </label>
        <label className="row">
          <span>结束时间</span>
          <input
            type="datetime-local"
            step="1"
            value={toDateTimeLocalValue(new Date(scenario.endTime))}
            onChange={(event) => updateScenario({ endTime: parseDateTimeLocal(event.target.value).toISOString() })}
          />
        </label>
        <label className="row">
          <span>当前时间</span>
          <input
            type="datetime-local"
            step="1"
            value={toDateTimeLocalValue(new Date(scenario.currentTime))}
            onChange={(event) => updateScenario({ currentTime: parseDateTimeLocal(event.target.value).toISOString() })}
          />
        </label>
        <label className="slider">
          <span>
            场景进度 {scenarioProgress(scenario).toFixed(1)}%，偏移 {currentOffsetMinutes(scenario).toFixed(1)} 分钟
          </span>
          <input
            type="range"
            min="0"
            max={scenarioTotalMinutes(scenario)}
            step="0.25"
            value={currentOffsetMinutes(scenario)}
            onChange={(event) => setScenarioCurrentFromOffset(Number(event.target.value))}
          />
        </label>
        <div className="button-row">
          <button className={isPlaying ? "active" : ""} onClick={() => setIsPlaying((value) => !value)}>
            {isPlaying ? "暂停动画" : "播放动画"}
          </button>
          <button onClick={() => updateScenario(defaultScenario())}>重置时间</button>
        </div>
        <label className="row">
          <span>播放倍率</span>
          <input
            type="number"
            value={scenario.playbackSpeed}
            onChange={(event) => updateScenario({ playbackSpeed: Number(event.target.value) || 1 })}
          />
        </label>
        <label className="row">
          <span>采样秒</span>
          <input
            type="number"
            min="10"
            value={scenario.sampleStepSeconds}
            onChange={(event) => updateScenario({ sampleStepSeconds: Number(event.target.value) || 60 })}
          />
        </label>
        <h2>底图与项目</h2>
        <div className="segmented wide">
          <button className={baseMapMode === "offline" ? "active" : ""} onClick={() => setBaseMapMode("offline")}>
            离线地图
          </button>
          <button className={baseMapMode === "osm" ? "active" : ""} onClick={() => setBaseMapMode("osm")}>
            OSM 在线
          </button>
        </div>
        <div className="button-row">
          <button onClick={importProject}>导入项目</button>
          <button onClick={exportProject}>导出项目</button>
        </div>
        <div className="notice">TLE + SGP4 适合规划辅助和基础仿真，不作为任务级精密定轨结果。</div>
      </section>
    );
  }

  function renderObjectsTab() {
    const activeTarget = groundTargets.find((target) => target.id === activeTargetId) ?? groundTargets[0];
    return (
      <section className="panel-section">
        <h2>对象显示</h2>
        <div className="switch-grid">
          {[
            ["stripes", "条带"],
            ["satellites", "卫星"],
            ["groundTrack", "轨迹"],
            ["subpoint", "星下点"],
            ["coverage", "覆盖"],
            ["targets", "目标"],
            ["accessHighlights", "访问线"],
            ["h3Grid", "H3 网格"]
          ].map(([key, label]) => (
            <label key={key} className="check-row">
              <input
                type="checkbox"
                checked={layerVisibility[key as keyof LayerVisibility]}
                onChange={(event) => setVisibility(key as keyof LayerVisibility, event.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <h2>地图网格</h2>
        <label className="check-row">
          <input
            type="checkbox"
            checked={h3Grid.show}
            onChange={(event) => {
              const show = event.target.checked;
              setH3Grid((value) => ({ ...value, show }));
              setVisibility("h3Grid", show);
            }}
          />
          <span>显示 H3 六边形网格</span>
        </label>
        <label className="slider">
          <span>网格层级 {h3Grid.resolution}，最高 13 级；高层级请放大到局部区域查看</span>
          <input
            type="range"
            min="0"
            max="13"
            step="1"
            value={h3Grid.resolution}
            onChange={(event) => setH3Grid((value) => ({ ...value, resolution: Number(event.target.value) }))}
          />
        </label>
        <label className="row">
          <span>H3 层级</span>
          <input
            type="number"
            min="0"
            max="13"
            step="1"
            value={h3Grid.resolution}
            onChange={(event) =>
              setH3Grid((value) => ({
                ...value,
                resolution: Math.min(13, Math.max(0, Math.round(Number(event.target.value) || 0)))
              }))
            }
          />
        </label>
        <h2>目标点 / 地面站</h2>
        <div className="button-row">
          <button onClick={addTargetAtMapCenter}>地图中心新增</button>
          <button
            onClick={() => {
              if (!activeTarget) return;
              setGroundTargets((items) => items.filter((target) => target.id !== activeTarget.id));
              setActiveTargetId(undefined);
            }}
          >
            删除目标
          </button>
        </div>
        <div className="object-list">
          {groundTargets.map((target) => {
            const access = currentAccessSamples.find((sample) => sample.targetId === target.id);
            return (
              <button
                key={target.id}
                className={target.id === activeTarget?.id ? "active item" : "item"}
                onClick={() => setActiveTargetId(target.id)}
              >
                <span>{target.name}</span>
                <small>{access?.visible ? "可见" : "不可见"}</small>
              </button>
            );
          })}
        </div>
        {activeTarget && (
          <>
            <label className="row">
              <span>名称</span>
              <input value={activeTarget.name} onChange={(event) => updateTarget(activeTarget.id, { name: event.target.value })} />
            </label>
            <label className="row">
              <span>纬度</span>
              <input
                type="number"
                step="0.000001"
                value={activeTarget.lat}
                onChange={(event) => updateTarget(activeTarget.id, { lat: Number(event.target.value) })}
              />
            </label>
            <label className="row">
              <span>经度</span>
              <input
                type="number"
                step="0.000001"
                value={activeTarget.lon}
                onChange={(event) => updateTarget(activeTarget.id, { lon: Number(event.target.value) })}
              />
            </label>
            <label className="row">
              <span>高度 km</span>
              <input
                type="number"
                step="0.001"
                value={activeTarget.heightKm}
                onChange={(event) => updateTarget(activeTarget.id, { heightKm: Number(event.target.value) })}
              />
            </label>
            <label className="row">
              <span>最小仰角</span>
              <input
                type="number"
                step="0.5"
                value={activeTarget.minElevationDeg}
                onChange={(event) => updateTarget(activeTarget.id, { minElevationDeg: Number(event.target.value) })}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={activeTarget.visible}
                onChange={(event) => updateTarget(activeTarget.id, { visible: event.target.checked })}
              />
              <span>显示并参与仿真</span>
            </label>
          </>
        )}
      </section>
    );
  }

  function renderStripeTab() {
    return (
      <section className="panel-section">
        <h2>条带参数</h2>
        <div className="input-grid">
          <label>
            <span>中心纬度</span>
            <input
              type="number"
              step="0.000001"
              value={plannerDraft.centerLat}
              onChange={(event) => setPlannerDraft((value) => ({ ...value, centerLat: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>中心经度</span>
            <input
              type="number"
              step="0.000001"
              value={plannerDraft.centerLon}
              onChange={(event) => setPlannerDraft((value) => ({ ...value, centerLon: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>长度 km</span>
            <input
              type="number"
              value={plannerDraft.lengthKm}
              onChange={(event) => setPlannerDraft((value) => ({ ...value, lengthKm: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>宽度 km</span>
            <input
              type="number"
              value={plannerDraft.widthKm}
              onChange={(event) => setPlannerDraft((value) => ({ ...value, widthKm: Number(event.target.value) }))}
            />
          </label>
          <label>
            <span>方位角 °</span>
            <input
              type="number"
              value={plannerDraft.headingDeg}
              onChange={(event) => setPlannerDraft((value) => ({ ...value, headingDeg: Number(event.target.value) }))}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="primary" onClick={generateStripeFromDraft}>生成条带</button>
          <button onClick={readActiveStripeToDraft}>读取当前条带</button>
          <button onClick={useSatelliteSubpointForDraft}>使用卫星位置</button>
        </div>
        <h2>坐标批量导入</h2>
        <textarea
          className="import-box"
          value={stripeImportText}
          onChange={(event) => setStripeImportText(event.target.value)}
          placeholder="支持 [[经度,纬度],[经度,纬度],[经度,纬度],[经度,纬度]]；多组可写成 [[[...]], [[...]]]，也可每行一组。"
        />
        <div className="button-row">
          <button className="primary" onClick={importStripesFromText}>导入并显示条带</button>
          <button
            onClick={() =>
              setStripeImportText("[[116.0,40.0],[117.0,40.0],[117.0,39.5],[116.0,39.5]]\n[[116.4,39.8],[117.4,39.8],[117.4,39.3],[116.4,39.3]]")
            }
          >
            填入示例
          </button>
        </div>
        <h2>当前条带</h2>
        <div className="metric-grid">
          <div>
            <span>中心</span>
            <strong>{stripeMetrics ? `${stripeMetrics.center.lat.toFixed(3)}, ${stripeMetrics.center.lon.toFixed(3)}` : "--"}</strong>
          </div>
          <div>
            <span>长 / 宽</span>
            <strong>{stripeMetrics ? `${stripeMetrics.lengthKm.toFixed(1)} / ${stripeMetrics.widthKm.toFixed(1)} km` : "--"}</strong>
          </div>
          <div>
            <span>面积估算</span>
            <strong>{stripeMetrics ? `${stripeMetrics.areaKm2.toFixed(0)} km²` : "--"}</strong>
          </div>
          <div>
            <span>方位角</span>
            <strong>{stripeMetrics ? `${stripeMetrics.headingDeg.toFixed(1)}°` : "--"}</strong>
          </div>
        </div>
        <label className="row">
          <span>坐标顺序</span>
          <select value={coordinateOrder} onChange={(event) => setCoordinateOrder(event.target.value as CoordinateOrder)}>
            <option value="lonlat">[经度, 纬度]</option>
            <option value="latlon">[纬度, 经度]</option>
          </select>
        </label>
        <textarea className="output" readOnly value={exportText} />
        <button className="primary" onClick={copyOutput}>复制数组</button>
        <h2>覆盖关系分析</h2>
        {stripeOverlapAnalyses.length ? (
          <div className="analysis-list">
            {stripeOverlapAnalyses.slice(0, 8).map((analysis) => (
              <button
                key={analysis.id}
                className="analysis-card"
                onClick={() => {
                  setActiveStripeId(analysis.stripeAId);
                  setStatus(`${analysis.stripeAName} 与 ${analysis.stripeBName}：${relationLabel(analysis.relation)}。`);
                }}
              >
                <strong>{analysis.stripeAName} / {analysis.stripeBName}</strong>
                <span>{relationLabel(analysis.relation)}，重叠约 {analysis.overlapAreaKm2.toFixed(1)} km²</span>
                <span>占 A {analysis.overlapPercentOfA.toFixed(1)}%，占 B {analysis.overlapPercentOfB.toFixed(1)}%</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty">当前多条带之间暂未检测到覆盖或重叠。</div>
        )}
        <div className="stripe-list">
          {stripes.map((stripe, index) => (
            <button
              key={stripe.id}
              className={stripe.id === activeStripe?.id ? "active item" : "item"}
              onClick={() => setActiveStripeId(stripe.id)}
            >
              {stripe.name || `条带 ${index + 1}`}
            </button>
          ))}
        </div>
      </section>
    );
  }

  function renderOrbitTab() {
    return (
      <section className="panel-section">
        <h2>卫星轨道</h2>
        <label className="row">
          <span>卫星</span>
          <select value={selectedTleId ?? ""} onChange={(event) => setSelectedTleId(event.target.value)}>
            {tles.map((tle) => (
              <option key={tle.id} value={tle.id}>
                {tle.name}
              </option>
            ))}
          </select>
        </label>
        <div className="metric-grid">
          <div>
            <span>纬度</span>
            <strong>{currentSample ? currentSample.lat.toFixed(4) : "--"}</strong>
          </div>
          <div>
            <span>经度</span>
            <strong>{currentSample ? currentSample.lon.toFixed(4) : "--"}</strong>
          </div>
          <div>
            <span>高度 km</span>
            <strong>{currentSample ? currentSample.heightKm.toFixed(2) : "--"}</strong>
          </div>
          <div>
            <span>速度 km/s</span>
            <strong>{currentSample ? currentSample.speedKmS.toFixed(3) : "--"}</strong>
          </div>
          <div>
            <span>周期</span>
            <strong>{periodMinutes.toFixed(1)} 分钟</strong>
          </div>
          <div>
            <span>覆盖半径</span>
            <strong>{coverageRadius.toFixed(1)} km</strong>
          </div>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={coverage.show}
            onChange={(event) => setCoverage((value) => ({ ...value, show: event.target.checked }))}
          />
          <span>显示传感器覆盖圈</span>
        </label>
        <label className="slider">
          <span>半锥角 {coverage.halfConeDeg.toFixed(1)}°</span>
          <input
            type="range"
            min="0"
            max="80"
            step="0.5"
            value={coverage.halfConeDeg}
            onChange={(event) => setCoverage((value) => ({ ...value, halfConeDeg: Number(event.target.value) }))}
          />
        </label>
        <h2>TLE 数据</h2>
        <textarea value={manualTle} onChange={(event) => setManualTle(event.target.value)} className="tle-box" />
        <button onClick={addManualTles}>加入手动 TLE</button>
        <div className="fetch-grid">
          <input value={tleSearch} onChange={(event) => setTleSearch(event.target.value)} placeholder="名称搜索，如 ISS" />
          <input value={tleNorad} onChange={(event) => setTleNorad(event.target.value)} placeholder="NORAD ID" />
          <input value={tleGroup} onChange={(event) => setTleGroup(event.target.value)} placeholder="CelesTrak 分组" />
          <button onClick={fetchCelesTrak}>拉取 CelesTrak</button>
        </div>
        <div className="credentials">
          <input value={spaceTrackUser} onChange={(event) => setSpaceTrackUser(event.target.value)} placeholder="Space-Track 用户名" />
          <input
            value={spaceTrackPassword}
            onChange={(event) => setSpaceTrackPassword(event.target.value)}
            placeholder="Space-Track 密码"
            type="password"
          />
          <button onClick={saveSpaceTrackCredentials}>保存账号</button>
          <button onClick={() => window.stripeApi!.clearSpaceTrackCredentials().then(() => setStatus("Space-Track 账号已清除。"))}>
            清除账号
          </button>
          <button onClick={fetchSpaceTrack}>拉取 Space-Track</button>
        </div>
      </section>
    );
  }

  function renderSimulationTab() {
    return (
      <section className="panel-section">
        <h2>基础仿真</h2>
        <div className="button-row">
          <button className="primary" onClick={runSimulation}>运行仿真</button>
          <button onClick={previewCoverageGrid}>预览网格</button>
          <button onClick={copySimulationCsv}>复制 CSV</button>
        </div>
        <label className="row">
          <span>网格间隔</span>
          <input
            type="number"
            min="20"
            value={coverageSpacingKm}
            onChange={(event) => setCoverageSpacingKm(Number(event.target.value) || 120)}
          />
        </label>
        <div className="metric-grid">
          <div>
            <span>访问窗口</span>
            <strong>{simulationResult ? simulationResult.accessWindows.length : "--"}</strong>
          </div>
          <div>
            <span>当前可见目标</span>
            <strong>{visibleAccessNow.length}</strong>
          </div>
          <div>
            <span>覆盖率</span>
            <strong>{simulationResult?.coveragePercent === undefined ? "--" : `${simulationResult.coveragePercent.toFixed(1)}%`}</strong>
          </div>
          <div>
            <span>重访估算</span>
            <strong>{simulationResult?.revisitMinutes ? `${simulationResult.revisitMinutes.toFixed(1)} 分` : "--"}</strong>
          </div>
        </div>
        <h2>当前访问状态</h2>
        <div className="access-list">
          {currentAccessSamples.length ? (
            currentAccessSamples.map((sample) => {
              const target = groundTargets.find((item) => item.id === sample.targetId);
              return (
                <div key={`${sample.targetId}-${sample.time}`} className={sample.visible ? "access-card visible" : "access-card"}>
                  <strong>{target?.name ?? sample.targetId}</strong>
                  <span>仰角 {sample.elevationDeg.toFixed(1)}°</span>
                  <span>方位 {sample.azimuthDeg.toFixed(1)}°</span>
                  <span>斜距 {sample.rangeKm.toFixed(0)} km</span>
                </div>
              );
            })
          ) : (
            <div className="empty">暂无目标点。</div>
          )}
        </div>
        <h2>访问窗口</h2>
        <div className="window-list">
          {simulationResult?.accessWindows.length ? (
            simulationResult.accessWindows.slice(0, 12).map((window) => {
              const target = groundTargets.find((item) => item.id === window.targetId);
              return (
                <div key={window.id} className="window-card">
                  <strong>{target?.name ?? window.targetId}</strong>
                  <span>{formatDateShort(window.startTime)} 至 {formatDateShort(window.endTime)}</span>
                  <span>持续 {formatDuration(window.durationSeconds)}，最大仰角 {window.maxElevationDeg.toFixed(1)}°</span>
                </div>
              );
            })
          ) : simulationResult ? (
            <div className="empty">当前场景时间范围内没有满足约束的访问窗口。</div>
          ) : (
            <div className="empty">运行仿真后显示访问窗口。</div>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className="app-shell">
      <section className="map-stage">
        <div className="top-toolbar">
          <div className="tool-group" aria-label="绘制工具">
            {(["draw", "select", "move", "rotate", "stretch"] as ToolMode[]).map((mode) => (
              <button
                key={mode}
                className={toolMode === mode ? "active" : ""}
                onClick={() => setToolMode(mode)}
                title={{
                  draw: "点击地图绘制四角条带",
                  select: "选择对象",
                  move: "拖动中心点移动",
                  rotate: "拖动旋转手柄",
                  stretch: "拖动拉伸手柄"
                }[mode]}
              >
                {{
                  draw: "绘制",
                  select: "选择",
                  move: "移动",
                  rotate: "旋转",
                  stretch: "拉伸"
                }[mode]}
              </button>
            ))}
          </div>
          <div className="tool-group">
            <button onClick={resetMapView} title="回到完整世界地图视图">重置视图</button>
            <button onClick={() => rotateActive(-5)}>左转</button>
            <button onClick={() => rotateActive(5)}>右转</button>
            <button onClick={() => scaleActive(1.08, 1)}>加宽</button>
            <button onClick={() => scaleActive(1, 1.08)}>加长</button>
            <button onClick={() => scaleActive(0.92, 0.92)}>缩小</button>
            <button onClick={deleteActive}>删除</button>
          </div>
          <button className={isPlaying ? "active orbit-toggle" : "orbit-toggle"} onClick={() => setIsPlaying((value) => !value)}>
            {isPlaying ? "暂停" : "播放"}
          </button>
          <button className="orbit-toggle" onClick={runSimulation}>仿真</button>
        </div>
        <div ref={mapElementRef} className="map" />
        <div className="time-chip">
          <span>场景时间</span>
          <strong>{formatDateShort(scenario.currentTime)}</strong>
        </div>
        <div className="status-bar">{status}</div>
      </section>

      <aside className="side-panel">
        <header>
          <div>
            <h1>卫星条带规划工具</h1>
            <p>轻量基础仿真工作台</p>
          </div>
        </header>
        <nav className="tab-bar">
          {[
            ["scene", "场景"],
            ["objects", "对象"],
            ["stripe", "条带"],
            ["orbit", "轨道"],
            ["simulation", "仿真"]
          ].map(([key, label]) => (
            <button
              key={key}
              className={activeTab === key ? "active" : ""}
              onClick={() => setActiveTab(key as WorkbenchTab)}
            >
              {label}
            </button>
          ))}
        </nav>
        {activeTab === "scene" && renderSceneTab()}
        {activeTab === "objects" && renderObjectsTab()}
        {activeTab === "stripe" && renderStripeTab()}
        {activeTab === "orbit" && renderOrbitTab()}
        {activeTab === "simulation" && renderSimulationTab()}
      </aside>
    </main>
  );
}
