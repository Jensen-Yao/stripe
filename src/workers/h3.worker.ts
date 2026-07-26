import { cellArea, cellToChildren, getNumCells, getRes0Cells, latLngToCell, polygonToCells } from "h3-js";

type Request = {
  id: number;
  resolution: number;
  bounds: { west: number; south: number; east: number; north: number };
  maxCells: number;
};

type Response =
  | { id: number; ok: true; cells: string[]; estimatedCells: number }
  | { id: number; ok: false; reason: "too-many" | "empty" | "invalid"; estimatedCells: number };

function sphericalAreaKm2(bounds: Request["bounds"]) {
  const radius = 6371.0088;
  const south = (bounds.south * Math.PI) / 180;
  const north = (bounds.north * Math.PI) / 180;
  let width = bounds.east - bounds.west;
  if (width < 0) width += 360;
  return radius * radius * ((width * Math.PI) / 180) * Math.abs(Math.sin(north) - Math.sin(south));
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    const centerLat = (request.bounds.north + request.bounds.south) / 2;
    const centerLon = request.bounds.west + ((request.bounds.east - request.bounds.west + 360) % 360) / 2;
    const sample = latLngToCell(centerLat, ((centerLon + 180) % 360) - 180, request.resolution);
    const fullWorld = request.bounds.east - request.bounds.west >= 359.999;
    const estimatedCells = fullWorld
      ? getNumCells(request.resolution)
      : Math.ceil(sphericalAreaKm2(request.bounds) / Math.max(1e-12, cellArea(sample, "km2")));
    if (estimatedCells > request.maxCells) {
      self.postMessage({ id: request.id, ok: false, reason: "too-many", estimatedCells } satisfies Response);
      return;
    }
    const { west, south, east, north } = request.bounds;
    const rings = east >= west
      ? [[[west, north], [east, north], [east, south], [west, south], [west, north]]]
      : [
          [[west, north], [180, north], [180, south], [west, south], [west, north]],
          [[-180, north], [east, north], [east, south], [-180, south], [-180, north]]
        ];
    const cells = fullWorld
      ? getRes0Cells().flatMap((cell) => cellToChildren(cell, request.resolution))
      : Array.from(new Set(rings.flatMap((ring) => polygonToCells([ring], request.resolution, true))));
    self.postMessage(
      cells.length
        ? ({ id: request.id, ok: true, cells, estimatedCells } satisfies Response)
        : ({ id: request.id, ok: false, reason: "empty", estimatedCells } satisfies Response)
    );
  } catch {
    self.postMessage({ id: request.id, ok: false, reason: "invalid", estimatedCells: 0 } satisfies Response);
  }
};
