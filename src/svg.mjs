// Pure geometry for the HTML report: numbers in, numbers out. No Node, no DOM,
// no dependencies, so it runs in the CLI and under test alike.
//
// The report draws with inline SVG; these helpers decide where the points, bars
// and gridlines go, and the CLI turns them into markup.

export function round(value) {
  return Math.round(value * 10) / 10;
}

// niceMax rounds an axis top up to 1/2/5 x 10^n so gridlines land on round numbers.
export function niceMax(value) {
  const n = Number(value);
  if (!isFinite(n) || n <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(n));
  const base = Math.pow(10, exponent);
  const scaled = n / base;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * base;
}

export function linePath(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return "";
  }
  let out = "";
  for (let i = 0; i < points.length; i += 1) {
    out += (i === 0 ? "M" : " L") + round(points[i].x) + " " + round(points[i].y);
  }
  return out;
}

// areaPath closes a line down to the baseline, so it can be filled.
export function areaPath(points, baseY) {
  if (!Array.isArray(points) || points.length === 0) {
    return "";
  }
  const first = points[0];
  const last = points[points.length - 1];
  return linePath(points) + " L" + round(last.x) + " " + round(baseY) +
    " L" + round(first.x) + " " + round(baseY) + " Z";
}

// barRects splits a horizontal band into equal slots; the caller fills each slot.
export function barRects(count, options) {
  const opts = options || {};
  const x = Number(opts.x) || 0;
  const width = Number(opts.width) || 100;
  const gap = opts.gap === undefined ? 1 : Number(opts.gap);
  if (!(count > 0)) {
    return [];
  }
  const slot = Math.max(0, (width - gap * (count - 1)) / count);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ x: round(x + i * (slot + gap)), w: round(slot) });
  }
  return out;
}

// stackHeights turns one index's values (bottom-up) into stacked segment heights.
export function stackHeights(values, totalHeight, max) {
  const scale = max > 0 ? Number(totalHeight) / max : 0;
  return (Array.isArray(values) ? values : []).map((value) => {
    const n = Number(value);
    return round(isFinite(n) && n > 0 ? n * scale : 0);
  });
}

// sparkPath fits a series into a small box: higher values sit nearer the top.
export function sparkPath(values, width, height, pad) {
  const series = (Array.isArray(values) ? values : []).filter((value) => isFinite(Number(value)));
  const inset = pad === undefined ? 1 : Number(pad);
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  if (series.length === 0) {
    return { path: "", points: [] };
  }
  const max = Math.max.apply(null, series.concat([1]));
  const min = Math.min.apply(null, series.concat([0]));
  const span = max - min || 1;
  const innerW = Math.max(1, w - inset * 2);
  const innerH = Math.max(1, h - inset * 2);
  const points = series.map((value, index) => ({
    x: round(inset + (series.length === 1 ? innerW / 2 : (index / (series.length - 1)) * innerW)),
    y: round(inset + innerH - ((Number(value) - min) / span) * innerH),
  }));
  return { path: linePath(points), points: points };
}

// tickValues is the set of gridline values from 0 up to the axis top.
export function tickValues(max, count) {
  const steps = Math.max(1, Number(count) || 4);
  const top = Number(max) > 0 ? Number(max) : 1;
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    out.push((top / steps) * i);
  }
  return out;
}
