import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'needs-input-band'
const SERVER = 'claude_ai_Claude_Docs'
const UPDATE = 'mcp__claude_ai_Claude_Docs__update' as const
const BATCH = 'mcp__claude_ai_Claude_Docs__batch' as const
const DELETE = 'mcp__claude_ai_Claude_Docs__delete' as const

const BAND = (extra: object = {}) =>
  ({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 100,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
      ...extra,
    },
  }) as const

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const DONE = (extra: object = {}) => ({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...extra }) as const

const GIT_DIRS: Record<string, string> = { '/w/shl': '/w/shl/.git', '/w/shl-t10': '/w/shl/.git' }
const KEY = 'item:/w/shl/.git:'

// A doc as the Docs connector returns it (shapes captured from a live probe, 2026-10-22).
const li = (t: string) => `<listItem id='.1' h='a'><paragraph id='.2' h='b'><text id='.3'>${t}</text></paragraph></listItem>`
const xmlOf = (title: string, body: string) =>
  `<doc node='n' rev='2'><paragraph id='m.0' rev='1' h='x' heading='1'><text id='.1'>${title}</text></paragraph>` +
  `<paragraph id='.24' h='y' heading='2'><text id='.25'>Next steps</text></paragraph><list id='.35' kind='bullet'>${body}</list></doc>`

type Doc = { title: string; xml: string; fail?: boolean; gone?: boolean }

// biome-ignore lint: the kit's `on`
const engine = (on: any, docs: Record<string, Doc>, opts: { cwd?: () => string; calls?: string[] } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const cwd = opts.cwd ?? (() => '/w/shl')
  on('session.cwd', () => ({ value: cwd() }))
  on('process.run', (_: unknown, e: { init?: { cwd?: string } }) => ({
    value: { exitCode: 0, stdout: `${GIT_DIRS[e.init?.cwd ?? ''] ?? '/other/.git'}\n`, stderr: '' },
  }))
  on('command.register', () => ({ value: { command: 'needs-input' } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {}, text: '{"verdict":"allow"}' }))
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('mcp.call', (_: unknown, e: { server: string; tool: string; args: any }) => {
    const text = (o: unknown) => ({ value: { content: [{ type: 'text', text: `${JSON.stringify(o)}\n\nextra prose` }], isError: false } })
    if (e.server !== SERVER || e.tool !== 'read') return { value: { content: [], isError: true } }
    const { ref } = e.args
    if (ref.object === 'project') {
      const d = docs[ref.id]
      if (!d || d.gone) {
        const deny = '{"verdict":"deny","reason":"access","hint":"no doc has this id"}'
        return { value: { content: [{ type: 'text', text: deny }], isError: true } }
      }
      if (d.fail) return { value: { content: [{ type: 'text', text: 'connector offline' }], isError: true } }
      return text({
        files: [{ id: 'f1', name: d.title, content: { kind: 'node', id: `node-${ref.id}`, engine: 'prose' } }],
        frame: { slug: ref.id, url: `https://claude.ai/artifact/short-${ref.id}` },
      })
    }
    opts.calls?.push(ref.id)
    const id = String(ref.id).replace('node-', '')
    return text({ data: { rev: 2, xml: docs[id]?.xml, complete: true } })
  })
  return clock
}

const start = ($: any, cwd = '/w/shl') => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
const write = ($: any, id: string, tool: typeof UPDATE | typeof BATCH = UPDATE) =>
  $.tool.call({ tool, container: { kind: 'project', id }, ref: { object: 'node', id: 'n' }, payload: { ops: [] } })
const turnEnd = ($: any, extra: object = {}) => $.turn.complete(DONE(extra))
const rows = async (ui: any) => (await ui.findAll({ type: 'Text', text: /^ +› / })).map((r: any) => r.text as string)
const sec = (r: any) => r.sections.find((s: any) => s.id === `${PLUGIN}:pending`)
const listed = async ($: any) => {
  const { text } = await $.command.run({ command: 'needs-input', args: '' } as any)
  return text === 'Nothing is waiting on you.' ? [] : text.split('\n')
}

test('1. an empty store renders nothing', async ($, on) => {
  mock.store(on)
  engine(on, {})
  await start($)
  const ui = await $.ui.mount(BAND())
  expect(await rows(ui)).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /Needs your input/ })).toBeUndefined()
  await ui.unmount()
})

