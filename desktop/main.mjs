/**
 * Three Studio desktop alpha.
 *
 * Electron is only the window and process supervisor. The Studio itself is the
 * existing loopback server, spawned with a Node 24 binary so the server and the
 * browser shell stay identical to the standalone build.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  LICENSE_FILE,
  licenseSummary,
  parseLicenseText,
  readPublicKey,
  verifyLicense,
} from './license/core.mjs'

app.setName('Three Studio')
app.setAppUserModelId('studio.three.workbench')

const APP_ROOT = app.isPackaged
  ? join(process.resourcesPath, 'app')
  : join(import.meta.dirname, '..')
const SERVER_ENTRY = join(APP_ROOT, 'standalone', 'server.mjs')

const TITLEBAR_COLORS = {
  dark: { color: '#121922', symbolColor: '#cbd5e1' },
  light: { color: '#f7f9fc', symbolColor: '#334155' },
}

let dataHome = null
let serverProcess = null
let serverPort = null
let mainWindow = null
let quitting = false
let licenseState = { active: false, edition: 'free', reason: 'not-loaded' }

const findFreePort = () => new Promise((resolvePort, reject) => {
  const probe = createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port
    probe.close(() => resolvePort(value))
  })
})

const waitForServer = async (url, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return
    } catch (error) { void error }
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
  }
  throw new Error(`Three Studio did not start within ${String(timeoutMs)} ms.`)
}

const applyTitleBarTheme = (theme) => {
  const resolved = theme === 'light' ? 'light' : 'dark'
  nativeTheme.themeSource = resolved
  if (process.platform !== 'win32' || mainWindow === null || mainWindow.isDestroyed()) return
  const palette = TITLEBAR_COLORS[resolved]
  try {
    mainWindow.setTitleBarOverlay({
      ...palette,
      height: 48,
    })
  } catch (error) {
    void error
  }
}

ipcMain.on('three-studio:theme', (event, theme) => {
  if (mainWindow === null || event.sender !== mainWindow.webContents) return
  applyTitleBarTheme(theme)
})

const studioDataHome = () => {
  if (dataHome === null) dataHome = join(app.getPath('userData'), 'data')
  return dataHome
}

const licenseFilePath = () => join(studioDataHome(), LICENSE_FILE)
const publicKeyPath = () => join(import.meta.dirname, 'license', 'public-key.pem')
const templatesDir = () => app.isPackaged
  ? join(APP_ROOT, 'templates')
  : join(import.meta.dirname, 'templates')

const setLicenseInactive = (reason, message = '') => {
  licenseState = { active: false, edition: 'free', reason, message }
  return licenseState
}

const refreshLicense = async () => {
  try {
    const publicKey = readPublicKey(publicKeyPath())
    let text
    try {
      text = await readFile(licenseFilePath(), 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return setLicenseInactive('none')
      throw error
    }
    const parsed = parseLicenseText(text)
    if (!parsed.ok) return setLicenseInactive(parsed.reason, parsed.message)
    const verified = verifyLicense(parsed.license, publicKey)
    if (!verified.ok) return setLicenseInactive(verified.reason, verified.message)
    licenseState = licenseSummary(verified.payload)
    return licenseState
  } catch (error) {
    return setLicenseInactive('error', 'The Pro license could not be checked.')
  }
}

const publicLicenseState = () => ({ ...licenseState })

const sendLicenseState = () => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('three-studio:license', publicLicenseState())
  }
}

const activateLicenseText = async (text) => {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64 * 1024) {
    return { ok: false, reason: 'size', message: 'License file is empty or too large.' }
  }
  let publicKey
  try {
    publicKey = readPublicKey(publicKeyPath())
  } catch (error) {
    return { ok: false, reason: 'public-key', message: 'This build cannot verify Pro licenses.' }
  }
  const parsed = parseLicenseText(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message }
  const verified = verifyLicense(parsed.license, publicKey)
  if (!verified.ok) return { ok: false, reason: verified.reason, message: verified.message }
  try {
    await mkdir(studioDataHome(), { recursive: true })
    await writeFile(licenseFilePath(), text, { mode: 0o600 })
  } catch (error) {
    return { ok: false, reason: 'storage', message: 'Could not save the license file.' }
  }
  licenseState = licenseSummary(verified.payload)
  sendLicenseState()
  buildMenu()
  return { ok: true, license: publicLicenseState() }
}

const removeLicenseFile = async () => {
  try {
    await rm(licenseFilePath(), { force: true })
  } catch (error) {
    return { ok: false, reason: 'storage', message: 'Could not remove the license file.' }
  }
  setLicenseInactive('none')
  sendLicenseState()
  buildMenu()
  return { ok: true, license: publicLicenseState() }
}

const openLicenseDialog = async () => {
  if (mainWindow === null) return
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Activate Three Studio Pro',
    filters: [{ name: 'Three Studio License', extensions: ['tslicense', 'json'] }],
    properties: ['openFile'],
  })
  if (picked.canceled || picked.filePaths.length === 0) return
  let text
  try {
    text = await readFile(picked.filePaths[0], 'utf8')
  } catch (error) {
    dialog.showErrorBox('License not activated', 'The selected license file could not be read.')
    return
  }
  const result = await activateLicenseText(text)
  if (!result.ok) {
    dialog.showErrorBox('License not activated', result.message || result.reason)
    return
  }
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Three Studio Pro activated',
    message: `Pro license active for ${result.license.customer}`,
    detail: result.license.expiresAt === null
      ? `${String(result.license.seats)} seat(s), perpetual.`
      : `${String(result.license.seats)} seat(s), expires ${new Date(result.license.expiresAt).toLocaleDateString()}.`,
  })
}

const showLicenseStatus = async () => {
  if (licenseState.active) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Three Studio Pro',
      message: `Active for ${licenseState.customer}`,
      detail: `${String(licenseState.seats)} seat(s) · ${licenseState.features.join(', ')}\n`
        + (licenseState.expiresAt === null
          ? 'Perpetual license.'
          : `Expires ${new Date(licenseState.expiresAt).toLocaleDateString()}.`),
    })
    return
  }
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Three Studio Free',
    message: 'No Pro license is active.',
    detail: 'Use Help → Activate Three Studio Pro to load a signed .tslicense file.',
  })
}

const openTemplates = async () => {
  if (!licenseState.active || !licenseState.features.includes('templates')) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Three Studio Pro',
      message: 'The Pro template pack requires an active license.',
      detail: 'Use Help → Activate Three Studio Pro.',
    })
    return
  }
  const base = templatesDir()
  const pro = join(base, 'pro')
  const target = existsSync(pro) ? pro : base
  const error = await shell.openPath(target)
  if (error !== '') dialog.showErrorBox('Could not open templates', error)
}

const licenseSenderOk = event => mainWindow !== null && event.sender === mainWindow.webContents

ipcMain.handle('three-studio:license:get', event => (
  licenseSenderOk(event) ? publicLicenseState() : { active: false, edition: 'free', reason: 'denied' }
))
ipcMain.handle('three-studio:license:activate', async (event, text) => {
  if (!licenseSenderOk(event)) return { ok: false, reason: 'denied', message: 'Permission denied.' }
  return activateLicenseText(text)
})
ipcMain.handle('three-studio:license:remove', async (event) => {
  if (!licenseSenderOk(event)) return { ok: false, reason: 'denied', message: 'Permission denied.' }
  return removeLicenseFile()
})
ipcMain.handle('three-studio:license:manage', async (event) => {
  if (!licenseSenderOk(event)) return false
  await openLicenseDialog()
  return true
})

const nodeBinary = () => {
  const executable = process.platform === 'win32' ? 'node.exe' : 'node'
  const bundled = app.isPackaged
    ? join(APP_ROOT, 'vendor', 'node', `${process.platform}-${process.arch}`, executable)
    : join(import.meta.dirname, 'vendor', 'node', `${process.platform}-${process.arch}`, executable)
  const candidates = [
    bundled,
    process.env.THREE_STUDIO_NODE,
    join(homedir(), '.local', 'node24', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    process.platform === 'win32' && process.env.ProgramFiles
      ? join(process.env.ProgramFiles, 'nodejs', 'node.exe')
      : null,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

const startServer = async () => {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(`Server entry not found: ${SERVER_ENTRY}`)
  }
  serverPort = Number(process.env.THREE_STUDIO_PORT || await findFreePort())
  const home = studioDataHome()
  serverProcess = spawn(nodeBinary(), [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      THREE_STUDIO_PORT: String(serverPort),
      THREE_STUDIO_HOME: home,
      THREE_WORKBENCH_DATA_DIR: join(home, 'scenes'),
      // macOS/Windows use the portable snapshot store automatically; this
      // also makes a Linux desktop build exercise the same path when asked.
      ...(process.env.THREE_STUDIO_PORTABLE_STORE === undefined
        ? { THREE_STUDIO_PORTABLE_STORE: process.platform === 'linux' ? '0' : '1' }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  serverProcess.stdout.on('data', chunk => { output += chunk })
  serverProcess.stderr.on('data', chunk => { output += chunk })
  serverProcess.on('exit', code => {
    if (quitting) return
    dialog.showErrorBox('Three Studio server stopped',
      `The local server exited with code ${String(code)}.\n\n${output.slice(-4000)}`)
    app.quit()
  })
  await waitForServer(`http://127.0.0.1:${String(serverPort)}/`)
  return serverPort
}

const createWindow = async () => {
  const base = `http://127.0.0.1:${String(serverPort)}/`
  const platformChrome = process.platform === 'win32'
    ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { ...TITLEBAR_COLORS.dark, height: 48 },
      }
    : process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 14, y: 18 },
        }
      : {}
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#080b10',
    title: 'Three Studio',
    icon: join(import.meta.dirname, 'build', 'icon.png'),
    autoHideMenuBar: process.platform !== 'darwin',
    ...platformChrome,
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === base || url.startsWith(base)) return
    event.preventDefault()
    if (/^https?:/iu.test(url)) void shell.openExternal(url)
  })
  await mainWindow.loadURL(base)
}

const buildMenu = () => {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: licenseState.active ? 'Three Studio Pro (active)' : 'Three Studio Free',
          click: () => { void showLicenseStatus() },
        },
        {
          label: 'Activate Three Studio Pro…',
          click: () => { void openLicenseDialog() },
        },
        {
          label: 'Remove Pro license',
          enabled: licenseState.active,
          click: async () => {
            const confirmation = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              buttons: ['Cancel', 'Remove'],
              defaultId: 0,
              cancelId: 0,
              message: 'Remove the Pro license from this computer?',
              detail: 'The local editor keeps working in Free mode; the Pro badge and template pack are disabled.',
            })
            if (confirmation.response === 1) await removeLicenseFile()
          },
        },
        {
          label: 'Open Pro templates',
          enabled: licenseState.active,
          click: () => { void openTemplates() },
        },
        { type: 'separator' },
        {
          label: 'Open data folder',
          click: () => { void shell.openPath(studioDataHome()) },
        },
        {
          label: 'Three Studio documentation',
          click: () => { void shell.openExternal('https://github.com/mrw7/three-studio') },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const shutdown = () => {
  quitting = true
  if (serverProcess !== null) {
    try { serverProcess.kill('SIGTERM') } catch (error) { void error }
    serverProcess = null
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(async () => {
    try {
      await refreshLicense()
      await startServer()
      buildMenu()
      await createWindow()
    } catch (error) {
      dialog.showErrorBox('Three Studio failed to start',
        `${error instanceof Error ? error.message : String(error)}\n\n` +
        'The desktop alpha needs Node.js 24 on PATH, or set THREE_STUDIO_NODE to a Node 24 binary.')
      app.quit()
    }
  })
  app.on('before-quit', shutdown)
  app.on('window-all-closed', () => { app.quit() })
}
