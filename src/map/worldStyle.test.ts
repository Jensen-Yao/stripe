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

  it("高德球面保留本地回退并把在线瓦片放在上层", () => {
    const style = createAmapGlobeStyle(
      "https://stripe.local/maps/amap-overview/",
      "https://stripe.local/maps/world.pmtiles"
    );
    expect(style.projection).toEqual({ type: "globe" });
    expect(style.sources["amap-fallback-world"]).toMatchObject({ type: "vector" });
    expect(style.layers.findIndex((layer) => layer.id === "amap-fallback-countries-fill"))
      .toBeLessThan(style.layers.findIndex((layer) => layer.id === "amap-globe"));
    expect(style.layers.find((layer) => layer.id === "amap-globe-overview")).toBeDefined();
  });
});
