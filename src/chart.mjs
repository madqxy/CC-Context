// Pure drawing helpers for the terminal views: no Node, no host, no state.
//
// The mod loads this file next to estimate.mjs, so it must stay dependency-free
// (a failed import stops the whole mod from loading).

// allocateCells splits `width` cells among `values` in proportion to them, as
// whole cells that add up to exactly `width`. A value above zero always gets at
// least one cell while the width allows it, so a small category stays visible
// instead of rounding away. Largest remainder decides who gets the spare cells.
export function allocateCells(values, width) {
  const count = values.length;
  const cells = new Array(count).fill(0);
  const w = Math.max(0, Math.floor(width));
  const clean = values.map((v) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0));
  const total = clean.reduce((sum, v) => sum + v, 0);
  if (w === 0 || total <= 0) {
    return cells;
  }
  const exact = clean.map((v) => (v / total) * w);
  let used = 0;
  for (let i = 0; i < count; i += 1) {
    cells[i] = Math.floor(exact[i]);
    used += cells[i];
  }
  // Spare cells go to the biggest fractional parts.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .filter((entry) => clean[entry.i] > 0)
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; used < w && order.length > 0; k = (k + 1) % order.length) {
    cells[order[k].i] += 1;
    used += 1;
  }
  // Anything above zero that still has no cell takes one from the widest.
  const positive = clean.filter((v) => v > 0).length;
  if (w >= positive) {
    for (let i = 0; i < count; i += 1) {
      if (clean[i] > 0 && cells[i] === 0) {
        let widest = 0;
        for (let j = 1; j < count; j += 1) {
          if (cells[j] > cells[widest]) {
            widest = j;
          }
        }
        cells[widest] -= 1;
        cells[i] = 1;
      }
    }
  }
  return cells;
}

// UP_EIGHTHS is how a partially filled cell looks: the glyph for k/8 of a row.
const UP_EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// blockColumns draws a filled column chart: every value becomes a rectangle of
// cells grown from the baseline, so a series reads as solid area instead of a
// line floating above it. The tallest column fills every row; the top cell of a
// column uses eighth-height blocks, so the edge steps by an eighth and not by a
// whole row. Bars thicken to 2-3 cells when there is room, and the returned
// positions map each original value to the column that draws it, so markers line up.
export function blockColumns(values, columns, rows = 3) {
  const cols = Math.max(1, Math.floor(columns));
  const rowCount = Math.max(1, Math.floor(rows));
  const clean = (Array.isArray(values) ? values : []).filter((v) => typeof v === "number" && isFinite(v) && v >= 0);
  if (clean.length === 0) {
    return { rows: new Array(rowCount).fill(" ".repeat(cols)), positions: [], width: cols, count: 0, per: 1 };
  }
  const max = Math.max.apply(null, clean.concat([1]));
  const per = Math.max(1, Math.min(3, Math.floor(cols / clean.length)));
  const buckets = Math.max(1, Math.min(clean.length, Math.floor(cols / per)));
  const size = clean.length / buckets;
  const height = rowCount * 8;
  const levels = [];
  for (let i = 0; i < buckets; i += 1) {
    const from = Math.floor(i * size);
    const to = Math.max(from + 1, Math.min(clean.length, Math.floor((i + 1) * size)));
    let peak = 0;
    for (let k = from; k < to; k += 1) {
      peak = Math.max(peak, clean[k]);
    }
    levels.push(peak <= 0 ? 0 : Math.max(1, Math.round((peak / max) * height)));
  }
  const out = [];
  for (let r = 0; r < rowCount; r += 1) {
    const below = (rowCount - 1 - r) * 8;
    let line = "";
    for (let i = 0; i < buckets; i += 1) {
      const fill = Math.max(0, Math.min(8, levels[i] - below));
      line += UP_EIGHTHS[fill].repeat(per);
    }
    out.push(line);
  }
  const positions = clean.map(function (_, index) {
    const bucket = Math.min(buckets - 1, Math.floor(index / size));
    return bucket * per + Math.floor(per / 2);
  });
  return { rows: out, positions: positions, width: buckets * per, count: buckets, per: per };
}

export function levelColor(percent) {
  const p = typeof percent === "number" && isFinite(percent) ? percent : 0;
  return p >= 90 ? "red" : p >= 75 ? "magenta" : p >= 50 ? "blue" : p >= 25 ? "cyan" : "green";
}

const EIGHTHS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];

// eighthBar draws `value` out of `max` as a bar `width` cells wide with eighth-cell
// precision, the rest of the width a faint track. Any value above zero shows at
// least a sliver, so a small item reads as small rather than as absent.
export function eighthBar(value, max, width, track = "·") {
  const w = Math.max(1, Math.floor(width));
  const v = typeof value === "number" && isFinite(value) && value > 0 ? value : 0;
  const m = typeof max === "number" && isFinite(max) && max > 0 ? max : 0;
  const cells = m > 0 ? Math.min(w, (v / m) * w) : 0;
  let full = Math.floor(cells);
  let eighths = Math.round((cells - full) * 8);
  if (eighths === 8) {
    full += 1;
    eighths = 0;
  }
  if (m > 0 && v > 0 && full === 0 && eighths === 0) {
    eighths = 1;
  }
  const head = "█".repeat(full) + (eighths > 0 && full < w ? EIGHTHS[eighths - 1] : "");
  const used = full + (eighths > 0 && full < w ? 1 : 0);
  return head + track.repeat(Math.max(0, w - used));
}
