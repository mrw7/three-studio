// Dynamic Playwright + Chromium resolution. The committed harness must keep
// `node --test tests/*.mjs` free of Playwright (no static import anywhere under
// tests/e2e either) and must degrade to a clear SKIP when the package or a
// usable browser is missing.
import { access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
]

async function isFile(target) {
  try {
    const stat = await access(target, constants.R_OK)
    return stat === undefined
  } catch {
    return false
  }
}

async function playwrightCandidate(specifier) {
  try {
    if (specifier.startsWith('/') || specifier.startsWith('.')) {
      const absolute = path.resolve(specifier)
      let target = absolute
      try {
        const entries = await readdir(absolute)
        if (entries.includes('index.mjs')) target = path.join(absolute, 'index.mjs')
        else if (entries.includes('index.js')) target = path.join(absolute, 'index.js')
      } catch {
        // Not a directory, use as-is.
      }
      if (!(await isFile(target))) return null
      const module = await import(pathToFileURL(target).href)
      if (module.chromium) return { module, specifier: target, how: 'path' }
      return null
    }
    const module = await import(specifier)
    if (module.chromium) return { module, specifier, how: 'package' }
    return null
  } catch {
    return null
  }
}

/** Sibling host checkouts that may carry a hoisted Playwright install. */
async function siblingInstallRoots(env) {
  const roots = []
  if (env.HARNESS_ROOT) roots.push(path.resolve(env.HARNESS_ROOT, 'node_modules'))
  const parent = path.resolve(REPO_ROOT, '..')
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/harness/i.test(entry.name)) continue
      roots.push(path.join(parent, entry.name, 'node_modules'))
    }
  } catch {
    // Parent not readable.
  }
  return roots
}

/** Try the normal package, then an explicit module path, then sibling installs. */
export async function resolvePlaywright(env = process.env) {
  const attempts = [{ label: 'package', specifier: 'playwright' }]
  if (env.PLAYWRIGHT_MODULE) {
    attempts.push({ label: 'PLAYWRIGHT_MODULE', specifier: path.resolve(env.PLAYWRIGHT_MODULE) })
  }

  const siblingRoots = []
  for (const root of await siblingInstallRoots(env)) {
    siblingRoots.push(root, path.join(root, '.pnpm'))
  }
  for (const root of siblingRoots) {
    const direct = path.join(root, 'playwright', 'index.mjs')
    if (await isFile(direct)) attempts.push({ label: 'sibling', specifier: direct })
    try {
      const entries = await readdir(root)
      for (const entry of entries) {
        if (!entry.startsWith('playwright@')) continue
        const candidate = path.join(root, entry, 'node_modules', 'playwright', 'index.mjs')
        if (await isFile(candidate)) attempts.push({ label: 'sibling-pnpm', specifier: candidate })
      }
    } catch {
      // Root absent.
    }
  }

  for (const attempt of attempts) {
    const resolved = await playwrightCandidate(attempt.specifier)
    if (resolved) return { ok: true, ...resolved, attempts: attempts.map(a => a.label) }
  }
  return {
    ok: false,
    reason: 'Playwright package not found (tried package resolution, PLAYWRIGHT_MODULE, sibling host installs)',
    attempts: attempts.map(a => a.label),
  }
}

async function findChromiumIn(cacheRoot) {
  if (!cacheRoot) return null
  try {
    const entries = await readdir(cacheRoot)
    const versions = entries
      .filter(entry => entry.startsWith('chromium-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const version of versions) {
      for (const relative of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux/headless_shell']) {
        const candidate = path.join(cacheRoot, version, relative)
        if (await isFile(candidate)) return candidate
      }
    }
  } catch {
    // No cache.
  }
  return null
}

/** Locate a Chromium executable without launching it. */
export async function resolveChromium(env = process.env) {
  const explicit = env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || env.CHROMIUM_PATH
  if (explicit) {
    if (await isFile(explicit)) return { ok: true, executablePath: explicit, how: 'env' }
    return { ok: false, reason: 'configured Chromium executable does not exist' }
  }
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH,
    env.PLAYWRIGHT_BROWSERS_PATH === '0' ? null : path.join(homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean)
  for (const root of roots) {
    const executablePath = await findChromiumIn(root)
    if (executablePath) return { ok: true, executablePath, how: 'cache' }
  }
  return { ok: false, reason: 'no downloaded Playwright Chromium executable found' }
}

/** Browser env with desktop/proxy variables removed and local NSS for headless. */
export function launchEnv(env = process.env) {
  const next = { ...env }
  for (const key of [
    'DISPLAY', 'WAYLAND_DISPLAY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'WORKBENCH_URL', 'WORKBENCH_SHARE_URL',
  ]) delete next[key]
  next.NO_PROXY = '127.0.0.1,localhost'
  next.no_proxy = next.NO_PROXY
  const nss = path.join(REPO_ROOT, '.preview-tmp', 'nss', 'usr', 'lib', 'x86_64-linux-gnu')
  if (!next.LD_LIBRARY_PATH) next.LD_LIBRARY_PATH = nss
  return next
}

export { REPO_ROOT }
