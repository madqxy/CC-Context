import test from "node:test";
import assert from "node:assert/strict";
import { allocateCells, blockColumns, levelColor, eighthBar } from "../src/chart.mjs";

const sum = (a) => a.reduce((x, y) => x + y, 0);

test("allocateCells always fills the width exactly", () => {
  for (const width of [1, 7, 20, 48, 101]) {
    const cells = allocateCells([12400, 9200, 38000, 1200, 137000], width);
    assert.equal(sum(cells), width, "width " + width);
  }
});

test("allocateCells keeps a tiny category visible and never goes negative", () => {
  const cells = allocateCells([1, 1000000, 5], 30);
  assert.ok(cells[0] >= 1 && cells[2] >= 1, JSON.stringify(cells));
  assert.ok(cells.every((c) => c >= 0));
  assert.equal(sum(cells), 30);
});

test("allocateCells is proportional when it can be", () => {
  assert.deepEqual(allocateCells([1, 1, 2], 8), [2, 2, 4]);
});

test("allocateCells handles empty and zero input", () => {
  assert.deepEqual(allocateCells([], 10), []);
  assert.deepEqual(allocateCells([0, 0], 10), [0, 0]);
  assert.deepEqual(allocateCells([5], 0), [0]);
  assert.deepEqual(allocateCells([NaN, -3, 4], 4), [0, 0, 4]);
});

test("blockColumns fills every column from the baseline", () => {
  const chart = blockColumns([100, 100, 100, 100], 4, 2);
  assert.equal(chart.rows.length, 2);
  assert.equal(chart.rows[1], "████", "the bottom row is full");
  assert.equal(chart.rows[0], "████", "and so is the top, at the peak");
});

test("blockColumns makes the peak full and a zero column empty", () => {
  const chart = blockColumns([0, 10], 2, 2);
  assert.equal(chart.rows[1], " █");
  assert.equal(chart.rows[0], " █");
});

test("blockColumns steps the edge by an eighth of a row", () => {
  // two rows are 16 steps: a quarter of the peak is 4, which is half the bottom row
  const chart = blockColumns([4, 16], 2, 2);
  assert.equal(chart.rows[1], "▄█");
  assert.equal(chart.rows[0], " █");
});

test("blockColumns keeps a tiny value visible and never overflows", () => {
  const chart = blockColumns([1, 1000000], 2, 2);
  assert.notEqual([...chart.rows[1]][0], " ", "a small value still gets a cell");
  assert.equal([...chart.rows[1]].length, 2);
});

test("blockColumns thickens bars when there is room, and maps every value to its column", () => {
  const chart = blockColumns([1, 2, 3], 9, 2);
  assert.equal(chart.per, 3);
  assert.equal([...chart.rows[1]].length, 9);
  assert.deepEqual(chart.positions, [1, 4, 7]);
});

test("blockColumns copes with nothing", () => {
  const chart = blockColumns([], 5, 2);
  assert.deepEqual(chart.rows, ["     ", "     "]);
  assert.deepEqual(chart.positions, []);
});

test("levelColor steps with the window", () => {
  assert.deepEqual([0, 30, 60, 80, 95].map(levelColor), ["green", "cyan", "blue", "magenta", "red"]);
});

test("eighthBar always has the asked width", () => {
  for (const value of [0, 1, 105, 5000, 253900, 640000, 9e9]) {
    assert.equal([...eighthBar(value, 640000, 20)].length, 20, "value " + value);
  }
});

test("eighthBar is proportional down to an eighth of a cell", () => {
  assert.equal(eighthBar(320000, 640000, 20), "██████████··········");
  assert.equal(eighthBar(640000, 640000, 20), "████████████████████");
  assert.equal(eighthBar(0, 640000, 20), "····················");
  // 1.5 cells of 20 -> one full cell and four eighths
  assert.equal(eighthBar(48000, 640000, 20), "█▌··················");
});

test("eighthBar never lets a small item vanish, and never overflows", () => {
  assert.equal(eighthBar(105, 640000, 20), "▏···················");
  assert.equal([...eighthBar(1e12, 640000, 20)].filter((c) => c === "█").length, 20);
  assert.equal(eighthBar(5, 0, 6), "······", "no maximum: nothing to compare against");
});
