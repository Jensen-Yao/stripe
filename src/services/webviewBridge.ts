import type { ProjectSnapshot } from "../domain/types";
import { requestLocalOrbit } from "./localOrbitBridge";

type WebViewMessage = {
  type: "response" | "command";
  requestId?: string;
  command?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
};

function getWebView() {
  return window.chrome?.webview;
}

export function installWebViewBridge() {
  const webview = getWebView();
  if (!webview || window.stripeApi) return false;
  const pending = new Map<string, PendingRequest>();

  const invoke = <T,>(command: string, payload?: unknown): Promise<T> => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`桌面命令超时：${command}`));
    }, 120_000);
    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
    webview.postMessage(JSON.stringify({ requestId, command, payload }));
  });

  webview.addEventListener("message", (event: MessageEvent<WebViewMessage>) => {
    const message = event.data;
    if (message?.type === "command" && message.command) {
      window.dispatchEvent(new CustomEvent("stripe:native-command", { detail: message.command }));
      return;
    }
    if (message?.type !== "response" || !message.requestId) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    window.clearTimeout(request.timer);
    pending.delete(message.requestId);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error || "桌面命令执行失败"));
  });

  window.stripeApi = {
    assetUrl: (path) => new URL(path.replace(/^\/+/, ""), document.baseURI).href,
    saveProject: (snapshot: ProjectSnapshot, filePath?: string) => invoke("project:save", { snapshot, filePath }),
    openProject: () => invoke("project:open"),
    orbitRequest: requestLocalOrbit,
    updateScienceData: () => invoke("science:update"),
    chooseOrbitFile: (type) => invoke("orbit:chooseFile", { type }),
    fetchCelesTrak: (query) => invoke("tle:fetchCelesTrak", query),
    fetchSpaceTrack: (query) => invoke("tle:fetchSpaceTrack", query),
    saveSpaceTrackCredentials: (credentials) => invoke("tle:saveCredentials", credentials),
    clearSpaceTrackCredentials: () => invoke("tle:clearCredentials")
  };
  return true;
}
