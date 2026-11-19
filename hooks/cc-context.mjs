// CC-Context · a Claude Code mod that shows what the context window is made of.
//
// Why almost one file: the mods loader evaluates this module directly, with no
// build step and no bundle. It imports only two pure modules: ../src/estimate.mjs
// (the formatters and token estimator the offline analyzer in ../cli shares) and
// ../src/chart.mjs (the stacked bar and the braille line). Neither touches Node or
// fs, so the plugin folder stays self-contained. A broken import would stop the
// mod from loading, which is why both stay dependency-free and the real-binary
// check (npm run test:live) is part of verification.
//
// What is exact and what is estimated:
//   exact     - the host's own context breakdown: categories, memory files, MCP
//               tools, skills, agents, slash commands, the window size, the
//               session cost and the subscription rate limits. All of it comes
//               from $.session.usage({ breakdown: "full" }).
//   estimated - only when the host reports no breakdown (an older build, or no
//               session bound): the split into system prompt, messages and tool
//               results, from character counts, so +/-10%.
//
// Events used:
//   session.start      reset, register /ccx, bind the host, read the breakdown
//   turn.step          one request to the model; read result.usage
//   turn.complete      refresh the reading after a main-loop turn
//   tool.call          count tools, durations, failures, touched files
//   prompt.section     capture system-prompt section sizes when exposed
//   classic.PreCompact note a compaction, and the window it happened at
//   ui.render          draw the band (AbovePrompt) and the pane (Pane)
//   ui.close           the person closed the pane
//   command.run        answer /ccx

import { estimateTokens, human, humanDuration, bar, sparkline, padRight, displayWidth, charWidth, percent as percentOf } from "../src/estimate.mjs";
import { allocateCells, blockColumns, levelColor, eighthBar } from "../src/chart.mjs";

const MAX_STEPS = 240;
const MAX_SECTIONS = 40;
const MAX_COMPACTIONS = 40;
const DEFAULT_WINDOW = 200000;
const SPARK = "▁▂▃▄▅▆▇█";
const BAR_WIDTH = 18;
const DASH_RULE = "─".repeat(42);
const PANE_ID = "ccx";
// One color per category in the pane's stacked bar, in the order the host lists
// them. The plain-text dashboard has no color, so it never tries to tell
// categories apart by glyph: it shows a used / buffer / free bar and one sized
// bar per category instead.
const SEG_COLORS = ["cyan", "green", "yellow", "magenta", "blue", "red", "white"];
const DASH_BAR_WIDTH = 48;
const DASH_ROW_BAR = 20;
const MIN_TREND_COLUMNS = 24;
// Persistence: a snapshot per session, so a reload or a resume keeps its history.
// The engine has no way to delete a file, so the number of files is bounded
// instead: a session writes to one of PERSIST_SLOTS fixed names chosen from its
// start time. Two sessions that land on the same slot take turns; a snapshot is
// only read back by the session whose start time it carries.
const PERSIST_DIR = ".claude/cc-context";
const PERSIST_SLOTS = 8;
const PERSIST_VERSION = 1;
const PERSIST_MAX_FILES = 300;
const REFRESH_MIN_MS = 1500;
// A subagent loop is a process this session watches through its events: its
// calls, its requests, and the end of its turn. No event says "idle", so one
// with no call for this long reads as idle rather than running.
const AGENT_IDLE_MS = 90000;
const MAX_AGENTS = 60;
const MAX_LAUNCHES = 30;
const LAUNCH_TOOLS = ["Agent", "Task", "Workflow"];
// The Agent tool's subagent_type is optional, and the engine fills in one of
// these when the caller leaves it out. A generic type names nothing, so the row
// shows the agent's own name (or what it was asked to do) instead.
const GENERIC_AGENT_TYPES = ["general-purpose", "general purpose", "general", "default", "subagent"];
const TABS = [
  { id: "composition", label: "组成", hotkey: "1" },
  { id: "trend", label: "趋势", hotkey: "2" },
  { id: "agents", label: "编队", hotkey: "3", aliases: ["子代理", "formation", "fleet"] },
  { id: "browser", label: "浏览", hotkey: "4" },
];

/**
 * @typedef {{ at: number, model: string, input: number, output: number, cacheRead: number, cacheCreate: number, total: number }} Step
 * One model request of the main loop. total = input + cacheRead + cacheCreate: that
 * request's window, not a running sum.
 *
 * @typedef {{ at: number, tool: string, toolUseId: string, name: string, type: string, description: string, agentId: string, parentAgentId: string, doneAt: number, isError: boolean, isAsync?: boolean, spawn?: { type: string, isFork: boolean, isBackground: boolean, model: string } | null, report?: { tokens: number, calls: number, ms: number } }} Launch
 * An Agent/Task/Workflow call, from the loop that made it.
 *
 * @typedef {{ id: string, firstAt: number, lastAt: number, doneAt: number, calls: number, errors: number, steps: number, input: number, output: number, cacheRead: number, cacheCreate: number, tokens: number, lastTool: string, lastSubject: string, lastModel: string, isDone: boolean, launch: Launch | null }} AgentRow
 * A subagent loop as its own events built it. tokens is its latest window.
 *
 * @typedef {"running" | "idle" | "done" | "failed"} AgentState
 * @typedef {{ row: AgentRow | null, launch: Launch | null, status: AgentState, depth?: number }} AgentEntry
 *
 * @typedef {{ at: number, before: number, after: number, source: string, stepNo: number }} Compaction
 * stepNo is the absolute number of the request that showed the compaction (see State.stepCount).
 * @typedef {{ n: number, ms: number, errors: number }} ToolTally
 *
 * @typedef {Array<any> | number} ListOrCount
 * The host reports some lists as rows and some builds as a bare count.
 * @typedef {{ name?: string, tokens?: number, kind?: string, isDeferred?: boolean }} Category
 * @typedef {{ total?: number, included?: number, totalSkills?: number, includedSkills?: number, tokens?: number, skillFrontmatter?: Array<{ name?: string, source?: string, pluginName?: string, tokens?: number }> }} Skills
 * @typedef {{ categories: Category[], totalTokens?: number, maxTokens?: number, rawMaxTokens?: number, percentage?: number, autocompactThreshold?: number, isAutoCompactEnabled?: boolean, memoryFiles?: ListOrCount, mcpTools?: ListOrCount, agents?: ListOrCount, skills?: Skills, slashCommands?: { totalCommands?: number, includedCommands?: number, tokens?: number }, apiUsage?: Record<string, number> | null }} Breakdown
 * @typedef {{ kind?: string, percentUsed?: number, resetsAt?: string }} RateLimit
 * @typedef {{ startedAt?: number, context?: { window?: number, tokens?: number, percent?: number, breakdown?: Breakdown }, cost?: { usd?: number }, rateLimits?: RateLimit[] }} Usage
 * @typedef {ReturnType<typeof hostOf>} Host
 *
 * @typedef {{
 *   steps: Step[], stepCount: number, agentSteps: number,
 *   agents: Record<string, AgentRow>, agentOrder: string[],
 *   agentInfo: Record<string, { info: any, seenAt: number }>, agentListState: "unknown" | "ok" | "unavailable",
 *   launches: Launch[], openLaunches: Launch[],
 *   tools: Record<string, ToolTally>, files: Record<string, number>, sections: Record<string, number>,
 *   compactions: Compaction[], pendingCompaction: { at: number, before: number } | null,
 *   tokens: number, window: number, percent: number,
 *   usage: Usage | null, breakdown: Breakdown | null, costUsd: number, rateLimits: RateLimit[],
 *   messages: any[], bandOn: boolean, startedAt: number, host: Host | null, fullRefreshAt: number,
 *   persist: { key: number, status: "off" | "ready" | "restored" | "saved" | "failed", savedAt: number, restoredAt: number, restored: number, dirty: boolean, gitignore: boolean },
 *   pane: { isOpen: boolean, isWaiting: boolean, tab: string, offset: number, bodyRows: number, expanded: Record<string, boolean>, folded: Record<string, boolean> }
 * }} State
 */

// Mutable session state. The object stays the same so top-level helpers can
// reach it; resetState() clears the fields in place.
/** @type {State} */
const state = {
  stepCount: 0, // main-loop requests recorded so far; steps is only the newest of them
  steps: [], // { at, model, input, output, cacheRead, cacheCreate, total }
  agentSteps: 0,
  agents: Object.create(null), // agentId -> the row the events built
  agentOrder: [], // ids, first seen first
  agentInfo: Object.create(null), // id -> { info, seenAt } from $.agent.list()
  agentListState: "unknown", // unknown | ok | unavailable
  launches: [], // the parent's Agent/Task calls, oldest first
  openLaunches: [], // launches whose tool call has not returned yet
  tools: Object.create(null), // name -> { n, ms, errors }
  files: Object.create(null), // path -> count
  sections: Object.create(null), // section name -> estimated tokens
  compactions: [], // { at, before, after, source }
  pendingCompaction: null, // { at, before } from classic.PreCompact, closed by the next step
  tokens: 0, // window occupancy the host last reported
  window: DEFAULT_WINDOW,
  percent: 0,
  usage: null, // the last $.session.usage() reading, as the host answered it
  breakdown: null, // the host's exact composition, when it reports one
  costUsd: 0,
  rateLimits: [],
  messages: [],
  // The status bar can carry the same numbers (scripts/statusline-command.sh), so the
  // row above the prompt is opt-in: /ccx on draws it for this process.
  bandOn: false,
  startedAt: 0,
  host: null, // the session-scoped host, kept for presses and timers
  fullRefreshAt: 0,
  persist: { key: 0, status: "off", savedAt: 0, restoredAt: 0, restored: 0, dirty: false, gitignore: false },
  pane: {
    isOpen: false,
    isWaiting: false,
    tab: "composition",
    offset: 0,
    bodyRows: 10,
    expanded: Object.create(null),
    folded: Object.create(null),
  },
};

// The engine reads "$.noun.event" call sites off this module, so the host is
// bound here with every member spelled out, and stored. "$" itself is never
// stored: the loader refuses a module that assigns it.
/** @param {import('claude-code').EngineInterface} $ */
function hostOf($) {
  return {
    usage: (args) => (args === undefined ? $.session.usage() : $.session.usage(args)),
    messages: () => $.session.messages(),
    agents: () => $.agent.list(),
    fsRead: (path) => $.fs.read(path),
    fsWrite: (path, text) => $.fs.write(path, text),
    open: (pane) => $.ui.open(pane),
    close: (pane) => $.ui.close(pane),
    invalidate: () => $.ui.invalidate("ui.render"),
  };
}

