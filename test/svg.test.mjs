// Geometry behind the HTML report: no DOM, so it is testable on its own.

import test from "node:test";
import assert from "node:assert/strict";
import { niceMax, linePath, areaPath, barRects, stackHeights, sparkPath, tickValues } from "../src/svg.mjs";

test("niceMax rounds an axis top up to 1/2/5 x 10^n", () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(37), 50);
  assert.equal(niceMax(1200), 2000);
  assert.equal(niceMax(1.4), 2);
  assert.equal(niceMax(500), 500);
});

test("linePath draws one move and then lines", () => {
  assert.equal(linePath([]), "");
  assert.equal(linePath([{ x: 0, y: 10 }, { x: 5, y: 0 }]), "M0 10 L5 0");
});

test("areaPath closes the line down to the baseline", () => {
  assert.equal(areaPath([{ x: 0, y: 10 }, { x: 5, y: 2 }], 20), "M0 10 L5 2 L5 20 L0 20 Z");
  assert.equal(areaPath([], 20), "");
});

test("barRects splits a band evenly, leaving gaps between slots", () => {
  const rects = barRects(3, { x: 10, width: 100, gap: 2 });
  assert.equal(rects.length, 3);
  assert.equal(rects[0].x, 10);
  assert.equal(rects[2].x + rects[2].w, 110);
  const total = rects.reduce((sum, rect) => sum + rect.w, 0) + 2 * 2;
  assert.equal(Math.round(total), 100);
  assert.deepEqual(barRects(0, { width: 10 }), []);
});

test("stackHeights scales each segment against the axis top", () => {
  assert.deepEqual(stackHeights([100, 50], 200, 200), [100, 50]);
  assert.deepEqual(stackHeights([0, 0], 200, 200), [0, 0]);
  assert.deepEqual(stackHeights([10], 100, 0), [0]);
});

test("sparkPath puts bigger values higher, and keeps one point centred", () => {
  const rising = sparkPath([1, 10], 100, 20, 0);
  assert.ok(rising.points[0].y > rising.points[1].y, "the larger value sits nearer the top");
  assert.equal(rising.points[0].x, 0);
  assert.equal(rising.points[1].x, 100);
  const single = sparkPath([5], 100, 20, 0);
  assert.equal(single.points[0].x, 50);
  assert.deepEqual(sparkPath([], 10, 10, 0), { path: "", points: [] });
});

test("tickValues covers 0 to the top inclusive", () => {
  assert.deepEqual(tickValues(100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(tickValues(0, 2), [0, 0.5, 1]);
});
