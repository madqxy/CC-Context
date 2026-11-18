#!/usr/bin/env node
// A live smoke test: drive the REAL claude binary against a local
// Anthropic-compatible endpoint, so the mod is exercised by the real engine
// (real hooks module loader, real prompt.section events, real usage reading)
// without credentials and without spending tokens.
//
//   node test/live/run.mjs
//
// What it proves that the unit and engine tests cannot:
//   - hooks/hooks.json loads in the real binary,
//   - session.start runs and $.session.usage({ breakdown: "full" }) answers,
//   - /ccx and /ccx panel answer with real text,
//   - a real tool call reaches the mod's tool.call hook.
//
// It needs the claude binary on PATH. It does not need a login: the endpoint is
// this file, and the API key is a placeholder.

import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

// On Windows the npm install is a .cmd shim, and spawn() without a shell cannot
// run one: point at the executable the shim wraps instead.
function resolveBinary(name) {
  if (process.env.CLAUDE_BIN) {
    return process.env.CLAUDE_BIN
  }
  if (process.platform !== 'win32') {
    return name
  }
  const candidates = []
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude.exe'))
  return candidates.find((candidate) => fs.existsSync(candidate)) || name
}

const CLAUDE = resolveBinary(process.env.CLAUDE_BIN || 'claude')

const README = path.join(ROOT, 'README.md')

function sse(res, event, data) {
  res.write('event: ' + event + '\n')
  res.write('data: ' + JSON.stringify(data) + '\n\n')
}

// The stub answers like the API: the first request asks for one Read, the next
// answers with text. Every request carries a usage block, which is what the mod
// records.
function startStub() {
  let requests = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      requests += 1
      const url = req.url || ''
      if (url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ input_tokens: 8210 }))
        return
      }
      if (!url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'no route ' + url } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg_live_' + requests,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 120, cache_creation_input_tokens: 400, cache_read_input_tokens: 8000, output_tokens: 1 },
        },
      })
      if (!raw.includes('tool_result')) {
        sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_live_1', name: 'Read', input: {} } })
        sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: README }) } })
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
        sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 21 } })
        sse(res, 'message_stop', { type: 'message_stop' })
        res.end()
        return
      }
      sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I read the readme.' } })
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } })
      sse(res, 'message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function runClaude(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.on('error', (error) => resolve({ code: -1, stdout: '', stderr: String(error) }))
  })
}

function check(condition, message, failures) {
  if (condition) {
    console.log('  ok   ' + message)
  } else {
    console.log('  FAIL ' + message)
    failures.push(message)
  }
}

const failures = []
const workDirs = []
console.log('live check: ' + CLAUDE + ' against a local endpoint')

// Fail once, clearly: without the binary every later check fails too, which
// reads as thirteen problems instead of one missing program.
const probeBinary = await runClaude(['--version'], { ...process.env }, ROOT)
if (probeBinary.code !== 0) {
  const detail = /ENOENT/.test(probeBinary.stderr) ? 'not found on PATH' : probeBinary.stderr.split('\n')[0]
  console.error('live check: cannot run "' + CLAUDE + '": ' + detail)
  console.error('live check: set CLAUDE_BIN to the binary, or run this where Claude Code is installed')
  process.exit(1)
}

const { server, port } = await startStub()
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-live-'))
fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }))

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: configDir,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port,
  ANTHROPIC_API_KEY: 'cc-context-live-check-not-a-secret',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
}