/** @param {import('claude-code').On} on */
export function register(on) {
  on("session.start", async ($, e, next) => {
    resetState();
    state.startedAt = Date.now();
    state.host = hostOf($);
    // Register first and in a try: a taken command name throws, and a throw here
    // would skip the rest of this hook.
    try {
      await $.command.register({
        name: "ccx",
        description: "Context insight: exact composition, cache, trend, tools for this session",
        argumentHint: "[panel|tab|agents|json|on|off|reset|close]",
        immediate: true,
      });
    } catch (error) {
      // The command name was taken, or this host has no command registry.
      // The band still works, so leave it on.
    }
    const result = await next(e);
    await refresh(state.host, true, false);
    await restoreSnapshot(state.host);
    return result;
  });

  on("turn.step", async function* ($, e, next) {
    const result = yield* next(e);
    recordStep(e, result);
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e && e.agentId) {
      // A subagent's loop ended: its own window never touches the main one.
      const row = agentRow(String(e.agentId));
      row.isDone = true;
      row.doneAt = Date.now();
    } else {
      // A turn is when the window changes, so ask for the full reading unless
      // one just came back (the full reading walks every category).
      await refresh(state.host, Date.now() - state.fullRefreshAt >= REFRESH_MIN_MS, true);
      await saveSnapshot(state.host);
    }
    return result;
  });

  on("tool.call", async ($, e, next) => {
    const startedAt = Date.now();
    // The parent's Agent/Task call is where a subagent is announced: it stays
    // open for as long as the child runs, so its start and end bracket the child.
    const launch = beginLaunch(e);
    let result;
    try {
      result = await next(e);
    } catch (error) {
      finishLaunch(launch, true);
      noteTool(e, Date.now() - startedAt, true);
      throw error;
    }
    const settled = callResultOf(result);
    const isError = Boolean(settled && settled.isError);
    settleLaunch(launch, settled);
    finishLaunch(launch, isError);
    noteTool(e, Date.now() - startedAt, isError);
    return result;
  });

  on("prompt.section", async ($, e, next) => {
    noteSection(e);
    return next(e);
  });

  // agent.spawn is where the engine says which agent actually started: the tool
  // call carries only the caller's words, and the subagent_type it may have
  // omitted is resolved here. It fires before the tool returns.
  on("agent.spawn", async ($, e, next) => {
    noteAgentSpawn(e);
    return next(e);
  });

  on("classic.PreCompact", async ($, e, next) => {
    // The window the person had before the compaction: the next step reports the
    // window after it, so one pair becomes a before -> after snapshot.
    state.pendingCompaction = { at: Date.now(), before: currentTokens() };
    return next(e);
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    const props = e && e.props && typeof e.props === "object" ? e.props : {};
    const columns = num(props.bodyColumns) || 80;
    const surface = e && typeof e.surface === "string" ? e.surface : "terminal";
    // A resumed session has a host reading before it has a request of its own.
    const hasReading = state.steps.length > 0 || state.tokens > 0;
    if (!state.bandOn || !hasReading || props.hasSurvey === true || surface !== "terminal") {
      return next(e);
    }
    return bandView($.ui.resolve(e), columns);
  });

  on("ui.render", { component: "Pane" }, ($, e, next) => {
    if (!e || e.requestId !== PANE_ID) {
      return next(e);
    }
    state.pane.isOpen = true;
    state.pane.isWaiting = false;
    return paneView($.ui.resolve(e), e);
  });

  on("ui.close", async ($, e, next) => {
    const result = await next(e);
    if (result && result.deny !== undefined) {
      return result;
    }
    if (e && e.id === PANE_ID) {
      state.pane.isOpen = false;
      state.pane.isWaiting = false;
    }
    return result;
  });

  on("command.run", { command: "ccx" }, async ($, e) => {
    const raw = String((e && e.args) || "").trim();
    const arg = raw.toLowerCase();
    if (!state.host) {
      state.host = hostOf($);
    }

    if (arg === "on") {
      state.bandOn = true;
      redraw();
      return { text: "CC-Context: 状态条已开启（输入框上方一行；默认关闭）" };
    }
    if (arg === "off") {
      state.bandOn = false;
      redraw();
      return { text: "CC-Context: 状态条已关闭（/ccx on 恢复）" };
    }
    if (arg === "reset") {
      resetState();
      state.host = hostOf($);
      state.persist.dirty = true;
      await saveSnapshot(state.host);
      redraw();
      return { text: "CC-Context: 本会话统计已清空（含已保存的快照）" };
    }
    // panel is the name; pane and open are kept as spellings people already use.
    if (arg === "panel" || arg === "pane" || arg === "open") {
      const opened = await openPane();
      return {
        text: opened.isPlaced
          ? "CC-Context: 侧栏已打开（/ccx close 关闭）"
          : "CC-Context: 这张终端暂时无法停靠侧栏（" + opened.reason + "）",
      };
    }
    if (arg === "close" || arg === "hide") {
      await closePane();
      return { text: "CC-Context: 侧栏已关闭（/ccx panel 恢复）" };
    }
    if (arg === "tab" || arg.startsWith("tab ")) {
      const name = raw.slice(3).trim();
      const tab = name ? tabOf(name) : null;
      if (!name) {
        const current = tabOf(state.pane.tab);
        return { text: "CC-Context: 当前标签页 " + (current ? current.label : state.pane.tab) + "；可切换 " + tabChoices() };
      }
      if (!tab) {
        return { text: "CC-Context: 没有名为 " + JSON.stringify(name) + " 的标签页；可切换 " + tabChoices() };
      }
      state.pane.tab = tab.id;
      state.pane.offset = 0;
      redraw();
      return { text: "CC-Context: 标签页已切到 " + tab.label + "（/ccx panel 打开侧栏）" };
    }
    if (arg === "agents" || arg === "agent") {
      const entries = agentRows();
      if (entries.length === 0) {
        return { text: "CC-Context: 本会话还没有子代理（主会话里的 Agent/Task 调用会出现在这里）" };
      }
      const lines = ["CC-Context · 编队 " + agentSummary()];
      for (const entry of entries.slice(-20)) {
        lines.push(agentLine(entry, 88));
        if (state.pane.expanded[agentKey(entry)] === true) {
          for (const line of agentDetailLines(entry, 88)) {
            lines.push("       " + line);
          }
        }
      }
      return { text: lines.join("\n") };
    }
    if (arg === "json") {
      await refresh(state.host, true, false);
      return { text: dumpProbe() };
    }

    if (arg !== "" && arg !== "dashboard") {
      return {
        text:
          "CC-Context: 不认识的参数 " + JSON.stringify(raw) + "。可用：panel（侧栏）· tab <组成|趋势|子代理|浏览> · agents · json · on · off · reset · close；不带参数是仪表板",
      };
    }
    await refresh(state.host, true, false);
    return { text: renderDashboard() };
  });
}

function resetState() {
  state.steps = [];
  state.stepCount = 0;
  state.agentSteps = 0;
  state.agents = Object.create(null);
  state.agentOrder = [];
  state.agentInfo = Object.create(null);
  state.agentListState = "unknown";
  state.launches = [];
  state.openLaunches = [];
  state.tools = Object.create(null);
  state.files = Object.create(null);
  state.sections = Object.create(null);
  state.compactions = [];
  state.pendingCompaction = null;
  state.tokens = 0;
  state.window = DEFAULT_WINDOW;
  state.percent = 0;
  state.usage = null;
  state.breakdown = null;
  state.costUsd = 0;
  state.rateLimits = [];
  state.messages = [];
  state.pane.offset = 0;
  state.pane.expanded = Object.create(null);
  state.pane.folded = Object.create(null);
  state.pane.bodyRows = 10;
  state.startedAt = Date.now();
  state.fullRefreshAt = 0;
  state.persist.restored = 0;
  state.persist.restoredAt = 0;
  state.persist.dirty = false;
  state.persist.gitignore = false;
}

// refresh asks the host what it knows. The full reading (a breakdown of the
// window) is the expensive one: it walks every category, memory file, MCP tool
// and skill, so it runs at a start, on a turn at most every REFRESH_MIN_MS, and
// on an explicit /ccx. The cheap reading is the window alone.
async function refresh(host, wantBreakdown, redrawAfter) {
  if (!host) {
    return;
  }
  const full = wantBreakdown && Date.now() - state.fullRefreshAt >= REFRESH_MIN_MS;
  let usage = null;
  if (full) {
    try {
      usage = await host.usage({ breakdown: "full" });
    } catch (error) {
      usage = null;
    }
  }
  if (!usage) {
    try {
      usage = await host.usage();
    } catch (error) {
      usage = null;
    }
  }
  absorbUsage(usage);
  await refreshAgents(host);
  if (full) {
    state.fullRefreshAt = Date.now();
    // Only the fallback estimate needs the conversation, and that only runs when
    // the host reported no breakdown. Copying every message on every turn is the
    // one place this mod could get expensive on a long session.
    if (!state.breakdown) {
      try {
        const messages = await host.messages();
        if (Array.isArray(messages)) {
          state.messages = messages;
        }
      } catch (error) {
        // No conversation this time; the last one read still describes the window.
      }
    }
  }
  if (redrawAfter) {
    redraw();
  }
}

// refreshAgents reads the host's own list of this session's subagents and
// teammates: it carries the real status (running / idle / completed / failed /
// killed) and the parent. A workflow's agents are not in it, so the events still
// build their rows; the list only corrects and extends what they say.
async function refreshAgents(host) {
  if (!host || typeof host.agents !== "function") {
    return;
  }
  /** @type {any} */
  let list = null;
  try {
    list = await host.agents();
  } catch (error) {
    state.agentListState = "unavailable";
    return;
  }
  if (!Array.isArray(list)) {
    state.agentListState = "unavailable";
    return;
  }
  state.agentListState = "ok";
  const next = Object.create(null);
  for (const info of list) {
    if (!info || typeof info.id !== "string" || !info.id) {
      continue;
    }
    const held = state.agentInfo[info.id];
    next[info.id] = { info: info, seenAt: held ? held.seenAt : Date.now() };
  }
  state.agentInfo = next;
}

// listedStatus maps the host's status word onto the four this UI shows.
function listedStatus(info) {
  const word = String((info && info.status) || "");
  if (word === "failed" || word === "killed") {
    return "failed";
  }
  if (word === "completed") {
    return "done";
  }
  if (word === "idle" || word === "waiting") {
    return "idle";
  }
  if (word === "running" || word === "pending") {
    return "running";
  }
  return "";
}

// absorbUsage keeps only the fields the host actually answered, so an older
// build (or a partially empty reading) never zeroes a number we already hold.
function absorbUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return;
  }
  state.usage = usage;
  const context = usage.context && typeof usage.context === "object" ? usage.context : null;
  if (context) {
    if (typeof context.tokens === "number" && context.tokens > 0) {
      state.tokens = context.tokens;
    }
    if (typeof context.window === "number" && context.window > 0) {
      state.window = context.window;
    }
    if (typeof context.percent === "number" && isFinite(context.percent)) {
      state.percent = context.percent;
    }
    const breakdown = context.breakdown;
    if (breakdown && Array.isArray(breakdown.categories)) {
      state.breakdown = breakdown;
    }
  }
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : null;
  if (cost && typeof cost.usd === "number" && isFinite(cost.usd)) {
    state.costUsd = cost.usd;
  }
  if (Array.isArray(usage.rateLimits)) {
    state.rateLimits = usage.rateLimits;
  }
}

function recordStep(e, result) {
  const usage = result && result.usage;
  if (!usage) {
    return;
  }
  const input = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  const total = input + cacheRead + cacheCreate;
  if (e && e.agentId) {
    // A subagent's request fills its own window: it is counted on the agent and
    // never drawn in the main trend, where it would read as a collapse.
    state.agentSteps += 1;
    const row = agentRow(String(e.agentId));
    row.steps += 1;
    row.input += input;
    row.cacheRead += cacheRead;
    row.cacheCreate += cacheCreate;
    row.output += output;
    // The agent's own window as of its latest request (not a running sum).
    row.tokens = total;
    row.lastAt = Date.now();
    row.lastModel = (e && e.model) || usage.model || row.lastModel;
    return;
  }
  if (total <= 0) {
    return;
  }
  const previous = state.steps.length ? state.steps[state.steps.length - 1].total : 0;
  if (state.pendingCompaction) {
    noteCompaction(state.pendingCompaction.before || previous, total, "hook", state.pendingCompaction.at);
    state.pendingCompaction = null;
  } else if (previous > 0 && total < previous * 0.75) {
    // A request far smaller than the one before it means the window was rebuilt:
    // a compaction, a clear, or a model switch that dropped history. No hook told
    // us, so the entry says so.
    noteCompaction(previous, total, "inferred", Date.now());
  }
  state.persist.dirty = true;
  state.stepCount += 1;
  state.steps.push({
    at: Date.now(),
    model: (e && e.model) || usage.model || "",
    input: input,
    output: num(usage.output_tokens),
    cacheRead: cacheRead,
    cacheCreate: cacheCreate,
    total: total,
  });
  while (state.steps.length > MAX_STEPS) {
    state.steps.shift();
  }
}

