export type CoordinateOrder = "lonlat" | "latlon";
export type BaseMapMode = "offline" | "osm";
export type ToolMode = "draw" | "select" | "move" | "rotate" | "stretch";
export type TleSource = "manual" | "celestrak" | "spacetrack";
export type WorkbenchTab = "scene" | "objects" | "stripe" | "orbit" | "simulation";

export type LatLon = {
  lat: number;
  lon: number;
};

export type ProjectedPoint = {
  x: number;
  y: number;
};

export type Stripe = {
  id: string;
  name?: string;
  corners: LatLon[];
  visible?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SatelliteTle = {
  id: string;
  name: string;
  noradId?: string;
  line1: string;
  line2: string;
  source: TleSource;
  fetchedAt: string;
};

export type OrbitSample = {
  time: string;
  lat: number;
  lon: number;
  heightKm: number;
  speedKmS: number;
  eciKm?: Vector3;
  ecfKm?: Vector3;
  crossedDateLine: boolean;
};

export type CoverageSettings = {
  show: boolean;
  halfConeDeg: number;
};

export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type ScenarioSettings = {
  startTime: string;
  endTime: string;
  currentTime: string;
  playbackSpeed: number;
  sampleStepSeconds: number;
};

export type LayerVisibility = {
  stripes: boolean;
  satellites: boolean;
  groundTrack: boolean;
  subpoint: boolean;
  coverage: boolean;
  targets: boolean;
  accessHighlights: boolean;
  h3Grid?: boolean;
};

export type GroundTarget = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  heightKm: number;
  minElevationDeg: number;
  visible: boolean;
};

export type AccessSample = {
  time: string;
  targetId: string;
  satelliteId: string;
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
  visible: boolean;
};

export type AccessWindow = {
  id: string;
  targetId: string;
  satelliteId: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  maxElevationDeg: number;
};

export type CoverageGridPoint = {
  id: string;
  lat: number;
  lon: number;
  covered: boolean;
  firstCoveredTime?: string;
  coverageCount: number;
};

export type CoverageGrid = {
  sourceStripeId?: string;
  spacingKm: number;
  points: CoverageGridPoint[];
};

export type SimulationResult = {
  generatedAt: string;
  accessWindows: AccessWindow[];
  currentAccessSamples: AccessSample[];
  coverageGrid?: CoverageGrid;
  coveragePercent?: number;
  firstCoverageTime?: string;
  revisitMinutes?: number;
};

export type PlannerDraft = {
  centerLat: number;
  centerLon: number;
  lengthKm: number;
  widthKm: number;
  headingDeg: number;
};

export type StripeMetrics = {
  center: LatLon;
  lengthKm: number;
  widthKm: number;
  areaKm2: number;
  headingDeg: number;
};

export type StripeOverlapRelation = "separate" | "overlap" | "a_contains_b" | "b_contains_a" | "same";

export type StripeOverlapAnalysis = {
  id: string;
  stripeAId: string;
  stripeBId: string;
  stripeAName: string;
  stripeBName: string;
  relation: StripeOverlapRelation;
  overlapAreaKm2: number;
  overlapPercentOfA: number;
  overlapPercentOfB: number;
  areaAKm2: number;
  areaBKm2: number;
};

export type H3GridSettings = {
  show: boolean;
  resolution: number;
};

export type ProjectState = {
  stripes: Stripe[];
  tles: SatelliteTle[];
  selectedTleId?: string;
  coordinateOrder: CoordinateOrder;
  baseMapMode: BaseMapMode;
  coverage: CoverageSettings;
  scenario?: ScenarioSettings;
  layerVisibility?: LayerVisibility;
  groundTargets?: GroundTarget[];
  h3Grid?: H3GridSettings;
};

export type StripeApi = {
  fetchCelesTrak(query: { group?: string; noradId?: string; search?: string }): Promise<SatelliteTle[]>;
  fetchSpaceTrack(query: { noradId?: string; search?: string }): Promise<SatelliteTle[]>;
  saveSpaceTrackCredentials(credentials: { username: string; password: string }): Promise<{ saved: boolean }>;
  clearSpaceTrackCredentials(): Promise<{ cleared: boolean }>;
  exportProject(payload: unknown): Promise<{ canceled: boolean; filePath?: string }>;
  importProject(): Promise<{ canceled: boolean; filePath?: string; data?: unknown }>;
};

declare global {
  interface Window {
    stripeApi?: StripeApi;
  }
}
