// Drives the mod with a fake host: no Claude Code needed, but every hook runs
// through the same code path the real host would take.
//
// The fake host keeps two shapes of registration: on(name, handler) and
// on(name, matcher, handler), and mirrors the event contracts the mod relies on:
//   turn.step   next() is an async generator, its return value carries .usage
//   ui.render   $.ui.resolve(event) hands back Box and Text

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../hooks/cc-context.mjs";

function createHost(options = {}) {
  const plain = new Map();
  const matched = [];
  const on = (name, a, b) => {
    if (typeof a === "function") {
      plain.set(name, a);
    } else {
      matched.push({ name: name, matcher: a || {}, handler: b });
    }
  };

  const commands = [];
  const $ = {
    command: {
      register: async (definition) => {
        commands.push(definition);
      },
    },
    session: {
      usage: async () => ({
        ...(options.startedAt ? { startedAt: options.startedAt } : {}),
        context: {
          tokens: 84000,
          window: 200000,
          percent: 42,
          ...(options.breakdown ? { breakdown: options.breakdown } : {}),
        },
      }),
      messages: async () => {
        options.messageReads = (options.messageReads || 0) + 1;
        return [
          { role: "user", text: "add a test for the estimator" },
          { role: "assistant", text: "Sure.", toolUses: [{ name: "Read", input: { file_path: "src/app.ts" } }] },
          { role: "tool", text: "export function add(a, b) { return a + b }" },
        ];
      },
    },
    fs: options.files
      ? {
          read: async (path) => {
            if (!options.files.has(path)) {
              throw new Error("ENOENT " + path);
            }
            return options.files.get(path);
          },
          write: async (path, text) => {
            if (options.failWrites) {
              throw new Error("EACCES");
            }
            options.writes = (options.writes || 0) + 1;
            options.files.set(path, text);
          },
        }
      : undefined,
    ui: {
      resolve: () => ({
        Box: (props) => ({ type: "Box", props: props }),
        Text: (props) => ({ type: "Text", props: props }),
      }),
      invalidate: () => {},
    },
  };

  const host = {
    commands: commands,
    async fire(name, event, next) {
      const handler = plain.get(name);
      if (handler) {
        return handler($, event, next);
      }
      // command.run is registered with a matcher, so fall back to the first
      // matched hook for that event.
      const entry = matched.find((item) => item.name === name);
      assert.ok(entry, `no hook registered for ${name}`);
      return entry.handler($, event, next);
    },
    async fireMatched(name, matcherValue, event, next) {
      const entry = matched.find((item) => item.name === name && item.matcher.component === matcherValue);
      assert.ok(entry, `no ${name} hook registered for component ${matcherValue}`);
      return entry.handler($, event, next);
    },
    // turn.step is an async generator: the caller has to drain it, which is what
    // the host does while streaming a response.
    fireStream(name, event, next) {
      const handler = plain.get(name);
      assert.ok(handler, `no hook registered for ${name}`);
      return handler($, event, next);
    },
  };
  return { on, host };
}

test("the mod collects a turn, then renders the dashboard and the band", async () => {
  const { on, host } = createHost();
  register(on);
  assert.equal(host.commands.length, 0, "commands are registered on session.start, not at load");

  const passThrough = async (event) => event;
  await host.fire("session.start", { session_id: "sess-1" }, passThrough);
  assert.equal(host.commands.length, 1);
  assert.equal(host.commands[0].name, "ccx");

  // One request with tool calls, reported the way turn.step reports it.
  const request = async function* () {
    yield { type: "text_delta", text: "Sure." };
    return { usage: { input_tokens: 200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 90 } };
  };
  for await (const chunk of host.fireStream("turn.step", { turnId: "t1", model: "claude-sonnet-4-5" }, request)) {
    assert.equal(chunk.type, "text_delta");
  }

  // One tool call, which records the name, the duration and the file.
  await host.fire("tool.call", { tool: "Read", file_path: "src/app.ts" }, async () => ({ isError: false }));

  const dashboard = await host.fire("command.run", { args: "" }, passThrough);
  assert.match(dashboard.text, /窗口   84k \/ 200k/);
  assert.match(dashboard.text, /请求   1 次/);
  assert.match(dashboard.text, /缓存命中 98%/);
  assert.match(dashboard.text, /未归因/);
  assert.match(dashboard.text, /Read 1/);
  assert.match(dashboard.text, /app\.ts ×1/);
  assert.match(dashboard.text, /±10%/);

  // The band is off by default now; ask for it the way a person would.
  const enabled = await host.fire("command.run", { args: "on" }, passThrough);
  assert.match(enabled.text, /已开启/);
  const band = await host.fireMatched("ui.render", "AbovePrompt", { props: { bodyColumns: 100, hasSurvey: false } }, passThrough);
  assert.equal(band.type, "Box");
  const percentCell = band.props.children.find((child) => String(child.props.children).includes("%"));
  assert.ok(percentCell, "the band shows a percentage");
  assert.equal(percentCell.props.children, "◧ 42%");

  // /ccx off hides the band; ui.render then defers to the host.
  const off = await host.fire("command.run", { args: "off" }, passThrough);
  assert.match(off.text, /已关闭/);
  const deferred = await host.fireMatched("ui.render", "AbovePrompt", { props: { bodyColumns: 100, hasSurvey: false } }, async () => "host-default");
  assert.equal(deferred, "host-default");
});