function noteCompaction(before, after, source, at) {
  state.compactions.push({ at: at || Date.now(), before: Math.max(0, num(before)), after: Math.max(0, num(after)), source: source, stepNo: state.stepCount });
  while (state.compactions.length > MAX_COMPACTIONS) {
    state.compactions.shift();
  }
}

// persistPath names the slot a session writes to.
function persistPath(startedAt) {
  return PERSIST_DIR + "/slot-" + (Math.floor(startedAt / 1000) % PERSIST_SLOTS) + ".json";
}

const isNum = (value) => typeof value === "number" && isFinite(value);

// restoreSnapshot reads back what an earlier run of this same session saved. The
// key is the session's start time, which the host keeps across a resume (and
// restarts at /clear), so a snapshot from another conversation is not taken.
// Anything missing, mismatched or malformed leaves the state as it is.
async function restoreSnapshot(host) {
  const started = state.usage ? state.usage.startedAt : undefined;
  const startedAt = typeof started === "number" && isFinite(started) ? started : 0;
  state.persist.key = startedAt;
  if (!host || !startedAt || typeof host.fsRead !== "function") {
    state.persist.status = "off";
    return;
  }
  state.persist.status = "ready";
  /** @type {any} */
  let data = null;
  try {
    const raw = await host.fsRead(persistPath(startedAt));
    data = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch (error) {
    return; // no snapshot yet, or one that cannot be read: start clean
  }
  if (!data || data.version !== PERSIST_VERSION || data.startedAt !== startedAt || state.steps.length > 0) {
    return;
  }
  const steps = (Array.isArray(data.steps) ? data.steps : [])
    .filter((step) => step && isNum(step.at) && isNum(step.total) && isNum(step.input) && isNum(step.output) && isNum(step.cacheRead) && isNum(step.cacheCreate))
    .map((step) => ({ at: step.at, model: typeof step.model === "string" ? step.model : "", input: step.input, output: step.output, cacheRead: step.cacheRead, cacheCreate: step.cacheCreate, total: step.total }))
    .slice(-MAX_STEPS);
  state.steps = steps;
  state.stepCount = Math.max(isNum(data.stepCount) ? data.stepCount : 0, steps.length);
  state.agentSteps = isNum(data.agentSteps) ? data.agentSteps : 0;
  state.compactions = (Array.isArray(data.compactions) ? data.compactions : [])
    .filter((entry) => entry && isNum(entry.at) && isNum(entry.before) && isNum(entry.after))
    .map((entry) => ({ at: entry.at, before: entry.before, after: entry.after, source: String(entry.source || "inferred"), stepNo: isNum(entry.stepNo) ? entry.stepNo : -1 }))
    .slice(-MAX_COMPACTIONS);
  for (const name of Object.keys(data.tools && typeof data.tools === "object" ? data.tools : {})) {
    const tool = data.tools[name];
    if (tool && isNum(tool.n) && isNum(tool.ms)) {
      state.tools[name] = { n: tool.n, ms: tool.ms, errors: isNum(tool.errors) ? tool.errors : 0 };
    }
  }
  for (const path of Object.keys(data.files && typeof data.files === "object" ? data.files : {})) {
    if (isNum(data.files[path])) {
      state.files[path] = data.files[path];
    }
  }
  for (const name of Object.keys(data.sections && typeof data.sections === "object" ? data.sections : {})) {
    if (isNum(data.sections[name])) {
      state.sections[name] = data.sections[name];
    }
  }
  state.persist.restored = steps.length;
  state.persist.restoredAt = isNum(data.savedAt) ? data.savedAt : 0;
  state.persist.status = "restored";
  // A snapshot this run can read implies the directory's ignore file was written
  // when it was saved, so the first save does not write it again.
  state.persist.gitignore = true;
}

// snapshotOf is what survives a reload: the request history and the tallies built
// from events. What the host can recompute (window, composition, cost) is not
// saved, and neither are subagent rows: their loops do not outlive the process.
// File paths are the one sensitive part, so the directory ignores itself.
function snapshotOf() {
  const files = topEntries(state.files, PERSIST_MAX_FILES, (count) => count);
  return {
    version: PERSIST_VERSION,
    startedAt: state.persist.key,
    savedAt: Date.now(),
    stepCount: state.stepCount,
    steps: state.steps,
    agentSteps: state.agentSteps,
    compactions: state.compactions,
    tools: state.tools,
    files: Object.fromEntries(files),
    sections: state.sections,
  };
}

// saveSnapshot writes the snapshot when something changed since the last one. A
// failure turns persistence off for the session rather than retrying on every
// turn: the live views do not depend on it.
async function saveSnapshot(host) {
  const persist = state.persist;
  if (!host || !persist.key || !persist.dirty || persist.status === "failed" || typeof host.fsWrite !== "function") {
    return;
  }
  try {
    if (!persist.gitignore) {
      // Its own try: a read-only file here must not turn the whole snapshot off.
      try {
        await host.fsWrite(PERSIST_DIR + "/.gitignore", "*\n");
        persist.gitignore = true;
      } catch (error) {
        // The snapshot itself is what matters; the ignore file is housekeeping.
      }
    }
    await host.fsWrite(persistPath(persist.key), JSON.stringify(snapshotOf()));
    persist.dirty = false;
    persist.savedAt = Date.now();
    if (persist.status !== "restored") {
      persist.status = "saved";
    }
  } catch (error) {
    persist.status = "failed";
  }
}

function compactionCount() {
  return state.compactions.length + (state.pendingCompaction ? 1 : 0);
}

function noteTool(e, ms, isError) {
  const name = e && typeof e.tool === "string" ? e.tool : "unknown";
  const entry = state.tools[name] || { n: 0, ms: 0, errors: 0 };
  state.persist.dirty = true;
  entry.n += 1;
  entry.ms += ms;
  if (isError) {
    entry.errors += 1;
  }
  state.tools[name] = entry;

  const path = filePathOf(e);
  if (path) {
    state.files[path] = (state.files[path] || 0) + 1;
  }

  const agentId = e && typeof e.agentId === "string" ? e.agentId : "";
  if (agentId) {
    const row = agentRow(agentId);
    row.calls += 1;
    if (isError) {
      row.errors += 1;
    }
    row.lastTool = name;
    row.lastSubject = subjectOf(e);
    row.lastAt = Date.now();
  }
}

// callResultOf reads the result of a tool call. The host hands a hook the
// result itself ({ isError, text, ... }); a stand-in answering in a test wraps
// it once more ({ result: ... }), so unwrap only when the outer shape has no
// verdict of its own.
function callResultOf(result) {
  if (result && typeof result === "object" && result.isError === undefined && result.result && typeof result.result === "object") {
    return result.result;
  }
  return result;
}

// subjectOf names what a call was aimed at, in the few words that fit a row.
function subjectOf(e) {
  if (!e) {
    return "";
  }
  const path = e.file_path || e.path || e.notebook_path || "";
  if (typeof path === "string" && path.length > 0) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : path;
  }
  const command = typeof e.command === "string" ? e.command.replace(/\s+/g, " ").trim() : "";
  if (command) {
    return command.slice(0, 32);
  }
  const other = [e.pattern, e.description, e.query, e.prompt, e.url, e.name];
  for (const value of other) {
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\s+/g, " ").trim().slice(0, 32);
    }
  }
  return "";
}

// ---------------------------------------------------------------- subagents

// A subagent loop is watched through events, not listed: the engine names the
// agent on every tool call and request it makes, and a workflow's ids appear
// nowhere else (not even in $.agent.list()). A row is created on first sight and
// kept until it falls out of the cap.
function agentRow(id) {
  const held = state.agents[id];
  if (held) {
    return held;
  }
  /** @type {AgentRow} */
  const row = {
    id: id,
    firstAt: Date.now(),
    lastAt: 0,
    doneAt: 0,
    calls: 0,
    errors: 0,
    steps: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    tokens: 0,
    lastTool: "",
    lastSubject: "",
    lastModel: "",
    isDone: false,
    launch: null,
  };
  state.agents[id] = row;
  state.agentOrder.push(id);
  while (state.agentOrder.length > MAX_AGENTS) {
    const oldest = state.agentOrder.shift();
    if (oldest !== undefined) {
      delete state.agents[oldest];
    }
  }
  // A launch whose result already named this id (an async launch returns at
  // once with it) is the exact match.
  for (const launch of state.launches) {
    if (launch.agentId === id) {
      row.launch = launch;
      return row;
    }
  }
  // Otherwise the oldest launch still waiting for a child.
  for (const launch of state.openLaunches) {
    if (!launch.agentId && !launch.parentAgentId) {
      launch.agentId = id;
      row.launch = launch;
      break;
    }
  }
  return row;
}

