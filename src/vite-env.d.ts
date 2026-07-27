/// <reference types="vite/client" />

import type { OrbitRequest, OrbitResponse, ProjectSnapshot } from "./domain/types";

declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage(message: string): void;
        addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
      };
    };
    stripeApi: {
      assetUrl(path: string): string;
      saveProject(snapshot: ProjectSnapshot, filePath?: string): Promise<{ canceled: boolean; filePath?: string }>;
      openProject(): Promise<{ canceled: boolean; filePath?: string; snapshot?: ProjectSnapshot }>;
      orbitRequest<T = unknown>(request: OrbitRequest): Promise<OrbitResponse<T>>;
      updateScienceData(): Promise<{ updated: boolean; version?: string }>;
      chooseOrbitFile(type: "omm" | "oem" | "sp3"): Promise<{ canceled: boolean; filePath?: string }>;
      fetchCelesTrak(query: { group?: string; noradId?: string; search?: string }): Promise<unknown[]>;
      fetchSpaceTrack(query: { noradId?: string; search?: string }): Promise<unknown[]>;
      saveSpaceTrackCredentials(credentials: { username: string; password: string }): Promise<{ saved: boolean }>;
      clearSpaceTrackCredentials(): Promise<{ cleared: boolean }>;
      getAmapConfig(): Promise<{ configured: boolean; key?: string; securityCode?: string; source?: string }>;
      chooseAmapConfig(): Promise<{ configured: boolean; canceled?: boolean; source?: string }>;
      clearAmapConfig(): Promise<{ cleared: boolean }>;
    };
  }
}

export {};
