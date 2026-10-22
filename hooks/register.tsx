import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item } from '../types'
import {
  DOCS_TOOL,
  MAX_ROWS,
  SHOWN_WHEN_MORE,
  ageText,
  byAge,
  fallbackUrl,
  fitRow,
  hashOf,
  isVisible,
  mintedId,
  parseDocHead,
  parseTab,
  parseTabXml,
  promptSection,
  textOf,
} from './model'
import type { Doc } from './model'

const PLUGIN = 'needs-input-band'
const RECONCILE_EVERY_MS = 5 * 60_000
const TOAST_EVERY_MS = 10 * 60_000

const itemsAtom = atom({ plugin: 'needs-input-band', key: 'items' } as const, [] as Item[])
const hiddenAtom = atom({ plugin: 'needs-input-band', key: 'isHidden' } as const, false)
const labelAtom = atom({ plugin: 'needs-input-band', key: 'label' } as const, '')
const nowAtom = atom({ plugin: 'needs-input-band', key: 'now' } as const, 0)
const touchedAtom = atom({ plugin: 'needs-input-band', key: 'touched' } as const, [] as string[])
const othersAtom = atom({ plugin: 'needs-input-band', key: 'others' } as const, 0)

// Module state is recomputed on demand: a hot reload resets it.
const S = {
  key: '',
  defaultLabel: '',
  server: 'claude_ai_Claude_Docs',
  lastReconcile: 0,
  lastToast: 0,
  timer: null as { cancel: () => void } | null,
}

const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

const ensureKey = async ($: EngineInterface, cwdHint?: string): Promise<string> => {
  if (S.key) return S.key
  const cwd = cwdHint ?? (await $.session.cwd())
  const git = await $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  const common = git.exitCode === 0 ? git.stdout.trim() : ''
  S.key = common || cwd
  S.defaultLabel = basename(common ? common.replace(/\/\.git\/?$/, '') : cwd)
  return S.key
}

const prefix = (): string => `item:${S.key}:`

const loadItems = async ($: EngineInterface): Promise<{ mine: Item[]; others: number }> => {
  const keys = await $.store.keys()
  const mine: Item[] = []
  let others = 0
  for (const k of keys) {
    if (!k.startsWith('item:')) continue
    if (!k.startsWith(prefix())) {
      others += 1
      continue
    }
    const v = (await $.store.get(k)) as Item | undefined
    if (v && typeof v.id === 'string') mine.push(v)
  }
  return { mine, others }
}

const publish = async ($: EngineInterface): Promise<void> => {
  await ensureKey($)
  const { mine, others } = await loadItems($)
  const visible = byAge(mine.filter(isVisible))
  const label = ((await $.store.get(`label:${S.key}`)) as string | undefined) || S.defaultLabel
  await update($, itemsAtom, () => visible)
  await update($, othersAtom, () => others)
  await update($, labelAtom, () => label)
  await update($, nowAtom, () => Date.now())
  if (visible.length && !S.timer) {
    S.timer = $.clock.every(60_000, () => {
      void tick($)
    })
  } else if (!visible.length && S.timer) {
    S.timer.cancel()
    S.timer = null
  }
}

const tick = async ($: EngineInterface): Promise<void> => {
  try {
    await publish($)
  } catch {}
}

/**
 * Reads a doc by uuid or link: its tabs, then each tab's open (you) paragraphs.
 * Null on any failure; 'gone' when the connector answers that the doc is not there for us
 * (it answers deleted and unshared alike: reason "access").
 */
