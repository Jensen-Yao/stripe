import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { feature, mesh } from "topojson-client";
import countriesTopology from "world-atlas/countries-50m.json";
import type {
  BaseMapMode,
  CoordinateOrder,
  CoverageSettings,
  LatLon,
  OrbitSample,
  ProjectState,
  SatelliteTle,
  Stripe,
  ToolMode
} from "./types";
import {
  coordinatesForOutput,
  coverageCircle,
  coverageRadiusKm,
  normalizeLatLon,
  project,
  rotatePoints,
  scalePoints,
  splitDateLinePath,
  translatePoints,
  unproject,
  unwrapLongitudes
} from "./utils/geo";
import { groundTrack, makeId, orbitPeriodMinutes, parseManualTles, sampleAt, withIds } from "./utils/tle";

const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   26166.47439209  .00016717  00000+0  30136-3 0  9997
2 25544  51.6313 331.6938 0003417 113.3422 246.7928 15.50065061517066`;

const DEFAULT_TLES = parseManualTles(ISS_TLE);

type WorldTopology = {
  objects: {
    countries: unknown;
  };
};

function toLatLng(point: LatLon): L.LatLngExpression {
  return [point.lat, point.lon];
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

function formatDateTimeLocal(date: Date) {
  const pad = (value: number, size = 2) => value.toString().padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseDateTimeLocal(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function uniqueTles(records: SatelliteTle[]) {
  const byKey = new Map<string, SatelliteTle>();
  records.forEach((record) => {
    const key = `${record.noradId ?? ""}-${record.line1}-${record.line2}`;
    byKey.set(key, record);
  });
  return Array.from(byKey.values());
}

export function App() {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const offlineLayerRef = useRef<L.LayerGroup | null>(null);
  const osmLayerRef = useRef<L.TileLayer | null>(null);
  const stripeLayerRef = useRef<L.LayerGroup | null>(null);
  const orbitLayerRef = useRef<L.LayerGroup | null>(null);
  const toolModeRef = useRef<ToolMode>("draw");

  const [baseMapMode, setBaseMapMode] = useState<BaseMapMode>("offline");
  const [coordinateOrder, setCoordinateOrder] = useState<CoordinateOrder>("lonlat");
  const [toolMode, setToolMode] = useState<ToolMode>("draw");
  const [stripes, setStripes] = useState<Stripe[]>([]);
  const [activeStripeId, setActiveStripeId] = useState<string | undefined>();
  const [draftCorners, setDraftCorners] = useState<LatLon[]>([]);
  const [manualTle, setManualTle] = useState(ISS_TLE);
  const [tles, setTles] = useState<SatelliteTle[]>(DEFAULT_TLES);
  const [selectedTleId, setSelectedTleId] = useState<string | undefined>(DEFAULT_TLES[0]?.id);
  const [tleSearch, setTleSearch] = useState("ISS");
  const [tleGroup, setTleGroup] = useState("stations");
  const [tleNorad, setTleNorad] = useState("");
  const [spaceTrackUser, setSpaceTrackUser] = useState("");
  const [spaceTrackPassword, setSpaceTrackPassword] = useState("");
  const [centerTime, setCenterTime] = useState(() => new Date());
  const [timeOffsetMinutes, setTimeOffsetMinutes] = useState(0);
  const [coverage, setCoverage] = useState<CoverageSettings>({ show: true, halfConeDeg: 20 });
  const [status, setStatus] = useState("点击地图 4 次绘制第一条四角条带。");

  const activeStripe = stripes.find((stripe) => stripe.id === activeStripeId) ?? stripes[0];
  const selectedTle = tles.find((tle) => tle.id === selectedTleId) ?? tles[0];
  const periodMinutes = selectedTle ? orbitPeriodMinutes(selectedTle) : 96;
  const selectedTime = new Date(centerTime.getTime() + timeOffsetMinutes * 60_000);
  const currentSample = selectedTle ? sampleAt(selectedTle, selectedTime) : null;
  const track = useMemo(
    () => (selectedTle ? groundTrack(selectedTle, selectedTime) : []),
    [selectedTle, selectedTime.getTime()]
  );
  const exportText = stripeOutput(activeStripe, coordinateOrder);
  const coverageRadius = currentSample
    ? coverageRadiusKm(currentSample.heightKm, coverage.halfConeDeg)
    : 0;

  useEffect(() => {
    toolModeRef.current = toolMode;
  }, [toolMode]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;

    const map = L.map(mapElementRef.current, {
      worldCopyJump: true,
      zoomControl: false,
      attributionControl: false
    }).setView([24, 20], 2);
    mapRef.current = map;

    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control
      .attribution({ position: "bottomleft" })
      .addAttribution("Natural Earth offline map | OSM tiles when enabled")
      .addTo(map);

    const topology = countriesTopology as unknown as WorldTopology;
    const countries = feature(countriesTopology as never, topology.objects.countries as never);
    const borders = mesh(
      countriesTopology as never,
      topology.objects.countries as never,
      (a, b) => a !== b
    );
    const offlineLayer = L.layerGroup();
    L.geoJSON(countries as GeoJSON.GeoJsonObject, {
      interactive: false,
      style: {
        color: "#6d785f",
        weight: 0.45,
        fillColor: "#d8c76f",
        fillOpacity: 0.74
      }
    }).addTo(offlineLayer);
    L.geoJSON(borders as GeoJSON.GeoJsonObject, {
      interactive: false,
      style: {
        color: "#7b6e57",
        weight: 0.55,
        opacity: 0.72,
        fillOpacity: 0
      }
    }).addTo(offlineLayer);
    offlineLayer.addTo(map);
    offlineLayerRef.current = offlineLayer;

    osmLayerRef.current = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "OpenStreetMap"
    });

    stripeLayerRef.current = L.layerGroup().addTo(map);
    orbitLayerRef.current = L.layerGroup().addTo(map);

    map.on("click", (event) => {
      if (toolModeRef.current !== "draw") return;
      const point = normalizeLatLon({ lat: event.latlng.lat, lon: event.latlng.lng });
      setDraftCorners((current) => {
        const next = [...current, point];
        if (next.length === 4) {
          const now = new Date().toISOString();
          const stripe: Stripe = {
            id: makeId("stripe"),
            corners: next,
            createdAt: now,
            updatedAt: now
          };
          setStripes((items) => [...items, stripe]);
          setActiveStripeId(stripe.id);
          setToolMode("select");
          setStatus("四角条带已生成，可拖动角点、中心点、旋转手柄或拉伸手柄。");
          return [];
        }
        setStatus(`已记录 ${next.length}/4 个角点。`);
        return next;
      });
    });

    return () => {
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

    if (draftCorners.length) {
      L.polyline(draftCorners.map(toLatLng), {
        color: "#ca5a38",
        dashArray: "6 6",
        weight: 2
      }).addTo(layer);
      draftCorners.forEach((corner, index) => {
        L.circleMarker(toLatLng(corner), {
          radius: 5,
          color: "#ca5a38",
          fillColor: "#fff8ea",
          fillOpacity: 1,
          weight: 2
        })
          .bindTooltip(`${index + 1}`)
          .addTo(layer);
      });
    }

    stripes.forEach((stripe) => {
      const isActive = stripe.id === activeStripe?.id;
      const unwrapped = unwrapLongitudes(stripe.corners);
      splitDateLinePath(unwrapped, true).forEach((segment) => {
        L.polygon(segment.map(toLatLng), {
          color: isActive ? "#d04e2e" : "#476b6f",
          fillColor: isActive ? "#f09a55" : "#5aa0a7",
          fillOpacity: isActive ? 0.32 : 0.22,
          weight: isActive ? 3 : 2
        })
          .on("click", () => {
            setActiveStripeId(stripe.id);
            setToolMode("select");
          })
          .addTo(layer);
      });

      if (!isActive) return;
      stripe.corners.forEach((corner, cornerIndex) => {
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
          updateStripe(stripe.id, (current) => {
            const corners = [...current.corners];
            corners[cornerIndex] = normalizeLatLon({ lat: position.lat, lon: position.lng });
            return { ...current, corners, updatedAt: new Date().toISOString() };
          });
        });
      });

      const projected = unwrapLongitudes(stripe.corners).map(project);
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
      let previousCenter = centerLatLon;
      centerMarker.on("drag", () => {
        const nextCenter = normalizeLatLon({
          lat: centerMarker.getLatLng().lat,
          lon: centerMarker.getLatLng().lng
        });
        const delta = {
          x: project(nextCenter).x - project(previousCenter).x,
          y: project(nextCenter).y - project(previousCenter).y
        };
        previousCenter = nextCenter;
        updateStripe(stripe.id, (current) => ({
          ...current,
          corners: translatePoints(unwrapLongitudes(current.corners).map(project), delta).map(unproject),
          updatedAt: new Date().toISOString()
        }));
      });

      const rotateAnchor = unproject({ x: center.x, y: center.y + 24 });
      const rotateMarker = L.marker(toLatLng(rotateAnchor), {
        draggable: true,
        icon: L.divIcon({
          className: "rotate-marker",
          html: "<span>↻</span>",
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        })
      }).addTo(layer);
      L.polyline([toLatLng(centerLatLon), toLatLng(rotateAnchor)], {
        color: "#b54934",
        dashArray: "4 5",
        weight: 1
      }).addTo(layer);
      let previousAngle = Math.atan2(project(rotateAnchor).y - center.y, project(rotateAnchor).x - center.x);
      rotateMarker.on("drag", () => {
        const next = project({ lat: rotateMarker.getLatLng().lat, lon: rotateMarker.getLatLng().lng });
        const nextAngle = Math.atan2(next.y - center.y, next.x - center.x);
        const deltaDeg = ((nextAngle - previousAngle) * 180) / Math.PI;
        previousAngle = nextAngle;
        updateStripe(stripe.id, (current) => ({
          ...current,
          corners: rotatePoints(unwrapLongitudes(current.corners).map(project), deltaDeg).map(unproject),
          updatedAt: new Date().toISOString()
        }));
      });

      [
        { label: "宽", dx: 34, dy: 0, sx: 1.025, sy: 1 },
        { label: "长", dx: 0, dy: -34, sx: 1, sy: 1.025 }
      ].forEach((handle) => {
        const marker = L.marker(toLatLng(unproject({ x: center.x + handle.dx, y: center.y + handle.dy })), {
          draggable: true,
          icon: L.divIcon({
            className: "stretch-marker",
            html: `<span>${handle.label}</span>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13]
          })
        }).addTo(layer);
        let last = marker.getLatLng();
        marker.on("drag", () => {
          const current = marker.getLatLng();
          const direction = handle.dx !== 0 ? Math.sign(current.lng - last.lng) : Math.sign(last.lat - current.lat);
          last = current;
          const factor = direction >= 0 ? 1.025 : 0.975;
          updateStripe(stripe.id, (item) => ({
            ...item,
            corners: scalePoints(
              unwrapLongitudes(item.corners).map(project),
              handle.sx === 1 ? 1 : factor,
              handle.sy === 1 ? 1 : factor
            ).map(unproject),
            updatedAt: new Date().toISOString()
          }));
        });
      });
    });
  }, [stripes, draftCorners, activeStripe?.id]);

  useEffect(() => {
    const layer = orbitLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!selectedTle || !currentSample) return;

    trackSegments(track).forEach((segment) => {
      L.polyline(segment.map(toLatLng), {
        color: "#2b65aa",
        weight: 2,
        opacity: 0.84
      }).addTo(layer);
    });

    if (coverage.show && coverageRadius > 0) {
      splitDateLinePath(coverageCircle(currentSample, coverageRadius), true).forEach((segment) => {
        L.polygon(segment.map(toLatLng), {
          color: "#7b4bb1",
          fillColor: "#7b4bb1",
          fillOpacity: 0.08,
          weight: 2,
          dashArray: "8 5"
        }).addTo(layer);
      });
    }

    L.circleMarker(toLatLng(currentSample), {
      radius: 7,
      color: "#123f67",
      fillColor: "#38a0ff",
      fillOpacity: 1,
      weight: 2
    })
      .bindTooltip(`${selectedTle.name}<br>${currentSample.lat.toFixed(3)}, ${currentSample.lon.toFixed(3)}`, {
        permanent: false,
        direction: "top"
      })
      .addTo(layer);
  }, [selectedTle, currentSample, track, coverage.show, coverage.halfConeDeg, coverageRadius]);

  function updateStripe(id: string, updater: (stripe: Stripe) => Stripe) {
    setStripes((items) => items.map((stripe) => (stripe.id === id ? updater(stripe) : stripe)));
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

  async function copyOutput() {
    await navigator.clipboard.writeText(exportText);
    setStatus("四角坐标数组已复制。");
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

  async function exportProject() {
    const payload: ProjectState = {
      stripes,
      tles,
      selectedTleId,
      coordinateOrder,
      baseMapMode,
      coverage
    };
    const result = await window.stripeApi!.exportProject(payload);
    if (!result.canceled) setStatus(`项目已导出：${result.filePath}`);
  }

  async function importProject() {
    const result = await window.stripeApi!.importProject();
    if (result.canceled || !result.data) return;
    const data = result.data as Partial<ProjectState>;
    setStripes(data.stripes ?? []);
    setTles(data.tles ?? []);
    setSelectedTleId(data.selectedTleId ?? data.tles?.[0]?.id);
    setCoordinateOrder(data.coordinateOrder ?? "lonlat");
    setBaseMapMode(data.baseMapMode ?? "offline");
    setCoverage(data.coverage ?? { show: true, halfConeDeg: 20 });
    setStatus(`项目已导入：${result.filePath}`);
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
                  draw: "绘制四角条带",
                  select: "选择条带",
                  move: "拖动中心点移动",
                  rotate: "拖动旋转手柄",
                  stretch: "拖动拉伸手柄"
                }[mode]}
              >
                {{
                  draw: "✚",
                  select: "⌖",
                  move: "↕",
                  rotate: "↻",
                  stretch: "⇔"
                }[mode]}
              </button>
            ))}
          </div>
          <div className="tool-group">
            <button onClick={() => rotateActive(-5)} title="逆时针旋转 5 度">
              ↶
            </button>
            <button onClick={() => rotateActive(5)} title="顺时针旋转 5 度">
              ↷
            </button>
            <button onClick={() => scaleActive(1.08, 1)} title="加宽">
              ⇔+
            </button>
            <button onClick={() => scaleActive(1, 1.08)} title="加长">
              ⇕+
            </button>
            <button onClick={() => scaleActive(0.92, 0.92)} title="整体缩小">
              ⤡
            </button>
            <button onClick={deleteActive} title="删除当前条带">
              ⌫
            </button>
          </div>
          <div className="segmented">
            <button className={baseMapMode === "offline" ? "active" : ""} onClick={() => setBaseMapMode("offline")}>
              离线
            </button>
            <button className={baseMapMode === "osm" ? "active" : ""} onClick={() => setBaseMapMode("osm")}>
              OSM
            </button>
          </div>
        </div>
        <div ref={mapElementRef} className="map" />
        <div className="status-bar">{status}</div>
      </section>

      <aside className="side-panel">
        <header>
          <h1>Stripe</h1>
          <div className="panel-actions">
            <button onClick={importProject}>导入</button>
            <button onClick={exportProject}>导出</button>
          </div>
        </header>

        <section>
          <h2>条带坐标</h2>
          <label className="row">
            <span>顺序</span>
            <select value={coordinateOrder} onChange={(event) => setCoordinateOrder(event.target.value as CoordinateOrder)}>
              <option value="lonlat">[经度, 纬度]</option>
              <option value="latlon">[纬度, 经度]</option>
            </select>
          </label>
          <textarea className="output" readOnly value={exportText} />
          <button className="primary" onClick={copyOutput}>
            复制数组
          </button>
          <div className="stripe-list">
            {stripes.map((stripe, index) => (
              <button
                key={stripe.id}
                className={stripe.id === activeStripe?.id ? "active item" : "item"}
                onClick={() => setActiveStripeId(stripe.id)}
              >
                条带 {index + 1}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>轨道计算</h2>
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
          <label className="row">
            <span>中心时间</span>
            <input
              type="datetime-local"
              step="1"
              value={formatDateTimeLocal(centerTime)}
              onChange={(event) => {
                setCenterTime(parseDateTimeLocal(event.target.value));
                setTimeOffsetMinutes(0);
              }}
            />
          </label>
          <label className="slider">
            <span>
              时间滑条：{timeOffsetMinutes.toFixed(1)} 分钟 / ±{periodMinutes.toFixed(1)} 分钟
            </span>
            <input
              type="range"
              min={-periodMinutes}
              max={periodMinutes}
              step="0.5"
              value={timeOffsetMinutes}
              onChange={(event) => setTimeOffsetMinutes(Number(event.target.value))}
            />
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
          </div>
          <label className="row">
            <span>覆盖圈</span>
            <input
              type="checkbox"
              checked={coverage.show}
              onChange={(event) => setCoverage((value) => ({ ...value, show: event.target.checked }))}
            />
          </label>
          <label className="slider">
            <span>
              半锥角 {coverage.halfConeDeg.toFixed(1)}°，半径 {coverageRadius.toFixed(1)} km
            </span>
            <input
              type="range"
              min="0"
              max="80"
              step="0.5"
              value={coverage.halfConeDeg}
              onChange={(event) => setCoverage((value) => ({ ...value, halfConeDeg: Number(event.target.value) }))}
            />
          </label>
        </section>

        <section>
          <h2>TLE 数据</h2>
          <textarea value={manualTle} onChange={(event) => setManualTle(event.target.value)} className="tle-box" />
          <button onClick={addManualTles}>加入手动 TLE</button>
          <div className="fetch-grid">
            <input value={tleSearch} onChange={(event) => setTleSearch(event.target.value)} placeholder="名称搜索，如 ISS" />
            <input value={tleNorad} onChange={(event) => setTleNorad(event.target.value)} placeholder="NORAD ID" />
            <input value={tleGroup} onChange={(event) => setTleGroup(event.target.value)} placeholder="CelesTrak group" />
            <button onClick={fetchCelesTrak}>CelesTrak</button>
          </div>
          <div className="credentials">
            <input
              value={spaceTrackUser}
              onChange={(event) => setSpaceTrackUser(event.target.value)}
              placeholder="Space-Track 用户名"
            />
            <input
              value={spaceTrackPassword}
              onChange={(event) => setSpaceTrackPassword(event.target.value)}
              placeholder="Space-Track 密码"
              type="password"
            />
            <button onClick={saveSpaceTrackCredentials}>保存账号</button>
            <button onClick={() => window.stripeApi!.clearSpaceTrackCredentials().then(() => setStatus("Space-Track 账号已清除。"))}>
              清除
            </button>
            <button onClick={fetchSpaceTrack}>Space-Track</button>
          </div>
        </section>
      </aside>
    </main>
  );
}
