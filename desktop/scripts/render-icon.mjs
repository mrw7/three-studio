#!/usr/bin/env node
/**
 * Render desktop/build/icon.svg to icon.png and a multi-size icon.ico.
 * Uses the repo's Playwright/Chromium resolver; no ImageMagick or Pillow.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { LAUNCH_ARGS, launchEnv, resolveChromium, resolvePlaywright } from '../../tests/e2e/lib/playwright.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(here, '..')
const buildDir = join(desktopRoot, 'build')
const svgPath = join(buildDir, 'icon.svg')

const sizes = [16, 24, 32, 48, 64, 128, 256]

function writeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + directory.length
  entries.forEach((entry, index) => {
    const base = index * 16
    directory[base] = entry.size >= 256 ? 0 : entry.size
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size
    directory[base + 2] = 0
    directory[base + 3] = 0
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.buffer.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.buffer.length
  })
  return Buffer.concat([header, directory, ...entries.map(entry => entry.buffer)])
}

// Standard 32-bit BMP/DIB ICO entry (not PNG-compressed). NSIS and Windows
// shell are most reliable with these, including for the uninstaller stub.
function icoBitmapEntry(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR + AND masks
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4, 20)
  header.writeInt32LE(0, 24)
  header.writeInt32LE(0, 28)
  header.writeUInt32LE(0, 32)
  header.writeUInt32LE(0, 36)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const src = ((size - 1 - y) * size + x) * 4
      const dst = (y * size + x) * 4
      pixels[dst] = rgba[src + 2]
      pixels[dst + 1] = rgba[src + 1]
      pixels[dst + 2] = rgba[src]
      pixels[dst + 3] = rgba[src + 3]
    }
  }
  const maskRowBytes = Math.ceil(size / 32) * 4
  const mask = Buffer.alloc(maskRowBytes * size)
  return Buffer.concat([header, pixels, mask])
}

const resolved = await resolvePlaywright(process.env)
const chromium = await resolveChromium(process.env)
if (!resolved.ok || !chromium.ok) {
  console.error('SKIP icon render - ' + (resolved.ok ? chromium.reason : resolved.reason))
  process.exit(1)
}

const svg = await readFile(svgPath, 'utf8')
const browser = await resolved.module.chromium.launch({
  headless: true,
  executablePath: chromium.executablePath,
  args: LAUNCH_ARGS,
  env: launchEnv(process.env),
})
try {
  await mkdir(buildDir, { recursive: true })
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await page.setContent(
    '<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:1024px;height:1024px}</style>' + svg,
    { waitUntil: 'load' },
  )
  const png = await page.screenshot({ omitBackground: true, type: 'png' })
  await writeFile(join(buildDir, 'icon.png'), png)
  const entries = []
  for (const size of sizes) {
    const rgba = await page.evaluate(async (pixelSize) => {
      const svgElement = document.querySelector('svg')
      const markup = new XMLSerializer().serializeToString(svgElement)
      const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
      try {
        const image = new Image()
        await new Promise((resolve, reject) => {
          image.onload = resolve
          image.onerror = reject
          image.src = url
        })
        const canvas = document.createElement('canvas')
        canvas.width = pixelSize
        canvas.height = pixelSize
        const context = canvas.getContext('2d')
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.clearRect(0, 0, pixelSize, pixelSize)
        context.drawImage(image, 0, 0, pixelSize, pixelSize)
        return Array.from(context.getImageData(0, 0, pixelSize, pixelSize).data)
      } finally {
        URL.revokeObjectURL(url)
      }
    }, size)
    entries.push({ size, buffer: icoBitmapEntry(size, rgba) })
  }
  await page.close()
  await writeFile(join(buildDir, 'icon.ico'), writeIco(entries))
  console.log(`Wrote ${join(buildDir, 'icon.png')} and ${join(buildDir, 'icon.ico')}`)
} finally {
  await browser.close()
}
