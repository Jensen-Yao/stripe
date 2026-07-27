import { describe, expect, it } from "vitest";
import { wgs84ToGcj02 } from "./amap";

describe("高德地图坐标对齐", () => {
  it("在中国境内将 WGS84 转换为 GCJ-02", () => {
    const [lon, lat] = wgs84ToGcj02(116.397, 39.908);
    expect(lon).toBeCloseTo(116.40324, 4);
    expect(lat).toBeCloseTo(39.9094, 4);
  });

  it("在中国境外保持 WGS84 坐标不变", () => {
    expect(wgs84ToGcj02(-74.006, 40.7128)).toEqual([-74.006, 40.7128]);
  });
});