test('2. a written doc with (you) items appears at turn end, and recounts as markers are settled', async ($, on) => {
  mock.store(on)
  const docs: Record<string, Doc> = {
    d1: { title: 'Report 09', xml: xmlOf('Report 09', li('(you) pick bins') + li('(you) approve') + li('run it')) },
  }
  engine(on, docs)
  await start($)
  await write($, 'd1')
  expect(await listed($)).toHaveLength(0) // nothing until the turn ends
  await turnEnd($)
  const ui = await $.ui.mount(BAND())
  const r = await rows(ui)
  expect(r).toHaveLength(1)
  expect(r[0]).toContain('Report 09')
  expect(r[0]).toContain('2 decisions')

  docs.d1 = { title: 'Report 09', xml: xmlOf('Report 09', li('(decided: bins 3) pick bins') + li('(you) approve')) }
  await write($, 'd1')
  await turnEnd($)
  await ui.redraw()
  expect((await rows(ui))[0]).toContain('1 decision')
  expect(await listed($)).toHaveLength(1)

  docs.d1 = { title: 'Report 09', xml: xmlOf('Report 09', li('(decided: yes) approve')) }
  await write($, 'd1')
  await turnEnd($)
  expect(await listed($)).toHaveLength(0)
  await ui.unmount()
})

test('3. only list and table markers count; split runs and trailing markers do', async ($, on) => {
  mock.store(on)
  const prose = `<paragraph id='.9' h='p'><text id='.10'>Items marked (you) need Justin.</text></paragraph>`
  const code = `<listItem id='.5'><paragraph id='.6'><text id='.7'>run </text><code id='.8'>(you)</code></paragraph></listItem>`
  const split = `<listItem id='.11'><paragraph id='.12'><text id='.13'>(</text><text id='.14'>you</text><text id='.15'>) approve v2</text></paragraph></listItem>`
  const cell = `<table id='.20'><row id='.21'><cell id='.22'><paragraph id='.23'><text id='.24'>Decide limit (you)</text></paragraph></cell></row></table>`
  const docs = {
    d2: {
      title: 'Mixed',
      xml:
        `<doc node='n'><paragraph id='.0' heading='1'><text id='.1'>Mixed</text></paragraph>${prose}` +
        `<list id='.4' kind='bullet'>${code}${split}${li('(decided: x) done')}${li('ship (you)')}</list>${cell}</doc>`,
    },
  }
  engine(on, docs)
  await start($)
  await write($, 'd2')
  await turnEnd($)
  expect((await listed($))[0]).toContain('· 3 ·')
})

test('4. a hidden item stays hidden only while its open decisions are unchanged', async ($, on) => {
  mock.store(on)
  const docs: Record<string, Doc> = { d1: { title: 'R', xml: xmlOf('R', li('(you) a')) } }
  engine(on, docs)
  await start($)
  await write($, 'd1')
  await turnEnd($)
  const cmd = (args: string) => $.command.run({ command: 'needs-input', args } as any)
  await cmd('clear 1')
  let ui = await $.ui.mount(BAND())
  expect(await rows(ui)).toHaveLength(0)
  await write($, 'd1')
  await turnEnd($)
  await ui.redraw()
  expect(await rows(ui)).toHaveLength(0) // same decisions: still hidden
  docs.d1 = { title: 'R', xml: xmlOf('R', li('(you) a') + li('(you) a new one')) }
  await write($, 'd1')
  await turnEnd($)
  await ui.redraw()
  expect(await rows(ui)).toHaveLength(1) // a new decision returns it
  await ui.unmount()
})

test('5. a failed read keeps the item; a delete call removes it', async ($, on) => {
  mock.store(on)
  const docs: Record<string, Doc> = { d1: { title: 'R', xml: xmlOf('R', li('(you) a')) } }
  engine(on, docs)
  await start($)
  await write($, 'd1')
  await turnEnd($)
  docs.d1 = { ...docs.d1!, fail: true }
  await write($, 'd1')
  await turnEnd($)
  expect(await listed($)).toHaveLength(1)
  await $.tool.call({ tool: DELETE, ref: { object: 'project', id: 'd1' } })
  expect(await listed($)).toHaveLength(0)
})

