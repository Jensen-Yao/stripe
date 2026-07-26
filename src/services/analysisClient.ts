import type { CoverageResult, OrbitSample, Sensor, Stripe, StripeOverlap } from "../domain/types";

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (value: StripeOverlap[]) => void; reject: (reason: Error) => void }>();
const coveragePending = new Map<number, { resolve: (value: { result: CoverageResult; cells: string[]; coveredCells: string[]; horizonClipped: boolean }) => void; reject: (reason: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/analysis.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event) => {
    const task = pending.get(event.data.id);
    if (task) {
      pending.delete(event.data.id);
      if (event.data.ok) task.resolve(event.data.overlaps);
      else task.reject(new Error(event.data.error ?? "重叠分析失败"));
      return;
    }
    const coverageTask = coveragePending.get(event.data.id);
    if (!coverageTask) return;
    coveragePending.delete(event.data.id);
    if (event.data.ok) coverageTask.resolve({ result: event.data.result, cells: event.data.cells, coveredCells: event.data.coveredCells, horizonClipped: Boolean(event.data.horizonClipped) });
    else coverageTask.reject(new Error(event.data.reason === "too-many" ? `覆盖网格数量 ${event.data.estimatedCells} 超过上限，请缩小条带或降低分析范围` : event.data.error ?? "覆盖分析失败"));
  };
  return worker;
}

export function analyzeCoverage(stripe: Stripe, samples: OrbitSample[], sensor: Sensor, resolution: number, maxCells: number) {
  sequence += 1;
  const id = sequence;
  return new Promise<{ result: CoverageResult; cells: string[]; coveredCells: string[]; horizonClipped: boolean }>((resolve, reject) => {
    coveragePending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type: "coverage", stripe, samples, sensor, resolution, maxCells });
  });
}

export function analyzeOverlaps(stripes: Stripe[]) {
  sequence += 1;
  const id = sequence;
  return new Promise<StripeOverlap[]>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type: "overlap", stripes });
  });
}
