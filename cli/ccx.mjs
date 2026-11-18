#!/usr/bin/env node
// CC-Context · offline analyzer for Claude Code transcripts.
//
// Claude Code writes one JSONL file per session under
// <config>/projects/<encoded-cwd>/<session-id>.jsonl. Each assistant line
// carries the API's usage block, which is the only per-request token record
// that survives after a session ends. This tool reads those files and reports
// the things a live pane cannot: cross-session totals, daily cost, per-session
// composition and tool/file activity.
//
//   node cli/ccx.mjs                      overview of recent sessions
//   node cli/ccx.mjs sessions             session list only
//   node cli/ccx.mjs session <id-prefix>  one session, request by request
//   node cli/ccx.mjs --days 7 --project demo
//   node cli/ccx.mjs --json               machine readable
//   node cli/ccx.mjs --html report.html   static report, no dependencies
//
// Flags: --days N · --project TEXT · --session-limit N · --json · --html PATH
//        --price-file PATH · --debug
//
// The transcript schema is not a public contract, so every read is defensive:
// unknown lines are ignored, unknown fields fall back, and --debug reports the
// shapes that were skipped.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { human, bar, sparkline, padRight, percent } from "../src/estimate.mjs";
import { niceMax, linePath, areaPath, barRects, stackHeights, sparkPath, tickValues, round } from "../src/svg.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRICE_FILE = path.join(HERE, "pricing.json");

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const projectsDir = path.join(configDir, "projects");

  if (!fs.existsSync(projectsDir)) {
    console.error(`找不到转录目录: ${projectsDir}`);
    console.error("如果 Claude Code 装在别处，设置 CLAUDE_CONFIG_DIR 指向配置目录。");
    process.exitCode = 1;
    return;
  }

  const pricing = loadPricing(args.priceFile);
  const files = walkJsonl(projectsDir);
  const sessions = [];
  for (const file of files) {
    const session = readSession(file, args.debug);
    if (session) {
      sessions.push(session);
    }
  }

  dedupeRequests(sessions);
  const filtered = filterSessions(sessions.filter((session) => session.requests.length > 0), args);
  if (filtered.length === 0) {
    console.error("没有匹配的会话。");
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    const summary = summarize(filtered, pricing);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  if (args.html) {
    const summary = summarize(filtered, pricing);
    fs.writeFileSync(args.html, renderHtml(summary, args), "utf8");
    console.log(`已写入 ${path.resolve(args.html)}`);
    return;
  }

  if (args.command === "session") {
    const target = findSession(filtered, args.target);
    if (!target) {
      console.error(`没有会话匹配 "${args.target}"。`);
      process.exitCode = 1;
      return;
    }
    console.log(renderSession(target, pricing));
    return;
  }

  if (args.command === "sessions") {
    const summary = summarize(filtered, pricing);
    console.log(`会话 ${summary.sessions.length} 个 · 请求 ${summary.totals.requests} 次`);
    for (const row of summary.sessions.slice(0, args.sessionLimit)) {
      const when = row.endAt ? new Date(row.endAt).toISOString().slice(0, 16).replace("T", " ") : "?";
      console.log(`  ${when}  ${padRight((row.kind === 'agent' ? '↳' : ' ') + row.id.slice(0, 8), 9)}  ${padRight(String(row.requests), 3)} 次  ${padRight(human(row.tokens), 6)}  $${row.costUsd.toFixed(2)}  ${row.cwd}`);
    }
    return;
  }

  console.log(renderOverview(filtered, pricing, args));
}

function parseArgs(argv) {
  const args = {
    command: "overview",
    target: "",
    days: 0,
    project: "",
    sessionLimit: 10,
    json: false,
    html: "",
    priceFile: DEFAULT_PRICE_FILE,
    debug: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "sessions") {
      args.command = "sessions";
    } else if (token === "session") {
      args.command = "session";
      args.target = argv[index + 1] || "";
      index += 1;
    } else if (token === "--days") {
      args.days = Number(argv[index + 1]) || 0;
      index += 1;
    } else if (token === "--project") {
      args.project = argv[index + 1] || "";
      index += 1;
    } else if (token === "--session-limit") {
      args.sessionLimit = Number(argv[index + 1]) || 10;
      index += 1;
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--html") {
      args.html = argv[index + 1] || "";
      index += 1;
    } else if (token === "--price-file") {
      args.priceFile = argv[index + 1] || DEFAULT_PRICE_FILE;
      index += 1;
    } else if (token === "--debug") {
      args.debug = true;
    } else if (token === "--help" || token === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 22).join("\n"));
      process.exit(0);
    }
  }
  return args;
}