test('5b. a doc deleted elsewhere (the connector denies access) is removed at the next turn end', async ($, on) => {
  mock.store(on)
  const docs: Record<string, Doc> = { d1: { title: 'R', xml: xmlOf('R', li('(you) a')) } }
  engine(on, docs)
  await start($)
  await write($, 'd1')
  await turnEnd($)
  expect(await listed($)).toHaveLength(1)
  docs.d1 = { ...docs.d1!, gone: true }
  await turnEnd($, { turnId: 't2' })
  expect(await listed($)).toHaveLength(1) // not due yet: only touched docs are re-read within 5 minutes
  await write($, 'd1')
  await turnEnd($, { turnId: 't3' })
  expect(await listed($)).toHaveLength(0)
})

test('6. a doc touched three times in a turn is read once; a subagent turn reads nothing', async ($, on) => {
  mock.store(on)
  const calls: string[] = []
  engine(on, { d1: { title: 'R', xml: xmlOf('R', li('(you) a')) } }, { calls })
  await start($)
  await write($, 'd1')
  await write($, 'd1')
  await write($, 'd1', BATCH)
  await turnEnd($, { agentId: 'sub-1' })
  expect(calls).toHaveLength(0)
  await turnEnd($)
  expect(calls).toHaveLength(1)
})

test('7. five items show 3 rows and +2 more, oldest first; the prompt section is stable and ends when empty', async ($, on) => {
  const entries: Record<string, unknown> = {}
  for (let i = 1; i <= 5; i++) {
    entries[`${KEY}d${i}`] = {
      id: `d${i}`,
      title: `Doc ${i}`,
      url: `https://claude.ai/artifact/d${i}`,
      decisions: i,
      addedAt: 1_000_000 - (6 - i) * 60_000,
      openHash: `h${i}`,
    }
  }
  mock.store(on, entries)
  engine(on, {})
  await start($)
  const ui = await $.ui.mount(BAND())
  const r = await rows(ui)
  expect(r).toHaveLength(3)
  expect(r[0]).toContain('Doc 1')
  expect(r[2]).toContain('Doc 3')
  expect(await ui.find({ type: 'Text', text: /\+2 more/ })).toBeDefined()
  await ui.unmount()
  const a = await $.prompt.compose(COMPOSE)
  const b = await $.prompt.compose(COMPOSE)
  expect(sec(a)?.text).toContain('(decided:')
  expect(sec(a)?.text).toBe(sec(b)?.text)
})

test('8. the main checkout and a worktree share one list; another project is counted, not listed', async ($, on) => {
  mock.store(on, {
    [`${KEY}d1`]: { id: 'd1', title: 'Shared', url: 'https://claude.ai/artifact/d1', decisions: 1, addedAt: 1, openHash: 'h' },
    'item:/other/.git:x': { id: 'x', title: 'Elsewhere', url: 'u', decisions: 1, addedAt: 1, openHash: 'h' },
  })
  let cwd = '/w/shl'
  engine(on, {}, { cwd: () => cwd })
  await start($, '/w/shl')
  cwd = '/w/shl-t10'
  await start($, '/w/shl-t10')
  const ui = await $.ui.mount(BAND())
  expect((await rows(ui))[0]).toContain('Shared')
  expect((await ui.find({ type: 'Text', text: /Needs your input/ }))?.text).toContain('+1 elsewhere')
  await ui.unmount()
})

test('9. a hook that throws still returns the engine result', async ($, on) => {
  on('store.keys', () => {
    throw new Error('store down')
  })
  on('store.get', () => ({ value: undefined }))
  engine(on, {})
  await start($)
  const r = await write($, 'd1')
  expect(r.text).toContain('allow')
  await turnEnd($)
})

test('10. the band yields to a survey', async ($, on) => {
  mock.store(on, {
    [`${KEY}d1`]: { id: 'd1', title: 'A', url: 'https://claude.ai/artifact/d1', decisions: 1, addedAt: 1, openHash: 'h' },
  })
  engine(on, {})
  await start($)
  const quiet = await $.ui.mount(BAND({ hasSurvey: true }))
  expect(await quiet.find({ type: 'Text', text: /Needs your input/ })).toBeUndefined()
  await quiet.unmount()
  const shown = await $.ui.mount(BAND())
  expect(await shown.find({ type: 'Text', text: /Needs your input/ })).toBeDefined()
  await shown.unmount()
})
