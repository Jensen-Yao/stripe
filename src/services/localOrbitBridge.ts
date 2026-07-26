import type { OrbitRequest, OrbitResponse } from "../domain/types";

let worker: Worker | null = null;
const pending = new Map<string, {
  resolve: (response: OrbitResponse<unknown>) => void;
  timer: number;
}>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/orbit.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<OrbitResponse<unknown>>) => {
    const response = event.data;
    const request = pending.get(response.requestId);
    if (!request || (response.progress !== undefined && response.progress < 1)) return;
    window.clearTimeout(request.timer);
    pending.delete(response.requestId);
    request.resolve(response);
  };
  worker.onerror = (event) => {
    const message = event.message || "轨道计算 Worker 异常";
    for (const [requestId, request] of pending) {
      window.clearTimeout(request.timer);
      request.resolve({ requestId, ok: false, error: message });
    }
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function requestLocalOrbit<T>(request: OrbitRequest): Promise<OrbitResponse<T>> {
  if (request.command === "job/cancel") {
    getWorker().postMessage(request);
    return Promise.resolve({ requestId: request.requestId, ok: true, result: { cancelled: true } as T });
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(request.requestId);
      resolve({ requestId: request.requestId, ok: false, error: "本地轨道计算超时" });
    }, request.command === "health" ? 5_000 : 120_000);
    pending.set(request.requestId, {
      timer,
      resolve: resolve as (response: OrbitResponse<unknown>) => void
    });
    getWorker().postMessage(request);
  });
}
