export type EntityId = string;
export type CoordinateOrder = "lonlat" | "latlon";
export type ToolMode = "select" | "draw-stripe" | "move" | "rotate" | "stretch";
export type ViewMode = "2d" | "3d";
export type BaseMapMode = "offline" | "osm" | "amap";
export type WorkspaceTab = "properties" | "analysis" | "orbit" | "tasks";

export type GeoPoint = {
  lon: number;
  lat: number;
  heightKm?: number;
};

export type Scenario = {
  id: EntityId;
  name: string;
  startTime: string;
  endTime: string;
  currentTime: string;
  playbackSpeed: number;
  sampleStepSeconds: number;
};

export type TleOrbitSource = {
  type: "tle";
  name?: string;
  noradId?: string;
  line1: string;
  line2: string;
};

export type KeplerianOrbitSource = {
  type: "keplerian";
  epoch: string;
  semiMajorAxisKm: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
  argumentOfPerigeeDeg: number;
  anomalyDeg: number;
  anomalyType: "true" | "mean";
  frame: "GCRF" | "EME2000";
};

export type CartesianOrbitSource = {
  type: "cartesian";
  epoch: string;
  frame: "GCRF" | "EME2000" | "ITRF";
  positionKm: [number, number, number];
  velocityKmS: [number, number, number];
};

export type EphemerisOrbitSource = {
  type: "omm" | "oem" | "sp3";
  fileName: string;
  localPath: string;
  objectId?: string;
};

export type OrbitSource = TleOrbitSource | KeplerianOrbitSource | CartesianOrbitSource | EphemerisOrbitSource;
export type PropagatorProfile = "fast" | "planning" | "research";

export type SpacecraftPhysicalModel = {
  massKg: number;
  dragAreaM2: number;
  dragCoefficient: number;
  srpAreaM2: number;
  reflectivityCoefficient: number;
};

export type Spacecraft = {
  id: EntityId;
  name: string;
  visible: boolean;
  color: string;
  orbit: OrbitSource;
  profile: PropagatorProfile;
  physical: SpacecraftPhysicalModel;
};

export type Sensor = {
  id: EntityId;
  spacecraftId: EntityId;
  name: string;
  shape: "conical" | "rectangular";
  halfConeDeg: number;
  crossTrackFovDeg: number;
  alongTrackFovDeg: number;
  maxOffNadirDeg: number;
  maxSlewRateDegS: number;
  settleTimeSeconds: number;
};

export type AttitudePlan = {
  mode: "nadir" | "fixed-offset" | "task-pointing";
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
};

export type Stripe = {
  id: EntityId;
  name: string;
  visible: boolean;
  color: string;
  corners: GeoPoint[];
  createdAt: string;
  updatedAt: string;
};

export type GroundAsset = {
  id: EntityId;
  name: string;
  kind: "target" | "station";
  visible: boolean;
  location: GeoPoint;
  minElevationDeg: number;
  radiusKm: number;
};

export type OrbitSample = GeoPoint & {
  time: string;
  heightKm: number;
  speedKmS: number;
  positionKm?: [number, number, number];
  velocityKmS?: [number, number, number];
};

export type AccessWindow = {
  id: EntityId;
  spacecraftId: EntityId;
  targetId: EntityId;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  maxElevationDeg: number;
  azimuthDeg?: number;
  rangeKm?: number;
  sunElevationDeg?: number;
  sensorConstrained: boolean;
};

export type CoverageResult = {
  id: EntityId;
  sourceId: EntityId;
  coveragePercent: number;
  firstCoverageTime?: string;
  revisitMinutes?: number;
  coveredCellCount: number;
  totalCellCount: number;
};

export type TaskPlan = {
  id: EntityId;
  name: string;
  spacecraftId: EntityId;
  sensorId: EntityId;
  targetId: EntityId;
  startTime: string;
  endTime: string;
  attitude: AttitudePlan;
  status: "draft" | "valid" | "conflict";
  conflicts: string[];
};

export type AnalysisJob = {
  id: EntityId;
  kind: "orbit" | "access" | "coverage" | "overlap";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  message?: string;
};

export type StripeOverlap = {
  id: string;
  stripeAId: EntityId;
  stripeBId: EntityId;
  relation: "overlap" | "a_contains_b" | "b_contains_a" | "same";
  overlapAreaKm2: number;
  overlapPercentOfA: number;
  overlapPercentOfB: number;
};

export type LayerVisibility = {
  geographicContext: boolean;
  chinaStandardMap: boolean;
  stripes: boolean;
  satellites: boolean;
  groundTracks: boolean;
  coverage: boolean;
  groundAssets: boolean;
  h3: boolean;
};

export type H3Settings = {
  visible: boolean;
  resolution: number;
  maxCells: number;
  displayMaxCells: number;
};

export type Selection = {
  kind: "spacecraft" | "stripe" | "groundAsset" | "task" | "scenario";
  id: EntityId;
} | null;

export type ProjectSnapshot = {
  schemaVersion: 2;
  scenario: Scenario;
  spacecraft: Spacecraft[];
  sensors: Sensor[];
  stripes: Stripe[];
  groundAssets: GroundAsset[];
  tasks: TaskPlan[];
  accessWindows: AccessWindow[];
  coverageResults: CoverageResult[];
  overlaps: StripeOverlap[];
  layerVisibility: LayerVisibility;
  h3: H3Settings;
  baseMapMode: BaseMapMode;
  savedAt: string;
};

export type OrbitRequest = {
  requestId: string;
  command: "health" | "orbit/propagate" | "access/compute" | "coverage/compute" | "task/validate" | "job/cancel";
  payload?: unknown;
};

export type OrbitResponse<T = unknown> = {
  requestId: string;
  ok: boolean;
  result?: T;
  error?: string;
  progress?: number;
};
