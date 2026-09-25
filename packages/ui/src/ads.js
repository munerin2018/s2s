// Banner ads shown while scrolling the timeline.
//
// S2S has no server, so this is the one piece of the app that talks to an
// outside company (Google) by design. It only runs on the native Android
// build (Capacitor) - on desktop and the web/PWA build the underlying
// plugin is a no-op, so this module is safe to import everywhere.
//
// The IDs below are Google's public TEST IDs. They only ever serve test
// ads and never earn money - this is intentional for closed testing and
// review. Before a real (non-test) release, create an AdMob account,
// create an app + banner ad unit for S2S, and replace:
//   - the App ID in apps/mobile/android/app/src/main/AndroidManifest.xml
//   - AD_UNIT_ID below

import { AdMob, BannerAdPosition, BannerAdSize } from '@capacitor-community/admob'
import { Capacitor } from '@capacitor/core'

const AD_UNIT_ID = 'ca-app-pub-3940256099942544/6300978111' // Google test banner unit (Android)

// Every Nth item in the timeline is an ad slot instead of a post.
export const AD_EVERY = 5

let ready = null

function init () {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(false)
  if (!ready) {
    ready = AdMob.initialize({ initializeForTesting: true })
      .then(() => true)
      .catch(() => false)
  }
  return ready
}

// Tracks which ad slot (by index) is currently the one showing, so we
// don't re-request an ad every time React re-renders the feed.
let activeSlot = null
let hideTimer = null

export async function showBannerForSlot (slotIndex) {
  if (!(await init())) return
  if (activeSlot === slotIndex) return
  clearTimeout(hideTimer)
  activeSlot = slotIndex
  try {
    await AdMob.showBanner({
      adId: AD_UNIT_ID,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      isTesting: true
    })
  } catch {
    // Ad failed to load (offline, no fill, etc). Not fatal - the in-feed
    // placeholder card still reserves its place, just without a live ad.
  }
}

export async function hideBannerIfSlot (slotIndex) {
  if (!(await init())) return
  if (activeSlot !== slotIndex) return
  // Small delay so scrolling past one ad slot straight into the next
  // doesn't hide-then-immediately-reshow the banner.
  clearTimeout(hideTimer)
  hideTimer = setTimeout(async () => {
    if (activeSlot !== slotIndex) return
    activeSlot = null
    try { await AdMob.hideBanner() } catch { /* ignore */ }
  }, 400)
}
