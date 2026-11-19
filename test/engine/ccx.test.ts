// Real-engine tests for the CC-Context mod.
//
// Run with: claude plugin test .
//
// These are not unit tests against a fake host: the engine loads hooks/hooks.json,
// registers the mod, and answers every host call the mod makes. A tree that the
// terminal's element table refuses fails here, which is the check the P1 notes
// called "未验证".

import { describe, expect, test } from 'claude-code/testing'

const PLUGIN = 'cc-context'
const SESSION = { surface: 'terminal', isInteractive: true, cwd: '/work' }

const MESSAGES = [
  { role: 'user', text: 'add a test for the estimator' },
  { role: 'assistant', text: 'Sure.', toolUses: [{ name: 'Read', input: { file_path: '/work/src/app.ts' } }] },
  { role: 'tool', text: 'export function add(a, b) { return a + b }' },
]

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 12400, kind: 'system' },
    { name: 'System tools', tokens: 9200, kind: 'tools' },
    { name: 'Messages', tokens: 38000, kind: 'messages' },
    { name: 'MCP tools', tokens: 1200, kind: 'mcp' },
    { name: 'Free space', tokens: 137000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 0, kind: 'buffer' },
  ],
  totalTokens: 60800,
  maxTokens: 200000,
  rawMaxTokens: 200000,
  percentage: 30,
  autocompactThreshold: 155000,
  isAutoCompactEnabled: true,
  gridRows: [],
  model: 'claude-sonnet-4-5-20250929',
  memoryFiles: [{ path: '/work/CLAUDE.md', type: 'Project', tokens: 800 }],
  mcpTools: [{ name: 'search', serverName: 'docs', tokens: 600, isLoaded: true }],
  agents: [{ agentType: 'reviewer', source: 'project', tokens: 400 }],
  skills: { totalSkills: 3, includedSkills: 2, tokens: 900, skillFrontmatter: [{ name: 'pdf', source: 'plugin', pluginName: 'docs', tokens: 450 }] },
  slashCommands: { totalCommands: 12, includedCommands: 4, tokens: 300 },
  apiUsage: { input_tokens: 200, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 },
}

// The step usage a real session reports: input + cache read + cache write is
// the window that request carried. Index 0 is the fixture's baseline window,
// index 1 a slightly larger one (so the band has a delta), index 2 a window
// rebuilt by a compaction.
const STEP_USAGE = [
  { input_tokens: 200, cache_read_input_tokens: 59400, cache_creation_input_tokens: 1200, output_tokens: 90 },
  { input_tokens: 200, cache_read_input_tokens: 60600, cache_creation_input_tokens: 1200, output_tokens: 120 },
  { input_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, output_tokens: 20 },
  // A subagent's window, far larger than the parent's: it must not move the band.
  { input_tokens: 90000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
]

const USAGE = {
  startedAt: 1,
  context: { tokens: 60800, window: 200000, percent: 30, breakdown: BREAKDOWN },
  rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-01-01T00:00:00Z' }],
  cost: { usd: 0.86 },
}

type Tree = { type?: string; children?: unknown[]; props?: Record<string, unknown> } | string | null | undefined

function stringsOf(node: Tree): string[] {
  if (node === null || node === undefined) {
    return []
  }
  if (typeof node === 'string') {
    return [node]
  }
  const own: string[] = []
  const props = (node as { props?: Record<string, unknown> }).props
  if (node.type === 'Button' && typeof props?.label === 'string') {
    own.push(props.label)
  }
  const children = ((node as { children?: readonly Tree[] }).children ?? []) as readonly Tree[]
  return [...own, ...children.flatMap((child) => stringsOf(child))]
}

const textOf = (node: Tree): string => stringsOf(node).join('')

function band(columns: number, over: Record<string, unknown> = {}) {
  return {
    component: 'AbovePrompt',
    surface: 'terminal',
    requestId: 'band',
    viewport: { columns: columns, rows: 40, isFullscreen: true },
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 19 }, view: {}, ...over },
  }
}

