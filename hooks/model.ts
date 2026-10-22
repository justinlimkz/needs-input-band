import type { Item } from '../types'

export const DOCS_TOOL = /^mcp__(.+)__(create|batch|update|delete)$/
export const DOCS_SERVER_HINT = /Claude_Docs/
export const MAX_ROWS = 4
export const SHOWN_WHEN_MORE = 3

const MARKER = /(^|[\s*_[])\(you\)(?=$|[\s.,:;*_\]])/i

const unescape = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

export type TabRead = { title?: string; open: string[] }

/** Reads one tab's outline XML: the open (you) paragraphs and the first level-1 heading. */
export const parseTab = (xml: string): TabRead => {
  const open: string[] = []
  let title: string | undefined
  const stack: string[] = []
  const bufs: { text: string; heading: boolean }[] = []
  const tok = /<(\/?)([A-Za-z][A-Za-z0-9]*)([^>]*?)(\/?)>|([^<]+)/g
  for (let m = tok.exec(xml); m; m = tok.exec(xml)) {
    if (m[5] !== undefined) {
      const top = bufs[bufs.length - 1]
      if (top && !stack.includes('code') && !stack.includes('inlineCode')) top.text += unescape(m[5])
      continue
    }
    const closing = m[1] === '/'
    const name = m[2] ?? ''
    const attrs = m[3] ?? ''
    const selfClosing = m[4] === '/'
    if (closing) {
      if (name === 'paragraph') {
        const b = bufs.pop()
        if (b) {
          const text = b.text.replace(/\s+/g, ' ').trim()
          if (b.heading && title === undefined && text) title = text
          if (stack.includes('listItem') || stack.includes('cell')) {
            if (MARKER.test(text)) open.push(text)
          }
        }
      }
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.length = at
    } else if (!selfClosing) {
      stack.push(name)
      if (name === 'paragraph') bufs.push({ text: '', heading: /heading=['"]1['"]/.test(attrs) })
    }
  }
  return { title, open }
}

/** The first JSON object in a tool's text (the docs tools append prose after it). */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

export const hashOf = (parts: readonly string[]): string => {
  let h = 5381
  for (const ch of [...parts].sort().join('\u0000')) h = ((h << 5) + h + ch.charCodeAt(0)) | 0
  return `${parts.length}:${(h >>> 0).toString(36)}`
}

export type Doc = { id: string; title: string; url: string; open: string[] }

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export const textOf = (r: { content?: readonly unknown[] } | undefined): string =>
  (r?.content ?? [])
    .map(b => str(rec(b).text) ?? '')
    .join('\n')

/** The tabs of a doc read: uuid, url, and each tab's body node. */
export const parseDocHead = (
  text: string,
): { id: string; url?: string; name?: string; tabs: { node: string; engine: string }[] } | null => {
  const j = rec(extractJson(text))
  const frame = rec(j.frame)
  const id = str(frame.slug)
  const files = Array.isArray(j.files) ? j.files : []
  if (!id) return null
  const tabs = files
    .map(f => rec(rec(f).content))
    .filter(c => typeof c.id === 'string')
    .map(c => ({ node: c.id as string, engine: str(c.engine) ?? 'prose' }))
  return { id, url: str(frame.url), name: str(rec(files[0]).name), tabs }
}

export const parseTabXml = (text: string): string | null => {
  const j = rec(extractJson(text))
  return str(rec(j.data).xml) ?? str(j.xml) ?? null
}

export const mintedId = (resultText: string): string | undefined =>
  /"created"\s*:\s*\{[^}]*?"minted"\s*:\s*"([0-9a-f-]{36})"/.exec(resultText)?.[1]

export const fallbackUrl = (id: string): string => `https://claude.ai/artifact/${id}`

export const isVisible = (i: Item): boolean => i.clearedHash !== i.openHash

export const byAge = (items: readonly Item[]): Item[] =>
  [...items].sort((a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id))

export const ageText = (addedAt: number, now: number): string => {
  const m = Math.max(0, Math.floor((now - addedAt) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

export const decisionsText = (n: number): string => (n <= 0 ? '' : n === 1 ? '1 decision' : `${n} decisions`)

const clip = (s: string, n: number): string => (n <= 0 ? '' : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)

/** Fits one row to `columns`: the title is shortened, the meta kept. */
export const fitRow = (item: Item, now: number, columns: number): { title: string; meta: string } => {
  const meta = [decisionsText(item.decisions), ageText(item.addedAt, now)].filter(Boolean).join(' · ')
  const room = Math.max(1, columns - 4)
  return { title: clip(item.title, room - meta.length - 3), meta }
}

export const promptSection = (items: readonly Item[]): string | null => {
  if (!items.length) return null
  const lines = byAge(items).map(i => `- ${i.title} (${i.decisions} open) · doc ${i.id} · ${i.url}`)
  return [
    'Docs waiting on the user (a band above their prompt lists them; do not mention the band unless asked):',
    ...lines,
    'When the user settles one of these decisions, in chat or by comment, edit that doc in the same turn: replace the "(you)" on the settled item with "(decided: <their answer>)". The list updates from the doc, not from anything you say.',
  ].join('\n')
}
