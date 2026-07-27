export type H3Bounds = { west: number; south: number; east: number; north: number };

function normalizeLon(lon: number) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

export function h3BoundsWidth(bounds: H3Bounds) {
  const rawWidth = bounds.east - bounds.west;
  return rawWidth >= 359.999 ? 360 : ((rawWidth % 360) + 360) % 360;
}

export function fitH3BoundsToBudget(bounds: H3Bounds, estimatedCells: number, maxCells: number, safetyRatio = 0.68) {
  if (estimatedCells <= maxCells) return { bounds, clipped: false };
  const scale = Math.min(1, Math.sqrt((maxCells * safetyRatio) / Math.max(1, estimatedCells)));
  const width = h3BoundsWidth(bounds);
  const centerLon = normalizeLon(bounds.west + width / 2);
  const centerLat = (bounds.south + bounds.north) / 2;
  const halfWidth = Math.min(180, width * scale / 2);
  const halfHeight = Math.min(85, (bounds.north - bounds.south) * scale / 2);
  return {
    bounds: {
      west: halfWidth >= 180 ? -180 : normalizeLon(centerLon - halfWidth),
      south: Math.max(-85, centerLat - halfHeight),
      east: halfWidth >= 180 ? 180 : normalizeLon(centerLon + halfWidth),
      north: Math.min(85, centerLat + halfHeight)
    },
    clipped: true
  };
}
