import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { PMTiles, Protocol } from "pmtiles";
import type { GeoPoint, OrbitSample, Sensor, Spacecraft, Stripe } from "../domain/types";
import { makeId } from "../domain/id";
import { scaleStripeAxes, stripeCenter, toEnu, transformStripe } from "../domain/geometry";
import { closestOrbitSample, createSensorFootprint, formatSensorFov, orbitHeadingAtIndex } from "../domain/sensorFov";
import { useWorkbenchStore } from "../store/workbenchStore";
import { createWorldStyle, fallbackStyle, osmStyle } from "./worldStyle";
import "maplibre-gl/dist/maplibre-gl.css";

type DragKind = "corner" | "move" | "rotate" | "stretch-length" | "stretch-width";
type HandleDescriptor = { kind: DragKind; cornerIndex?: number; point: { x: number; y: number }; label: string };
const BASE_LABEL_CHARACTERS = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32));
const STRIPE_SOURCE_ID = "stripe-plans";
const STRIPE_FILL_LAYER_ID = "stripe-plans-fill";
const STRIPE_LINE_LAYER_ID = "stripe-plans-line";

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

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function assetUrl(path: string) {
  return window.stripeApi?.assetUrl(path) ?? new URL(`./${path}`, window.location.href).href;
}

export function MapWorkbench() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    installPmtilesProtocol();

    const archiveUrl = assetUrl("maps/world.pmtiles");
    const archive = new PMTiles(archiveUrl);
    pmtilesProtocol.add(archive);
    const map = new maplibregl.Map({
      container,
      style: useWorkbenchStore.getState().baseMapMode === "offline" ? createWorldStyle(archiveUrl) : osmStyle,
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

    let mapLoadFailed = false;
    map.on("error", (event) => {
      const message = event.error?.message ?? "";
      if (!mapLoadFailed && useWorkbenchStore.getState().baseMapMode === "offline" && /pmtiles|world\.pmtiles|source/i.test(message)) {
        mapLoadFailed = true;
        map.setStyle(fallbackStyle);
        map.once("style.load", () => {
          ensureStripeLayers();
          syncStripeSource(true);
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
    let h3Cells: string[] = [];
    let h3RequestId = 0;
    let previewStripe: Stripe | null = null;
    let draftPoints: GeoPoint[] = [];
    let cityLabels: Array<{ lon: number; lat: number; name: string; population: number }> = [];
    let countryLabels: Array<{ lon: number; lat: number; name: string; rank: number }> = [];
    let textCharacterSet = BASE_LABEL_CHARACTERS;
    let tracksCache: Array<{ spacecraft: Spacecraft; samples: OrbitSample[] }> = [];
    let sourceStripesRef: Stripe[] | null = null;
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
    let frame: number | null = null;
    let handleFrame: number | null = null;
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

    const refreshCharacterSet = () => {
      const labels = [
        ...countryLabels.map((item) => item.name),
        ...cityLabels.map((item) => item.name),
        ...groundAssetsRef.map((item) => item.name),
        "圆锥矩形视场"
      ].join("");
      textCharacterSet = Array.from(new Set([...BASE_LABEL_CHARACTERS, ...labels]));
    };

    const applyProjection = (viewMode: "2d" | "3d") => {
      const update = () => map.setProjection({ type: viewMode === "3d" ? "globe" : "mercator" });
      if (map.isStyleLoaded()) update();
      else map.once("style.load", update);
    };

    const stripeGeoJson = () => ({
      type: "FeatureCollection" as const,
      features: useWorkbenchStore.getState().stripes
        .filter((stripe) => stripe.visible)
        .map((stripe) => {
          const centerLon = stripeCenter(stripe.corners).lon;
          const ring = stripe.corners.map((corner) => pointArrayNear(corner, centerLon));
          return {
            type: "Feature" as const,
            id: stripe.id,
            properties: { id: stripe.id, color: stripe.color },
            geometry: { type: "Polygon" as const, coordinates: [[...ring, ring[0]]] }
          };
        })
    });

    const applyStripeSelectionState = (selection = useWorkbenchStore.getState().selection) => {
      if (selection?.kind !== "stripe" || !map.getSource(STRIPE_SOURCE_ID)) return;
      map.setFeatureState({ source: STRIPE_SOURCE_ID, id: selection.id }, { selected: true });
    };

    const ensureStripeLayers = () => {
      if (!map.getSource(STRIPE_SOURCE_ID)) {
        map.addSource(STRIPE_SOURCE_ID, { type: "geojson", data: stripeGeoJson(), promoteId: "id" });
      }
      if (!map.getLayer(STRIPE_FILL_LAYER_ID)) {
        map.addLayer({
          id: STRIPE_FILL_LAYER_ID,
          type: "fill",
          source: STRIPE_SOURCE_ID,
          paint: {
            "fill-color": ["get", "color"],
            "fill-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 0.36, 0.2]
          }
        });
      }
      if (!map.getLayer(STRIPE_LINE_LAYER_ID)) {
        map.addLayer({
          id: STRIPE_LINE_LAYER_ID,
          type: "line",
          source: STRIPE_SOURCE_ID,
          paint: {
            "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#dc502b", ["get", "color"]],
            "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.5, 1.4]
          }
        });
      }
      const visibility = useWorkbenchStore.getState().layerVisibility.stripes ? "visible" : "none";
      map.setLayoutProperty(STRIPE_FILL_LAYER_ID, "visibility", visibility);
      map.setLayoutProperty(STRIPE_LINE_LAYER_ID, "visibility", visibility);
      applyStripeSelectionState();
    };

    const syncStripeSource = (force = false) => {
      const state = useWorkbenchStore.getState();
      if (!map.isStyleLoaded()) return;
      ensureStripeLayers();
      if (force || sourceStripesRef !== state.stripes) {
        sourceStripesRef = state.stripes;
        (map.getSource(STRIPE_SOURCE_ID) as maplibregl.GeoJSONSource).setData(stripeGeoJson());
        applyStripeSelectionState(state.selection);
      }
      const visibility = state.layerVisibility.stripes ? "visible" : "none";
      map.setLayoutProperty(STRIPE_FILL_LAYER_ID, "visibility", visibility);
      map.setLayoutProperty(STRIPE_LINE_LAYER_ID, "visibility", visibility);
    };


    const scheduleRender = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        render();
      });
    };

    const scheduleHandleUpdate = () => {
      if (handleFrame !== null) return;
      handleFrame = window.requestAnimationFrame(() => {
        handleFrame = null;
        updateHandles();
      });
    };

    const updateEditPreview = (corners: Stripe["corners"] | null) => {
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
      if (nextHandleKey === handleRenderKey) return;
      handleRenderKey = nextHandleKey;
      handleLayer.replaceChildren();
      if (selectedStripe && state.toolMode !== "draw-stripe" && state.viewMode === "2d") createHandles(previewStripe ?? selectedStripe);
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
        refreshCharacterSet();
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

      overlay.setProps({
        layers: [
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
            getText: (asset) => asset.name,
            getSize: 12,
            getPixelOffset: [0, -13],
            getColor: [33, 43, 48, 230],
            fontFamily: "Microsoft YaHei, sans-serif",
            characterSet: textCharacterSet,
            billboard: true
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
          new H3HexagonLayer({
            id: "h3-grid",
            data: state.layerVisibility.h3 && state.h3.visible ? h3Cells : [],
            getHexagon: (cell) => cell,
            getFillColor: [42, 117, 142, 7],
            getLineColor: [42, 117, 142, state.h3.resolution >= 10 ? 205 : 125],
            getLineWidth: state.h3.resolution >= 10 ? 0.75 : 1,
            lineWidthUnits: "pixels",
            filled: true,
            extruded: false,
            stroked: true,
            highPrecision: true,
            pickable: false
          }),
          new PathLayer({
            id: "draft-line",
            data: draftPoints.length ? [{ points: draftPoints }] : [],
            getPath: (item) => item.points.map(pointArray),
            getColor: [224, 91, 54, 255],
            getWidth: 2,
            widthUnits: "pixels",
            widthMinPixels: 1
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
      const centerPoint = map.project(displayPoint(stripeCenter(stripe.corners)));
      const front = midpoint(screens[0], screens[1]);
      const side = midpoint(screens[1], screens[2]);
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
        element.title = { corner: "拖动角点", move: "移动条带", rotate: "旋转条带", "stretch-length": "拉伸长度", "stretch-width": "拉伸宽度" }[descriptor.kind];
        element.style.left = `${descriptor.point.x}px`;
        element.style.top = `${descriptor.point.y}px`;
        element.addEventListener("pointerdown", (event) => beginDrag(event, descriptor, stripe));
        handleLayer.appendChild(element);
      }
    };

    const beginDrag = (event: PointerEvent, descriptor: HandleDescriptor, stripe: Stripe) => {
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
        const next = [...corners] as Stripe["corners"];
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
      if (drag && previewStripe) useWorkbenchStore.getState().commitStripe(drag.stripe.id, previewStripe);
      drag = null;
      previewStripe = null;
      updateEditPreview(null);
      map.dragPan.enable();
      map.doubleClickZoom.enable();
      handleRenderKey = "";
      scheduleRender();
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
      scheduleRender();
    };

    const updateH3 = () => {
      const state = useWorkbenchStore.getState();
      if (!state.h3.visible || !state.layerVisibility.h3) {
        h3Cells = [];
        scheduleRender();
        return;
      }
      const bounds = map.getBounds();
      const rawWest = bounds.getWest();
      const rawEast = bounds.getEast();
      const fullWorld = rawEast - rawWest >= 360;
      const west = fullWorld ? -180 : normalizeViewLon(rawWest);
      const east = fullWorld ? 180 : normalizeViewLon(rawEast);
      h3RequestId += 1;
      h3Worker.postMessage({
        id: h3RequestId,
        resolution: state.h3.resolution,
        maxCells: state.h3.maxCells,
        bounds: { west, south: Math.max(-85, bounds.getSouth()), east, north: Math.min(85, bounds.getNorth()) }
      });
    };

    const focusSelectionWhenOutside = () => {
      if (!map.loaded()) return;
      const state = useWorkbenchStore.getState();
      let point: GeoPoint | undefined;
      if (state.selection?.kind === "stripe") {
        const stripe = state.stripes.find((item) => item.id === state.selection?.id);
        if (stripe) point = stripeCenter(stripe.corners);
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
        zoom: state.viewMode === "3d" ? Math.min(3.5, Math.max(2, map.getZoom())) : Math.max(4, map.getZoom()),
        duration: 280
      });
    };

    h3Worker.onmessage = (event) => {
      if (event.data.id !== h3RequestId) return;
      if (event.data.ok) {
        h3Cells = event.data.cells;
        useWorkbenchStore.getState().setStatus(`H3 ${useWorkbenchStore.getState().h3.resolution} 级：${h3Cells.length.toLocaleString("zh-CN")} 个网格`);
      } else {
        h3Cells = [];
        if (event.data.reason === "too-many") {
          useWorkbenchStore.getState().setStatus(`当前范围预计 ${event.data.estimatedCells.toLocaleString("zh-CN")} 个 H3 网格，请缩小地图范围；层级不会自动降低`);
        }
      }
      scheduleRender();
    };

    const onMapClick = (event: maplibregl.MapMouseEvent) => {
      const state = useWorkbenchStore.getState();
      if (state.toolMode !== "draw-stripe" || state.viewMode !== "2d") {
        const feature = map.queryRenderedFeatures(event.point, { layers: [STRIPE_FILL_LAYER_ID, STRIPE_LINE_LAYER_ID] })[0];
        const stripeId = feature?.id === undefined ? feature?.properties?.id : String(feature.id);
        if (stripeId) {
          state.setSelection({ kind: "stripe", id: stripeId });
          state.setToolMode("select");
        }
        return;
      }
      draftPoints = [...draftPoints, { lon: event.lngLat.lng, lat: event.lngLat.lat }];
      if (draftPoints.length === 4) {
        const timestamp = new Date().toISOString();
        state.addStripe({
          id: makeId("stripe"),
          name: `条带 ${state.stripes.length + 1}`,
          visible: true,
          color: "#e9693f",
          corners: draftPoints as Stripe["corners"],
          createdAt: timestamp,
          updatedAt: timestamp
        });
        draftPoints = [];
        state.setToolMode("select");
        state.setStatus("四角条带已生成，可使用屏幕手柄移动、旋转和拉伸");
      } else {
        state.setStatus(`已记录 ${draftPoints.length}/4 个角点`);
      }
      scheduleRender();
    };

    const unsubscribe = useWorkbenchStore.subscribe((state, previous) => {
      scheduleRender();
      if (state.baseMapMode !== previous.baseMapMode) {
        map.setStyle(state.baseMapMode === "offline" ? createWorldStyle(archiveUrl) : osmStyle);
        applyProjection(state.viewMode);
        map.once("style.load", () => {
          ensureStripeLayers();
          syncStripeSource(true);
        });
      }
      if (state.viewMode !== previous.viewMode) {
        applyProjection(state.viewMode);
        map.setMaxZoom(state.viewMode === "3d" ? 8 : 16);
        useWorkbenchStore.getState().setStatus(state.viewMode === "3d" ? "三维地球检查视图：条带编辑已锁定" : "二维地图编辑视图");
      }
      if (state.stripes !== previous.stripes || state.layerVisibility.stripes !== previous.layerVisibility.stripes) syncStripeSource();
      if (state.selection !== previous.selection && map.getSource(STRIPE_SOURCE_ID)) {
        if (previous.selection?.kind === "stripe") map.setFeatureState({ source: STRIPE_SOURCE_ID, id: previous.selection.id }, { selected: false });
        applyStripeSelectionState(state.selection);
      }
      if (state.h3.visible !== previous.h3.visible || state.h3.resolution !== previous.h3.resolution || state.h3.maxCells !== previous.h3.maxCells || state.layerVisibility.h3 !== previous.layerVisibility.h3) {
        updateH3();
      }
      if (state.toolMode !== "draw-stripe" && previous.toolMode === "draw-stripe") draftPoints = [];
      if (state.selection !== previous.selection || state.stripes.length > previous.stripes.length) focusSelectionWhenOutside();
    });
    map.on("click", onMapClick);
    map.on("movestart", () => {
      if (!drag) handleLayer.style.visibility = "hidden";
    });
    map.on("moveend", () => {
      handleLayer.style.visibility = "visible";
      handleRenderKey = "";
      scheduleHandleUpdate();
      updateH3();
    });
    map.on("zoomend", scheduleRender);
    map.once("load", () => {
      applyProjection(useWorkbenchStore.getState().viewMode);
      ensureStripeLayers();
      syncStripeSource(true);
      render();
      updateH3();
    });
    fetch(assetUrl("maps/cities.json"))
      .then((response) => response.ok ? response.json() : [])
      .then((cities) => {
        cityLabels = Array.isArray(cities) ? cities : [];
        refreshCharacterSet();
        scheduleRender();
      })
      .catch(() => undefined);
    fetch(assetUrl("maps/country-labels.json"))
      .then((response) => response.ok ? response.json() : [])
      .then((countries) => {
        countryLabels = Array.isArray(countries) ? countries : [];
        refreshCharacterSet();
        scheduleRender();
      })
      .catch(() => undefined);

    return () => {
      unsubscribe();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (handleFrame !== null) window.cancelAnimationFrame(handleFrame);
      h3Worker.terminate();
      map.remove();
      handleLayer.remove();
      editPreviewSvg.remove();
    };
  }, []);

  return <div className="map-workbench" ref={containerRef} />;
}
