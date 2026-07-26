import type { StyleSpecification } from "maplibre-gl";

export function createWorldStyle(pmtilesUrl: string): StyleSpecification {
  return {
    version: 8,
    name: "Stripe 离线世界地图",
    sources: {
      world: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
        attribution: "Natural Earth / PMTiles"
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

export const osmStyle: StyleSpecification = {
  version: 8,
  name: "OpenStreetMap 在线底图",
  sources: {
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
    { id: "osm", type: "raster", source: "osm", paint: { "raster-fade-duration": 0 } }
  ]
};
