import { describe, expect, it } from "vitest";
import { parseStripeInput } from "./importers";

describe("stripe import", () => {
  it("imports multiple coordinate arrays", () => {
    const result = parseStripeInput("[[[116,40],[117,40],[117,39],[116,39]],[[118,40],[119,40],[119,39],[118,39]]]", "lonlat");
    expect(result).toHaveLength(2);
  });

  it("imports GeoJSON polygons", () => {
    const result = parseStripeInput(JSON.stringify({ type: "Feature", geometry: { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] }, properties: {} }), "lonlat");
    expect(result).toHaveLength(1);
  });

  it("imports KML coordinates", () => {
    const result = parseStripeInput("<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1 0,1 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>", "lonlat");
    expect(result).toHaveLength(1);
  });

  it("keeps standard KML and GeoJSON coordinates in longitude-latitude order", () => {
    const kml = parseStripeInput("<kml><coordinates>110,20 111,20 111,21 110,21 110,20</coordinates></kml>", "latlon");
    const geoJson = parseStripeInput(JSON.stringify({ type: "Polygon", coordinates: [[[110,20],[111,20],[111,21],[110,21],[110,20]]] }), "latlon");
    expect(kml[0].corners.every((point) => point.lon > 100 && point.lat < 30)).toBe(true);
    expect(geoJson[0].corners.every((point) => point.lon > 100 && point.lat < 30)).toBe(true);
  });

  it("rejects latitude values outside the geographic range", () => {
    expect(parseStripeInput("[[0,95],[1,95],[1,94],[0,94]]", "lonlat")).toHaveLength(0);
  });

  it("rejects degenerate four point input", () => {
    const result = parseStripeInput("[[0,0],[0,0],[1,1],[0,1]]", "lonlat");
    expect(result).toHaveLength(0);
  });

  it("imports arbitrary concave polygons without reordering vertices", () => {
    const result = parseStripeInput("[[110,30],[112,30],[112,32],[111,31],[110,32]]", "lonlat");
    expect(result).toHaveLength(1);
    expect(result[0].corners).toHaveLength(5);
    expect(result[0].corners[3]).toMatchObject({ lon: 111, lat: 31 });
  });

  it("rejects self-intersecting arbitrary polygons", () => {
    expect(parseStripeInput("[[0,0],[3,3],[0,3],[3,0],[1.5,-1]]", "lonlat")).toHaveLength(0);
  });
});