try {
  const probe = await runClaude(['-p', '/ccx json', '--plugin-dir', ROOT], env, ROOT)
  if (probe.code !== 0) {
    check(false, 'the binary ran /ccx (exit ' + probe.code + '): ' + probe.stderr.split('\n').slice(-3).join(' '), failures)
  } else {
    const start = probe.stdout.indexOf('{')
    const end = probe.stdout.lastIndexOf('}')
    let payload = null
    if (start >= 0 && end > start) {
      try {
        payload = JSON.parse(probe.stdout.slice(start, end + 1))
      } catch (error) {
        payload = null
      }
    }
    check(payload !== null, 'the probe answered with JSON', failures)
    if (payload !== null) {
      check(typeof payload.window === 'number' && payload.window > 0, 'the host reported a window (' + payload.window + ')', failures)
      check(
        payload.agentList && payload.agentList.state === 'ok' && Array.isArray(payload.agentList.entries),
        'the host answered $.agent.list() (' + (payload.agentList ? payload.agentList.state + ', ' + payload.agentList.entries.length + ' entries' : 'missing') + ')',
        failures,
      )
      const breakdown = payload.breakdown
      check(Boolean(breakdown), 'the host reported a breakdown', failures)
      if (breakdown) {
        const categories = Array.isArray(breakdown.categories) ? breakdown.categories : []
        check(categories.length > 0, 'the breakdown has categories (' + categories.length + ')', failures)
        check(
          categories.every((category) => category.kind !== undefined),
          'every category carries the host kind (used/deferred/free/buffer)',
          failures,
        )
        check(
          categories.some((category) => category.kind === 'free'),
          'free space is its own kind, not counted as content',
          failures,
        )
      }
    }
  }

  const pane = await runClaude(['-p', '/ccx panel', '--plugin-dir', ROOT], env, ROOT)
  check(pane.code === 0, 'the binary ran /ccx panel (exit ' + pane.code + ')', failures)
  check(pane.stdout.includes('CC-Context'), '/ccx panel answered', failures)

  // The turn runs in a scratch working directory: the mod saves its snapshot under
  // the session's cwd, and the repository must not be littered by a test.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-work-'))
  workDirs.push(work)
  const turn = await runClaude(['-p', 'read the readme', '--plugin-dir', ROOT, '--add-dir', ROOT, '--allowedTools', 'Read'], env, work)
  check(turn.code === 0, 'the binary ran a turn with a tool call (exit ' + turn.code + ')', failures)
  check(turn.stdout.includes('I read the readme.'), 'the model answer came back', failures)

  // The end of that turn saved a snapshot through the real $.fs.write.
  const snapshotDir = path.join(work, '.claude', 'cc-context')
  const slots = fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir).filter((name) => /^slot-\d\.json$/.test(name)) : []
  check(slots.length === 1, 'the turn saved one snapshot slot (' + slots.join(',') + ')', failures)
  let saved = null
  if (slots.length === 1) {
    try {
      saved = JSON.parse(fs.readFileSync(path.join(snapshotDir, slots[0]), 'utf8'))
    } catch (error) {
      saved = null
    }
  }
  check(saved !== null && saved.version === 1 && saved.steps.length >= 1, 'the snapshot holds the requests of the turn (' + (saved ? saved.steps.length : 0) + ')', failures)
  check(fs.existsSync(path.join(snapshotDir, '.gitignore')), 'the snapshot directory ignores itself', failures)
  check(saved !== null && !JSON.stringify(saved).includes('read the readme'), 'the snapshot holds no conversation text', failures)

  // --continue reopens that session: the host keeps its start time, so the mod
  // finds its own snapshot and restores the history.
  const resumed = await runClaude(['-p', '--continue', '/ccx json', '--plugin-dir', ROOT], env, work)
  const rs = resumed.stdout.indexOf('{')
  const re = resumed.stdout.lastIndexOf('}')
  let resumedProbe = null
  try {
    resumedProbe = JSON.parse(resumed.stdout.slice(rs, re + 1))
  } catch (error) {
    resumedProbe = null
  }
  check(resumedProbe !== null, 'the resumed session answered /ccx json', failures)
  check(resumedProbe !== null && resumedProbe.persist.status === 'restored', 'the resumed session restored its snapshot (' + (resumedProbe ? resumedProbe.persist.status : 'no probe') + ')', failures)
  check(resumedProbe !== null && resumedProbe.stepCount >= 1, 'the restored history is there (' + (resumedProbe ? resumedProbe.stepCount : 0) + ' requests)', failures)

  const transcripts = []
  const projects = path.join(configDir, 'projects')
  if (fs.existsSync(projects)) {
    for (const dir of fs.readdirSync(projects)) {
      for (const file of fs.readdirSync(path.join(projects, dir))) {
        if (file.endsWith('.jsonl')) {
          transcripts.push(path.join(projects, dir, file))
        }
      }
    }
  }
  let usageLines = 0
  for (const file of transcripts) {
    usageLines += fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.includes('"usage"')).length
  }
  check(usageLines >= 2, 'the transcript holds the real usage blocks (' + usageLines + ')', failures)
} finally {
  server.close()
  fs.rmSync(configDir, { recursive: true, force: true })
  for (const dir of workDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(failures.length === 0 ? 'live check passed' : 'live check failed: ' + failures.length)
process.exit(failures.length === 0 ? 0 : 1)