function pane(columns: number, bodyRows = 20) {
  return {
    component: 'Pane',
    surface: 'terminal',
    requestId: 'ccx',
    plugin: PLUGIN,
    viewport: { columns: columns + 20, rows: 48, isFullscreen: true },
    props: { title: 'CC-Context', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
  }
}

const command = (args = '') => ({
  command: 'ccx',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

type World = {
  commands: string[]
  opened: { id: string; title?: string }[]
  closed: string[]
  invalidations: number
  /** The files the stand-in file system holds, by path. */
  files: Map<string, string>
  /** What $.agent.list() answers; a test sets it. */
  agents: Record<string, unknown>[]
  /** Answers the parent's open Agent/Task call, the way a finished child would. */
  releaseLaunch: (isError?: boolean) => void
  /** Resolves once the stand-in has the parent's Agent/Task call in hand. */
  launched: () => Promise<void>
}

// worldOf seats the stand-ins beneath the plugin: the calls the host would answer
// are answered here, and the ones the mod only asks for are recorded.
function worldOf(
  on: (name: string, handler: (...args: any[]) => unknown) => unknown,
  options: { breakdown?: Record<string, unknown>; launches?: Record<string, string> } = {},
): World {
  let breakdown: Record<string, unknown> = options.breakdown ?? BREAKDOWN
  let markLaunched: (() => void) | null = null
  const launchOpened = new Promise<void>((resolve) => {
    markLaunched = () => resolve()
  })
  const world: World = { commands: [], opened: [], closed: [], invalidations: 0, files: new Map(), agents: [], releaseLaunch: () => undefined, launched: () => launchOpened }
  let pendingLaunch: ((value: unknown) => void) | null = null
  world.releaseLaunch = (isError?: boolean) => {
    const resolve = pendingLaunch
    pendingLaunch = null
    if (resolve !== null) {
      resolve({ result: { isError: isError === true } })
    }
  }
  on('session.start', (_h: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', (_h: unknown, e: { name: string }) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.usage', (_h: unknown, e: { breakdown?: string } | undefined) => ({
    value: {
      ...USAGE,
      context: { ...USAGE.context, ...(e && e.breakdown === 'full' ? { breakdown } : { breakdown: undefined }) },
    },
  }))
  on('session.messages', () => ({ value: MESSAGES }))
  on('agent.list', () => ({ value: world.agents }))
  // The engine has no default implementation for the spawn event; a test fires
  // it explicitly, and the mod's hook runs before this one. The event's result is
  // the model the agent will use (or a refusal), not a free-form value.
  on('agent.spawn', () => ({ model: 'claude-sonnet-4-5-20250929' }))
  on('fs.write', (_h: unknown, e: { path: string; text: string }) => {
    world.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_h: unknown, e: { path: string }) => {
    const held = world.files.get(e.path)
    if (held === undefined) {
      throw new Error('ENOENT ' + e.path)
    }
    return { value: held }
  })
  on('ui.open', (_h: unknown, e: { id: string; title?: string }) => {
    world.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_h: unknown, e: { id: string }) => {
    world.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.invalidate', () => {
    world.invalidations += 1
    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', children: [''] }))
  on('turn.complete', (_h: unknown, e: { answer?: string }) => ({ text: e.answer ?? '' }))
  on('turn.step', async function* (_h: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      usage: STEP_USAGE[e.index] ?? STEP_USAGE[0],
    }
  })
  // A subagent call stays open for as long as the child runs, so the stand-in
  // holds the parent's Agent/Task call until the test releases it.
  on('tool.call', (_h: unknown, e: { tool?: string }) => {
    const tool = String(e.tool ?? '')
    if (tool === 'Agent' || tool === 'Task') {
      // An async launch answers at once with the child's id (the shape the host
      // uses for a background agent), which is what the tree needs to nest.
      const listed = options.launches?.[String((e as { description?: string }).description ?? '')]
      if (listed !== undefined) {
        return { result: { status: 'async_launched', agentId: listed } }
      }
      if (markLaunched !== null) {
        markLaunched()
      }
      return new Promise((resolve) => {
        pendingLaunch = resolve
      })
    }
    return { result: { isError: false } }
  })
  return world
}

async function start($: any, on: any, options: { breakdown?: Record<string, unknown>; launches?: Record<string, string> } = {}): Promise<World> {
  const world = worldOf(on, options)
  await $.session.start(SESSION)
  return world
}

// The band above the prompt is off unless asked for: /ccx on draws it.
async function showBand($: any) {
  await $.command.run(command('on'))
}

async function step($: any, index = 0, agentId?: string) {
  const chunks: unknown[] = []
  const event: Record<string, unknown> = { turnId: 't1', index, model: 'claude-sonnet-4-5-20250929' }
  if (agentId !== undefined) {
    event.agentId = agentId
  }
  for await (const chunk of $.turn.step(event)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('band', () => {
  test('the mod registers /ccx at session.start and leaves the band off until asked', async ($, on) => {
    const world = await start($, on)
    expect(world.commands).toEqual(['ccx'])
    // The stand-in reports a window at start, as a resumed session does. The band
    // could draw it, but it is opt-in now: the status bar carries these numbers.
    expect(textOf(await $.ui.render(band(120))), 'off by default').toBe('')
    await showBand($)
    const tree = await $.ui.render(band(120))
    expect(textOf(tree)).toContain('◧ 30%')
  })

  test('it degrades by width: percent, then size, then delta, then cache and the bar', async ($, on) => {
    await start($, on)
    await showBand($)
    await step($, 0)
    await step($, 1)

    const narrow = textOf(await $.ui.render(band(30)))
    expect(narrow).toContain('◧ 30%')
    expect(narrow, 'no size under 40 columns').not.toContain('/ 200k')

    const medium = textOf(await $.ui.render(band(44)))
    expect(medium).toContain('60.8k / 200k')

    const wide = textOf(await $.ui.render(band(120)))
    expect(wide, 'the delta is the last step against the one before it').toContain('+1.2k')
    expect(wide).toContain('cache 98%')
    expect(wide).toContain('详情')
  })

  test('a survey holds the band, and a non-terminal surface gets nothing', async ($, on) => {
    await start($, on)
    await showBand($)
    await step($)
    expect(textOf(await $.ui.render(band(120, { hasSurvey: true })))).toBe('')
    expect(textOf(await $.ui.render({ ...band(120), surface: 'desktop' }))).toBe('')
  })

  test('the terminal accepts the band at every width it can be drawn at', async ($, on) => {
    await start($, on)
    await showBand($)
    await step($)
    for (const columns of [30, 44, 60, 96, 160]) {
      const mounted = await ($ as any).ui.mount({ ...band(columns), plugin: PLUGIN })
      expect(mounted.surface, 'band at ' + columns + ' columns').toBe('terminal')
      await mounted.unmount()
    }
  })

  test('/ccx on draws the band, /ccx off puts the host back in charge of it', async ($, on) => {
    await start($, on)
    await step($)
    expect(textOf(await $.ui.render(band(120))), 'still off').toBe('')
    await $.command.run(command('on'))
    expect(textOf(await $.ui.render(band(120)))).toContain('%')
    await $.command.run(command('off'))
    expect(textOf(await $.ui.render(band(120)))).toBe('')
  })
})

describe('pane', () => {
  test('/ccx panel opens the pane, and the pane draws the exact composition', async ($, on) => {
    const world = await start($, on)
    await step($)

    const opened = await $.command.run(command('panel'))
    expect(textOf(opened.text)).toContain('侧栏已打开')
    expect(world.opened, 'it asks for the keyboard, or its hotkeys do nothing').toEqual([{ id: 'ccx', title: 'CC-Context', focus: true }])

    const tree = await $.ui.render(pane(72))
    const text = textOf(tree)
    expect(text).toContain('组成')
    expect(text, 'the host names its own categories').toContain('System prompt')
    expect(text).toContain('12.4k')
    expect(text, 'the total comes from the host').toContain('合计 60.8k / 200k')
    expect(text).toContain('自动压缩阈值 155k')
    expect(text, 'free space is named, not counted as something in the window').toContain('空余 Free space 137k')
    expect(text).toContain('记忆文件 (1)')
    expect(text).toContain('技能 (1)')
    expect(text).toContain('MCP 工具 (1)')
    expect(text).toContain('关闭')
  })

  test('the composition is one stacked bar with a legend, colored by category', async ($, on) => {
    await start($, on)
    await step($)
    await $.command.run(command('panel'))
    const tree = JSON.stringify(await $.ui.render(pane(72)))
    expect(tree, 'a legend marker per used category').toContain('■ ')
    expect((tree.match(/■ /g) ?? []).length, 'four used categories in the fixture').toBe(4)
    expect(tree, 'the bar has solid cells for the window').toContain('█')
    expect(tree, 'free space is the dim stretch at the end').toContain('░')
    const colors = new Set((tree.match(/"color":"([a-z]+)"/g) ?? []))
    expect(colors.size, 'categories are told apart by color').toBeGreaterThanOrEqual(4)
  })

  test('the trend tab fills columns from the baseline and marks a compaction', async ($, on) => {
    await start($, on)
    await step($, 0)
    await step($, 1)
    await step($, 2) // the window collapses: a compaction
    await $.command.run(command('panel'))
    await $.ui.render(pane(72))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:trend' })
    const text = textOf(await $.ui.render(pane(72)))
    expect(text, 'filled blocks, not a line of dots').toMatch(/[\u2581-\u2588]/)
    expect(text, 'no braille left behind').not.toMatch(/[\u2801-\u28ff]/)
    expect(text, 'the mark under the drop').toContain('▲')
    expect(text).toContain('▲ 压缩')
    const mounted = await ($ as any).ui.mount(pane(72))
    expect(mounted.surface, 'the terminal accepts the chart').toBe('terminal')
    await mounted.unmount()
  })

  test('the footer says how to drive the pane, and what to do while it is not focused', async ($, on) => {
    await start($, on)
    await step($)
    await $.command.run(command('panel'))
    const focused = textOf(await $.ui.render(pane(72)))
    expect(focused).toContain('j/k 翻页')
    expect(focused).toContain('Esc')
    expect(focused, 'a focused pane does not tell the person to focus it').not.toContain('未聚焦')

    const loose = pane(72) as { props: { isFocused: boolean } }
    loose.props.isFocused = false
    const unfocused = textOf(await $.ui.render(loose as never))
    expect(unfocused, 'an unfocused pane says how to give it the keys').toContain('ctrl+x tab')
  })

  test('an unknown /ccx argument says so instead of printing the dashboard', async ($, on) => {
    await start($, on)
    const reply = textOf((await $.command.run(command('sidebar'))).text)
    expect(reply).toContain('不认识的参数')
    expect(reply, 'the name it offers is panel').toContain('panel（侧栏）')
    expect(reply, 'not the dashboard').not.toContain('窗口')
    for (const spelling of ['panel', 'pane', 'open']) {
      const opened = await $.command.run(command(spelling))
      expect(textOf(opened.text), spelling + ' opens the panel').toContain('侧栏已打开')
    }
  })

  test('the pane is accepted by the terminal at narrow and wide bodies', async ($, on) => {
    await start($, on)
    await step($)
    for (const columns of [24, 40, 60, 100]) {
      const mounted = await ($ as any).ui.mount(pane(columns))
      expect(mounted.surface, 'pane at ' + columns + ' columns').toBe('terminal')
      await mounted.unmount()
    }
  })

  test('tabs switch on their buttons, and the drawn text follows', async ($, on) => {
    await start($, on)
    await step($)
    await $.command.run(command('panel'))
    await $.ui.render(pane(72))

    await $.ui.press({ plugin: PLUGIN, key: 'tab:trend' })
    const trend = textOf(await $.ui.render(pane(72)))
    expect(trend).toContain('趋势')
    expect(trend).toContain('缓存命中 98%')
    expect(trend, 'the composition rows are gone').not.toContain('System prompt')

    await $.ui.press({ plugin: PLUGIN, key: 'tab:browser' })
    const browser = textOf(await $.ui.render(pane(72)))
    expect(browser).toContain('本会话 文件')
    expect(browser).toContain('工具 (1)')

    await $.ui.press({ plugin: PLUGIN, key: 'tab:composition' })
    expect(textOf(await $.ui.render(pane(72)))).toContain('System prompt')
  })

  test('a section header drills down to its items and closes again', async ($, on) => {
    await start($, on)
    await step($)
    await $.command.run(command('panel'))
    expect(textOf(await $.ui.render(pane(72))), 'collapsed by default').not.toContain('/work/CLAUDE.md')

    await $.ui.press({ plugin: PLUGIN, key: 'section:memory' })
    const open = textOf(await $.ui.render(pane(72)))
    expect(open).toContain('/work/CLAUDE.md')
    expect(open).toContain('800')

    await $.ui.press({ plugin: PLUGIN, key: 'section:memory' })
    expect(textOf(await $.ui.render(pane(72)))).not.toContain('/work/CLAUDE.md')
  })

  test('/ccx tab names a tab without opening the pane, and an unknown name is refused', async ($, on) => {
    await start($, on)
    await step($)
    const named = await $.command.run(command('tab trend'))
    expect(textOf(named.text)).toContain('趋势')
    expect(textOf(await $.ui.render(pane(72)))).toContain('趋势')

    const refused = await $.command.run(command('tab nope'))
    expect(textOf(refused.text)).toContain('没有名为')
  })

  test('a compaction keeps the window it happened at', async ($, on) => {
    await start($, on)
    await step($, 0)

    // A request far smaller than the one before it is a rebuilt window.
    await step($, 2)
    await $.command.run(command('panel'))
    await $.ui.render(pane(72))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:trend' })
    const text = textOf(await $.ui.render(pane(72)))
    expect(text).toContain('压缩 1 次')
    expect(text, 'the pair is kept').toContain('60.8k → 2k')
    expect(text).toContain('（推断）')
  })

  test('scrolling moves the body without moving the tabs', async ($, on) => {
    await start($, on)
    await step($)
    await $.command.run(command('panel'))
    const first = textOf(await $.ui.render(pane(72, 8)))
    await $.ui.press({ plugin: PLUGIN, key: 'scroll-down' })
    const second = textOf(await $.ui.render(pane(72, 8)))
    expect(second, 'tabs stay').toContain('组成')
    expect(second).not.toBe(first)
  })

  test('closing the pane is recorded, and drawing it again marks it open', async ($, on) => {
    const world = await start($, on)
    await step($)
    await $.command.run(command('panel'))
    await $.ui.render(pane(72))

    await $.ui.press({ plugin: PLUGIN, key: 'close' })
    expect(world.closed).toEqual(['ccx'])
    expect((await $.command.run(command('close'))).text).toBe('CC-Context: 侧栏已关闭（/ccx panel 恢复）')
  })
})


describe('persistence', () => {
  test('a turn saves the history, and a new session of the same start time reads it back', async ($, on) => {
    const world = await start($, on)
    await step($, 0)
    await step($, 1)
    await $.tool.call({ tool: 'Read', file_path: '/work/src/app.ts' })
    await $.turn.complete({ turnId: 't1', answer: 'ok' })

    // The engine resolves the relative path against the working directory before
    // the call, so the key is absolute -- with the platform's separator.
    const slot = [...world.files.keys()].find((name) => /[\\/]\.claude[\\/]cc-context[\\/]slot-\d\.json$/.test(name))
    expect(slot, 'a snapshot slot is written at the end of a turn').toBeDefined()
    const ignore = [...world.files.keys()].find((name) => /[\\/]\.claude[\\/]cc-context[\\/]\.gitignore$/.test(name))
    expect(world.files.get(ignore as string), 'the directory ignores itself').toBe('*\n')
    const saved = JSON.parse(world.files.get(slot as string) as string)
    expect(saved.version).toBe(1)
    expect(saved.startedAt, 'keyed by the host start time').toBe(1)
    expect(saved.steps.length).toBe(2)
    expect(JSON.stringify(saved), 'no conversation text in it').not.toContain('add a test')

    // The same session again, as a reload would: the mod's memory is cleared at
    // session.start, and the snapshot is what brings the history back.
    await $.session.start(SESSION)
    const dashboard = textOf((await $.command.run(command(''))).text)
    expect(dashboard).toContain('请求   2 次')
    expect(dashboard).toContain('其中 2 次从快照恢复')
    expect(dashboard).toContain('app.ts ×1')
    const probe = JSON.parse((await $.command.run(command('json'))).text)
    expect(probe.persist.status).toBe('restored')
    expect(probe.stepCount).toBe(2)
  })
})

describe('subagents', () => {
  test('the host agent list supplies status, so silence is not guessed', async ($, on) => {
    const world = await start($, on)
    await step($, 0)
    void $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'look around' })
    await world.launched()
    await $.tool.call({ tool: 'Read', file_path: '/work/a.ts', agentId: 'agent-7' })
    // The host says it is idle between turns; no event said so.
    world.agents = [{ id: 'agent-7', type: 'Explore', description: 'look around', status: 'idle' }]
    let probe = JSON.parse((await $.command.run(command('json'))).text)
    expect(probe.agentList.state).toBe('ok')
    expect(probe.agents[0].status).toBe('idle')

    // A teammate no event ever named still gets a row, with the host's status.
    world.agents = [
      { id: 'agent-7', type: 'Explore', description: 'look around', status: 'killed' },
      { id: 'mate-1', type: 'teammate', description: 'review', status: 'running' },
    ]
    probe = JSON.parse((await $.command.run(command('json'))).text)
    expect(probe.agents.find((a: { id: string }) => a.id === 'agent-7').status, 'killed reads as failed').toBe('failed')
    expect(probe.agents.find((a: { id: string }) => a.id === 'mate-1').status).toBe('running')
    world.releaseLaunch()
  })

  test('a child is named by its own events: launch, calls, requests, the end of its turn', async ($, on) => {
    const world = await start($, on)
    await step($, 0)

    // The parent asks for a child; its call stays open while the child runs.
    void $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', name: 'estimator-scout', description: 'find the estimator tests' })
    await world.launched()
    // The child's calls and requests carry the id the parent never sees.
    await $.tool.call({ tool: 'Read', file_path: '/work/src/estimate.test.mjs', agentId: 'agent-1' })
    await step($, 0, 'agent-1')
    await $.tool.call({ tool: 'Grep', pattern: 'estimateTokens', agentId: 'agent-1' })
    await $.turn.complete({ turnId: 'child', answer: 'found it', agentId: 'agent-1' })
    world.releaseLaunch()

    await $.command.run(command('panel'))
    await $.ui.render(pane(80))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:agents' })
    const text = textOf(await $.ui.render(pane(80)))

    expect(text).toContain('编队')
    expect(text, 'the name the caller gave names the row').toContain('estimator-scout')
    expect(text, 'the engine default type is not shown as an identity').not.toContain('general-purpose')
    expect(text, 'the launch also says what the child was asked to do').toContain('find the estimator tests')
    expect(text, 'its calls are counted').toContain('2调')
    expect(text, 'a finished child reads as done').toContain('完成 1')

    const probe = JSON.parse((await $.command.run(command('json'))).text)
    expect(probe.agents.length).toBe(1)
    expect(probe.agents[0].id).toBe('agent-1')
    expect(probe.agents[0].status).toBe('done')
    expect(probe.agents[0].calls).toBe(2)
    expect(probe.agents[0].steps).toBe(1)
    expect(probe.agents[0].launch.type).toBe('general-purpose')
  })

  test('an unnamed child reads as its task, not as the engine default type', async ($, on) => {
    const world = await start($, on)
    await step($, 0)
    void $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: 'sweep the docs' })
    await world.launched()
    world.releaseLaunch()

    await $.command.run(command('panel'))
    await $.ui.render(pane(90))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:agents' })
    const text = textOf(await $.ui.render(pane(90)))
    expect(text, 'the task is what tells this row apart').toContain('sweep the docs')
    expect(text, 'the engine default is not an identity').not.toContain('general-purpose')
  })

  test('agent.spawn supplies the type the tool call left out', async ($, on) => {
    const world = await start($, on)
    await step($, 0)
    void $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_1', description: 'dig one' })
    await world.launched()
    // The call carried no subagent_type; the engine resolves it when the agent starts.
    await $.agent.spawn({ tool_use_id: 'toolu_1', subagentType: 'Explore', background: false, fork: false })
    world.releaseLaunch()

    await $.command.run(command('panel'))
    await $.ui.render(pane(90))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:agents' })
    const text = textOf(await $.ui.render(pane(90)))
    expect(text, 'the resolved type names the row').toContain('Explore')
    expect(text).not.toContain('general-purpose')
  })

  test('a child still working is running, and the band says how many', async ($, on) => {
    const world = await start($, on)
    await showBand($)
    await step($, 0)
    void $.tool.call({ tool: 'Task', description: 'scan the repo' })
    await world.launched()
    await $.tool.call({ tool: 'Bash', command: 'ls -R src', agentId: 'agent-2' })

    expect(textOf(await $.ui.render(band(100))), 'one child is running').toContain('⟳1')

    const list = textOf((await $.command.run(command('agents'))).text)
    expect(list).toContain('运行 1')
    expect(list).toContain('scan the repo')

    await $.turn.complete({ turnId: 'child', answer: 'done', agentId: 'agent-2' })
    world.releaseLaunch()
    expect(textOf(await $.ui.render(band(100))), 'nothing runs once it ends').not.toContain('⟳')
    expect(textOf((await $.command.run(command('agents'))).text)).toContain('完成 1')
  })

  test('a launch that answers with an error marks its child failed', async ($, on) => {
    const world = await start($, on)
    await step($, 0)
    const launching = $.tool.call({ tool: 'Agent', description: 'do the impossible' })
    await world.launched()
    await $.tool.call({ tool: 'Read', file_path: '/work/none.ts', agentId: 'agent-3' })
    world.releaseLaunch(true)
    await launching

    const probe = JSON.parse((await $.command.run(command('json'))).text)
    const text = textOf((await $.command.run(command('agents'))).text)
    expect(text).toContain('失败 1')
    expect(text).toContain('✗')
  })

  test('a child window never moves the parent band or its trend', async ($, on) => {
    const world = await start($, on)
    await showBand($)
    await step($, 0)
    const before = textOf(await $.ui.render(band(120)))

    void $.tool.call({ tool: 'Agent', description: 'read a lot' })
    await world.launched()
    await $.tool.call({ tool: 'Read', file_path: '/work/big.ts', agentId: 'agent-4' })
    await step($, 3, 'agent-4')
    await $.turn.complete({ turnId: 'child', answer: 'ok', agentId: 'agent-4' })
    world.releaseLaunch()

    const after = textOf(await $.ui.render(band(120)))
    expect(after, 'the parent window reading is unchanged').toBe(before)

    const probe = JSON.parse((await $.command.run(command('json'))).text)
    expect(probe.stepCount, 'the child request is not a parent step').toBe(1)
    const child = probe.agents.find((entry: { id: string }) => entry.id === 'agent-4')
    expect(child.tokens, 'the child carries its own window').toBe(90000)
  })

  test('the subagent tab is accepted by the terminal at narrow and wide bodies', async ($, on) => {
    const world = await start($, on)
    await step($, 0)
    void $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'look around' })
    await world.launched()
    await $.tool.call({ tool: 'Read', file_path: '/work/src/app.ts', agentId: 'agent-5' })
    await $.ui.render(pane(72))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:agents' })

    for (const columns of [24, 40, 72, 100]) {
      const mounted = await ($ as any).ui.mount(pane(columns))
      expect(mounted.surface, 'agents tab at ' + columns + ' columns').toBe('terminal')
      await mounted.unmount()
    }
    world.releaseLaunch()
  })
})


// The shapes the real host has actually shipped: categories carry their own
// kind, list fields are sometimes a bare count, and skills come either as
// totals or as frontmatter rows. All three were seen in live runs
// (test/live/run.mjs, docs/spike-checklist.md).
const KINDED_BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 73890, kind: 'used' },
    { name: 'System tools', tokens: 6149, kind: 'used' },
    { name: 'System tools (deferred)', tokens: 84810, kind: 'deferred', isDeferred: true },
    { name: 'Skills', tokens: 2061, kind: 'used' },
    { name: 'Messages', tokens: 8210, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
    { name: 'Free space', tokens: 876690, kind: 'free' },
  ],
  totalTokens: 90310,
  maxTokens: 1000000,
  percentage: 9,
  isAutoCompactEnabled: true,
  memoryFiles: 2,
  mcpTools: 0,
  agents: 0,
  skills: { total: 13, included: 13, tokens: 2061 },
  apiUsage: { input_tokens: 120, output_tokens: 12, cache_creation_input_tokens: 400, cache_read_input_tokens: 8000 },
}

