// Pure helpers shared by the offline analyzer and its tests.
//
// The mod in ../hooks carries its own copy of estimateTokens and human(),
// because the mods loader evaluates that file on its own. Keep the two in step:
// test/estimate.test.mjs pins the numbers these functions must produce.

export function estimateTokens(text) {
  if (typeof text !== "string" || text.length === 0) {
    return 0;
  }
  let ascii = 0;
  let wide = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) {
      ascii += 1;
    } else {
      wide += 1;
    }
  }
  return Math.round(ascii / 4 + wide * 0.75);
}

export function human(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n >= 1000000) {
    return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  }
  return String(n);
}

export function bar(value, max, width) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function sparkline(values, glyphs = "▁▂▃▄▅▆▇█") {
  if (!values.length) {
    return "";
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  let out = "";
  for (const value of values) {
    const index = Math.min(glyphs.length - 1, Math.floor(((value - min) / span) * (glyphs.length - 1)));
    out += glyphs[index];
  }
  return out;
}

// charWidth is the columns a code point takes. East Asian wide and fullwidth
// ranges take two; box drawing, block and braille glyphs (the ones this tool
// draws with) take one. A plain "not ASCII, therefore wide" rule gets those
// wrong, and every tree line then comes out one column too long.
export function charWidth(code) {
  if (code < 0x1100) {
    return 1;
  }
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

export function displayWidth(value) {
  let used = 0;
  for (const char of String(value)) {
    used += charWidth(char.codePointAt(0) || 0);
  }
  return used;
}

// padRight pads by display width: a CJK character takes two columns.
export function padRight(text, width) {
  return String(text) + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function percent(value, total) {
  if (!total || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

export function humanDuration(ms) {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${Math.round(ms / 60000)}m`;
}