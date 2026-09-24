/**
 * The device-local hide list: what the user hid when reporting, plus the
 * maintainer's list if they follow it.
 *
 * Kept in localStorage rather than the event log on purpose. Hiding is a
 * private reaction, not a statement - nothing here is signed, published or
 * replicated, and no one else's view changes because you hid something.
 * Blocking, which *is* meant to follow you across devices, is a signed event
 * and lives in the log as before.
 */
import { MODERATION_URL } from './policy.js'

const KEY_HIDDEN = 's2s.hidden.v1'
const KEY_LIST = 's2s.modlist.v1'
const KEY_FOLLOW = 's2s.modlist.follow'

/** Anything bigger is not a moderation list, it is an attack on memory. */
const MAX_ENTRIES = 20_000
const REFRESH_MS = 6 * 60 * 60 * 1000

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // private browsing or full storage: the filter still applies this session
  }
}

const idsOf = (list, prefix) =>
  Array.isArray(list)
    ? list.filter((x) => typeof x === 'string' && x.startsWith(prefix) && x.length < 80).slice(0, MAX_ENTRIES)
    : []

export function isFollowingList () {
  return read(KEY_FOLLOW, true) !== false
}

export function setFollowingList (on) {
  write(KEY_FOLLOW, !!on)
}

export function hiddenLocally () {
  const h = read(KEY_HIDDEN, {})
  return { authors: idsOf(h.authors, '@'), events: idsOf(h.events, '%') }
}

export function hideLocally ({ eventId, authorId }) {
  const h = hiddenLocally()
  if (eventId && !h.events.includes(eventId)) h.events.push(eventId)
  if (authorId && !h.authors.includes(authorId)) h.authors.push(authorId)
  write(KEY_HIDDEN, h)
}

export function clearHiddenLocally () {
  write(KEY_HIDDEN, { authors: [], events: [] })
}

export function cachedList () {
  const l = read(KEY_LIST, null)
  if (!l) return null
  return { authors: idsOf(l.authors, '@'), events: idsOf(l.events, '%'), updated: l.updated ?? null, fetchedAt: l.fetchedAt ?? 0 }
}

/**
 * Fetch the maintainer's list, keeping the last good copy on any failure.
 * A network error must never be the reason something reappears.
 */
export async function refreshList ({ force = false } = {}) {
  const cached = cachedList()
  if (!force && cached && Date.now() - cached.fetchedAt < REFRESH_MS) return cached

  try {
    const res = await fetch(MODERATION_URL, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return cached
    const body = await res.json()
    const list = {
      authors: idsOf(body.authors, '@'),
      events: idsOf(body.events, '%'),
      updated: typeof body.updated === 'string' ? body.updated : null,
      fetchedAt: Date.now()
    }
    write(KEY_LIST, list)
    return list
  } catch {
    return cached
  }
}

/** What the views should hide right now. */
export function effectiveFilter () {
  const local = hiddenLocally()
  const list = isFollowingList() ? cachedList() : null
  return {
    authors: [...new Set([...local.authors, ...(list?.authors ?? [])])],
    events: [...new Set([...local.events, ...(list?.events ?? [])])]
  }
}

/** Push the current filter into the peer, wherever it runs. */
export async function applyFilter (adapter) {
  await adapter.act('setFilter', effectiveFilter())
}