function walkJsonl(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  return out;
}

function readSession(file, debug) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return null;
  }

  const session = {
    file: file,
    id: path.basename(file, ".jsonl"),
    cwd: "",
    version: "",
    startAt: 0,
    endAt: 0,
    requests: [],
    tools: new Map(),
    files: new Map(),
    toolErrors: new Map(),
    toolNames: new Map(),
    compactions: 0,
    malformed: 0,
    skippedShapes: new Set(),
  };

  const byId = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      session.malformed += 1;
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    observeSession(session, entry);

    if (entry.type === "assistant" && entry.message && entry.message.usage) {
      recordRequest(byId, session, entry);
    }

    const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : null;
    if (content) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        if (block.type === "tool_use") {
          recordToolUse(session, block);
        } else if (block.type === "tool_result") {
          recordToolResult(session, block);
        }
      }
    } else if (debug && entry.type === "assistant") {
      session.skippedShapes.add("assistant without content array");
    }
  }

  // A subagent's transcript sits beside its parent's, named agent-<id>.jsonl.
  session.kind = isAgentFile(session) ? "agent" : "session";
  session.requests = [...byId.values()].sort((a, b) => a.at - b.at);
  inferCompactions(session);

  if (debug && session.skippedShapes.size > 0) {
    console.error(`[debug] ${session.id}: ${[...session.skippedShapes].join("; ")}`);
  }
  if (session.requests.length === 0) {
    return null;
  }
  return session;
}

function observeSession(session, entry) {
  if (!session.cwd && typeof entry.cwd === "string") {
    session.cwd = entry.cwd;
  }
  if (!session.version && typeof entry.version === "string") {
    session.version = entry.version;
  }
  const at = Date.parse(entry.timestamp || "");
  if (!Number.isNaN(at) && at > 0) {
    session.startAt = session.startAt === 0 ? at : Math.min(session.startAt, at);
    session.endAt = Math.max(session.endAt, at);
  }
  if (entry.type === "system" && typeof entry.subtype === "string" && entry.subtype.toLowerCase().includes("compact")) {
    session.compactions += 1;
  }
}

function recordRequest(byId, session, entry) {
  const usage = entry.message.usage;
  const key = entry.message.id || entry.requestId || entry.uuid || `${session.id}-${byId.size}`;
  const request = {
    key: key,
    at: Date.parse(entry.timestamp || "") || 0,
    model: entry.message.model || "",
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheCreate: num(usage.cache_creation_input_tokens),
    sidechain: entry.isSidechain === true,
  };
  request.total = request.input + request.cacheRead + request.cacheCreate;

  // Streaming writes the same message id more than once; keep the copy with the
  // most tokens, which is the final one.
  const previous = byId.get(key);
  if (!previous || request.total + request.output >= previous.total + previous.output) {
    byId.set(key, request);
  }
}

function recordToolUse(session, block) {
  const name = typeof block.name === "string" ? block.name : "unknown";
  session.tools.set(name, (session.tools.get(name) || 0) + 1);
  if (block.id) {
    session.toolNames.set(block.id, name);
  }
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const candidate = input.file_path || input.path || input.notebook_path || "";
  if (typeof candidate === "string" && candidate.length > 0 && candidate.length < 300) {
    session.files.set(candidate, (session.files.get(candidate) || 0) + 1);
  }
}

function recordToolResult(session, block) {
  if (block.is_error !== true) {
    return;
  }
  const name = session.toolNames.get(block.tool_use_id) || "unknown";
  session.toolErrors.set(name, (session.toolErrors.get(name) || 0) + 1);
}

// A request much smaller than the one before it means the window was rebuilt.
// Explicit compact_boundary lines win when the transcript has them; otherwise
// the drop in window size is the only evidence left.
function inferCompactions(session) {
  let inferred = 0;
  let previous = 0;
  for (const request of session.requests) {
    // A subagent's request is a different window: it neither shows nor rebuilds
    // the parent's, so it is not evidence of a compaction.
    if (request.sidechain) {
      continue;
    }
    if (previous > 0 && request.total < previous * 0.75) {
      inferred += 1;
    }
    previous = request.total;
  }
  session.compactions = Math.max(session.compactions, inferred);
}

