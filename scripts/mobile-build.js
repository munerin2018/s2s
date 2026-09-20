#!/usr/bin/env node
/**
 * Build the Android APK.
 *
 * Capacitor wraps the same static bundle the web version uses, so the phone
 * runs the in-page peer: WebSocket and WebRTC only, no mDNS. It reaches the
 * network through whichever peer you point it at - normally the desktop app on
 * your own Wi-Fi.
 *
 * Gradle needs a JDK 21 or newer for Capacitor 8, and the Android SDK. Both are
 * located here rather than assumed, because getting either wrong produces an
 * error message that says nothing useful.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const androidDir = join(root, 'apps', 'mobile', 'android')

// `npx` and `gradlew.bat` are batch files on Windows, which need a shell; the
// arguments here are all built by this script, never taken from input.
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts })

/** Newest JDK on this machine that is at least version 21. */
function findJdk () {
  if (process.env.JAVA_HOME && jdkMajor(process.env.JAVA_HOME) >= 21) return process.env.JAVA_HOME

  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    '/usr/lib/jvm'
  ]
  const found = []
  for (const dir of roots) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const major = jdkMajor(path)
      if (major >= 21) found.push({ path, major })
    }
  }
  found.sort((a, b) => b.major - a.major)
  return found[0]?.path ?? null
}

function jdkMajor (home) {
  if (!existsSync(join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'))) return 0
  const m = /(?:jdk-?|-)(\d+)/.exec(home)
  return m ? Number(m[1]) : 0
}

function findSdk () {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    process.env.HOME && join(process.env.HOME, 'Android', 'Sdk')
  ].filter(Boolean)
  return candidates.find((p) => existsSync(join(p, 'platform-tools'))) ?? null
}

const jdk = findJdk()
const sdk = findSdk()

if (!jdk) {
  console.error('Could not find a JDK 21 or newer. Capacitor 8 needs one to compile.')
  process.exit(1)
}
if (!sdk) {
  console.error('Could not find the Android SDK. Set ANDROID_HOME and try again.')
  process.exit(1)
}

console.log(`JDK          ${jdk}`)
console.log(`Android SDK  ${sdk}\n`)

console.log('building the web bundle…')
run('npx', ['vite', 'build', 'packages/ui'])

// The Android project is generated rather than committed, so a fresh clone has
// to create it before anything can be copied into it.
if (!existsSync(join(androidDir, 'gradlew.bat')) && !existsSync(join(androidDir, 'gradlew'))) {
  console.log('\ncreating the Android project (first run)…')
  run('npx', ['cap', 'add', 'android'], { env: { ...process.env, ANDROID_HOME: sdk } })
}

console.log('\ncopying the bundle into the Android project…')
run('npx', ['cap', 'copy', 'android'], { env: { ...process.env, ANDROID_HOME: sdk } })

// Gradle reads the SDK location from here; forward slashes sidestep the
// escaping rules of .properties files. Written after the project exists.
writeFileSync(join(androidDir, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`)

console.log('\nrunning gradle…')
// Windows does not search the working directory for executables, so the
// wrapper has to be named relative to it explicitly.
const gradlew = process.platform === 'win32' ? join(androidDir, 'gradlew.bat') : './gradlew'
run(gradlew, ['assembleDebug'], {
  cwd: androidDir,
  env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk }
})

const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
console.log(`\nAPK: ${apk}`)
console.log('install it with:')
console.log(`  "${join(sdk, 'platform-tools', 'adb')}" install -r "${apk}"`)
