import { create } from "zustand";
import { makeId } from "../domain/id";
import { stripeFromParameters } from "../domain/geometry";
import type {
  AccessWindow,
  BaseMapMode,
  CoverageResult,
  GroundAsset,
  H3Settings,
  LayerVisibility,
  OrbitSample,
  ProjectSnapshot,
  Scenario,
  Selection,
  Sensor,
  Spacecraft,
  Stripe,
  StripeOverlap,
  TaskPlan,
  ToolMode,
  ViewMode,
  WorkspaceTab
} from "../domain/types";

function createDefaultScenario(): Scenario {
  const now = new Date();
  return {
    id: "scenario-main",
    name: "默认场景",
    startTime: new Date(now.getTime() - 90 * 60_000).toISOString(),
    endTime: new Date(now.getTime() + 90 * 60_000).toISOString(),
    currentTime: now.toISOString(),
    playbackSpeed: 60,
    sampleStepSeconds: 30
  };
}

const defaultScenario = createDefaultScenario();

const defaultSpacecraft: Spacecraft = {
  id: "spacecraft-iss",
  name: "ISS (ZARYA)",
  visible: true,
  color: "#4cb8ff",
  profile: "fast",
  orbit: {
    type: "tle",
    name: "ISS (ZARYA)",
    noradId: "25544",
    line1: "1 25544U 98067A   26166.47439209  .00016717  00000+0  30136-3 0  9997",
    line2: "2 25544  51.6313 331.6938 0003417 113.3422 246.7928 15.50065061517066"
  },
  physical: {
    massKg: 420000,
    dragAreaM2: 400,
    dragCoefficient: 2.2,
    srpAreaM2: 400,
    reflectivityCoefficient: 1.3
  }
};

const defaultSensor: Sensor = {
  id: "sensor-iss-main",
  spacecraftId: defaultSpacecraft.id,
  name: "主载荷",
  shape: "rectangular",
  halfConeDeg: 20,
  crossTrackFovDeg: 10,
  alongTrackFovDeg: 2,
  maxOffNadirDeg: 45,
  maxSlewRateDegS: 1.5,
  settleTimeSeconds: 12
};

const defaultGroundAsset: GroundAsset = {
  id: "ground-beijing",
  name: "北京目标",
  kind: "target",
  visible: true,
  location: { lon: 116.4074, lat: 39.9042, heightKm: 0 },
  minElevationDeg: 10,
  radiusKm: 25
};

const defaultLayerVisibility: LayerVisibility = {
  geographicContext: true,
  chinaStandardMap: true,
  stripes: true,
  satellites: true,
  groundTracks: true,
  coverage: true,
  groundAssets: true,
  h3: false
};

type StripeHistory = { past: Stripe[][]; future: Stripe[][] };

type WorkbenchState = {
  scenario: Scenario;
  spacecraft: Spacecraft[];
  sensors: Sensor[];
  stripes: Stripe[];
  groundAssets: GroundAsset[];
  tasks: TaskPlan[];
  orbitSamples: Record<string, OrbitSample[]>;
  accessWindows: AccessWindow[];
  overlaps: StripeOverlap[];
  activeOverlapId?: string;
  coverageResults: CoverageResult[];
  coverageCells: string[];
  selection: Selection;
  toolMode: ToolMode;
  viewMode: ViewMode;
  activeTab: WorkspaceTab;
  layerVisibility: LayerVisibility;
  h3: H3Settings;
  baseMapMode: BaseMapMode;
  projectPath?: string;
  dirty: boolean;
  status: string;
  isPlaying: boolean;
  history: StripeHistory;
  setScenario: (patch: Partial<Scenario>) => void;
  setCurrentTime: (time: string) => void;
  setSpacecraft: (id: string, patch: Partial<Spacecraft>) => void;
  addSpacecraft: () => void;
  setSensor: (id: string, patch: Partial<Sensor>) => void;
  addStripe: (stripe: Stripe) => void;
  addGeneratedStripe: (parameters: { centerLon: number; centerLat: number; lengthKm: number; widthKm: number; headingDeg: number }) => void;
  commitStripe: (id: string, stripe: Stripe) => void;
  addStripes: (stripes: Stripe[]) => void;
  deleteSelected: () => void;
  setGroundAsset: (id: string, patch: Partial<GroundAsset>) => void;
  addGroundAsset: (asset: GroundAsset) => void;
  setTasks: (tasks: TaskPlan[]) => void;
  setOrbitSamples: (spacecraftId: string, samples: OrbitSample[]) => void;
  setAccessWindows: (windows: AccessWindow[]) => void;
  setOverlaps: (overlaps: StripeOverlap[]) => void;
  setActiveOverlap: (id?: string) => void;
  setCoverageResult: (result: CoverageResult, coveredCells: string[]) => void;
  setSelection: (selection: Selection) => void;
  setToolMode: (mode: ToolMode) => void;
  setViewMode: (mode: ViewMode) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  setLayerVisibility: (patch: Partial<LayerVisibility>) => void;
  setH3: (patch: Partial<H3Settings>) => void;
  setBaseMapMode: (mode: BaseMapMode) => void;
  setProjectPath: (path?: string) => void;
  markSaved: (path?: string) => void;
  setStatus: (status: string) => void;
  setPlaying: (playing: boolean) => void;
  undo: () => void;
  redo: () => void;
  snapshot: () => ProjectSnapshot;
  hydrate: (snapshot: ProjectSnapshot, path?: string) => void;
  resetProject: () => void;
};

