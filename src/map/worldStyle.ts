import type { StyleSpecification } from "maplibre-gl";

export function createWorldStyle(pmtilesUrl: string, projection: "mercator" | "globe" = "mercator"): StyleSpecification {
  return {
    version: 8,
    name: "Stripe 离线世界地图",
    projection: { type: projection },
    sources: {
      world: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution: "Natural Earth / 阿里云 DataV / PMTiles"
      }
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#d8e7ea" } },
      {
        id: "countries-fill",
        type: "fill",
        source: "world",
        "source-layer": "countries",
        paint: { "fill-color": "#d7ded3", "fill-opacity": 0.98 }
      },
      {
        id: "countries-line",
        type: "line",
        source: "world",
        "source-layer": "countries",
        paint: { "line-color": "#637b76", "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.45, 8, 1.2] }
      },
      {
        id: "states-line",
        type: "line",
        source: "world",
        "source-layer": "states",
        minzoom: 3,
        paint: { "line-color": "#89958d", "line-opacity": 0.72, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 8, 0.9] }
      },
      {
        id: "lakes-fill",
        type: "fill",
        source: "world",
        "source-layer": "lakes",
        paint: { "fill-color": "#bad9e1", "fill-opacity": 1 }
      },
      {
        id: "rivers-line",
        type: "line",
        source: "world",
        "source-layer": "rivers",
        paint: { "line-color": "#8eb9c8", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.35, 8, 1.1] }
      }
    ]
  };
}

export const fallbackStyle: StyleSpecification = {
  version: 8,
  name: "Stripe 空白底图",
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#d9e6e8" } }]
};

export function createOsmStyle(archiveUrl: string, projection: "mercator" | "globe" = "mercator"): StyleSpecification {
  return {
    version: 8,
    name: "OpenStreetMap 在线底图",
    projection: { type: projection },
    sources: {
      world: {
        type: "vector",
        url: `pmtiles://${archiveUrl}`,
        attribution: "Natural Earth / 阿里云 DataV / PMTiles"
      },
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        maxzoom: 19,
        attribution: "© OpenStreetMap contributors"
      }
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#d9e6e8" } },
      {
        id: "osm-fallback-countries-fill",
        type: "fill",
        source: "world",
        "source-layer": "countries",
        paint: { "fill-color": "#d7ded3", "fill-opacity": 0.98 }
      },
      {
        id: "osm-fallback-countries-line",
        type: "line",
        source: "world",
        "source-layer": "countries",
        paint: { "line-color": "#637b76", "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.45, 8, 1.2] }
      },
      {
        id: "osm-fallback-states-line",
        type: "line",
        source: "world",
        "source-layer": "states",
        minzoom: 3,
        paint: { "line-color": "#89958d", "line-opacity": 0.72, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 8, 0.9] }
      },
      {
        id: "osm-fallback-lakes-fill",
        type: "fill",
        source: "world",
        "source-layer": "lakes",
        paint: { "fill-color": "#bad9e1", "fill-opacity": 1 }
      },
      {
        id: "osm-fallback-rivers-line",
        type: "line",
        source: "world",
        "source-layer": "rivers",
        paint: { "line-color": "#8eb9c8", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.35, 8, 1.1] }
      },
      { id: "osm", type: "raster", source: "osm", paint: { "raster-fade-duration": 0 } }
    ]
  };
}

export const transparentOverlayStyle: StyleSpecification = {
  version: 8,
  name: "高德地图透明规划图层",
  projection: { type: "mercator" },
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "rgba(0, 0, 0, 0)" } }
  ]
};

export function createAmapGlobeStyle(
  overviewTileBase: string,
  archiveUrl?: string,
  surfaceRendering = false,
  satelliteOverviewTileBase = overviewTileBase
): StyleSpecification {
  const fallbackLayers: StyleSpecification["layers"] = archiveUrl ? [
    {
      id: "amap-fallback-countries-fill",
      type: "fill",
      source: "amap-fallback-world",
      "source-layer": "countries",
      paint: { "fill-color": "#d7ded3", "fill-opacity": 0.98 }
    },
    {
      id: "amap-fallback-countries-line",
      type: "line",
      source: "amap-fallback-world",
      "source-layer": "countries",
      paint: { "line-color": "#637b76", "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.45, 8, 1.2] }
    },
    {
      id: "amap-fallback-states-line",
      type: "line",
      source: "amap-fallback-world",
      "source-layer": "states",
      minzoom: 3,
      paint: { "line-color": "#89958d", "line-opacity": 0.72, "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.35, 8, 0.9] }
    },
    {
      id: "amap-fallback-lakes-fill",
      type: "fill",
      source: "amap-fallback-world",
      "source-layer": "lakes",
      paint: { "fill-color": "#bad9e1", "fill-opacity": 1 }
    },
    {
      id: "amap-fallback-rivers-line",
      type: "line",
      source: "amap-fallback-world",
      "source-layer": "rivers",
      paint: { "line-color": "#8eb9c8", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.35, 8, 1.1] }
    }
  ] : [];
  return {
    version: 8,
    name: surfaceRendering ? "高德自然地表球面" : "高德地图球面底图",
    projection: { type: "globe" },
    sources: {
      ...(archiveUrl ? {
        "amap-fallback-world": {
          type: "vector" as const,
          url: `pmtiles://${archiveUrl}`,
          attribution: "Natural Earth / 阿里云 DataV / PMTiles"
        }
      } : {}),
      "amap-overview": {
        type: "raster",
        tiles: [`${surfaceRendering ? satelliteOverviewTileBase : overviewTileBase}{z}/{x}/{y}.png`],
        tileSize: 512,
        minzoom: 0,
        maxzoom: 2,
        attribution: "高德地图 © AutoNavi"
      },
      amap: {
        type: "raster",
        tiles: [1, 2, 3, 4].map((index) => surfaceRendering
          ? `https://webst0${index}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}`
          : `https://webrd0${index}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`),
        tileSize: 256,
        minzoom: 3,
        maxzoom: 18,
        attribution: "高德地图 © AutoNavi"
      },
      ...(surfaceRendering ? {
        "amap-annotations": {
          type: "raster" as const,
          tiles: [1, 2, 3, 4].map((index) => `https://webst0${index}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}`),
          tileSize: 256,
          minzoom: 0,
          maxzoom: 18,
          attribution: "高德地图 © AutoNavi"
        }
      } : {})
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": surfaceRendering ? "#020609" : "#d9e6e8" } },
      ...fallbackLayers,
      { id: "amap-globe-overview", type: "raster", source: "amap-overview", maxzoom: 3, paint: { "raster-fade-duration": 0 } },
      { id: "amap-globe", type: "raster", source: "amap", minzoom: 3, paint: { "raster-fade-duration": 0 } },
      ...(surfaceRendering ? [{
        id: "amap-globe-annotations",
        type: "raster" as const,
        source: "amap-annotations",
        paint: { "raster-fade-duration": 0 }
      }] : [])
    ]
  };
}
