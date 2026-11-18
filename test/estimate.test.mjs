// Run with: node --test test/
//
// These pin the numbers the analyzer prints, and they load the mod module so a
// syntax error in hooks/cc-context.mjs fails here rather than at session start.

import test from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, human, bar, sparkline, padRight, percent, charWidth, displayWidth } from "../src/estimate.mjs";
import { register } from "../hooks/cc-context.mjs";

test("the mod exports register", () => {
  assert.equal(typeof register, "function");
});

test("estimateTokens counts ASCII at four characters per token", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("estimateTokens charges wide characters more", () => {
  assert.equal(estimateTokens("中文"), 2);
  assert.equal(estimateTokens("a中"), 1);
  assert.ok(estimateTokens("中中中中") > estimateTokens("aaaa"));
});

test("human shortens large numbers", () => {
  assert.equal(human(0), "0");
  assert.equal(human(999), "999");
  assert.equal(human(1500), "1.5k");
  assert.equal(human(2000), "2k");
  assert.equal(human(1500000), "1.5M");
});

test("bar fills in proportion", () => {
  assert.equal(bar(0, 100, 10), "░".repeat(10));
  assert.equal(bar(100, 100, 10), "█".repeat(10));
  assert.equal(bar(50, 100, 10), "█".repeat(5) + "░".repeat(5));
  assert.equal(bar(200, 100, 10), "█".repeat(10));
});

test("sparkline maps the range onto the glyphs", () => {
  assert.equal(sparkline([1, 2, 3]), "▁▄█");
  assert.equal(sparkline([5]), "▁");
  assert.equal(sparkline([]), "");
});

test("padRight pads by display width", () => {
  assert.equal(padRight("ab", 5), "ab   ");
  assert.equal(padRight("中文", 6), "中文  ");
  assert.equal(padRight("abcdef", 3), "abcdef");
});

test("percent guards against a zero total", () => {
  assert.equal(percent(50, 200), 25);
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(300, 200), 100);
});

test("width counts box-drawing, block and braille glyphs as one column", () => {
  assert.equal(charWidth(0x2500), 1, "─");
  assert.equal(charWidth(0x251c), 1, "├");
  assert.equal(charWidth(0x2588), 1, "█");
  assert.equal(charWidth(0x2800), 1, "braille");
  assert.equal(charWidth(0x4e2d), 2, "中");
  assert.equal(displayWidth("├─ ●"), 4, "tree branch plus one glyph");
  assert.equal(displayWidth("中文"), 4);
  assert.equal(padRight("├─", 4), "├─  ");
});