test("the probe reports what the host actually handed over", async () => {
  const { on, host } = createHost();
  register(on);
  await host.fire("session.start", { session_id: "sess-2" }, async (event) => event);
  const probe = await host.fire("command.run", { args: "json" }, async (event) => event);
  const payload = JSON.parse(probe.text);
  assert.equal(payload.window, 200000);
  assert.equal(payload.stepCount, 0);
  assert.equal(payload.messagesSample.length, 3);
  assert.equal(payload.messagesSample[0].role, "user");
});

test("a PreCompact and the step after it make one before/after pair", async () => {
  const { on, host } = createHost();
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", { session_id: "sess-3" }, passThrough);

  const first = async function* () {
    yield { kind: "text", index: 0, text: "a" };
    return {
      turnId: "t1",
      index: 0,
      answer: "a",
      toolUses: [],
      usage: { input_tokens: 200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 90 },
    };
  };
  for await (const _chunk of host.fireStream("turn.step", { turnId: "t1", index: 0, model: "claude-sonnet-4-5" }, first)) {
    // drain
  }

  // The hook names the moment; the fake host's usage reading (84k) is the window
  // it happened at, and the next step reports the window afterwards.
  await host.fire("classic.PreCompact", {}, passThrough);

  const second = async function* () {
    yield { kind: "text", index: 1, text: "b" };
    return {
      turnId: "t1",
      index: 1,
      answer: "b",
      toolUses: [],
      usage: { input_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 20 },
    };
  };
  for await (const _chunk of host.fireStream("turn.step", { turnId: "t1", index: 1, model: "claude-sonnet-4-5" }, second)) {
    // drain
  }

  const dashboard = await host.fire("command.run", { args: "" }, passThrough);
  assert.match(dashboard.text, /压缩 1/);
  assert.match(dashboard.text, /84k → 2k/);
  assert.doesNotMatch(dashboard.text, /（推断）/, "the hook named it, so nothing is inferred");
});

