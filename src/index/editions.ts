import type { IndexedItem } from './query.js'
import { log } from '../logger.js'

export interface EditionMember {
  id: string
  serverKey: string
  libraryId: string
  title: string
  narratorName: string
  duration: number
  /** Why this member joined the set: asin, isbn or title. */
  reason: string
}

export interface EditionSet {
  preferred: string
  members: EditionMember[]
}

export interface EditionOptions {
  /** Server keys in order of preference for the edition that gets shown. */
  preferServers: string[]
  /** Item ids that must never be collapsed into a set. */
  keepSeparate: Set<string>
}

const ARTICLES = /^(the|a|an)\s+/
const EDITION_NOISE = /\s*[([]?\s*(unabridged|abridged|audiobook|audio book|audible original|a novel)\s*[)\]]?\s*$/i

/** "The Hobbit (Unabridged)" and "the hobbit" compare equal. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(EDITION_NOISE, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(ARTICLES, '')
    .trim()
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const normalizeIsbn = (isbn: string) => isbn.replace(/[^0-9xX]/g, '').toUpperCase()

class UnionFind {
  private readonly parent = new Map<string, string>()
  find(x: string): string {
    let p = this.parent.get(x) ?? x
    if (p !== x) {
      p = this.find(p)
      this.parent.set(x, p)
    }
    return p
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/**
 * Group copies of the same book into edition sets. Rules, in order:
 * identical ASIN; identical ISBN; same normalized title and primary author,
 * provided the language (when both known) and the abridged flag agree.
 * Items listed in `keepSeparate` never join a set. Every set is logged so a
 * false merge can be pinned apart in the config.
 */
export function buildEditionSets(items: IndexedItem[], opts: EditionOptions, logDecisions = true): Map<string, EditionSet> {
  const uf = new UnionFind()
  const reason = new Map<string, string>()
  const eligible = items.filter((it) => !opts.keepSeparate.has(it.row.id))
  const join = (key: string, pick: (it: IndexedItem) => string | null, guard?: (a: IndexedItem, b: IndexedItem) => boolean) => {
    const byKey = new Map<string, IndexedItem[]>()
    for (const it of eligible) {
      const k = pick(it)
      if (k) byKey.set(k, [...(byKey.get(k) ?? []), it])
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue
      for (let i = 1; i < group.length; i++) {
        if (guard && !guard(group[0], group[i])) continue
        uf.union(group[0].row.id, group[i].row.id)
        if (!reason.has(group[i].row.id)) reason.set(group[i].row.id, key)
        if (!reason.has(group[0].row.id)) reason.set(group[0].row.id, key)
      }
    }
  }
  join('asin', (it) => (it.row.asin ? it.row.asin.trim().toUpperCase() : null))
  join('isbn', (it) => (it.row.isbn && normalizeIsbn(it.row.isbn).length >= 10 ? normalizeIsbn(it.row.isbn) : null))
  join(
    'title',
    (it) => {
      const author = it.item.media.metadata.authors?.[0]?.name ?? it.row.authorName.split(',')[0]
      const t = normalizeTitle(it.row.title)
      const a = normalizeName(author ?? '')
      return t && a ? `${t}|${a}` : null
    },
    (a, b) => {
      const la = a.row.language?.trim().toLowerCase()
      const lb = b.row.language?.trim().toLowerCase()
      if (la && lb && la !== lb) return false
      return !!a.row.abridged === !!b.row.abridged
    }
  )

  const groups = new Map<string, IndexedItem[]>()
  for (const it of eligible) {
    const root = uf.find(it.row.id)
    groups.set(root, [...(groups.get(root) ?? []), it])
  }

  const rank = (it: IndexedItem) => {
    const i = opts.preferServers.indexOf(it.row.serverKey)
    return i === -1 ? opts.preferServers.length : i
  }
  const bitrate = (it: IndexedItem) => (it.row.duration ? it.row.size / it.row.duration : 0)
  const sets = new Map<string, EditionSet>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    members.sort((a, b) => rank(a) - rank(b) || bitrate(b) - bitrate(a) || b.row.numAudioFiles - a.row.numAudioFiles || (a.row.id < b.row.id ? -1 : 1))
    const set: EditionSet = {
      preferred: members[0].row.id,
      members: members.map((it) => ({ id: it.row.id, serverKey: it.row.serverKey, libraryId: it.row.libraryId, title: it.row.title, narratorName: (it.item.media.metadata.narrators ?? []).join(', '), duration: it.row.duration, reason: reason.get(it.row.id) ?? 'title' }))
    }
    for (const m of set.members) sets.set(m.id, set)
    if (logDecisions) log.info(`[editions] "${members[0].row.title}" by ${members[0].row.authorName}: showing ${members[0].row.serverKey}/${members[0].row.id.slice(0, 8)}, hiding ${members.slice(1).map((m) => `${m.row.serverKey}/${m.row.id.slice(0, 8)} (${reason.get(m.row.id)})`).join(', ')}`)
  }
  return sets
}

export const formatDuration = (seconds: number) => {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
