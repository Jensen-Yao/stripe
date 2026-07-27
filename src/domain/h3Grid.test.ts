import { describe, expect, it } from "vitest";
import { fitH3BoundsToBudget, h3BoundsWidth } from "./h3Grid";

describe("H3 display bounds", () => {
  it("keeps a range that fits the cell budget", () => {
    const bounds = { west: 110, south: 35, east: 120, north: 45 };
    expect(fitH3BoundsToBudget(bounds, 100_000, 500_000)).toEqual({ bounds, clipped: false });
  });

  it("clips oversized ranges around the same center without lowering resolution", () => {
    const bounds = { west: 110, south: 30, east: 130, north: 50 };
    const fitted = fitH3BoundsToBudget(bounds, 2_000_000, 500_000);
    expect(fitted.clipped).toBe(true);
    expect((fitted.bounds.west + fitted.bounds.east) / 2).toBeCloseTo(120, 6);
    expect((fitted.bounds.south + fitted.bounds.north) / 2).toBeCloseTo(40, 6);
    expect(h3BoundsWidth(fitted.bounds)).toBeLessThan(h3BoundsWidth(bounds));
  });

  it("preserves date-line crossing when clipping", () => {
    const fitted = fitH3BoundsToBudget({ west: 170, south: -20, east: -170, north: 20 }, 4_000_000, 500_000);
    expect(fitted.clipped).toBe(true);
    expect(fitted.bounds.east).toBeLessThan(fitted.bounds.west);
    expect(h3BoundsWidth(fitted.bounds)).toBeLessThan(20);
  });
});
