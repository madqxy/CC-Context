// End-to-end check of the analyzer against test/fixtures: the fixture is a
// hand-written transcript with three requests, one compact_boundary, one Read
// and one Edit, so every number below is known by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURES = path.join(ROOT, "test", "fixtures");

// The fixture was written on Windows; the analyzer runs anywhere. Take the last
// segment of either separator, which is what the CLI prints too.
function baseName(file) {
  const parts = String(file).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : String(file);
}

function run(args) {
  const output = execFileSync(process.execPath, [path.join(ROOT, "cli", "ccx.mjs"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: FIXTURES },
  });
  return output;
}

test("the analyzer reads the fixture session", () => {
  const data = JSON.parse(run(["--json"]));
  // Two transcripts: the session and one subagent's own file. The fixture writes
  // one response in both, the way an older build might have; the analyzer counts
  // five distinct responses, not six.
  assert.equal(data.totals.sessions, 2);
  assert.equal(data.totals.requests, 5);
  assert.equal(data.totals.input, 410);
  assert.equal(data.totals.cacheRead, 8000);
  assert.equal(data.totals.cacheCreate, 11000);
  assert.equal(data.totals.output, 285);
});

test("a compact_boundary is counted once, not also inferred", () => {
  const data = JSON.parse(run(["--json"]));
  assert.equal(data.totals.compactions, 1);
});

test("a response written to two transcripts is counted once, off the parent's window", () => {
  const data = JSON.parse(run(["--json"]));
  const parent = data.sessions.find((session) => session.id === "sess-0001");
  const agent = data.sessions.find((session) => session.id === "agent-0001");
  assert.ok(parent, "the parent transcript is a session");
  assert.ok(agent, "the subagent transcript is a session too");
  assert.equal(parent.requests, 3, "the inline sidechain copy is not the parent's own request");
  assert.equal(parent.tokens, 19370);
  assert.equal(agent.requests, 2);
  assert.equal(data.totals.sidechain, 2, "both subagent requests are counted as sidechain");
  assert.equal(agent.kind, "agent", "a subagent's transcript is marked as one");
  assert.equal(parent.kind, "session");
});

test("tool use lands in the tool and file tallies", () => {
  const data = JSON.parse(run(["--json"]));
  const tools = new Map(data.topTools.map((tool) => [tool.name, tool.count]));
  assert.equal(tools.get("Read"), 1);
  assert.equal(tools.get("Edit"), 1);
  const files = data.topFiles.map((file) => baseName(file.file)).sort();
  assert.deepEqual(files, ["app.test.ts", "app.ts"]);
});

test("the text overview names the session and the tool totals", () => {
  const text = run([]);
  assert.match(text, /sess-000/);
  assert.match(text, /Read 1 · Edit 1/);
  assert.match(text, /压缩 1 次/);
});

test("the day buckets and session rows carry what the charts plot", () => {
  const data = JSON.parse(run(["--json"]));
  const day = data.byDay[0];
  assert.equal(typeof day.contextTokens, "number", "context tokens per day");
  assert.equal(typeof day.outputTokens, "number", "output tokens per day");
  assert.equal(typeof day.cacheHitRate, "number", "the cache line needs a per-day hit rate");
  const session = data.sessions[0];
  assert.ok(Array.isArray(session.curve) && session.curve.length > 0, "a session carries its per-request window curve");
  assert.equal(typeof session.cacheHitRate, "number");
});

test("the html report is one self-contained file with charts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-report-"));
  const file = path.join(dir, "report.html");
  run(["--html", file]);
  const html = fs.readFileSync(file, "utf8");
  assert.match(html, /<svg class="chart" viewBox="0 0 760 180"/, "the charts are inline svg");
  assert.match(html, /class="spark"/, "each session row has a window curve");
  assert.match(html, /sess-000/, "the sessions table is there");
  assert.doesNotMatch(html, /NaN/, "no broken geometry");
  assert.doesNotMatch(html, /https?:\/\//, "nothing is fetched from the network");
  fs.rmSync(dir, { recursive: true, force: true });
});