const readDoc = async ($: EngineInterface, ref: string): Promise<Doc | 'gone' | null> => {
  try {
    const head = await $.mcp.call(S.server, 'read', { ref: { object: 'project', id: ref } })
    if (head.isError) return /"reason"\s*:\s*"access"/.test(textOf(head)) ? 'gone' : null
    const h = parseDocHead(textOf(head))
    if (!h || !h.tabs.length) return null
    const open: string[] = []
    let title: string | undefined
    for (const tab of h.tabs) {
      const r = await $.mcp.call(S.server, 'read', {
        ref: { object: 'node', id: tab.node },
        engine: tab.engine,
        container: { kind: 'project', id: h.id },
        payload: { kind: 'view' },
      })
      if (r.isError) return null
      const xml = parseTabXml(textOf(r))
      if (xml === null) return null
      const t = parseTab(xml)
      title ??= t.title
      open.push(...t.open)
    }
    return { id: h.id, title: title ?? h.name ?? 'Untitled doc', url: h.url ?? fallbackUrl(h.id), open }
  } catch {
    return null
  }
}

/** Recounts one doc and writes or removes its item. Returns false when the read failed (item kept). */
const reconcileDoc = async ($: EngineInterface, ref: string): Promise<boolean> => {
  let doc = await readDoc($, ref)
  if (doc === 'gone') {
    // Ask twice in a row before trusting it, so one odd answer cannot drop an item.
    doc = await readDoc($, ref)
    if (doc === 'gone') {
      await $.store.delete(`${prefix()}${ref}`)
      return true
    }
  }
  if (!doc) return false
  const key = `${prefix()}${doc.id}`
  if (!doc.open.length) {
    await $.store.delete(key)
    return true
  }
  const old = (await $.store.get(key)) as Item | undefined
  const item: Item = {
    id: doc.id,
    title: doc.title,
    url: doc.url,
    decisions: doc.open.length,
    addedAt: old?.addedAt ?? (await $.clock.now()),
    openHash: hashOf(doc.open),
    ...(old?.clearedHash !== undefined ? { clearedHash: old.clearedHash } : {}),
  }
  await $.store.set(key, item)
  return true
}

const toastOnce = ($: EngineInterface): void => {
  const now = Date.now()
  if (now - S.lastToast < TOAST_EVERY_MS) return
  S.lastToast = now
  $.ui.toast('needs-input-band: could not read a doc back (is mcp__claude_ai_Claude_Docs__read allowed?); items unchanged')
}