describe('the host shapes the live runs reported', () => {
  test('category kinds split what is in the window from room and deferred tools', async ($, on) => {
    await start($, on, { breakdown: KINDED_BREAKDOWN })
    await step($, 0)
    await $.command.run(command('panel'))
    const text = textOf(await $.ui.render(pane(84)))

    expect(text, 'content rows').toContain('System prompt')
    expect(text, 'free space and the buffer are room, not content').toContain('空余 Autocompact buffer 33k · Free space 876.7k')
    expect(text, 'a deferred tool definition is declared, not loaded').toContain('未加载 System tools (deferred) 84.8k')
    expect(text, 'the total is the used sum, not the window').toContain('合计 90.3k / 1M · 已用 9%')
  })

  test('skills reported as totals still drill down', async ($, on) => {
    await start($, on, { breakdown: KINDED_BREAKDOWN })
    await step($, 0)
    await $.command.run(command('panel'))
    await $.ui.render(pane(84))
    await $.ui.press({ plugin: PLUGIN, key: 'section:skills' })
    const text = textOf(await $.ui.render(pane(84)))

    expect(text).toContain('共 13 个 · 计入上下文 13 个 · 2.1k')
  })

  test('a list reported as a count still names itself', async ($, on) => {
    await start($, on, { breakdown: KINDED_BREAKDOWN })
    await step($, 0)
    await $.command.run(command('panel'))
    await $.ui.render(pane(84))
    await $.ui.press({ plugin: PLUGIN, key: 'section:memory' })
    const text = textOf(await $.ui.render(pane(84)))

    expect(text).toContain('2 个记忆文件')
  })

  test('the dashboard agrees with the pane about kinds and counts', async ($, on) => {
    await start($, on, { breakdown: KINDED_BREAKDOWN })
    await step($, 0)
    const text = (await $.command.run(command(''))).text
    expect(text).toContain('未加载 System tools (deferred) 84.8k')
    expect(text).toContain('明细   记忆文件 2 · 技能 13')
  })
})


  test('a row with children folds its subtree, and the marker still opens its words', async ($, on) => {
    await start($, on, { launches: { plan: 'a-p', 'dig one': 'a-c1', 'dig two': 'a-c2' } })
    await step($, 0)
    await $.tool.call({ tool: 'Agent', subagent_type: 'Plan', description: 'plan' })
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'dig one', agentId: 'a-p' })
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'dig two', agentId: 'a-p' })
    await step($, 0, 'a-p')

    await $.command.run(command('panel'))
    await $.ui.render(pane(84))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:agents' })
    const open = textOf(await $.ui.render(pane(84)))
    expect(open).toContain('dig one')
    expect(open, 'a row with children offers the fold marker').toContain('▾')

    await $.ui.press({ plugin: PLUGIN, key: 'agent:a-p' })
    const folded = textOf(await $.ui.render(pane(84)))
    expect(folded, 'the whole subtree is gone').not.toContain('dig one')
    expect(folded).toContain('▸')
    expect(folded, 'it says how many rows it hides').toContain('(+2)')

    await $.ui.press({ plugin: PLUGIN, key: 'agent:a-p' })
    expect(textOf(await $.ui.render(pane(84))), 'unfolding brings them back').toContain('dig one')

    await $.ui.press({ plugin: PLUGIN, key: 'agent-info:a-p' })
    const detail = textOf(await $.ui.render(pane(84)))
    expect(detail, 'the marker opens the details without folding').toContain('1 步 · 2 次调用')
    expect(detail).toContain('dig one')
  })


  test('one key folds every subtree, and the same key opens them again', async ($, on) => {
    await start($, on, { launches: { plan: 'a-p', 'dig one': 'a-c1', 'dig two': 'a-c2' } })
    await step($, 0)
    await $.tool.call({ tool: 'Agent', subagent_type: 'Plan', description: 'plan' })
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'dig one', agentId: 'a-p' })
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'dig two', agentId: 'a-p' })

    await $.command.run(command('panel'))
    await $.ui.render(pane(84))
    await $.ui.press({ plugin: PLUGIN, key: 'tab:agents' })
    expect(textOf(await $.ui.render(pane(84)))).toContain('dig one')

    await $.ui.press({ plugin: PLUGIN, key: 'fold-all' })
    const folded = textOf(await $.ui.render(pane(84)))
    expect(folded, 'every child row is gone').not.toContain('dig one')
    expect(folded, 'the root says how much it hides').toContain('(+2)')
    expect(folded).toContain('▸')

    await $.ui.press({ plugin: PLUGIN, key: 'fold-all' })
    expect(textOf(await $.ui.render(pane(84))), 'the same key opens them again').toContain('dig one')
  })

