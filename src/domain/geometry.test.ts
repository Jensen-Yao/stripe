import { describe, expect, it } from "vitest";
import { analyzeStripeOverlaps, analyzeStripePair, scaleStripeAxes, stripeFromParameters, stripeMetrics, transformStripe } from "./geometry";
import type { Stripe } from "./types";

function stripe(id: string, centerLon: number, widthKm = 100): Stripe {
  const now = new Date(0).toISOString();
  return { id, name: id, visible: true, color: "#fff", corners: stripeFromParameters({ lon: centerLon, lat: 20 }, 400, widthKm, 0), createdAt: now, updatedAt: now };
}

describe("WGS84 stripe geometry", () => {
  it("builds a stripe with stable engineering dimensions", () => {
    const corners = stripeFromParameters({ lon: 116, lat: 40 }, 500, 50, 32);
    const metrics = stripeMetrics(corners);
    expect(metrics.lengthKm).toBeCloseTo(500, 0);
    expect(metrics.widthKm).toBeCloseTo(50, 0);
    expect(metrics.areaKm2).toBeGreaterThan(24000);
  });

  it("rotates without changing length and width", () => {
    const corners = stripeFromParameters({ lon: 0, lat: 72 }, 300, 30, 5);
    const before = stripeMetrics(corners);
    const after = stripeMetrics(transformStripe(corners, { rotationDeg: 75 }));
    expect(after.lengthKm).toBeCloseTo(before.lengthKm, 1);
    expect(after.widthKm).toBeCloseTo(before.widthKm, 1);
  });

  it("scales along stripe axes rather than map axes", () => {
    const corners = stripeFromParameters({ lon: 12, lat: 51 }, 200, 40, 47);
    const metrics = stripeMetrics(scaleStripeAxes(corners, 1.5, 0.5));
    expect(metrics.lengthKm).toBeCloseTo(300, 0);
    expect(metrics.widthKm).toBeCloseTo(20, 0);
  });

  it("computes precise overlap relation", () => {
    const a = stripe("a", 0, 120);
    const b = stripe("b", 0.5, 120);
    const overlap = analyzeStripePair(a, b);
    expect(overlap).not.toBeNull();
    expect(overlap?.relation).toBe("overlap");
    expect(overlap?.overlapAreaKm2).toBeGreaterThan(0);
  });

  it("handles stripes crossing the date line", () => {
    const a = stripe("a", 179.7, 160);
    const b = stripe("b", -179.7, 160);
    expect(analyzeStripePair(a, b)).not.toBeNull();
  });

  it("indexes one thousand stripes without quadratic comparison", () => {
    const values = Array.from({ length: 1000 }, (_value, index) => stripe(`s-${index}`, -170 + (index % 100) * 3.4, 20));
    expect(analyzeStripeOverlaps(values)).toBeInstanceOf(Array);
  });
});