function withHistory(state: WorkbenchState, nextStripes: Stripe[]) {
  return {
    stripes: nextStripes,
    history: { past: [...state.history.past.slice(-49), state.stripes], future: [] },
    overlaps: [],
    activeOverlapId: undefined,
    coverageResults: [],
    coverageCells: [],
    dirty: true
  };
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  scenario: defaultScenario,
  spacecraft: [defaultSpacecraft],
  sensors: [defaultSensor],
  stripes: [],
  groundAssets: [defaultGroundAsset],
  tasks: [],
  orbitSamples: {},
  accessWindows: [],
  overlaps: [],
  activeOverlapId: undefined,
  coverageResults: [],
  coverageCells: [],
  selection: { kind: "scenario", id: defaultScenario.id },
  toolMode: "select",
  viewMode: "2d",
  activeTab: "properties",
  layerVisibility: defaultLayerVisibility,
  h3: { visible: false, resolution: 3, maxCells: 200000, displayMaxCells: 500000 },
  baseMapMode: "offline",
  dirty: false,
  status: "工作台已就绪",
  isPlaying: false,
  history: { past: [], future: [] },
  setScenario: (patch) => set((state) => ({ scenario: { ...state.scenario, ...patch }, dirty: true })),
  setCurrentTime: (currentTime) => set((state) => ({ scenario: { ...state.scenario, currentTime } })),
  setSpacecraft: (id, patch) => set((state) => ({
    spacecraft: state.spacecraft.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    dirty: true
  })),
  addSpacecraft: () => set((state) => {
    const id = makeId("spacecraft");
    const spacecraft: Spacecraft = { ...defaultSpacecraft, id, name: `卫星 ${state.spacecraft.length + 1}`, orbit: { ...defaultSpacecraft.orbit }, physical: { ...defaultSpacecraft.physical } };
    const sensor: Sensor = { ...defaultSensor, id: makeId("sensor"), spacecraftId: id, name: "主载荷" };
    return { spacecraft: [...state.spacecraft, spacecraft], sensors: [...state.sensors, sensor], selection: { kind: "spacecraft", id }, dirty: true };
  }),
  setSensor: (id, patch) => set((state) => ({
    sensors: state.sensors.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    dirty: true
  })),
  addStripe: (stripe) => set((state) => ({ ...withHistory(state, [...state.stripes, stripe]), selection: { kind: "stripe", id: stripe.id } })),
  addGeneratedStripe: (parameters) => {
    const timestamp = new Date().toISOString();
    const stripe: Stripe = {
      id: makeId("stripe"),
      name: `条带 ${get().stripes.length + 1}`,
      visible: true,
      color: "#e9693f",
      corners: stripeFromParameters(
        { lon: parameters.centerLon, lat: parameters.centerLat },
        parameters.lengthKm,
        parameters.widthKm,
        parameters.headingDeg
      ),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    get().addStripe(stripe);
  },
  commitStripe: (id, stripe) => set((state) => withHistory(state, state.stripes.map((item) => (item.id === id ? stripe : item)))),
  addStripes: (items) => set((state) => ({
    ...withHistory(state, [...state.stripes, ...items]),
    selection: items[0] ? { kind: "stripe", id: items[0].id } : state.selection
  })),
  deleteSelected: () => set((state) => {
    if (!state.selection) return state;
    if (state.selection.kind === "stripe") return { ...withHistory(state, state.stripes.filter((item) => item.id !== state.selection?.id)), selection: null };
    if (state.selection.kind === "spacecraft") return {
      spacecraft: state.spacecraft.filter((item) => item.id !== state.selection?.id),
      sensors: state.sensors.filter((item) => item.spacecraftId !== state.selection?.id),
      tasks: state.tasks.filter((item) => item.spacecraftId !== state.selection?.id),
      selection: null,
      dirty: true
    };
    if (state.selection.kind === "groundAsset") return { groundAssets: state.groundAssets.filter((item) => item.id !== state.selection?.id), selection: null, dirty: true };
    if (state.selection.kind === "task") return { tasks: state.tasks.filter((item) => item.id !== state.selection?.id), selection: null, dirty: true };
    return state;
  }),
  setGroundAsset: (id, patch) => set((state) => ({
    groundAssets: state.groundAssets.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    dirty: true
  })),
  addGroundAsset: (asset) => set((state) => ({ groundAssets: [...state.groundAssets, asset], selection: { kind: "groundAsset", id: asset.id }, dirty: true })),
  setTasks: (tasks) => set({ tasks, dirty: true }),
  setOrbitSamples: (spacecraftId, samples) => set((state) => ({ orbitSamples: { ...state.orbitSamples, [spacecraftId]: samples } })),
  setAccessWindows: (accessWindows) => set({ accessWindows }),
  setOverlaps: (overlaps) => set({ overlaps, activeOverlapId: overlaps[0]?.id }),
  setActiveOverlap: (activeOverlapId) => set({ activeOverlapId }),
  setCoverageResult: (result, coverageCells) => set((state) => ({ coverageResults: [result, ...state.coverageResults].slice(0, 20), coverageCells })),
  setSelection: (selection) => set({ selection }),
  setToolMode: (toolMode) => set({ toolMode }),
  setViewMode: (viewMode) => set({ viewMode }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setLayerVisibility: (patch) => set((state) => ({ layerVisibility: { ...state.layerVisibility, ...patch }, dirty: true })),
  setH3: (patch) => set((state) => ({ h3: { ...state.h3, ...patch }, layerVisibility: { ...state.layerVisibility, h3: patch.visible ?? state.layerVisibility.h3 } })),
  setBaseMapMode: (baseMapMode) => set({ baseMapMode, dirty: true }),
  setProjectPath: (projectPath) => set({ projectPath }),
  markSaved: (projectPath) => set((state) => ({ projectPath: projectPath ?? state.projectPath, dirty: false, status: "项目已保存" })),
  setStatus: (status) => set({ status }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  undo: () => set((state) => {
    const previous = state.history.past.at(-1);
    if (!previous) return state;
    return {
      stripes: previous,
      history: { past: state.history.past.slice(0, -1), future: [state.stripes, ...state.history.future].slice(0, 50) },
      overlaps: [],
      activeOverlapId: undefined,
      coverageResults: [],
      coverageCells: [],
      dirty: true
    };
  }),
  redo: () => set((state) => {
    const next = state.history.future[0];
    if (!next) return state;
    return {
      stripes: next,
      history: { past: [...state.history.past, state.stripes].slice(-50), future: state.history.future.slice(1) },
      overlaps: [],
      activeOverlapId: undefined,
      coverageResults: [],
      coverageCells: [],
      dirty: true
    };
  }),
  snapshot: () => {
    const state = get();
    return {
      schemaVersion: 2,
      scenario: state.scenario,
      spacecraft: state.spacecraft,
      sensors: state.sensors,
      stripes: state.stripes,
      groundAssets: state.groundAssets,
      tasks: state.tasks,
      accessWindows: state.accessWindows,
      coverageResults: state.coverageResults,
      overlaps: state.overlaps,
      layerVisibility: state.layerVisibility,
      h3: state.h3,
      baseMapMode: state.baseMapMode,
      savedAt: new Date().toISOString()
    };
  },
  hydrate: (snapshot, projectPath) => set({
    scenario: snapshot.scenario,
    spacecraft: snapshot.spacecraft,
    sensors: snapshot.sensors,
    stripes: (snapshot.stripes ?? []).filter((stripe) => stripe.corners?.length >= 3),
    groundAssets: (snapshot.groundAssets ?? []).map((asset) => ({ ...asset, radiusKm: Math.max(0, asset.radiusKm ?? 0) })),
    tasks: snapshot.tasks,
    accessWindows: snapshot.accessWindows ?? [],
    coverageResults: snapshot.coverageResults ?? [],
    overlaps: snapshot.overlaps ?? [],
    activeOverlapId: snapshot.overlaps?.[0]?.id,
    layerVisibility: { ...defaultLayerVisibility, ...snapshot.layerVisibility },
    h3: {
      visible: snapshot.h3?.visible ?? false,
      resolution: snapshot.h3?.resolution ?? 3,
      maxCells: snapshot.h3?.maxCells ?? 200000,
      displayMaxCells: snapshot.h3?.displayMaxCells ?? 500000
    },
    baseMapMode: snapshot.baseMapMode ?? "offline",
    projectPath,
    selection: { kind: "scenario", id: snapshot.scenario.id },
    orbitSamples: {},
    coverageCells: [],
    history: { past: [], future: [] },
    toolMode: "select",
    isPlaying: false,
    dirty: false,
    status: "项目已打开"
  }),
  resetProject: () => set({
    scenario: createDefaultScenario(),
    spacecraft: [defaultSpacecraft],
    sensors: [defaultSensor],
    stripes: [],
    groundAssets: [defaultGroundAsset],
    tasks: [],
    orbitSamples: {},
    accessWindows: [],
    overlaps: [],
    activeOverlapId: undefined,
    coverageResults: [],
    coverageCells: [],
    selection: { kind: "scenario", id: defaultScenario.id },
    toolMode: "select",
    viewMode: "2d",
    activeTab: "properties",
    layerVisibility: defaultLayerVisibility,
    h3: { visible: false, resolution: 3, maxCells: 200000, displayMaxCells: 500000 },
    baseMapMode: "offline",
    projectPath: undefined,
    dirty: false,
    status: "已新建项目",
    isPlaying: false,
    history: { past: [], future: [] }
  })
}));