/** End of a main-loop turn: recount touched docs, and every pending doc every few minutes. */
const settle = async ($: EngineInterface, everything: boolean): Promise<void> => {
  await ensureKey($)
  const touched = await read($, touchedAtom)
  await update($, touchedAtom, cur => cur.filter(id => !touched.includes(id)))
  const done = new Set<string>()
  let failed = false
  for (const id of touched) {
    done.add(id)
    if (!(await reconcileDoc($, id))) failed = true
  }
  const now = Date.now()
  if (everything || now - S.lastReconcile > RECONCILE_EVERY_MS) {
    S.lastReconcile = now
    const { mine } = await loadItems($)
    for (const item of mine) {
      if (!done.has(item.id)) await reconcileDoc($, item.id)
    }
  }
  if (failed) toastOnce($)
  await publish($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      S.key = ''
      await ensureKey($, e.cwd)
      await $.command.register({
        name: 'needs-input',
        description: 'List or clear docs waiting on you; add <link>; hide/show the band; label <text>.',
        argumentHint: '[clear <n|all>|add <link>|hide|show|label <text>]',
      })
      await publish($)
    } catch (err) {
      $.ui.log(`needs-input-band: session.start failed: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await publish($)
    } catch {}
    return next(e)
  })

  // The docs connector: only note which doc was written. Never blocks or fails the call.
  on('tool.call', async ($, e, next) => {
    const m = DOCS_TOOL.exec(String(e.tool))
    if (!m) return next(e)
    const result = await next(e)
    try {
      if ((result as { isError?: boolean }).isError) return result
      S.server = String(e.tool).replace(/^mcp__/, '').replace(/__(create|batch|update|delete)$/, '')
      await ensureKey($)
      const input = e as unknown as Record<string, unknown>
      const container = (input.container ?? {}) as Record<string, unknown>
      const ref = (input.ref ?? {}) as Record<string, unknown>
      if (m[2] === 'delete') {
        if (ref.object === 'project' && typeof ref.id === 'string') {
          await $.store.delete(`${prefix()}${ref.id}`)
          await publish($)
        }
        return result
      }
      const text = JSON.stringify((result as { text?: string; result?: unknown }).text ?? (result as { result?: unknown }).result ?? '')
      const id = typeof container.id === 'string' ? container.id : mintedId(text.replace(/\\"/g, '"'))
      if (id) await update($, touchedAtom, cur => (cur.includes(id) ? cur : [...cur, id]))
    } catch (err) {
      $.ui.log(`needs-input-band: docs hook failed: ${String(err)}`, { to: 'debug' })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if (e.agentId) return out
    try {
      await settle($, false)
    } catch (err) {
      $.ui.log(`needs-input-band: settle failed: ${String(err)}`, { to: 'debug' })
    }
    return out
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    const text = promptSection(await read($, itemsAtom))
    if (!text) return out
    return { sections: [...out.sections, { id: `${PLUGIN}:pending`, text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'needs-input' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    try {
      await ensureKey($)
      if (sub === 'hide' || sub === 'show') {
        await update($, hiddenAtom, () => sub === 'hide')
        return { text: sub === 'hide' ? 'Band hidden for this session.' : 'Band shown.' }
      }
      if (sub === 'label') {
        const label = rest.join(' ')
        if (label) await $.store.set(`label:${S.key}`, label)
        else await $.store.delete(`label:${S.key}`)
        await publish($)
        return { text: label ? `Label set to ${label}.` : 'Label reset.' }
      }
      if (sub === 'add') {
        const link = rest[0]
        if (!link) return { text: 'Usage: /needs-input add <doc link>' }
        const ok = await reconcileDoc($, link)
        await publish($)
        return { text: ok ? 'Read the doc; the band shows it if it has open (you) items.' : 'Could not read that doc.' }
      }
      if (sub === 'clear') {
        const items = byAge(await read($, itemsAtom))
        const picked = items[Number(rest[0]) - 1]
        const chosen = rest[0] === 'all' ? items : picked ? [picked] : []
        if (!chosen.length) return { text: 'Usage: /needs-input clear <n|all>' }
        for (const i of chosen) await $.store.set(`${prefix()}${i.id}`, { ...i, clearedHash: i.openHash })
        await publish($)
        return { text: `Hid ${chosen.length}; they return if the doc's open decisions change.` }
      }
      const items = byAge(await read($, itemsAtom))
      const now = Date.now()
      return {
        text: items.length
          ? items.map((i, x) => `${x + 1}. ${i.title} · ${i.decisions} · ${ageText(i.addedAt, now)} · ${i.url}`).join('\n')
          : 'Nothing is waiting on you.',
      }
    } catch (err) {
      return { text: `needs-input failed: ${String(err)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const items = byAge(await read($, itemsAtom))
    if (e.props.hasSurvey || !items.length || (await read($, hiddenAtom))) return next(e)

    const now = (await read($, nowAtom)) || Date.now()
    const label = await read($, labelAtom)
    const others = await read($, othersAtom)
    const shown = items.length > MAX_ROWS ? items.slice(0, SHOWN_WHEN_MORE) : items
    const { Box, Link, Text } = $.ui.resolve(e)
    const columns = e.props.bodyColumns

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text color="warning">●</Text> Needs your input
          <Text dimColor>
            {' '}· {label} · {items.length}
            {others ? ` · +${others} elsewhere` : ''}
          </Text>
        </Text>
        {shown.map(item => {
          const p = fitRow(item, now, columns)
          return (
            <Text wrap="truncate-end">
              {'  '}
              <Text dimColor>›</Text>{' '}
              <Text color="suggestion">
                <Link href={item.url}>{p.title}</Link>
              </Text>
              <Text dimColor> · {p.meta}</Text>
            </Text>
          )
        })}
        {items.length > MAX_ROWS ? <Text dimColor>{`  +${items.length - SHOWN_WHEN_MORE} more`}</Text> : null}
      </Box>
    )
  })
}
