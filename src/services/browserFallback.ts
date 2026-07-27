import type { OrbitRequest, OrbitResponse } from "../domain/types";
import { requestLocalOrbit } from "./localOrbitBridge";

export function installBrowserFallback() {
  if (window.stripeApi) return;
  window.stripeApi = {
    assetUrl: (path) => new URL(`./${path.replace(/^\/+/, "")}`, window.location.href).href,
    saveProject: async () => ({ canceled: true }),
    openProject: async () => ({ canceled: true }),
    orbitRequest: <T,>(request: OrbitRequest): Promise<OrbitResponse<T>> => requestLocalOrbit<T>(request),
    updateScienceData: async () => ({ updated: false }),
    chooseOrbitFile: async () => ({ canceled: true }),
    fetchCelesTrak: async () => [],
    fetchSpaceTrack: async () => [],
    saveSpaceTrackCredentials: async () => ({ saved: false }),
    clearSpaceTrackCredentials: async () => ({ cleared: true }),
    getAmapConfig: async () => ({ configured: false }),
    chooseAmapConfig: async () => ({ configured: false, canceled: true }),
    clearAmapConfig: async () => ({ cleared: true })
  };
}
