/**
 * Views over the replica.
 *
 * The three UI modes this SNS offers are not three data models - they are three
 * queries over the same event log:
 *
 *   Twitter-style    posts by people you follow, newest first
 *   Instagram-style  the same posts filtered to the ones carrying media
 *   2ch-style        `thread` events grouped by board, with their replies
 *                    numbered in arrival order
 */

const isPostish = (k) => k === 'post' || k === 'repost' || k === 'thread'

/**
 * @param {import('./store.js').S2SStore} store
 * @param {string} viewer author id of the local user
 * @param {{ authors: Set<string>, events: Set<string> }} [filter]
 *   Hidden on this device only, on top of the viewer's own signed blocks: the
 *   events a user hid when reporting them, and whatever moderation list they
 *   chose to follow. Deliberately not events - nothing here is published or
 *   replicated, and nobody else's view changes because of it.
 */
export function makeViews (store, viewer, filter = { authors: new Set(), events: new Set() }) {
  const hidden = (authorId) =>
    store.blocked(viewer).has(authorId) || (authorId !== viewer && filter.authors.has(authorId))

  const visible = (id) => {
    const e = store.get(id)
    if (!e) return false
    if (store.isDeleted(id)) return false
    if (filter.events.has(id)) return false
    if (hidden(e.author)) return false
    return true
  }

  /** Resolve a repost to the post it points at, so the UI renders one card. */
  const hydrate = (id) => {
    const e = store.get(id)
    if (!e) return null
    let subject = e
    let repostedBy = null
    if (e.kind === 'repost') {
      const target = store.get(e.content.target)
      if (!target || !visible(target.id)) return null
      subject = target
      repostedBy = store.profile(e.author)
    }
    return {
      id: subject.id,
      cardId: e.id,
      kind: subject.kind,
      author: store.profile(subject.author),
      authorId: subject.author,
      ts: e.ts,
      text: subject.content.text ?? '',
      title: subject.content.title ?? null,
      board: subject.content.board ?? null,
      media: subject.content.media ?? [],
      tags: subject.content.tags ?? [],
      repostedBy,
      likes: store.likeScore(subject.id),
      myLike: store.myLike(subject.id, viewer),
      replies: store.replyCount(subject.id),
      seq: subject.seq
    }
  }

  const newestFirst = (ids) => ids.slice().reverse()

  return {
    /** Everything the network has handed us. The discovery feed. */
    global (limit = 200) {
      return newestFirst(store.posts).filter(visible).slice(0, limit).map(hydrate).filter(Boolean)
    },

    /** Posts from the people you follow, plus your own. */
    home (limit = 200) {
      const circle = new Set(store.following(viewer))
      circle.add(viewer)
      return newestFirst(store.posts)
        .filter((id) => visible(id) && circle.has(store.get(id).author))
        .slice(0, limit)
        .map(hydrate)
        .filter(Boolean)
    },

    /** Instagram mode: the same feed, media only. */
    media (scope = 'global', limit = 200) {
      const base = scope === 'home' ? this.home(1000) : this.global(1000)
      return base.filter((p) => p.media.length > 0).slice(0, limit)
    },

    /** One author's own log, rendered as a profile feed. */
    byAuthor (author, limit = 200) {
      return newestFirst(store.posts)
        .filter((id) => visible(id) && store.get(id).author === author)
        .slice(0, limit)
        .map(hydrate)
        .filter(Boolean)
    },

    /** 2ch mode: which boards exist, and how busy they are. */
    boards () {
      const out = []
      for (const [board, threadIds] of store.boards) {
        const live = threadIds.filter(visible)
        if (live.length === 0) continue
        let lastActivity = 0
        let posts = 0
        for (const id of live) {
          const replies = store.repliesByRoot.get(id) ?? []
          posts += 1 + replies.length
          // Spreading replies into Math.max blows the argument limit once a
          // thread passes a hundred thousand posts, which a P2P board can.
          lastActivity = Math.max(lastActivity, store.get(id).ts)
          for (const r of replies) lastActivity = Math.max(lastActivity, store.get(r)?.ts ?? 0)
        }
        out.push({ board, threads: live.length, posts, lastActivity })
      }
      return out.sort((a, b) => b.lastActivity - a.lastActivity)
    },

    /** Threads on one board, most recently active first - the 2ch ordering. */
    board (name) {
      const ids = (store.boards.get(name) ?? []).filter(visible)
      return ids
        .map((id) => {
          const e = store.get(id)
          const replies = (store.repliesByRoot.get(id) ?? []).filter(visible)
          const lastTs = replies.length ? store.get(replies[replies.length - 1]).ts : e.ts
          return {
            id,
            title: e.content.title,
            author: store.profile(e.author),
            ts: e.ts,
            lastTs,
            count: 1 + replies.length,
            text: e.content.text ?? '',
            media: e.content.media ?? []
          }
        })
        .sort((a, b) => b.lastTs - a.lastTs)
    },

    /**
     * A thread: the root plus every reply, numbered. Replies are ordered by
     * claimed timestamp, with the event id as tiebreak so every peer that has
     * the same set of replies numbers them identically.
     */
    thread (rootId) {
      const root = store.get(rootId)
      // A hidden thread stays hidden when reached by link, not only in lists.
      if (!root || !visible(rootId)) return null
      const replies = (store.repliesByRoot.get(rootId) ?? [])
        .filter(visible)
        .map((id) => store.get(id))
        .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))

      return {
        root: hydrate(rootId),
        posts: replies.map((e, i) => ({
          no: i + 2, // 2ch convention: the thread opener is >>1
          id: e.id,
          author: store.profile(e.author),
          authorId: e.author,
          ts: e.ts,
          text: e.content.text ?? '',
          media: e.content.media ?? [],
          parent: e.content.parent,
          likes: store.likeScore(e.id),
          myLike: store.myLike(e.id, viewer)
        }))
      }
    },

    /** Replies to a Twitter-style post, as a flat conversation. */
    conversation (rootId) {
      return this.thread(rootId)
    },

    /**
     * Local full-text search. There is no global index in a P2P network - you
     * can only search what you have replicated. That is a real limit, not a bug.
     */
    search (query, limit = 100) {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const hits = []
      for (const id of newestFirst(store.posts)) {
        if (!visible(id)) continue
        const e = store.get(id)
        const hay = `${e.content.text ?? ''} ${e.content.title ?? ''} ${(e.content.tags ?? []).join(' ')}`.toLowerCase()
        if (hay.includes(q)) hits.push(hydrate(id))
        if (hits.length >= limit) break
      }
      return hits.filter(Boolean)
    },

    /** Who we know about, for the "find people" view. */
    people () {
      const me = store.following(viewer)
      return store
        .knownAuthors()
        .filter((a) => a === viewer || !hidden(a))
        .map((a) => ({
          ...store.profile(a),
          posts: store.logs.get(a)?.length ?? 0,
          following: me.has(a),
          isSelf: a === viewer,
          followers: (store.followers.get(a) ?? new Set()).size
        }))
        .sort((a, b) => b.posts - a.posts)
    },

    /** Things addressed at the local user. */
    notifications (limit = 100) {
      const out = []
      const mine = new Set()
      for (const [id, e] of store.events) if (e.author === viewer) mine.add(id)

      for (const [id, e] of store.events) {
        if (e.author === viewer || hidden(e.author)) continue
        if (e.kind === 'reply' && (mine.has(e.content.parent) || mine.has(e.content.root))) {
          out.push({ type: 'reply', id, who: store.profile(e.author), ts: e.ts, text: e.content.text, target: e.content.root })
        } else if (e.kind === 'like' && mine.has(e.content.target)) {
          out.push({ type: e.content.value === 1 ? 'like' : 'dislike', id, who: store.profile(e.author), ts: e.ts, target: e.content.target })
        } else if (e.kind === 'follow' && e.content.target === viewer) {
          out.push({ type: 'follow', id, who: store.profile(e.author), ts: e.ts })
        } else if (e.kind === 'repost' && mine.has(e.content.target)) {
          out.push({ type: 'repost', id, who: store.profile(e.author), ts: e.ts, target: e.content.target })
        }
      }
      return out.sort((a, b) => b.ts - a.ts).slice(0, limit)
    },

    hydrate,
    visible
  }
}

export { isPostish }
