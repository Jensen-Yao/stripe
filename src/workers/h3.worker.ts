import { cellArea, cellToChildren, getNumCells, getRes0Cells, latLngToCell, polygonToCells } from "h3-js";
import { fitH3BoundsToBudget, h3BoundsWidth, type H3Bounds } from "../domain/h3Grid";

type Request = {
  id: number;
  resolution: number;
  bounds: H3Bounds;
  maxCells: number;
};

type Response =
  | { id: number; ok: true; kind: "chunk"; cells: string[]; estimatedCells: number; clipped: boolean }
  | { id: number; ok: true; kind: "complete"; cells: []; estimatedCells: number; clipped: boolean; displayedCells: number }
  | { id: number; ok: false; reason: "too-many" | "empty" | "invalid"; estimatedCells: number };

function sphericalAreaKm2(bounds: Request["bounds"]) {
  const radius = 6371.0088;
  const south = (bounds.south * Math.PI) / 180;
  const north = (bounds.north * Math.PI) / 180;
  let width = bounds.east - bounds.west;
  if (width < 0) width += 360;
  return radius * radius * ((width * Math.PI) / 180) * Math.abs(Math.sin(north) - Math.sin(south));
}

function cellsForBounds(bounds: H3Bounds, resolution: number) {
  const fullWorld = h3BoundsWidth(bounds) >= 359.999;
  if (fullWorld) return getRes0Cells().flatMap((cell) => cellToChildren(cell, resolution));
  const { west, south, east, north } = bounds;
  const rings = east >= west
    ? [[[west, north], [east, north], [east, south], [west, south], [west, north]]]
    : [
        [[west, north], [180, north], [180, south], [west, south], [west, north]],
        [[-180, north], [east, north], [east, south], [-180, south], [-180, north]]
      ];
  return Array.from(new Set(rings.flatMap((ring) => polygonToCells([ring], resolution, true))));
}

function normalizeLon(lon: number) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function splitBounds(bounds: H3Bounds, chunkCount: number) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(chunkCount)));
  const rows = Math.max(1, Math.ceil(chunkCount / columns));
  const width = h3BoundsWidth(bounds);
  const lonStep = width / columns;
  const latStep = (bounds.north - bounds.south) / rows;
  const values: H3Bounds[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const west = normalizeLon(bounds.west + column * lonStep);
      const eastUnwrapped = bounds.west + (column + 1) * lonStep;
      const east = eastUnwrapped >= 180 && eastUnwrapped <= 180 + 1e-9 ? 180 : normalizeLon(eastUnwrapped);
      values.push({
        west,
        south: bounds.south + row * latStep,
        east,
        north: bounds.south + (row + 1) * latStep
      });
    }
  }
  return values;
}

let activeRequestId = 0;

async function generateGrid(request: Request) {
  try {
    const centerLat = (request.bounds.north + request.bounds.south) / 2;
    const centerLon = request.bounds.west + ((request.bounds.east - request.bounds.west + 360) % 360) / 2;
    const sample = latLngToCell(centerLat, ((centerLon + 180) % 360) - 180, request.resolution);
    const fullWorld = h3BoundsWidth(request.bounds) >= 359.999;
    const estimatedCells = fullWorld
      ? getNumCells(request.resolution)
      : Math.ceil(sphericalAreaKm2(request.bounds) / Math.max(1e-12, cellArea(sample, "km2")));
    const fitted = fitH3BoundsToBudget(request.bounds, estimatedCells, request.maxCells);
    const expectedDisplayCells = Math.min(estimatedCells, Math.floor(request.maxCells * 0.72));
    const regions = splitBounds(fitted.bounds, Math.max(1, Math.ceil(expectedDisplayCells / 10_000)));
    const seen = new Set<string>();
    let clipped = fitted.clipped || estimatedCells > request.maxCells;
    for (const region of regions) {
      if (request.id !== activeRequestId) return;
      const available = request.maxCells - seen.size;
      if (available <= 0) {
        clipped = true;
        break;
      }
      const uniqueCells: string[] = [];
      for (const cell of cellsForBounds(region, request.resolution)) {
        if (seen.has(cell)) continue;
        seen.add(cell);
        uniqueCells.push(cell);
        if (uniqueCells.length >= available) {
          clipped = true;
          break;
        }
      }
      if (uniqueCells.length) self.postMessage({
        id: request.id,
        ok: true,
        kind: "chunk",
        cells: uniqueCells,
        estimatedCells,
        clipped
      } satisfies Response);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (request.id !== activeRequestId) return;
    if (!seen.size) {
      self.postMessage({ id: request.id, ok: false, reason: "empty", estimatedCells } satisfies Response);
      return;
    }
    self.postMessage({
      id: request.id,
      ok: true,
      kind: "complete",
      cells: [],
      estimatedCells,
      clipped,
      displayedCells: seen.size
    } satisfies Response);
  } catch {
    if (request.id === activeRequestId) self.postMessage({ id: request.id, ok: false, reason: "invalid", estimatedCells: 0 } satisfies Response);
  }
}

self.onmessage = (event: MessageEvent<Request>) => {
  activeRequestId = event.data.id;
  void generateGrid(event.data);
};