// A subagent's response belongs in exactly one transcript: inline in the parent
// (isSidechain) or in the agent's own file. A scan of 563 real transcripts found
// no response in both, so this is insurance: if a build ever writes it twice,
// count it once and keep the dedicated file's copy, so a parent session is not
// charged for its children's windows.
function dedupeRequests(sessions) {
  const holders = new Map();
  for (const session of sessions) {
    // Iterate a copy: the else branch below can drop from this same array, and
    // splicing the array being walked would skip the next request.
    for (const request of [...session.requests]) {
      const held = holders.get(request.key);
      if (!held) {
        holders.set(request.key, { session: session, request: request });
        continue;
      }
      if (isAgentFile(session) && !isAgentFile(held.session)) {
        dropRequest(held.session, held.request);
        holders.set(request.key, { session: session, request: request });
      } else {
        dropRequest(session, request);
      }
    }
  }
}

function dropRequest(session, request) {
  const index = session.requests.indexOf(request);
  if (index >= 0) {
    session.requests.splice(index, 1);
  }
}

// isAgentFile tells a subagent's own transcript from a session's: Claude Code
// names the former agent-<id>.jsonl inside the project directory.
function isAgentFile(session) {
  return /^agent[-_]/i.test(path.basename(session.file));
}

function filterSessions(sessions, args) {
  const cutoff = args.days > 0 ? Date.now() - args.days * 24 * 3600 * 1000 : 0;
  return sessions
    .filter((session) => cutoff === 0 || session.endAt >= cutoff)
    .filter((session) => {
      if (!args.project) {
        return true;
      }
      const needle = args.project.toLowerCase();
      return session.cwd.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle);
    })
    .sort((a, b) => b.endAt - a.endAt);
}

function findSession(sessions, target) {
  if (!target) {
    return sessions[0] || null;
  }
  const needle = target.toLowerCase();
  return sessions.find((session) => session.id.toLowerCase().startsWith(needle)) || null;
}

function loadPricing(file) {
  const fallback = {
    note: "示例价格，务必按你的合同或官网核对后再看成本",
    cacheReadMultiplier: 0.1,
    cacheWriteMultiplier: 1.25,
    models: [
      { match: "opus", input: 15, output: 75 },
      { match: "sonnet", input: 3, output: 15 },
      { match: "haiku", input: 1, output: 5 },
    ],
    default: { input: 3, output: 15 },
  };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      note: typeof raw.note === "string" ? raw.note : fallback.note,
      cacheReadMultiplier: typeof raw.cacheReadMultiplier === "number" ? raw.cacheReadMultiplier : fallback.cacheReadMultiplier,
      cacheWriteMultiplier: typeof raw.cacheWriteMultiplier === "number" ? raw.cacheWriteMultiplier : fallback.cacheWriteMultiplier,
      models: Array.isArray(raw.models) ? raw.models : fallback.models,
      default: raw.default || fallback.default,
    };
  } catch (error) {
    return fallback;
  }
}

function priceFor(pricing, model) {
  const name = String(model || "").toLowerCase();
  for (const row of pricing.models) {
    const needle = String((row && row.match) || "").toLowerCase();
    // An empty match would hit every model; a row without one is skipped.
    if (needle && name.includes(needle)) {
      return row;
    }
  }
  return pricing.default;
}

function costOf(pricing, request) {
  const price = priceFor(pricing, request.model);
  const input = num(price.input);
  const output = num(price.output);
  return (
    (request.input * input +
      request.cacheRead * input * pricing.cacheReadMultiplier +
      request.cacheCreate * input * pricing.cacheWriteMultiplier +
      request.output * output) /
    1000000
  );
}