describe('dashboard and probe', () => {
  test('/ccx reports the exact composition and the host numbers it was given', async ($, on) => {
    await start($, on)
    await step($)
    const text = (await $.command.run(command(''))).text
    expect(text).toContain('CC-Context · 上下文透视')
    expect(text).toContain('窗口   60.8k / 200k')
    expect(text).toContain('组成（宿主精确上报')
    expect(text).toContain('System prompt')
    expect(text).toContain('明细   记忆文件 1 · 技能 1 · MCP 工具 1 · 子 Agent 定义 1')
    expect(text).toContain('空余 Free space 137k')
    expect(text).toContain('额度   5h 42%')
    expect(text).toContain('成本   $0.86')
    expect(text, 'an exact composition must not claim +/-10%').not.toContain('±10%')
    expect(text, 'the runtime list is the formation, the static count is the definitions').toContain('子 Agent 定义')
  })

  test('/ccx json dumps the breakdown the host reported', async ($, on) => {
    await start($, on)
    await step($)
    const payload = JSON.parse((await $.command.run(command('json'))).text)
    expect(payload.version).toBe(2)
    expect(payload.window).toBe(200000)
    expect(payload.breakdown.totalTokens).toBe(60800)
    expect(payload.breakdown.categories.length).toBe(6)
    expect(payload.costUsd).toBe(0.86)
    expect(payload.rateLimits.length).toBe(1)
  })
})
