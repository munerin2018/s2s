/**
 * Pick the adapter that fits where this bundle is running.
 *
 * Exactly one bundle is shipped. On desktop, Electron injects `window.s2sBridge`
 * from the preload script and the peer lives in the main process. Everywhere
 * else - a browser tab, a phone's webview - the peer runs in the page itself.
 */
import { createIpcAdapter } from './ipc.js'

export async function createAdapter (opts = {}) {
  if (typeof window !== 'undefined' && window.s2sBridge) {
    return createIpcAdapter(window.s2sBridge)
  }
  const { createLocalAdapter } = await import('./local.js')
  return createLocalAdapter(opts)
}

/**
 * Peers the web build tries on first run.
 *
 * Empty by default, and that is deliberate: a default bootstrap list is the
 * thing that quietly turns "peer to peer" into "everyone depends on my server".
 * You paste in the address your own desktop app prints, or a friend's.
 */
export function savedBootstrapPeers () {
  try {
    return JSON.parse(localStorage.getItem('s2s.bootstrap') ?? '[]')
  } catch {
    return []
  }
}

export function saveBootstrapPeers (list) {
  try {
    localStorage.setItem('s2s.bootstrap', JSON.stringify(list.slice(0, 20)))
  } catch {
    // private browsing; the list simply will not persist
  }
}