function pickString(e, keys) {
  if (!e) {
    return "";
  }
  for (const key of keys) {
    const value = e[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function beginLaunch(e) {
  if (!e) {
    return null;
  }
  const tool = typeof e.tool === "string" ? e.tool : "";
  if (LAUNCH_TOOLS.indexOf(tool) < 0) {
    return null;
  }
  const launch = {
    at: Date.now(),
    tool: tool,
    // The engine's own id for this call: agent.spawn repeats it, which pairs the
    // two events exactly instead of by order.
    toolUseId: pickString(e, ["tool_use_id"]),
    name: pickString(e, ["name"]),
    type: pickString(e, ["subagent_type", "agentType", "agent", "type"]),
    description: pickString(e, ["description", "prompt", "query", "task"]).replace(/\s+/g, " ").slice(0, 80),
    agentId: "",
    // A call made from inside a subagent: that loop is the new child's parent.
    parentAgentId: typeof e.agentId === "string" ? e.agentId : "",
    doneAt: 0,
    isError: false,
    spawn: null,
  };
  state.launches.push(launch);
  while (state.launches.length > MAX_LAUNCHES) {
    state.launches.shift();
  }
  state.openLaunches.push(launch);
  return launch;
}

// settleLaunch reads the Agent tool's own result: its agentId pairs the launch
// with its child exactly (correcting an order-based guess), and an async or
// remote launch returned at once, so it is not finished when the call returns.
function settleLaunch(launch, settled) {
  if (!launch || !settled || typeof settled !== "object") {
    return;
  }
  const id = typeof settled.agentId === "string" ? settled.agentId : "";
  if (id && launch.agentId !== id) {
    const old = launch.agentId ? state.agents[launch.agentId] : null;
    if (old && old.launch === launch) {
      old.launch = null;
    }
    launch.agentId = id;
    const row = state.agents[id];
    if (row) {
      row.launch = launch;
    }
  }
  if (settled.status === "async_launched" || settled.status === "remote_launched") {
    launch.isAsync = true;
  }
  // Some builds report the resolved type on the result too; it is only useful
  // when the caller did not choose one and agent.spawn has not spoken yet.
  if (!launch.type && typeof settled.agentType === "string" && settled.agentType.trim()) {
    launch.type = settled.agentType.trim();
  }
  if (typeof settled.totalTokens === "number" && settled.status === "completed") {
    launch.report = {
      tokens: settled.totalTokens,
      calls: num(settled.totalToolUseCount),
      ms: num(settled.totalDurationMs),
    };
  }
}

// noteAgentSpawn records what the engine says about the agent it just started:
// the pair's own id ties it to the call that asked for it, and the resolved
// subagent type lives here rather than in the tool call (which may omit it).
// A resumed agent carries e.resume: it is the same agent running again.
function noteAgentSpawn(e) {
  if (!e || e.resume) {
    return;
  }
  const toolUseId = typeof e.tool_use_id === "string" ? e.tool_use_id : "";
  let launch = null;
  for (let index = state.launches.length - 1; index >= 0; index -= 1) {
    const candidate = state.launches[index];
    if (candidate.spawn) {
      continue;
    }
    if (toolUseId && candidate.toolUseId && candidate.toolUseId !== toolUseId) {
      continue;
    }
    launch = candidate;
    break;
  }
  if (!launch) {
    // A teammate or a workflow agent: no Agent call of ours asked for it.
    return;
  }
  launch.spawn = {
    type: typeof e.subagentType === "string" ? e.subagentType : "",
    isFork: e.fork === true,
    isBackground: e.background === true,
    model: typeof e.model === "string" ? e.model : "",
  };
  if (!launch.name && typeof e.name === "string" && e.name.trim()) {
    launch.name = e.name.trim();
  }
}

function finishLaunch(launch, isError) {
  if (!launch) {
    return;
  }
  if (launch.isAsync && !isError) {
    // Returned at once; the child is still running. It ends on its own
    // turn.complete, so the launch is released for pairing but not marked done.
    const held = state.openLaunches.indexOf(launch);
    if (held >= 0) {
      state.openLaunches.splice(held, 1);
    }
    return;
  }
  launch.doneAt = Date.now();
  launch.isError = isError;
  const index = state.openLaunches.indexOf(launch);
  if (index >= 0) {
    state.openLaunches.splice(index, 1);
  }
}

// agentStatus reads a row as the four states a person cares about. A launch that
// failed makes it failed; silence for AGENT_IDLE_MS makes it idle, not running.
function agentStatus(row, now) {
  const at = now || Date.now();
  if (row.launch && row.launch.isError) {
    return "failed";
  }
  if (row.isDone) {
    return "done";
  }
  const listed = state.agentInfo[row.id];
  const word = listed ? listedStatus(listed.info) : "";
  if (word) {
    return word;
  }
  if (row.lastAt > 0 && at - row.lastAt > AGENT_IDLE_MS) {
    return "idle";
  }
  return "running";
}

// agentRows merges the two views: agents the events named, and launches whose
// child never announced itself (it may run in another process).
function agentRows() {
  const now = Date.now();
  const rows = [];
  for (const id of state.agentOrder) {
    const row = state.agents[id];
    if (!row) {
      continue;
    }
    rows.push({ row: row, launch: row.launch, status: agentStatus(row, now) });
  }
  const named = Object.create(null);
  for (const launch of state.launches) {
    if (launch.agentId) {
      named[launch.agentId] = true;
    }
  }
  for (const id of Object.keys(state.agentInfo)) {
    if (state.agents[id] || named[id]) {
      continue;
    }
    const held = state.agentInfo[id];
    const info = held.info;
    rows.push({
      row: null,
      launch: {
        at: held.seenAt,
        tool: "Agent",
        toolUseId: "",
        name: typeof info.name === "string" ? info.name : "",
        type: String(info.type || ""),
        description: String(info.description || "").slice(0, 80),
        agentId: id,
        doneAt: listedStatus(info) === "done" ? Date.now() : 0,
        isError: listedStatus(info) === "failed",
        spawn: null,
      },
      status: listedStatus(info) || "running",
    });
  }
  for (const launch of state.launches) {
    if (launch.agentId && state.agents[launch.agentId]) {
      continue;
    }
    rows.push({
      row: null,
      launch: launch,
      status: launch.doneAt > 0 ? (launch.isError ? "failed" : "done") : "running",
    });
  }
  return nestRows(rows);
}

// nestRows puts each child under its parent and records how deep it sits. The
// parent is the loop whose Agent call started it, or the host list's parentId.
function nestRows(rows) {
  const idOf = (entry) => (entry.row ? entry.row.id : (entry.launch && entry.launch.agentId) || "");
  const parentOf = (entry) => {
    const id = idOf(entry);
    const listed = id ? state.agentInfo[id] : null;
    return (entry.launch && entry.launch.parentAgentId) || (listed && listed.info.parentId) || "";
  };
  const byId = Object.create(null);
  for (const entry of rows) {
    const id = idOf(entry);
    if (id) {
      byId[id] = entry;
    }
  }
  const kids = Object.create(null);
  const top = [];
  for (const entry of rows) {
    const parent = parentOf(entry);
    if (parent && byId[parent] && byId[parent] !== entry) {
      (kids[parent] = kids[parent] || []).push(entry);
    } else {
      top.push(entry);
    }
  }
  const out = [];
  const seen = new Set();
  // trunk is the part of the prefix that says which ancestors still have a
  // sibling below; isLast decides this node's own branch character.
  const visit = (entry, depth, trunk, isLast, parentEntry) => {
    if (seen.has(entry)) {
      return 0;
    }
    seen.add(entry);
    const children = kids[idOf(entry)] || [];
    entry.depth = depth;
    entry.isLast = isLast;
    // Keyed the same way folding is keyed, so a folded parent hides its subtree.
    entry.parentKey = parentEntry ? agentKey(parentEntry) : "";
    entry.prefix = depth === 0 ? "" : trunk + (isLast ? "└─ " : "├─ ");
    entry.kidCount = children.length;
    out.push(entry);
    const childTrunk = depth === 0 ? "" : trunk + (isLast ? "   " : "│  ");
    let below = 0;
    for (let i = 0; i < children.length; i += 1) {
      below += visit(children[i], depth + 1, childTrunk, i === children.length - 1, entry);
    }
    entry.totalKids = below;
    return below + 1;
  };
  for (const entry of top) {
    visit(entry, 0, "", true, "");
  }
  // A parent cycle would leave rows unreached; show them flat rather than lose them.
  for (const entry of rows) {
    visit(entry, 0, "", true, "");
  }
  return out;
}

function agentCounts() {
  const counts = { running: 0, done: 0, failed: 0, idle: 0 };
  for (const entry of agentRows()) {
    counts[entry.status] += 1;
  }
  return counts;
}

function agentGlyph(status) {
  if (status === "running") {
    return "●";
  }
  if (status === "failed") {
    return "✗";
  }
  if (status === "idle") {
    return "◌";
  }
  return "✓";
}

// A type the caller actually chose names the agent; the engine's fallback does
// not ("general-purpose" on every row says nothing).
function specificAgentType(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return GENERIC_AGENT_TYPES.indexOf(text.toLowerCase()) >= 0 ? "" : text;
}

// agentName is the row's identity, in the order that tells rows apart: the name
// the caller gave, then a type someone chose, then the task's own words. The
// engine's generic type is skipped rather than repeated on every line.
function agentName(entry) {
  const launch = entry.launch;
  const listed = entry.row ? state.agentInfo[entry.row.id] : null;
  const info = listed && listed.info ? listed.info : null;

  const named = (launch && launch.name) || (info && typeof info.name === "string" ? info.name.trim() : "");
  if (named) {
    return String(named);
  }
  const typed =
    specificAgentType(launch && launch.spawn && launch.spawn.type) ||
    specificAgentType(launch && launch.type) ||
    specificAgentType(info && info.type);
  if (typed) {
    return typed;
  }
  const described = (info && (info.label || info.description)) || (launch && launch.description) || "";
  if (described) {
    return clip(String(described), 16);
  }
  return "子代理";
}

// agentPurpose is what the agent was asked to do: the launch's own words first,
// then the host list's description. This is the column a formation view exists for.
function agentPurpose(entry) {
  const launch = entry.launch;
  if (launch && launch.description) {
    return launch.description;
  }
  const listed = entry.row ? state.agentInfo[entry.row.id] : null;
  if (listed && listed.info && listed.info.description) {
    return String(listed.info.description).replace(/\s+/g, " ").trim();
  }
  return "";
}

function agentKey(entry) {
  const id = entry.row ? entry.row.id : (entry.launch && entry.launch.agentId) || "";
  return id ? "agent:" + id : "agent:launch:" + ((entry.launch && entry.launch.at) || 0);
}

// A deep tree would push its own rows off the right edge: past four levels the
// leading trunk folds into one ellipsis, keeping the branch that matters.
function curvePrefix(prefix) {
  const text = String(prefix || "");
  const units = text.split(/(?=[│├└])/).filter((part) => part.length > 0);
  return units.length <= 4 ? text : "…" + units.slice(-3).join("");
}

function wrapPlain(value, width) {
  const limit = Math.max(8, width);
  const words = String(value || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? line + " " + word : word;
    if (displayWidth(next) > limit && line) {
      lines.push(clip(line, limit));
      line = word;
    } else {
      line = next;
    }
  }
  if (line) {
    lines.push(clip(line, limit));
  }
  return lines;
}

function agentAge(entry, now) {
  const at = now || Date.now();
  const row = entry.row;
  const launch = entry.launch;
  if (row) {
    const end = row.isDone && row.doneAt > 0 ? row.doneAt : entry.status === "idle" ? row.lastAt : at;
    const ms = Math.max(0, end - row.firstAt);
    return (entry.status === "idle" ? "静 " : "") + humanDuration(ms);
  }
  const end = launch.doneAt > 0 ? launch.doneAt : at;
  return humanDuration(Math.max(0, end - launch.at));
}

// agentWork is the one thing a row can say about what the child is doing: its
// latest call, or, before any call, what it was asked to do.
function agentWork(entry) {
  const row = entry.row;
  const launch = entry.launch;
  if (row && row.lastTool) {
    return row.lastTool + (row.lastSubject ? " " + row.lastSubject : "");
  }
  if (launch && launch.description && launch.description !== agentName(entry)) {
    return launch.description;
  }
  return "";
}

function agentLine(entry, columns, options) {
  const opts = options || {};
  const row = entry.row;
  const counts = row ? row.steps + "步 " + row.calls + "调 " + human(row.tokens) : "—";
  const age = agentAge(entry);
  const prefix = curvePrefix(entry.prefix);
  // The fold slot sits before the node so ▾/▸ lines up with the branch it opens.
  const fold = typeof opts.foldGlyph === "string" ? opts.foldGlyph : " ";
  const name = agentName(entry);
  const purpose = agentPurpose(entry);
  // 16 columns holds a name, or a chosen type such as "Explore", whole.
  const head = "  " + prefix + fold + " " + agentGlyph(entry.status) + " " + padRight(clip(name, 16), 16);
  const tail = pad(counts, 15) + " " + age;
  const hiddenText = num(opts.hidden) > 0 ? " (+" + num(opts.hidden) + ")" : "";
  const room = Math.max(0, columns - displayWidth(head) - displayWidth(tail) - 2);
  // When the name fell back to the task's own words, do not print them twice.
  const detail = purpose && purpose !== name ? purpose : agentWork(entry);
  const purposeText = room > 4
    ? clip(detail, Math.max(0, room - displayWidth(hiddenText))) + hiddenText
    : hiddenText.trim();
  const line = purposeText ? head + " " + padRight(purposeText, room) + " " + tail : head + " " + tail;
  return clip(line, Math.max(20, columns));
}

function agentSummary() {
  const counts = agentCounts();
  const parts = [];
  if (counts.running > 0) {
    parts.push("运行 " + counts.running);
  }
  if (counts.idle > 0) {
    parts.push("静默 " + counts.idle);
  }
  if (counts.done > 0) {
    parts.push("完成 " + counts.done);
  }
  if (counts.failed > 0) {
    parts.push("失败 " + counts.failed);
  }
  if (parts.length === 0) {
    return "本会话还没有子代理";
  }
  return parts.join(" · ") + " · 共 " + (counts.running + counts.idle + counts.done + counts.failed);
}

function filePathOf(e) {
  if (!e) {
    return "";
  }
  const candidate = e.file_path || e.path || e.notebook_path || "";
  return typeof candidate === "string" && candidate.length < 300 ? candidate : "";
}

function noteSection(e) {
  if (!e) {
    return;
  }
  const text = typeof e.text === "string" ? e.text : typeof e.content === "string" ? e.content : "";
  if (!text) {
    return;
  }
  const name = String(e.name || e.title || e.section || e.id || "section").slice(0, 60);
  const keys = Object.keys(state.sections);
  if (!(name in state.sections) && keys.length >= MAX_SECTIONS) {
    return;
  }
  // Assign, never add: the engine announces a section again after a compaction or
  // a new thread, and the latest text is the one in the window.
  state.sections[name] = estimateTokens(text);
}

// --------------------------------------------------------------------- pane

// tabChoices names every tab the way a person types it: the label first, then
// the id the argument parser also accepts.
function tabChoices() {
  return TABS.map((tab) => tab.label + "（" + tab.id + "）").join(" / ");
}

function tabOf(name) {
  const needle = String(name || "").toLowerCase();
  if (!needle) {
    return null;
  }
  for (const tab of TABS) {
    if (tab.id === needle || tab.label === String(name) || tab.hotkey === needle) {
      return tab;
    }
    if (Array.isArray(tab.aliases) && tab.aliases.indexOf(String(name)) >= 0) {
      return tab;
    }
  }
  return null;
}

async function openPane() {
  const host = state.host;
  if (!host) {
    return { isPlaced: false, reason: "宿主没有提供侧栏" };
  }
  /** @type {any} */
  let result = null;
  try {
    // focus is a request: the surface grants it while the composer is empty, which it
    // is right after a /ccx. Without it the pane draws but its hotkeys (1-4, j/k, 0)
    // do nothing until the person focuses it with ctrl+x tab or a click.
    result = await host.open({ id: PANE_ID, title: "CC-Context", focus: true });
  } catch (error) {
    return { isPlaced: false, reason: String((/** @type {any} */ (error) || {}).message || error) };
  }
  const isPlaced = !result || result.isPlaced !== false;
  state.pane.isOpen = isPlaced;
  state.pane.isWaiting = !isPlaced;
  await refresh(host, true, false);
  redraw();
  return { isPlaced: isPlaced, reason: (result && result.reason) || "" };
}

async function closePane() {
  state.pane.isOpen = false;
  state.pane.isWaiting = false;
  const host = state.host;
  if (!host) {
    return;
  }
  try {
    await host.close({ id: PANE_ID });
  } catch (error) {
    // The pane is gone either way; a surface that does not track it is not an error.
  }
  redraw();
}

function redraw() {
  const host = state.host;
  if (!host) {
    return;
  }
  try {
    void host.invalidate();
  } catch (error) {
    // A headless surface draws nothing; nothing to invalidate.
  }
}

function switchTab(id) {
  const tab = tabOf(id);
  if (!tab) {
    return;
  }
  state.pane.tab = tab.id;
  state.pane.offset = 0;
  redraw();
}

function toggleSection(id) {
  state.pane.expanded[id] = state.pane.expanded[id] !== true;
  redraw();
}

function toggleFold(key) {
  state.pane.folded[key] = state.pane.folded[key] !== true;
  redraw();
}

// One key for the whole tab: with anything folded it opens everything, otherwise
// it folds every row that has children. That leaves the roots, which is the shape
// a big fleet is easiest to read in.
function toggleFoldAll() {
  if (Object.keys(state.pane.folded).length > 0) {
    state.pane.folded = Object.create(null);
  } else {
    const folded = state.pane.folded;
    for (const entry of agentRows()) {
      if (entry.kidCount > 0) {
        folded[agentKey(entry)] = true;
      }
    }
  }
  redraw();
}

// visibleAgentEntries drops the subtree of every folded row. The walk is in tree
// order, so a parent is always seen before its children.
function visibleAgentEntries(entries) {
  const byKey = Object.create(null);
  const out = [];
  for (const entry of entries) {
    const key = agentKey(entry);
    const parentKey = entry.parentKey || "";
    const parent = parentKey ? byKey[parentKey] : null;
    const hidden = Boolean(parent && (parent.hidden || state.pane.folded[parentKey] === true));
    entry.hidden = hidden;
    byKey[key] = entry;
    if (!hidden) {
      out.push(entry);
    }
  }
  return out;
}

function scrollBy(delta) {
  const step = Math.max(1, num(state.pane.bodyRows) - 1);
  state.pane.offset = Math.max(0, state.pane.offset + delta * step);
  redraw();
}

function paneView(table, e) {
  const props = e && e.props && typeof e.props === "object" ? e.props : {};
  const columns = Math.max(24, (num(props.bodyColumns) || 72) - 1);
  const scroll = props.scroll && typeof props.scroll === "object" ? props.scroll : {};
  const visible = Math.max(3, num(scroll.bodyRows) || 12);
  const rows = Math.max(1, visible - 2); // one row of tabs above, one of hints below
  state.pane.bodyRows = rows;
  const body = paneBody(table, columns);
  const maxOffset = Math.max(0, body.length - rows);
  if (state.pane.offset > maxOffset) {
    state.pane.offset = maxOffset;
  }
  const page = body.slice(state.pane.offset, state.pane.offset + rows);
  const position = body.length > rows ? " " + (state.pane.offset + 1) + "-" + (state.pane.offset + page.length) + "/" + body.length : "";
  const Box = table.Box;
  return Box({
    flexDirection: "column",
    children: [tabBar(table, columns), ...page, footerRow(table, columns, position, props.isFocused === true)],
  });
}

function tabBar(table, columns) {
  const Box = table.Box;
  const Button = table.Button;
  const children = [];
  for (const tab of TABS) {
    const active = state.pane.tab === tab.id;
    if (typeof Button === "function") {
      children.push(
        Button({
          key: "tab:" + tab.id,
          hotkey: tab.hotkey,
          plain: true,
          onPress: () => {
            switchTab(tab.id);
          },
          children: (active ? "▪" : "▫") + tab.label,
        }),
      );
    } else {
      children.push(text(table, (active ? "▪" : "▫") + tab.label, active ? {} : { dimColor: true }));
    }
  }
  const tail = typeof Button === "function"
    ? Button({
        key: "close",
        hotkey: "0",
        plain: true,
        dimColor: true,
        onPress: () => {
          void closePane();
        },
        children: "关闭",
      })
    : text(table, "关闭", { dimColor: true });
  return Box({
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    children: [Box({ flexDirection: "row", columnGap: 1, children: children }), tail],
  });
}

// keyHint says how to drive the pane. Its hotkeys only work while it holds the
// keyboard, so an unfocused pane says how to give it that.
function keyHint(isFocused) {
  const base = isFocused
    ? "1-" + TABS.length + " 切换 · j/k 翻页 · 0 关闭 · Esc 回输入框"
    : "未聚焦：ctrl+x tab 或点击侧栏后，按 1-" + TABS.length + " 切换 · j/k 翻页";
  // Kept last so a narrow pane clips the optional part, never the essentials.
  return state.pane.tab === "agents" ? base + " · f 全折叠/展开 · ⓘ 明细" : base;
}

function footerRow(table, columns, position, isFocused) {
  const Box = table.Box;
  const Button = table.Button;
  if (typeof Button !== "function") {
    return text(table, clip(keyHint(isFocused) + position, columns), { dimColor: true });
  }
  const children = [
    Button({ key: "scroll-up", hotkey: "k", plain: true, dimColor: true, onPress: () => { scrollBy(-1); }, children: "↑" }),
    Button({ key: "scroll-down", hotkey: "j", plain: true, dimColor: true, onPress: () => { scrollBy(1); }, children: "↓" }),
  ];
  if (state.pane.tab === "agents") {
    const anyFolded = Object.keys(state.pane.folded).length > 0;
    children.push(
      Button({
        key: "fold-all",
        hotkey: "f",
        plain: true,
        dimColor: true,
        onPress: () => {
          toggleFoldAll();
        },
        children: anyFolded ? "▸全" : "▾全",
      }),
    );
  }
  children.push(text(table, clip(keyHint(isFocused) + position, Math.max(4, columns - 6)), { dimColor: true }));
  return Box({ flexDirection: "row", columnGap: 1, children: children });
}

function paneBody(table, columns) {
  if (state.pane.tab === "trend") {
    return trendRows(table, columns);
  }
  if (state.pane.tab === "agents") {
    return agentTabRows(table, columns);
  }
  if (state.pane.tab === "browser") {
    return browserRows(table, columns);
  }
  return compositionRows(table, columns);
}

function agentTabRows(table, columns) {
  const rows = [];
  const all = agentRows();
  const entries = visibleAgentEntries(all);
  rows.push(text(table, "编队（本会话；▾ 折叠 · ⓘ 明细 · 按谁启动了谁排）", { dimColor: true }));
  rows.push(text(table, agentSummary(), { dimColor: true }));
  if (entries.length === 0) {
    rows.push(text(table, "  （还没有子代理；主会话里的 Agent/Task 调用会出现在这里）", { dimColor: true }));
    return rows;
  }
  rows.push(text(table, ""));
  for (const entry of entries.slice(-24)) {
    rows.push(agentRowView(table, entry, Math.max(20, columns - 2)));
    if (state.pane.expanded[agentKey(entry)] === true) {
      for (const line of agentDetailLines(entry, columns)) {
        rows.push(text(table, "       " + line, { dimColor: true }));
      }
    }
  }
  if (all.some((entry) => !entry.row)) {
    rows.push(text(table, "  （调用数显示为 — 的行，只看到了启动记录，没看到它自己的事件）", { dimColor: true }));
  }
  return rows;
}

// A formation row is pressable: pressing it opens the agent's own words, the
// numbers behind its counters, and what the host says its status is.
function agentRowView(table, entry, columns) {
  const key = agentKey(entry);
  const hasKids = entry.kidCount > 0;
  const folded = state.pane.folded[key] === true;
  const foldGlyph = hasKids ? (folded ? "▸" : "▾") : " ";
  const hidden = folded ? entry.totalKids : 0;
  const Button = table.Button;
  if (typeof Button !== "function") {
    return text(table, agentLine(entry, columns, { foldGlyph: foldGlyph, hidden: hidden }), entry.status === "running" ? {} : { dimColor: true });
  }
  // A row with children folds them (the ▾/▸ says so); ⓘ opens its own words.
  const label = agentLine(entry, hasKids ? Math.max(20, columns - 2) : columns, { foldGlyph: foldGlyph, hidden: hidden });
  const main = Button({
    key: key,
    plain: true,
    onPress: () => {
      if (hasKids) {
        toggleFold(key);
      } else {
        toggleSection(key);
      }
    },
    children: label,
  });
  if (!hasKids) {
    return main;
  }
  return table.Box({
    flexDirection: "row",
    children: [
      main,
      Button({
        key: "agent-info:" + key.slice("agent:".length),
        plain: true,
        dimColor: true,
        onPress: () => {
          toggleSection(key);
        },
        children: " ⓘ",
      }),
    ],
  });
}

function agentDetailLines(entry, columns) {
  const lines = [];
  for (const part of wrapPlain(agentPurpose(entry), Math.max(16, columns - 8))) {
    lines.push(part);
  }
  const row = entry.row;
  const listed = row ? state.agentInfo[row.id] : null;
  const facts = [];
  if (row) {
    facts.push(row.steps + " 步 · " + row.calls + " 次调用" + (row.errors > 0 ? " · " + row.errors + " 失败" : ""));
    if (row.tokens > 0) {
      facts.push("自身窗口 " + human(row.tokens));
    }
  }
  const report = entry.launch && entry.launch.report;
  if (report) {
    facts.push("宿主报告 " + human(report.tokens) + " · " + report.calls + " 次 · " + humanDuration(report.ms));
  }
  const spawn = entry.launch && entry.launch.spawn;
  const type = spawn && spawn.type ? spawn.type : entry.launch && entry.launch.type;
  if (type) {
    facts.push("类型 " + type + (spawn && spawn.isFork ? "（fork）" : ""));
  }
  if (entry.launch && entry.launch.name) {
    facts.push("名称 " + entry.launch.name);
  }
  if (listed && listed.info.kind) {
    facts.push(String(listed.info.kind));
  }
  if (listed && listed.info.status) {
    facts.push("宿主状态 " + listed.info.status);
  }
  if (entry.kidCount > 0) {
    facts.push("下辖 " + entry.kidCount);
  }
  if (facts.length > 0) {
    lines.push(facts.join(" · "));
  }
  if (row && row.lastTool) {
    lines.push("最近 " + row.lastTool + (row.lastSubject ? " " + row.lastSubject : ""));
  }
  return lines;
}

// compositionModel reads the host's breakdown once for every view: what is in
// the window (used), the room the window has left (free space and the compaction
// buffer), and tool definitions declared but not loaded (deferred).
/** @param {Breakdown} breakdown @param {number} current */
function compositionModel(breakdown, current) {
  const total = num(breakdown.totalTokens) || current;
  const windowSize = num(breakdown.maxTokens) || num(breakdown.rawMaxTokens) || state.window || total;
  const categories = (Array.isArray(breakdown.categories) ? breakdown.categories : []).filter((category) => num(category.tokens) > 0);
  return {
    total: total,
    windowSize: windowSize,
    used: categories.filter((category) => !isRoom(category) && !isDeferredCategory(category)),
    room: categories.filter((category) => isRoom(category)),
    deferred: categories.filter((category) => isDeferredCategory(category) && !isRoom(category)),
  };
}

// barSegments lays the window out left to right: each used category, then the
// compaction buffer, then free space, as whole cells that add up to the width.
function barSegments(model, width) {
  const parts = [];
  model.used.forEach((category, index) => parts.push({ kind: "used", index: index, tokens: num(category.tokens) }));
  for (const category of model.room.filter((item) => categoryKind(item) === "buffer")) {
    parts.push({ kind: "buffer", index: -1, tokens: num(category.tokens) });
  }
  for (const category of model.room.filter((item) => categoryKind(item) !== "buffer")) {
    parts.push({ kind: "free", index: -1, tokens: num(category.tokens) });
  }
  const cells = allocateCells(parts.map((part) => part.tokens), width);
  return parts.map((part, i) => ({ ...part, cells: cells[i] })).filter((part) => part.cells > 0);
}

// stackedBar is the window drawn as one bar in the pane: a color per category
// in proportion to the window, so what is left reads as the dim stretch at the end.
function stackedBar(table, model, width) {
  const segments = barSegments(model, width);
  if (segments.length === 0) {
    return text(table, "");
  }
  return table.Box({
    flexDirection: "row",
    children: segments.map((segment) =>
      segment.kind === "used"
        ? text(table, "█".repeat(segment.cells), { color: SEG_COLORS[segment.index % SEG_COLORS.length] })
        : text(table, (segment.kind === "buffer" ? "▒" : "░").repeat(segment.cells), { dimColor: true }),
    ),
  });
}

// dashBar answers one question for the plain-text dashboard, how full the window
// is: used (█), the compaction buffer (▒) and free space (░), nothing finer.
function dashBar(model, width) {
  const sum = (items) => items.reduce((total, category) => total + num(category.tokens), 0);
  const buffer = model.room.filter((category) => categoryKind(category) === "buffer");
  const free = model.room.filter((category) => categoryKind(category) !== "buffer");
  const cells = allocateCells([sum(model.used), sum(buffer), sum(free)], width);
  return "█".repeat(cells[0]) + "▒".repeat(cells[1]) + "░".repeat(cells[2]);
}

// legendRow is one category of the bar: its color, its name, its size and share
// of the window.
function legendRow(table, index, name, tokens, windowSize, columns) {
  const share = windowSize > 0 ? Math.round((tokens / windowSize) * 100) : 0;
  const tail = pad(human(tokens), 7) + " " + pad(share + "%", 4);
  const labelWidth = Math.max(8, columns - 2 - tail.length - 1);
  return table.Box({
    flexDirection: "row",
    children: [
      text(table, "■ ", { color: SEG_COLORS[index % SEG_COLORS.length] }),
      text(table, padRight(clip(name, labelWidth), labelWidth) + " " + tail),
    ],
  });
}

// trendChart draws the window of the last requests as a braille line two rows
// tall, with a mark under every compaction. The series is cut to at most two
// points per column, so a long session shows its recent shape, not a smear.
function trendChart(columns) {
  const cols = Math.max(8, Math.floor(columns));
  const steps = state.steps;
  const series = steps.slice(-cols).map((step) => step.total);
  // series[0] is request number (stepCount - series.length); a compaction knows
  // the number of the request that showed it, so no clock is involved.
  const firstNo = state.stepCount - series.length;
  const chart = blockColumns(series, cols, 3);
  const cells = new Array(chart.width).fill(" ");
  let hasMarks = false;
  for (const entry of state.compactions) {
    const at = entry.stepNo - firstNo;
    if (at < 0 || at >= series.length) {
      continue;
    }
    const x = chart.positions[at];
    if (typeof x === "number" && x >= 0 && x < cells.length) {
      cells[x] = "▲";
      hasMarks = true;
    }
  }
  return {
    rows: chart.rows,
    marks: cells.join(""),
    hasMarks: hasMarks,
    first: series[0],
    last: series[series.length - 1],
    peak: Math.max.apply(null, series),
  };
}

function compositionRows(table, columns) {
  const rows = [];
  const breakdown = state.breakdown;
  const current = currentTokens();
  if (breakdown) {
    rows.push(text(table, "组成（宿主精确上报，单位 token）", { dimColor: true }));
    const model = compositionModel(breakdown, current);
    const { total, windowSize, used, room, deferred } = model;
    const barWidth = Math.max(10, columns - 2);
    rows.push(stackedBar(table, model, barWidth));
    for (let index = 0; index < used.length; index += 1) {
      const category = used[index];
      rows.push(legendRow(table, index, String(category.name || "?"), num(category.tokens), windowSize, columns));
    }
    const usedPercent = percentOf(total, windowSize);
    rows.push(text(table, "合计 " + human(total) + " / " + human(windowSize) + " · 已用 " + usedPercent + "%", { color: levelColor(usedPercent), bold: usedPercent >= 75 }));
    if (room.length > 0) {
      rows.push(text(table, "空余 " + room.map((category) => String(category.name || "?") + " " + human(num(category.tokens))).join(" · "), { dimColor: true }));
    }
    if (deferred.length > 0) {
      rows.push(text(table, "未加载 " + deferred.map((category) => String(category.name || "?") + " " + human(num(category.tokens))).join(" · ") + "（需要时才加载，不计入窗口）", { dimColor: true }));
    }
    if (num(breakdown.autocompactThreshold) > 0) {
      const off = breakdown.isAutoCompactEnabled === false ? "（自动压缩已关）" : "";
      const left = num(breakdown.autocompactThreshold) - total;
      const close = left <= 0 ? "red" : left / num(breakdown.autocompactThreshold) <= 0.1 ? "red" : left / num(breakdown.autocompactThreshold) <= 0.25 ? "magenta" : "";
      const gap = off ? "" : left > 0 ? " · 距阈值 " + human(left) : " · 已越过阈值";
      rows.push(text(table, "自动压缩阈值 " + human(breakdown.autocompactThreshold) + off + gap, close ? { color: close } : { dimColor: true }));
    }
  } else {
    rows.push(text(table, "组成 ≈（总量精确，拆分按字符估算）", { dimColor: true }));
    const buckets = composition(state.messages, current);
    if (buckets.length === 0) {
      rows.push(text(table, "  （拿不到会话消息，暂无拆分）", { dimColor: true }));
    } else {
      const top = Math.max.apply(null, buckets.map((bucket) => bucket.tokens));
      for (const bucket of buckets) {
        rows.push(text(table, barLine(bucket.label, bucket.tokens, top, current, columns)));
      }
      rows.push(text(table, "  （宿主没有上报上下文分解，以上按字符估算，误差约 ±10%）", { dimColor: true }));
    }
  }
  rows.push(text(table, ""));
  const detail = sectionRows(table, columns, ["memory", "skills", "mcp", "agents", "slash"]);
  if (detail.length === 0) {
    rows.push(text(table, "明细（宿主未上报记忆/技能/MCP/子 Agent 定义）", { dimColor: true }));
  } else {
    rows.push(...detail);
  }
  return rows;
}

function trendRows(table, columns) {
  const rows = [];
  const steps = state.steps;
  if (steps.length === 0) {
    rows.push(text(table, "（本会话还没有完成一次模型请求）", { dimColor: true }));
  } else {
    const chart = trendChart(Math.min(columns - 2, 60));
    const color = levelColor(windowPercent(chart.last));
    for (const line of chart.rows) {
      rows.push(text(table, line, { color: color }));
    }
    if (chart.hasMarks) {
      rows.push(text(table, chart.marks, { color: "red" }));
    }
    rows.push(text(table, "窗口 " + human(chart.first) + " → " + human(chart.last) + " · 峰值 " + human(chart.peak) + (chart.hasMarks ? " · ▲ 压缩" : "")));
    rows.push(text(table, "请求 " + steps.length + " 次 · 缓存命中 " + cachePercentOf(steps) + "% · 输出累计 " + human(sumOf(steps, "output")), { dimColor: true }));
    const last = steps[steps.length - 1];
    rows.push(text(table, "最近 入 " + human(last.total) + "（读 " + human(last.cacheRead) + " / 写 " + human(last.cacheCreate) + "）· 出 " + human(last.output), { dimColor: true }));
    if (state.costUsd > 0) {
      rows.push(text(table, "成本 " + money(state.costUsd) + "（宿主上报）", { dimColor: true }));
    }
    if (state.rateLimits.length > 0) {
      rows.push(text(table, "额度 " + rateLimitText(), { dimColor: true }));
    }
    rows.push(text(table, ""));
    rows.push(text(table, "逐请求（新 → 旧）", { dimColor: true }));
    const recent = steps.slice(-8).reverse();
    for (const step of recent) {
      rows.push(text(table, requestLine(step), { dimColor: true }));
    }
  }
  rows.push(text(table, ""));
  rows.push(text(table, "压缩 " + compactionCount() + " 次", { dimColor: true }));
  if (state.compactions.length === 0) {
    rows.push(text(table, "  （还没有压缩）", { dimColor: true }));
  } else {
    for (const entry of state.compactions.slice(-6)) {
      rows.push(text(table, compactionLine(entry)));
    }
  }
  return rows;
}

function browserRows(table, columns) {
  const rows = [];
  const fileCount = Object.keys(state.files).length;
  const toolCount = Object.keys(state.tools).length;
  rows.push(text(table, "本会话 文件 " + fileCount + " 个 · 工具 " + toolCount + " 种" + (state.agentSteps > 0 ? "（含子代理）" : ""), { dimColor: true }));
  rows.push(...sectionRows(table, columns, ["files", "tools", "sections", "memory", "skills", "mcp", "agents"]));
  return rows;
}

function sectionRows(table, columns, ids) {
  const rows = [];
  const all = sections();
  for (const id of ids) {
    /** @type {any} */
    let definition = null;
    for (const candidate of all) {
      if (candidate.id === id) {
        definition = candidate;
      }
    }
    if (!definition) {
      continue;
    }
    let items = [];
    try {
      items = definition.items();
    } catch (error) {
      items = [];
    }
    if (items.length === 0) {
      continue;
    }
    const expanded = state.pane.expanded[id] === true;
    const label = (expanded ? "▾ " : "▸ ") + definition.title + " (" + items.length + ")";
    rows.push(sectionHeader(table, id, label, columns));
    if (expanded) {
      for (const item of items) {
        rows.push(text(table, "    " + clip(String(item), Math.max(8, columns - 4)), { dimColor: true }));
      }
    }
  }
  return rows;
}

function sectionHeader(table, id, label, columns) {
  const Button = table.Button;
  if (typeof Button !== "function") {
    return text(table, label, { dimColor: true });
  }
  return Button({
    key: "section:" + id,
    plain: true,
    onPress: () => {
      toggleSection(id);
    },
    children: clip(label, Math.max(8, columns - 1)),
  });
}

// A category list is either rows or a bare count, depending on the build. A
// count still belongs in the drill-down: "3 memory files" is the answer even when
// their paths are not reported.
function listItems(value, noun) {
  const rows = toArray(value);
  if (rows.length > 0) {
    return rows.map((item) => {
      if (item && typeof item === "object") {
        const label = item.path || item.name || item.agentType || "?";
        const extra = item.serverName ? String(item.serverName) + "/" : "";
        const detail = item.tokens === undefined ? "" : " · " + human(num(item.tokens));
        const note = item.type ? " (" + item.type + ")" : item.source ? " (" + item.source + ")" : item.isLoaded === false ? " (未加载)" : "";
        return extra + String(label) + detail + note;
      }
      return String(item);
    });
  }
  const count = num(value);
  return count > 0 ? [count + " " + noun] : [];
}

// skillItems reads both shapes the host has shipped: a list of frontmatter rows,
// and the plain totals a build reports when it does not enumerate them.
function skillItems(skills) {
  if (!skills) {
    return [];
  }
  const rows = toArray(skills.skillFrontmatter).map((skill) => String(skill.name || "?") + (skill.pluginName ? " [" + skill.pluginName + "]" : "") + " · " + human(num(skill.tokens)));
  if (rows.length > 0) {
    return rows;
  }
  const total = num(skills.total) || num(skills.totalSkills);
  if (total <= 0) {
    return [];
  }
  const included = num(skills.included) || num(skills.includedSkills);
  return ["共 " + total + " 个 · 计入上下文 " + included + " 个 · " + human(num(skills.tokens))];
}

// sections are the drill-down behind the totals: the individual memory files,
// skills, MCP tools, agents and prompt sections that make up a category.
function sections() {
  /** @type {any} */
  const breakdown = state.breakdown || {};
  return [
    {
      id: "memory",
      title: "记忆文件",
      items: () => listItems(breakdown.memoryFiles, "个记忆文件"),
    },
    {
      id: "skills",
      title: "技能",
      items: () => skillItems(breakdown.skills),
    },
    {
      id: "mcp",
      title: "MCP 工具",
      items: () => listItems(breakdown.mcpTools, "个 MCP 工具"),
    },
    {
      id: "agents",
      title: "子 Agent 定义",
      items: () => listItems(breakdown.agents, "个子 Agent 定义"),
    },
    {
      id: "slash",
      title: "斜杠命令",
      items: () => {
        const slash = breakdown.slashCommands;
        if (!slash) {
          return [];
        }
        return ["共 " + num(slash.totalCommands) + " 个 · 计入上下文 " + num(slash.includedCommands) + " 个 · " + human(num(slash.tokens))];
      },
    },
    {
      id: "sections",
      title: "提示词分段",
      items: () => Object.keys(state.sections).sort((a, b) => state.sections[b] - state.sections[a]).map((name) => name + " · " + human(state.sections[name])),
    },
    {
      id: "files",
      title: "文件",
      items: () => topEntries(state.files, 20, (count) => count).map(([path, count]) => String(path) + " ×" + count),
    },
    {
      id: "tools",
      title: "工具",
      items: () => topEntries(state.tools, 20, (entry) => entry.n).map(([name, entry]) => String(name) + " " + entry.n + " 次 · 平均 " + humanDuration(Math.round(entry.ms / Math.max(1, entry.n))) + (entry.errors > 0 ? " · " + entry.errors + " 失败" : "")),
    },
  ];
}

// ---------------------------------------------------------------- band/dash

function bandView(table, columns) {
  const Box = table.Box;
  const Text = table.Text;
  const Button = table.Button;
  const last = state.steps[state.steps.length - 1];
  // Prefer the reading the host reported: it covers everything in the window,
  // while a request's own total only covers what that request carried.
  const current = state.tokens > 0 ? state.tokens : last.total;
  const percent = windowPercent(current);
  const color = levelColor(percent);
  const previous = state.steps.length > 1 ? state.steps[state.steps.length - 2].total : 0;
  const delta = previous > 0 ? last.total - previous : 0;

  const parts = [];
  parts.push(Text({ color: color, bold: true, children: "◧ " + percent + "%" }));
  if (columns >= 40) {
    parts.push(Text({ dimColor: true, children: "  " + human(current) + " / " + human(state.window) }));
  }
  if (columns >= 58 && previous > 0) {
    parts.push(Text({ dimColor: true, children: "  " + (delta >= 0 ? "+" : "-") + human(Math.abs(delta)) }));
  }
  if (columns >= 58) {
    const counts = agentCounts();
    if (counts.running > 0) {
      parts.push(Text({ color: "cyan", children: "  ⟳" + counts.running }));
    }
  }
  if (columns >= 76) {
    parts.push(Text({ dimColor: true, children: "  cache " + cachePercent(last) + "%" }));
    parts.push(Text({ color: color, children: "  " + bar(percent, 100, 8) }));
  }
  if (typeof Button === "function" && columns >= 96) {
    parts.push(
      Button({
        key: "open-pane",
        hotkey: "c",
        plain: true,
        dimColor: true,
        onPress: () => {
          void openPane();
        },
        children: "  详情",
      }),
    );
  }
  return Box({ flexDirection: "row", paddingX: 1, children: parts });
}

function renderDashboard() {
  const lines = [];
  const last = state.steps.length ? state.steps[state.steps.length - 1] : null;
  const current = currentTokens();
  const window = state.window;

  lines.push("CC-Context · 上下文透视");
  lines.push(DASH_RULE);

  const percent = windowPercent(current);
  const left = Math.max(0, window - current);
  lines.push("窗口   " + human(current) + " / " + human(window) + "   " + pad(percent, 3) + "%   剩余 " + human(left));

  if (last) {
    lines.push("请求   " + state.steps.length + " 次 · 缓存命中 " + cachePercentOf(state.steps) + "% · 输出累计 " + human(sumOf(state.steps, "output")));
    if (state.persist.restored > 0) {
      lines.push("       其中 " + state.persist.restored + " 次从快照恢复（保存于 " + new Date(state.persist.restoredAt).toISOString().slice(11, 19) + "，重载前）");
    }
    lines.push("最近   入 " + human(last.total) + "（读 " + human(last.cacheRead) + " / 写 " + human(last.cacheCreate) + "）· 出 " + human(last.output));
  } else if (current > 0) {
    // A resumed session: the window is the host's reading of the conversation
    // it reopened, but this run has not asked the model anything yet.
    lines.push("请求   本次运行还没有发起模型请求（窗口与组成是宿主按恢复的会话算的）");
  } else {
    lines.push("请求   本会话还没有完成一次模型请求");
  }

  lines.push("");
  const breakdown = state.breakdown;
  if (breakdown && Array.isArray(breakdown.categories)) {
    lines.push("组成（宿主精确上报，单位 token）");
    const model = compositionModel(breakdown, current);
    const { windowSize, used, room, deferred } = model;
    lines.push("  " + dashBar(model, DASH_BAR_WIDTH) + "   █ 已用  ▒ 缓冲  ░ 空余");
    // Each category's bar is its share of the window, biggest first; a tiny one
    // still shows a sliver, so "1% of the window" reads as small, not as absent.
    const bySize = used.slice().sort((a, b) => num(b.tokens) - num(a.tokens));
    for (const category of bySize) {
      const tokens = num(category.tokens);
      const share = windowSize > 0 ? Math.round((tokens / windowSize) * 100) : 0;
      lines.push("  " + padRight(clip(String(category.name || "?"), 22), 22) + " " + eighthBar(tokens, windowSize, DASH_ROW_BAR) + " " + pad(human(tokens), 6) + " " + pad(share, 3) + "%");
    }
    if (room.length > 0) {
      lines.push("  空余 " + room.map((category) => String(category.name || "?") + " " + human(num(category.tokens))).join(" · "));
    }
    if (deferred.length > 0) {
      lines.push("  未加载 " + deferred.map((category) => String(category.name || "?") + " " + human(num(category.tokens))).join(" · "));
    }
    const extras = [
      { label: "记忆文件", count: countOf(breakdown.memoryFiles) },
      { label: "技能", count: countOf(breakdown.skills && breakdown.skills.skillFrontmatter) || num(breakdown.skills && breakdown.skills.included) || num(breakdown.skills && breakdown.skills.includedSkills) },
      { label: "MCP 工具", count: countOf(breakdown.mcpTools) },
      // "定义" keeps this apart from the formation below, which counts running agents.
      { label: "子 Agent 定义", count: countOf(breakdown.agents) },
    ].filter((entry) => entry.count > 0);
    if (extras.length > 0) {
      lines.push("明细   " + extras.map((entry) => entry.label + " " + entry.count).join(" · ") + "   （/ccx panel 展开逐项）");
    }
  } else {
    lines.push("组成 ≈（总量精确，拆分按字符估算）");
    const buckets = composition(state.messages, current);
    if (buckets.length === 0) {
      lines.push("  （拿不到会话消息，暂无拆分）");
    } else {
      const top = Math.max.apply(null, buckets.map((bucket) => bucket.tokens));
      for (const bucket of buckets) {
        const share = current > 0 ? Math.round((bucket.tokens / current) * 100) : 0;
        lines.push("  " + padRight(bucket.label, 14) + bar(bucket.tokens, top, BAR_WIDTH) + " " + pad(human(bucket.tokens), 6) + " " + pad(share, 3) + "%");
      }
    }
  }

  lines.push("");
  lines.push("趋势");
  const recent = state.steps.slice(-20);
  if (recent.length === 0) {
    lines.push("  （暂无请求）");
  } else {
    const chart = trendChart(Math.min(DASH_BAR_WIDTH, Math.max(MIN_TREND_COLUMNS, state.steps.length)));
    for (const line of chart.rows) {
      lines.push("  " + line);
    }
    if (chart.hasMarks) {
      lines.push("  " + chart.marks);
    }
    lines.push("  " + human(chart.first) + " → " + human(chart.last) + " · 峰值 " + human(chart.peak) + (chart.hasMarks ? " · ▲ 压缩" : ""));
  }

  const agents = agentRows();
  if (agents.length > 0) {
    lines.push("");
    lines.push("编队     " + agentSummary());
    for (const entry of agents.slice(-5)) {
      lines.push(agentLine(entry, 84));
    }
  }

  const tools = topEntries(state.tools, 5, (entry) => entry.n);
  if (tools.length > 0) {
    lines.push("");
    lines.push("工具" + (state.agentSteps > 0 ? "（含子代理）" : ""));
    const parts = tools.map(([name, entry]) => {
      const avg = entry.n > 0 ? Math.round(entry.ms / entry.n) : 0;
      const failed = entry.errors > 0 ? " (" + entry.errors + " 失败)" : "";
      return shortTool(name) + " " + entry.n + " · " + humanDuration(avg) + failed;
    });
    lines.push("  " + parts.join("   "));
  }

  const files = topEntries(state.files, 4, (count) => count);
  if (files.length > 0) {
    lines.push("");
    lines.push("文件");
    lines.push("  " + files.map(([path, count]) => tail(path) + " ×" + count).join(" · "));
  }

  const events = ["压缩 " + compactionCount()];
  if (state.agentSteps > 0) {
    events.push("子代理请求 " + state.agentSteps);
  }
  lines.push("");
  lines.push("事件   " + events.join(" · "));
  for (const entry of state.compactions.slice(-3)) {
    lines.push("       " + compactionLine(entry).trim());
  }

  if (state.rateLimits.length > 0) {
    lines.push("额度   " + rateLimitText());
  }
  if (state.costUsd > 0) {
    lines.push("成本   " + money(state.costUsd) + "（宿主上报）");
  }

  lines.push("");
  if (breakdown) {
    lines.push("精度   窗口/成本/额度/上下文分解均取自宿主上报；工具耗时来自本地计时");
  } else {
    lines.push("精度   窗口/缓存/输出取自服务商上报；组成按字符估算，误差约 ±10%");
  }
  return lines.join("\n");
}

// composition returns the rows of the stacked bar, largest first. The total is
// exact; each row is an estimate, and whatever the estimates cannot explain is
// reported as 未归因 rather than spread across the rows. It is only used when
// the host reports no breakdown of its own.
function composition(messages, current) {
  const parts = [];
  const byRole = classifyMessages(messages);
  let sectionTokens = 0;
  for (const name of Object.keys(state.sections)) {
    sectionTokens += state.sections[name];
  }

  if (sectionTokens > 0) {
    parts.push({ label: "系统提示词", tokens: sectionTokens });
  }
  if (byRole.user > 0) {
    parts.push({ label: "用户消息", tokens: byRole.user });
  }
  if (byRole.assistant > 0) {
    parts.push({ label: "助手回复", tokens: byRole.assistant });
  }
  if (byRole.results > 0) {
    parts.push({ label: "工具结果", tokens: byRole.results });
  }
  if (parts.length === 0) {
    return [];
  }

  let accounted = 0;
  for (const part of parts) {
    accounted += part.tokens;
  }
  const rest = current - accounted;
  if (rest > 0) {
    // System prompt sections and tool schemas are the usual occupants here;
    // name it honestly instead of guessing a split.
    parts.push({ label: "未归因", tokens: rest });
  }
  parts.sort((a, b) => b.tokens - a.tokens);
  return parts;
}

function classifyMessages(messages) {
  const result = { user: 0, assistant: 0, results: 0 };
  if (!Array.isArray(messages)) {
    return result;
  }
  for (const message of messages) {
    if (!message) {
      continue;
    }
    const role = String(message.role || "").toLowerCase();
    const text = typeof message.text === "string" ? message.text : "";
    let tokens = estimateTokens(text);
    if (Array.isArray(message.toolUses)) {
      for (const use of message.toolUses) {
        try {
          tokens += estimateTokens(JSON.stringify(use || {}));
        } catch (error) {
          // A tool use that cannot be serialized adds nothing.
        }
      }
    }
    if (role === "tool" || role === "tool_result" || role === "tool-result") {
      result.results += tokens;
    } else if (role === "assistant") {
      result.assistant += tokens;
    } else {
      result.user += tokens;
    }
  }
  return result;
}

function dumpProbe() {
  const breakdown = state.breakdown;
  const payload = {
    note: "CC-Context probe: paste this into an issue when a number looks wrong",
    version: 2,
    at: new Date().toISOString(),
    window: state.window,
    tokens: state.tokens,
    percent: state.percent,
    steps: state.steps.slice(-10),
    stepCount: state.steps.length,
    agentSteps: state.agentSteps,
    persist: { status: state.persist.status, path: state.persist.key ? persistPath(state.persist.key) : "", restored: state.persist.restored, savedAt: state.persist.savedAt },
    agentList: {
      state: state.agentListState,
      entries: Object.keys(state.agentInfo).map((id) => {
        const info = state.agentInfo[id].info;
        return {
          id: id,
          name: info.name,
          label: info.label,
          type: info.type,
          kind: info.kind,
          status: info.status,
          taskStatus: info.taskStatus,
          parentId: info.parentId,
          spawnedBy: info.spawnedBy,
        };
      }),
    },
    launches: state.launches.slice(-10).map((launch) => ({
      tool: launch.tool,
      toolUseId: launch.toolUseId,
      name: launch.name,
      type: launch.type,
      spawnType: launch.spawn ? launch.spawn.type : "",
      agentId: launch.agentId,
      done: launch.doneAt > 0,
    })),
    compactions: compactionCount(),
    compactionLog: state.compactions.slice(-10),
    sections: Object.keys(state.sections).map((name) => ({ name: name, tokens: state.sections[name] })),
    tools: Object.keys(state.tools).map((name) => ({ name: name, n: state.tools[name].n, errors: state.tools[name].errors })),
    costUsd: state.costUsd,
    rateLimits: state.rateLimits,
    agents: agentRows().map((entry) => ({
      id: entry.row ? entry.row.id : (entry.launch && entry.launch.agentId) || null,
      status: entry.status,
      steps: entry.row ? entry.row.steps : 0,
      calls: entry.row ? entry.row.calls : 0,
      errors: entry.row ? entry.row.errors : 0,
      tokens: entry.row ? entry.row.tokens : 0,
      lastTool: entry.row ? entry.row.lastTool : "",
      lastSubject: entry.row ? entry.row.lastSubject : "",
      launch: entry.launch
        ? { tool: entry.launch.tool, type: entry.launch.type, description: entry.launch.description, isError: entry.launch.isError }
        : null,
    })),
    breakdown: breakdown
      ? {
          totalTokens: breakdown.totalTokens,
          maxTokens: breakdown.maxTokens,
          percentage: breakdown.percentage,
          autocompactThreshold: breakdown.autocompactThreshold,
          isAutoCompactEnabled: breakdown.isAutoCompactEnabled,
          categories: toArray(breakdown.categories).map((category) => ({ name: category.name, tokens: category.tokens, kind: category.kind, isDeferred: category.isDeferred })),
          memoryFiles: countOf(breakdown.memoryFiles),
          skills: breakdown.skills
            ? { total: num(breakdown.skills.total) || num(breakdown.skills.totalSkills), included: num(breakdown.skills.included) || num(breakdown.skills.includedSkills), tokens: breakdown.skills.tokens }
            : null,
          mcpTools: countOf(breakdown.mcpTools),
          agents: countOf(breakdown.agents),
          apiUsage: breakdown.apiUsage || null,
        }
      : null,
    usageSample: state.usage,
    messagesSample: Array.isArray(state.messages) ? state.messages.slice(-3).map(shapeOfMessage) : [],
  };
  let text;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch (error) {
    text = JSON.stringify({ error: String((/** @type {any} */ (error) || {}).message) });
  }
  return text.length > 12000 ? text.slice(0, 12000) + "\n…（已截断）" : text;
}

function shapeOfMessage(message) {
  if (!message || typeof message !== "object") {
    return { type: typeof message };
  }
  const shape = {};
  for (const key of Object.keys(message)) {
    const value = message[key];
    if (typeof value === "string") {
      shape[key] = value.length > 120 ? value.slice(0, 120) + "…(" + value.length + " chars)" : value;
    } else if (Array.isArray(value)) {
      shape[key] = "array[" + value.length + "]";
    } else if (value && typeof value === "object") {
      shape[key] = "object";
    } else {
      shape[key] = value;
    }
  }
  return shape;
}

// ------------------------------------------------------------------ helpers

function currentTokens() {
  if (state.breakdown && num(state.breakdown.totalTokens) > 0) {
    return num(state.breakdown.totalTokens);
  }
  if (state.tokens > 0) {
    return state.tokens;
  }
  return state.steps.length ? state.steps[state.steps.length - 1].total : 0;
}

function rateLimitText() {
  const names = { five_hour: "5h", seven_day: "7d", spend_limit: "额度" };
  return state.rateLimits
    .map((limit) => {
      const name = names[limit.kind] || String(limit.kind || "?");
      return name + " " + Math.round(num(limit.percentUsed)) + "%";
    })
    .join(" · ");
}

function requestLine(step) {
  const when = new Date(step.at).toISOString().slice(11, 19);
  const model = (step.model || "?").replace(/^claude-/, "").replace(/-\d{8}$/, "").slice(0, 18);
  return "  " + when + "  " + padRight(model, 18) + " 入 " + pad(human(step.total), 6) + " 出 " + pad(human(step.output), 5) + " 读 " + human(step.cacheRead);
}

function compactionLine(entry) {
  const when = new Date(entry.at).toISOString().slice(11, 19);
  const drop = entry.before > 0 ? Math.round(((entry.before - entry.after) / entry.before) * 100) : 0;
  return "  " + when + "  " + human(entry.before) + " → " + human(entry.after) + "  -" + Math.max(0, drop) + "%" + (entry.source === "inferred" ? " （推断）" : "");
}

function barLine(label, tokens, max, total, columns) {
  const share = total > 0 ? Math.round((tokens / total) * 100) : 0;
  const tail = pad(human(tokens), 7) + " " + pad(share + "%", 4);
  const room = Math.max(0, columns - 2 - tail.length);
  const barWidth = room >= 18 ? Math.min(12, room - 12) : 0;
  const labelWidth = Math.max(8, Math.min(22, room - barWidth - (barWidth > 0 ? 1 : 0)));
  const gap = Math.max(1, room - barWidth - labelWidth - (barWidth > 0 ? 1 : 0));
  const barCell = barWidth > 0 ? bar(tokens, max, barWidth) + " " : "";
  return "  " + barCell + padRight(clip(label, labelWidth), labelWidth) + " ".repeat(gap) + tail;
}

function text(table, value, props) {
  const Text = table.Text;
  const merged = props && typeof props === "object" ? props : {};
  return Text(Object.assign({}, merged, { children: String(value == null ? "" : value) }));
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

// countOf reads a field the host reports either as a list or as a count.
function countOf(value) {
  return Array.isArray(value) ? value.length : Math.max(0, Math.round(num(value)));
}

// The host kinds its own categories: "used" is in the window, "free" and
// "buffer" are room the window has yet to fill, and "deferred" is a tool
// definition that is declared but not loaded. We trust the kind and fall back to
// the name only for an older build that does not report one.
function categoryKind(category) {
  const kind = String((category && category.kind) || "");
  if (kind) {
    return kind;
  }
  const name = String((category && category.name) || "");
  if (/free|空闲/i.test(name)) {
    return "free";
  }
  if (/buffer|缓冲/i.test(name)) {
    return "buffer";
  }
  return "used";
}

function isRoom(category) {
  const kind = categoryKind(category);
  return kind === "free" || kind === "buffer";
}

function isDeferredCategory(category) {
  return categoryKind(category) === "deferred" || (category && category.isDeferred === true);
}

function sumOf(steps, field) {
  let total = 0;
  for (const step of steps) {
    total += num(step[field]);
  }
  return total;
}

function cachePercentOf(steps) {
  let cacheRead = 0;
  let rest = 0;
  for (const step of steps) {
    cacheRead += step.cacheRead;
    rest += step.cacheRead + step.cacheCreate + step.input;
  }
  return rest > 0 ? Math.round((cacheRead / rest) * 100) : 0;
}

function windowPercent(tokens) {
  if (!state.window || state.window <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((tokens / state.window) * 100)));
}

// money keeps a sub-cent cost from rounding away to $0.00: a session that
// spent a third of a cent did not spend nothing.
function money(usd) {
  const value = num(usd);
  return "$" + (value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2));
}

function cachePercent(step) {
  if (!step) {
    return 0;
  }
  const denom = step.cacheRead + step.cacheCreate + step.input;
  return denom > 0 ? Math.round((step.cacheRead / denom) * 100) : 0;
}

function topEntries(map, limit, weightOf) {
  return Object.keys(map)
    .map((key) => [key, map[key]])
    .sort((a, b) => weightOf(b[1]) - weightOf(a[1]))
    .slice(0, limit);
}

function shortTool(name) {
  const raw = String(name || "unknown");
  return raw.length > 14 ? raw.slice(0, 13) + "…" : raw;
}

function tail(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : String(path);
  return last.length > 18 ? last.slice(0, 17) + "…" : last;
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

// clip cuts by display width, so a Chinese label cannot push a row past the pane.
function clip(value, width) {
  const source = String(value == null ? "" : value);
  let used = 0;
  let out = "";
  for (const char of source) {
    const size = charWidth(char.codePointAt(0) || 0);
    if (used + size > Math.max(1, width)) {
      return out.length > 0 ? out.slice(0, Math.max(0, out.length - 1)) + "…" : "…";
    }
    used += size;
    out += char;
  }
  return out;
}

function num(value) {
  return typeof value === "number" && isFinite(value) ? value : 0;
}
