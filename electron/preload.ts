import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("stripeApi", {
  fetchCelesTrak: (query: { group?: string; noradId?: string; search?: string }) =>
    ipcRenderer.invoke("tle:fetchCelesTrak", query),
  fetchSpaceTrack: (query: { noradId?: string; search?: string }) =>
    ipcRenderer.invoke("tle:fetchSpaceTrack", query),
  saveSpaceTrackCredentials: (credentials: { username: string; password: string }) =>
    ipcRenderer.invoke("tle:saveCredentials", credentials),
  clearSpaceTrackCredentials: () => ipcRenderer.invoke("tle:clearCredentials"),
  exportProject: (payload: unknown) => ipcRenderer.invoke("project:export", payload),
  importProject: () => ipcRenderer.invoke("project:import")
});
