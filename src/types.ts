export type CoordinateOrder = "lonlat" | "latlon";
export type BaseMapMode = "offline" | "osm";
export type ToolMode = "draw" | "select" | "move" | "rotate" | "stretch";
export type TleSource = "manual" | "celestrak" | "spacetrack";

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
  corners: LatLon[];
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
  crossedDateLine: boolean;
};

export type CoverageSettings = {
  show: boolean;
  halfConeDeg: number;
};

export type ProjectState = {
  stripes: Stripe[];
  tles: SatelliteTle[];
  selectedTleId?: string;
  coordinateOrder: CoordinateOrder;
  baseMapMode: BaseMapMode;
  coverage: CoverageSettings;
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