function summarize(sessions, pricing) {
  const totals = {
    sessions: sessions.length,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    sidechain: 0,
    compactions: 0,
    costUsd: 0,
  };
  const byDay = new Map();
  const tools = new Map();
  const files = new Map();
  const rows = [];

  for (const session of sessions) {
    const fromAgentFile = isAgentFile(session);
    const sessionCost = { value: 0 };
    for (const request of session.requests) {
      const cost = costOf(pricing, request);
      sessionCost.value += cost;
      totals.requests += 1;
      totals.input += request.input;
      totals.output += request.output;
      totals.cacheRead += request.cacheRead;
      totals.cacheCreate += request.cacheCreate;
      if (request.sidechain || fromAgentFile) {
        totals.sidechain += 1;
      }
      totals.costUsd += cost;
      const day = dayKey(request.at);
      const bucket = byDay.get(day) || {
        tokens: 0,
        contextTokens: 0,
        outputTokens: 0,
        cost: 0,
        requests: 0,
        sidechain: 0,
        input: 0,
        cacheRead: 0,
        cacheCreate: 0,
      };
      bucket.tokens += request.total + request.output;
      bucket.contextTokens += request.total;
      bucket.outputTokens += request.output;
      bucket.cost += cost;
      bucket.requests += 1;
      bucket.input += request.input;
      bucket.cacheRead += request.cacheRead;
      bucket.cacheCreate += request.cacheCreate;
      if (request.sidechain || fromAgentFile) {
        bucket.sidechain += 1;
      }
      byDay.set(day, bucket);
    }
    totals.compactions += session.compactions;
    for (const [name, count] of session.tools) {
      tools.set(name, (tools.get(name) || 0) + count);
    }
    for (const [file, count] of session.files) {
      files.set(file, (files.get(file) || 0) + count);
    }
    rows.push({
      id: session.id,
      kind: session.kind,
      cwd: session.cwd,
      startAt: session.startAt,
      endAt: session.endAt,
      requests: session.requests.length,
      tokens: session.requests.reduce((sum, request) => sum + request.total, 0),
      costUsd: sessionCost.value,
      compactions: session.compactions,
      sidechain: session.requests.filter((request) => request.sidechain || fromAgentFile).length,
      cacheHitRate: percent(
        session.requests.reduce((sum, request) => sum + request.cacheRead, 0),
        session.requests.reduce((sum, request) => sum + request.cacheRead + request.cacheCreate + request.input, 0),
      ),
      curve: curveOf(session.requests),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    pricingNote: pricing.note,
    totals: totals,
    cacheHitRate: percent(totals.cacheRead, totals.cacheRead + totals.cacheCreate + totals.input),
    byDay: [...byDay.entries()]
      .map(([day, bucket]) => ({
        day,
        ...bucket,
        cacheHitRate: percent(bucket.cacheRead, bucket.cacheRead + bucket.cacheCreate + bucket.input),
      }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    topTools: [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
    topFiles: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([file, count]) => ({ file, count })),
    sessions: rows.sort((a, b) => b.endAt - a.endAt),
  };
}

// curveOf is the per-request window series a session's sparkline draws. Long
// sessions are sampled evenly, and the last request is always kept.
function curveOf(requests, limit) {
  const cap = limit || 40;
  const values = requests.map((request) => request.total);
  if (values.length <= cap) {
    return values;
  }
  const out = [];
  for (let i = 0; i < cap; i += 1) {
    out.push(values[Math.floor((i * values.length) / cap)]);
  }
  out[cap - 1] = values[values.length - 1];
  return out;
}

// denseDays fills the calendar: a day with no requests is a visible zero, not a
// missing column, so the cost and cache charts keep their spacing.
function denseDays(byDay, limit) {
  if (byDay.length === 0) {
    return [];
  }
  const held = new Map(byDay.map((day) => [day.day, day]));
  const newest = byDay[byDay.length - 1].day;
  const base = new Date(newest + "T00:00:00");
  const out = [];
  for (let i = limit - 1; i >= 0; i -= 1) {
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i).getTime();
    const key = dayKey(at);
    out.push(
      held.get(key) || {
        day: key,
        tokens: 0,
        contextTokens: 0,
        outputTokens: 0,
        cost: 0,
        requests: 0,
        sidechain: 0,
        input: 0,
        cacheRead: 0,
        cacheCreate: 0,
        cacheHitRate: 0,
      },
    );
  }
  return out;
}

function dayKey(at) {
  if (!at) {
    return "unknown";
  }
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function renderOverview(sessions, pricing, args) {
  const summary = summarize(sessions, pricing);
  const totals = summary.totals;
  const lines = [];
  lines.push("CC-Context · 离线分析");
  lines.push(`范围      ${args.days > 0 ? `近 ${args.days} 天` : "全部"} · ${totals.sessions} 个会话 · ${totals.requests} 次请求`);
  lines.push(`Token     入 ${human(totals.input)} · 缓存读 ${human(totals.cacheRead)} · 缓存写 ${human(totals.cacheCreate)} · 出 ${human(totals.output)}`);
  lines.push(`成本      $${totals.costUsd.toFixed(2)}   （${summary.pricingNote}）`);
  lines.push(`缓存      命中 ${summary.cacheHitRate}% · 压缩 ${totals.compactions} 次 · 子 Agent 请求 ${totals.sidechain}`);

  const days = summary.byDay.slice(-14);
  if (days.length > 0) {
    lines.push("");
    lines.push("按天");
    const maxTokens = Math.max(...days.map((day) => day.tokens), 1);
    for (const day of days) {
      lines.push(`  ${day.day}  ${bar(day.tokens, maxTokens, 24)} ${padRight(human(day.tokens), 7)} $${day.cost.toFixed(2)}  ${day.requests} 次`);
    }
  }

  lines.push("");
  lines.push(`会话（近 ${Math.min(args.sessionLimit, summary.sessions.length)}）`);
  for (const row of summary.sessions.slice(0, args.sessionLimit)) {
    const when = row.endAt ? new Date(row.endAt).toISOString().slice(0, 16).replace("T", " ") : "?";
    lines.push(`  ${when}  ${padRight((row.kind === 'agent' ? '↳' : ' ') + row.id.slice(0, 8), 9)}  ${padRight(String(row.requests), 3)} 次  ${padRight(human(row.tokens), 6)}  $${row.costUsd.toFixed(2)}  ${row.cwd}`);
  }

  if (summary.topTools.length > 0) {
    lines.push("");
    lines.push("工具");
    lines.push(`  ${summary.topTools.slice(0, 8).map((tool) => `${tool.name} ${tool.count}`).join(" · ")}`);
  }
  lines.push("");
  lines.push("单会话明细: node cli/ccx.mjs session <id前 8 位> · 网页报表: --html report.html");
  return lines.join("\n");
}

function renderSession(session, pricing) {
  const requests = session.requests;
  const totals = requests.reduce(
    (acc, request) => {
      acc.input += request.input;
      acc.output += request.output;
      acc.cacheRead += request.cacheRead;
      acc.cacheCreate += request.cacheCreate;
      acc.total += request.total;
      acc.cost += costOf(pricing, request);
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, cost: 0 },
  );

  const lines = [];
  lines.push(`CC-Context · 会话 ${session.id.slice(0, 8)}`);
  lines.push(`目录      ${session.cwd || "?"}`);
  lines.push(`请求      ${requests.length} 次 · 压缩 ${session.compactions} 次`);
  lines.push(`Token     入 ${human(totals.input)} · 缓存读 ${human(totals.cacheRead)} · 缓存写 ${human(totals.cacheCreate)} · 出 ${human(totals.output)}`);
  lines.push(`成本      $${totals.cost.toFixed(2)}   （${pricing.note}）`);
  lines.push("");
  lines.push("趋势（每次请求的窗口大小）");
  lines.push(`  ${sparkline(requests.map((request) => request.total))}  ${human(requests[0].total)} → ${human(requests[requests.length - 1].total)}`);

  lines.push("");
  lines.push("最近请求");
  const tail = requests.slice(-10);
  for (const request of tail) {
    const when = request.at ? new Date(request.at).toISOString().slice(11, 19) : "--:--:--";
    const model = (request.model || "?").replace(/^claude-/, "").slice(0, 22);
    lines.push(`  ${when}  ${padRight(model, 22)}  入 ${padRight(human(request.total), 6)} 出 ${padRight(human(request.output), 5)} 读 ${human(request.cacheRead)}`);
  }

  if (session.tools.size > 0) {
    lines.push("");
    lines.push("工具");
    const tools = [...session.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    lines.push(`  ${tools.map(([name, count]) => `${name} ${count}`).join(" · ")}`);
  }
  if (session.files.size > 0) {
    lines.push("");
    lines.push("文件");
    const files = [...session.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    lines.push(`  ${files.map(([file, count]) => `${baseName(file)} ×${count}`).join(" · ")}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- html report

// The report is one file with inline SVG: no network, no scripts, no fonts to
// fetch. Geometry comes from src/svg.mjs; this section only turns it into markup.
const CHART = { width: 760, height: 180, left: 56, right: 12, top: 14, bottom: 26 };

function svgFrame(inner, height) {
  return '<svg class="chart" viewBox="0 0 ' + CHART.width + ' ' + (height || CHART.height) + '" role="img">' + inner + "</svg>";
}

function chartGrid(max, innerH, innerW, label) {
  let out = "";
  for (const tick of tickValues(max, 4)) {
    const y = CHART.top + innerH - (tick / max) * innerH;
    out +=
      '<line class="g" x1="' + CHART.left + '" y1="' + round(y) + '" x2="' + (CHART.left + innerW) + '" y2="' + round(y) + '"/>' +
      '<text class="gl" x="' + (CHART.left - 8) + '" y="' + round(y + 4) + '" text-anchor="end">' + esc(label(tick)) + "</text>";
  }
  return out;
}

function chartDays(days) {
  const step = Math.max(1, Math.ceil(days.length / 6));
  let out = "";
  for (let i = 0; i < days.length; i += step) {
    const x = CHART.left + ((i + 0.5) / Math.max(1, days.length)) * (CHART.width - CHART.left - CHART.right);
    out += '<text class="gl" x="' + round(x) + '" y="' + (CHART.height - 8) + '" text-anchor="middle">' + esc(days[i].day.slice(5)) + "</text>";
  }
  return out;
}

// dailyTokensSvg stacks context tokens under output tokens, one bar per day.
function dailyTokensSvg(days) {
  const innerW = CHART.width - CHART.left - CHART.right;
  const innerH = CHART.height - CHART.top - CHART.bottom;
  const max = niceMax(Math.max.apply(null, days.map((day) => day.tokens).concat([1])));
  const slots = barRects(days.length, { x: CHART.left, width: innerW, gap: 2 });
  let bars = "";
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const heights = stackHeights([day.contextTokens, day.outputTokens], innerH, max);
    const x = slots[i].x;
    const w = Math.max(1, slots[i].w);
    const restY = CHART.top + innerH;
    bars +=
      "<g><title>" + esc(day.day + " · 上下文 " + human(day.contextTokens) + " · 输出 " + human(day.outputTokens) + " · $" + day.cost.toFixed(2) + " · " + day.requests + " 次") + "</title>" +
      '<rect class="b-ctx" x="' + round(x) + '" y="' + round(restY - heights[0]) + '" width="' + round(w) + '" height="' + heights[0] + '"/>' +
      '<rect class="b-out" x="' + round(x) + '" y="' + round(restY - heights[0] - heights[1]) + '" width="' + round(w) + '" height="' + heights[1] + '"/>' +
      "</g>";
  }
  return svgFrame(chartGrid(max, innerH, innerW, (tick) => human(tick)) + bars + chartDays(days));
}

function dailyCostSvg(days) {
  const innerW = CHART.width - CHART.left - CHART.right;
  const innerH = CHART.height - CHART.top - CHART.bottom;
  const max = niceMax(Math.max.apply(null, days.map((day) => day.cost).concat([0.01])));
  const slots = barRects(days.length, { x: CHART.left, width: innerW, gap: 2 });
  let bars = "";
  for (let i = 0; i < days.length; i += 1) {
    const day = days[i];
    const height = (day.cost / max) * innerH;
    const x = slots[i].x;
    const w = Math.max(1, slots[i].w);
    bars +=
      "<g><title>" + esc(day.day + " · $" + day.cost.toFixed(2) + " · " + day.requests + " 次") + "</title>" +
      '<rect class="b-cost" x="' + round(x) + '" y="' + round(CHART.top + innerH - height) + '" width="' + round(w) + '" height="' + round(height) + '"/>' +
      "</g>";
  }
  return svgFrame(chartGrid(max, innerH, innerW, (tick) => "$" + tick.toFixed(2)) + bars + chartDays(days));
}

// cacheSvg is a 0-100% line: the one number that moves when a prompt stops
// being cacheable is worth seeing as a shape, not a single total.
function cacheSvg(days) {
  const innerW = CHART.width - CHART.left - CHART.right;
  const innerH = CHART.height - CHART.top - CHART.bottom;
  const points = days.map((day, i) => ({
    x: CHART.left + ((i + 0.5) / Math.max(1, days.length)) * innerW,
    y: CHART.top + innerH - (day.cacheHitRate / 100) * innerH,
  }));
  const dots = days
    .map((day, i) => '<circle class="dot" cx="' + round(points[i].x) + '" cy="' + round(points[i].y) + '" r="2.5"><title>' + esc(day.day + " · 命中 " + day.cacheHitRate + "% · " + day.requests + " 次") + "</title></circle>")
    .join("");
  const body = days.length > 1 ? '<path class="line" d="' + areaPath(points, CHART.top + innerH) + '"/>' + '<path class="line" d="' + linePath(points) + '"/>' + dots : dots;
  return svgFrame(chartGrid(100, innerH, innerW, (tick) => Math.round(tick) + "%") + body + chartDays(days));
}

function sparkSvg(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return "";
  }
  const spark = sparkPath(values, 120, 24, 2);
  return '<svg class="spark" viewBox="0 0 120 24" role="img"><title>' + esc(values.length + " 次请求的窗口大小，峰值 " + human(Math.max.apply(null, values))) + '</title><path d="' + spark.path + '"/></svg>';
}

function barList(entries, labelOf, valueOf) {
  if (entries.length === 0) {
    return '<div class="sub">暂无数据</div>';
  }
  const max = Math.max.apply(null, entries.map(valueOf).concat([1]));
  return entries
    .map((entry) => {
      const width = Math.max(2, Math.round((valueOf(entry) / max) * 100));
      return '<div class="hbar"><span class="k">' + esc(labelOf(entry)) + '</span><span class="t"><i style="width:' + width + '%"></i></span><span class="v">' + esc(String(valueOf(entry))) + "</span></div>";
    })
    .join("");
}

function renderHtml(summary, args) {
  const totals = summary.totals;
  const window = args && args.days > 0 ? Math.min(90, args.days) : 30;
  const days = denseDays(summary.byDay, window);
  const sidechainShare = percent(totals.sidechain, totals.requests);
  const sessionRows = summary.sessions
    .slice(0, 30)
    .map((row) => {
      const when = row.endAt ? new Date(row.endAt).toISOString().slice(0, 16).replace("T", " ") : "?";
      return (
        "<tr><td>" + esc(when) + '</td><td class="mono">' + esc((row.kind === "agent" ? "↳ " : "") + row.id.slice(0, 8)) + "</td>" +
        "<td>" + row.requests + '</td><td class="sparkcell">' + sparkSvg(row.curve) + "</td>" +
        "<td>" + esc(human(row.tokens)) + "</td><td>" + num(row.cacheHitRate) + "%</td>" +
        "<td>$" + row.costUsd.toFixed(2) + '</td><td class="path">' + esc(row.cwd) + "</td></tr>"
      );
    })
    .join("");

  return '<!doctype html>\n' +
    '<html lang="zh-CN"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    "<title>CC-Context 报告</title>\n" +
    "<style>\n" +
    ":root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--dim:#8b93a7;--accent:#5b9dff;--warn:#ffb454;--track:#0b0d12}\n" +
    "@media (prefers-color-scheme: light){:root{--bg:#f5f7fb;--panel:#fff;--line:#e2e6ef;--text:#1b2233;--dim:#5c6478;--accent:#2563eb;--warn:#c2760a;--track:#eef1f7}}\n" +
    "*{box-sizing:border-box}\n" +
    "body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,\"Segoe UI\",system-ui,\"Noto Sans SC\",sans-serif;padding:32px}\n" +
    "h1{font-size:20px;margin:0 0 4px}\n" +
    ".sub{color:var(--dim);margin-bottom:20px;font-size:12px}\n" +
    ".kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}\n" +
    ".card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}\n" +
    ".card .k{color:var(--dim);font-size:12px}\n" +
    ".card .v{font-size:22px;font-weight:600;margin-top:2px}\n" +
    ".panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:20px;overflow:hidden}\n" +
    ".panel h2{font-size:13px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;margin:0 0 12px}\n" +
    ".chart{width:100%;height:auto;display:block}\n" +
    ".g{stroke:var(--line);stroke-width:1}\n" +
    ".gl{fill:var(--dim);font-size:11px}\n" +
    ".b-ctx{fill:var(--accent)}\n" +
    ".b-out{fill:var(--warn)}\n" +
    ".b-cost{fill:var(--accent);opacity:.85}\n" +
    ".line{fill:none;stroke:var(--accent);stroke-width:2}\n" +
    ".dot{fill:var(--accent)}\n" +
    ".legend{display:flex;gap:16px;color:var(--dim);font-size:12px;margin-top:6px}\n" +
    ".legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}\n" +
    "table{width:100%;border-collapse:collapse;font-size:13px}\n" +
    "th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}\n" +
    "th{color:var(--dim);font-weight:500;font-size:12px}\n" +
    ".mono{font-family:ui-monospace,Consolas,monospace}\n" +
    ".path{color:var(--dim);font-size:12px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n" +
    ".spark{width:120px;height:24px}\n" +
    ".spark path{fill:none;stroke:var(--accent);stroke-width:1.5}\n" +
    ".hbar{display:grid;grid-template-columns:150px 1fr 56px;gap:10px;align-items:center;padding:2px 0}\n" +
    ".hbar .k{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n" +
    ".hbar .t{background:var(--track);border-radius:4px;height:8px;overflow:hidden}\n" +
    ".hbar .t i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--warn))}\n" +
    ".hbar .v{text-align:right;font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}\n" +
    "footer{color:var(--dim);font-size:12px;margin-top:8px}\n" +
    "</style></head><body>\n" +
    "<h1>CC-Context · 上下文与用量报告</h1>\n" +
    '<div class="sub">生成于 ' + esc(summary.generatedAt) + " · " + esc(summary.pricingNote) + "</div>\n" +
    '<div class="kpis">\n' +
    '  <div class="card"><div class="k">会话</div><div class="v">' + totals.sessions + "</div></div>\n" +
    '  <div class="card"><div class="k">请求</div><div class="v">' + totals.requests + "</div></div>\n" +
    '  <div class="card"><div class="k">上下文 Token 累计</div><div class="v">' + esc(human(totals.input + totals.cacheRead + totals.cacheCreate)) + "</div></div>\n" +
    '  <div class="card"><div class="k">输出 Token</div><div class="v">' + esc(human(totals.output)) + "</div></div>\n" +
    '  <div class="card"><div class="k">缓存命中</div><div class="v">' + summary.cacheHitRate + "%</div></div>\n" +
    '  <div class="card"><div class="k">子代理请求</div><div class="v">' + sidechainShare + "%</div></div>\n" +
    '  <div class="card"><div class="k">估算成本</div><div class="v">$' + totals.costUsd.toFixed(2) + "</div></div>\n" +
    "</div>\n" +
    '<div class="panel"><h2>每日用量（上下文 / 输出）</h2>' +
    (days.length > 0 ? dailyTokensSvg(days) + '<div class="legend"><span><i style="background:var(--accent)"></i>上下文</span><span><i style="background:var(--warn)"></i>输出</span></div>' : '<div class="sub">暂无数据</div>') +
    "</div>\n" +
    '<div class="panel"><h2>每日成本（估算）</h2>' + (days.length > 0 ? dailyCostSvg(days) : '<div class="sub">暂无数据</div>') + "</div>\n" +
    '<div class="panel"><h2>缓存命中率</h2>' + (days.length > 0 ? cacheSvg(days) : '<div class="sub">暂无数据</div>') + "</div>\n" +
    '<div class="panel"><h2>会话（曲线 = 逐请求的窗口大小）</h2>\n' +
    "<table><thead><tr><th>最后活动</th><th>会话</th><th>请求</th><th>窗口</th><th>上下文 Token</th><th>缓存</th><th>成本</th><th>目录</th></tr></thead>\n" +
    "<tbody>" + sessionRows + "</tbody></table></div>\n" +
    '<div class="panel"><h2>工具</h2>' + barList(summary.topTools, (tool) => tool.name, (tool) => tool.count) + "</div>\n" +
    '<div class="panel"><h2>文件</h2>' + barList(summary.topFiles, (file) => file.file.split(/[\\/]/).pop(), (file) => file.count) + "</div>\n" +
    "<footer>总量为服务商上报值；成本按 pricing.json 的示例单价估算，请按合同核对。逐分类的上下文分解（系统提示词/工具/技能/MCP/记忆）只有实时侧栏有——它由宿主现场计算，不落转录，所以这份离线报告给不出。</footer>\n" +
    "</body></html>";
}

function num(value) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main();