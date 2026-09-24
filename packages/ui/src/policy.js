/**
 * Where the app's rules live, and how it enforces them without a server.
 *
 * App stores require a social app to let people report content, block users,
 * agree to terms, and to show that someone can act on reports. A network with
 * no operator has no moderator to route any of that to, so this is the honest
 * version of each:
 *
 *   report     hides the thing on this device straight away, optionally blocks
 *              its author (a signed event, so it follows you to other devices),
 *              and optionally opens a pre-filled report to the maintainer.
 *   act on it  the maintainer publishes a plain JSON list of author and event
 *              ids as a static file. Apps fetch it and hide what is on it.
 *              It is advisory: it changes what *this* app shows and nothing
 *              else, it costs nothing to host, and it can be switched off in
 *              settings by anyone who would rather not follow it.
 *
 * Everything here is a static page or file on GitHub Pages - there is still
 * no server.
 */

const SITE = 'https://munerin2018.github.io/s2s'

export const TERMS_URL = `${SITE}/terms.html`
export const PRIVACY_URL = `${SITE}/privacy.html`
export const DELETION_URL = `${SITE}/delete-account.html`
export const MODERATION_URL = `${SITE}/moderation.json`

/** Bump when the terms change in a way people must agree to again. */
export const TERMS_VERSION = 1

export const REPORT_REASONS = [
  { key: 'spam', label: 'スパム・宣伝' },
  { key: 'harassment', label: '嫌がらせ・差別・脅迫' },
  { key: 'sexual', label: '性的なコンテンツ' },
  { key: 'violence', label: '暴力的・残酷なコンテンツ' },
  { key: 'illegal', label: '違法なコンテンツ' },
  { key: 'impersonation', label: 'なりすまし' },
  { key: 'other', label: 'その他' }
]

/**
 * A pre-filled report to the maintainer, as a GitHub issue form.
 *
 * Only identifiers go in it, never the content itself - the report is public,
 * and reposting what is being reported would spread it. The maintainer looks
 * the id up on their own peer.
 */
export function reportUrl ({ eventId, authorId, reason }) {
  const q = new URLSearchParams({
    template: 'report.yml',
    title: `[通報] ${REPORT_REASONS.find((r) => r.key === reason)?.label ?? reason}`,
    reason: reason ?? '',
    event: eventId ?? '',
    author: authorId ?? ''
  })
  return `https://github.com/munerin2018/s2s/issues/new?${q}`
}
