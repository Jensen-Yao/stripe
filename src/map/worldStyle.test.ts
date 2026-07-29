import { describe, expect, it } from "vitest";
import { createAmapGlobeStyle, createOsmStyle } from "./worldStyle";

describe("底图样式回退", () => {
  it("OSM 二维和三维都保留本地 PMTiles 世界层", () => {
    for (const projection of ["mercator", "globe"] as const) {
      const style = createOsmStyle("https://stripe.local/maps/world.pmtiles", projection);
      expect(style.projection).toEqual({ type: projection });
      expect(style.sources.world).toMatchObject({
        type: "vector",
        url: "pmtiles://https://stripe.local/maps/world.pmtiles"
      });
      expect(style.layers.some((layer) => layer.id === "osm-fallback-countries-fill")).toBe(true);
      expect(style.layers.some((layer) => layer.id === "osm")).toBe(true);
    }
  });

  it("高德球面以本地低层级脉络覆盖概览图，但不延伸到在线高层级", () => {
    const style = createAmapGlobeStyle(
      "https://stripe.local/maps/amap-overview/",
      "https://stripe.local/maps/world.pmtiles"
    );
    expect(style.projection).toEqual({ type: "globe" });
    expect(style.sources["amap-fallback-world"]).toMatchObject({ type: "vector" });
    const fallback = style.layers.find((layer) => layer.id === "amap-fallback-countries-fill");
    expect(style.layers.findIndex((layer) => layer.id === "amap-fallback-countries-fill"))
      .toBeGreaterThan(style.layers.findIndex((layer) => layer.id === "amap-globe-overview"));
    expect(fallback).toMatchObject({ maxzoom: 3 });
    expect(style.layers.find((layer) => layer.id === "amap-globe-overview")).toBeDefined();
  });

  it("高德自然地表球面组合卫星影像与中文注记", () => {
    const style = createAmapGlobeStyle(
      "https://stripe.local/maps/amap-overview/",
      "https://stripe.local/maps/world.pmtiles",
      true,
      "https://stripe.local/maps/amap-satellite-overview/"
    );
    expect(style.name).toBe("高德自然地表球面");
    expect(style.sources["amap-overview"]).toMatchObject({
      tiles: ["https://stripe.local/maps/amap-satellite-overview/{z}/{x}/{y}.png"]
    });
    expect(style.sources.amap).toMatchObject({ type: "raster" });
    expect(style.sources["amap-annotations"]).toMatchObject({ type: "raster" });
    expect(style.layers.find((layer) => layer.id === "amap-globe-annotations")).toMatchObject({ minzoom: 3 });
    expect(style.layers.find((layer) => layer.id === "amap-globe-overview")?.paint).toMatchObject({
      "raster-opacity": 0.88,
      "raster-contrast": -0.12
    });
  });
});