test("a section announced twice counts once", async () => {
  const { on, host } = createHost();
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  const text = "x".repeat(400);
  await host.fire("prompt.section", { name: "memory", text }, passThrough);
  await host.fire("prompt.section", { name: "memory", text }, passThrough);
  const probe = JSON.parse((await host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.equal(probe.sections.find((s) => s.name === "memory").tokens, 100);
});

test("the Agent result's agentId pairs a launch exactly, and async launches stay running", async () => {
  const { on, host } = createHost();
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  // Async launch returns at once with the child's id.
  await host.fire("tool.call", { tool: "Agent", subagent_type: "Explore", description: "look" }, async () => ({
    status: "async_launched",
    agentId: "a-9",
  }));
  // The child's first event arrives after the parent call returned.
  await host.fire("tool.call", { tool: "Read", file_path: "x.ts", agentId: "a-9" }, async () => ({ isError: false }));
  const probe = JSON.parse((await host.fire("command.run", { args: "json" }, passThrough)).text);
  const row = probe.agents.find((a) => a.id === "a-9");
  assert.ok(row, "the child has a row");
  assert.equal(row.launch.type, "Explore", "paired by the result's id, after the call returned");
  assert.equal(row.status, "running");
});

test("a subagent's own Agent call nests the grandchild under it", async () => {
  const { on, host } = createHost();
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  // Two roots, launched asynchronously so the result names the child at once.
  await host.fire("tool.call", { tool: "Agent", subagent_type: "Plan", description: "plan the work" }, async () => ({ status: "async_launched", agentId: "p-1" }));
  await host.fire("tool.call", { tool: "Agent", subagent_type: "Explore", description: "look around" }, async () => ({ status: "async_launched", agentId: "p-2" }));
  // The first root spawns two children, and the first of those spawns one more.
  await host.fire("tool.call", { tool: "Agent", subagent_type: "Explore", description: "dig one", agentId: "p-1" }, async () => ({ status: "async_launched", agentId: "g-1" }));
  await host.fire("tool.call", { tool: "Agent", subagent_type: "Explore", description: "dig two", agentId: "p-1" }, async () => ({ status: "async_launched", agentId: "g-2" }));
  await host.fire("tool.call", { tool: "Agent", subagent_type: "Explore", description: "sweep", agentId: "g-1" }, async () => ({ status: "async_launched", agentId: "gg-1" }));
  await host.fire("tool.call", { tool: "Grep", pattern: "x", agentId: "gg-1" }, async () => ({ isError: false }));

  const probe = JSON.parse((await host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.deepEqual(probe.agents.map((a) => a.id), ["p-1", "g-1", "gg-1", "g-2", "p-2"], "the tree order is parent, its subtree, then the next root");

  const lines = (await host.fire("command.run", { args: "agents" }, passThrough)).text.split("\n");
  assert.match(lines[1], /^ {4}● Plan/, "a root draws no branch of its own (the command output has no fold control)");
  assert.match(lines[2], /^ {2}├─ {3}● Explore/, "a child with a sibling below it draws ├─");
  assert.match(lines[3], /^ {2}│ {2}└─ {3}● Explore/, "a leaf keeps the trunk of the level above");
  assert.match(lines[4], /^ {2}└─ {3}● Explore/, "the last leaf draws └─");
  assert.match(lines[5], /^ {4}● Explore/, "the second root starts a new trunk");
  assert.match(lines[3], /sweep/, "the grandchild's own purpose is on its row");
  assert.match(lines[2], /dig one/, "the child's purpose is on its row");
});
test("the compaction mark sits under the drop even when every request lands in the same millisecond", async () => {
  const { on, host } = createHost();
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  const windows = [20000, 30000, 40000, 50000, 60000, 70000, 20000, 30000, 40000, 50000];
  let index = 0;
  for (const total of windows) {
    const request = async function* () {
      return { usage: { input_tokens: 0, cache_read_input_tokens: total, cache_creation_input_tokens: 0, output_tokens: 10 } };
    };
    for await (const _chunk of host.fireStream("turn.step", { turnId: "t", index: index++, model: "m" }, request)) {
      // drain
    }
  }
  const lines = (await host.fire("command.run", { args: "" }, passThrough)).text.split("\n");
  const marks = lines.find((line) => /^ +▲ *$/.test(line));
  assert.ok(marks, "a marker row under the chart");
  const column = marks.indexOf("▲") - 2;
  // 10 requests over the 24-column minimum chart: the bars thicken to 2 cells, so
  // the drop (the 7th request, index 6) owns columns 12 and 13, and the mark is
  // centred on the bar rather than at the line's old proportional position.
  assert.ok(column >= 12 && column <= 13, "the mark sits on the bar of the request that showed the drop, got " + column);
});


// ---- persistence: a reload or a resume keeps the history of the same session

async function runTurns(host, totals) {
  const passThrough = async (event) => event;
  let index = 0;
  for (const total of totals) {
    const request = async function* () {
      return { usage: { input_tokens: 0, cache_read_input_tokens: total, cache_creation_input_tokens: 0, output_tokens: 10 } };
    };
    for await (const _chunk of host.fireStream("turn.step", { turnId: "t", index: index++, model: "m" }, request)) {
      // drain
    }
  }
  await host.fire("tool.call", { tool: "Read", file_path: "src/app.ts" }, async () => ({ isError: false }));
  await host.fire("turn.complete", {}, passThrough);
}

test("a session's history survives a reload and is shown as restored", async () => {
  const files = new Map();
  const passThrough = async (event) => event;

  const first = createHost({ startedAt: 1700000000000, files });
  register(first.on);
  await first.host.fire("session.start", {}, passThrough);
  await runTurns(first.host, [20000, 30000, 40000]);
  const slot = [...files.keys()].find((name) => /^\.claude\/cc-context\/slot-\d\.json$/.test(name));
  assert.ok(slot, "a snapshot slot was written: " + [...files.keys()].join(", "));
  assert.equal(files.get(".claude/cc-context/.gitignore"), "*\n", "the directory ignores itself");

  // A reload: a new process, the same session (same start time), nothing in memory.
  const second = createHost({ startedAt: 1700000000000, files });
  register(second.on);
  await second.host.fire("session.start", {}, passThrough);
  const dashboard = (await second.host.fire("command.run", { args: "" }, passThrough)).text;
  assert.match(dashboard, /请求   3 次/, "the three requests are back");
  assert.match(dashboard, /其中 3 次从快照恢复/);
  assert.match(dashboard, /Read 1/, "tool tallies come back too");
  assert.match(dashboard, /app\.ts ×1/);
  const probe = JSON.parse((await second.host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.equal(probe.persist.status, "restored");

  // New requests continue the history instead of starting over.
  await runTurns(second.host, [50000]);
  const after = JSON.parse((await second.host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.equal(after.stepCount, 4);
});

test("a restored session writes the snapshot, not the ignore file again", async () => {
  const files = new Map();
  const passThrough = async (event) => event;
  const first = createHost({ startedAt: 1700000000000, files });
  register(first.on);
  await first.host.fire("session.start", {}, passThrough);
  await runTurns(first.host, [20000]);

  const options = { startedAt: 1700000000000, files };
  const second = createHost(options);
  register(second.on);
  await second.host.fire("session.start", {}, passThrough);
  const before = options.writes || 0;
  await runTurns(second.host, [30000]);
  assert.equal((options.writes || 0) - before, 1, "one turn is one write: the snapshot only");
});

test("a host that reports a breakdown is not asked for the conversation", async () => {
  const options = {
    startedAt: 1700000000000,
    files: new Map(),
    breakdown: { categories: [{ name: "Messages", tokens: 38000, kind: "used" }], totalTokens: 38000, maxTokens: 200000 },
  };
  const host = createHost(options);
  register(host.on);
  const passThrough = async (event) => event;
  await host.host.fire("session.start", {}, passThrough);
  await runTurns(host.host, [20000, 30000]);
  assert.equal(options.messageReads || 0, 0, "the exact breakdown makes the message copy unnecessary");
});

test("a snapshot from another conversation is not taken", async () => {
  const files = new Map();
  const passThrough = async (event) => event;
  const first = createHost({ startedAt: 1700000000000, files });
  register(first.on);
  await first.host.fire("session.start", {}, passThrough);
  await runTurns(first.host, [20000, 30000]);

  // Same slot (start times a multiple of 8 s apart), different session.
  const other = createHost({ startedAt: 1700000000000 + 8000 * 3, files });
  register(other.on);
  await other.host.fire("session.start", {}, passThrough);
  const probe = JSON.parse((await other.host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.equal(probe.stepCount, 0, "nothing carried over");
  assert.equal(probe.persist.status, "ready");
});

test("a damaged or foreign snapshot is ignored without an error", async () => {
  const passThrough = async (event) => event;
  const key = 1700000000000;
  const path = ".claude/cc-context/slot-" + (Math.floor(key / 1000) % 8) + ".json";
  for (const content of ["{not json", "[]", JSON.stringify({ version: 99, startedAt: key, steps: [{ total: 1 }] }), JSON.stringify({ version: 1, startedAt: key, steps: [{ total: "x" }, null, 7], tools: { Read: "bad" } })]) {
    const files = new Map([[path, content]]);
    const { on, host } = createHost({ startedAt: key, files });
    register(on);
    await host.fire("session.start", {}, passThrough);
    const probe = JSON.parse((await host.fire("command.run", { args: "json" }, passThrough)).text);
    assert.equal(probe.stepCount, 0, "kept clean for " + content.slice(0, 24));
  }
});

test("a write that fails turns saving off instead of failing the turn", async () => {
  const files = new Map();
  const options = { startedAt: 1700000000000, files, failWrites: true };
  const { on, host } = createHost(options);
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  await runTurns(host, [20000, 30000]);
  await runTurns(host, [40000]);
  const probe = JSON.parse((await host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.equal(probe.persist.status, "failed");
  assert.equal(probe.stepCount, 3, "the live view is unaffected");
});

test("no start time from the host means nothing is saved", async () => {
  const files = new Map();
  const { on, host } = createHost({ files });
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  await runTurns(host, [20000]);
  assert.equal(files.size, 0);
  const probe = JSON.parse((await host.fire("command.run", { args: "json" }, passThrough)).text);
  assert.equal(probe.persist.status, "off");
});

test("the snapshot files are bounded: sessions share a fixed set of slots", async () => {
  const files = new Map();
  const passThrough = async (event) => event;
  for (let n = 0; n < 40; n += 1) {
    const { on, host } = createHost({ startedAt: 1700000000000 + n * 1000, files });
    register(on);
    await host.fire("session.start", {}, passThrough);
    await runTurns(host, [20000]);
  }
  const slots = [...files.keys()].filter((name) => name.endsWith(".json"));
  assert.ok(slots.length <= 8, "at most 8 slot files, got " + slots.length);
});

test("/ccx reset clears the saved copy as well", async () => {
  const files = new Map();
  const { on, host } = createHost({ startedAt: 1700000000000, files });
  register(on);
  const passThrough = async (event) => event;
  await host.fire("session.start", {}, passThrough);
  await runTurns(host, [20000, 30000]);
  const slot = [...files.keys()].find((name) => name.endsWith(".json"));
  assert.equal(JSON.parse(files.get(slot)).steps.length, 2);
  await host.fire("command.run", { args: "reset" }, passThrough);
  assert.equal(JSON.parse(files.get(slot)).steps.length, 0, "a reload would not bring it back");
});
