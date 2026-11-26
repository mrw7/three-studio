import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const site = join(repo, 'site')
const demos = [
  'one-minute-demo',
  'agency-demo',
  'configurator-demo',
  'education-demo',
  'nebula-demo',
  'kinetic-demo',
  'audio-demo',
  'data-demo',
  'atrium-demo',
]

test('demo gallery links nine runnable, offline demos', async () => {
  const gallery = await readFile(join(site, 'index.html'), 'utf8')
  for (const id of demos) {
    assert.match(gallery, new RegExp(`href="\\./${id}/"`), `gallery links ${id}`)
    for (const file of ['index.html', 'main.js', 'styles.css', 'preview.png', 'README.md']) {
      await access(join(site, id, file))
    }
    const html = await readFile(join(site, id, 'index.html'), 'utf8')
    assert.match(html, /"three": "\.\.\/runtime\/three\.module\.js"/, `${id} uses the shared runtime`)
    assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg\.com|fonts\.googleapis/, `${id} has no CDN dependency`)
  }
  for (const file of ['three.module.js', 'three.core.js', 'OrbitControls.js', 'exporters/GLTFExporter.js']) {
    await access(join(site, 'runtime', file))
  }
})

test('configurator demo exposes live options and GLB export', async () => {
  const html = await readFile(join(site, 'configurator-demo', 'index.html'), 'utf8')
  const main = await readFile(join(site, 'configurator-demo', 'main.js'), 'utf8')
  for (const value of ['sand', 'graphite', 'forest', 'chrome', 'cone', 'dome', 'warm', 'neutral', 'cool']) {
    assert.match(html, new RegExp(`data-(?:finish|shade|temp)="${value}"`), `option ${value}`)
  }
  assert.match(main, /new GLTFExporter/)
  assert.match(main, /lumen-config\.glb/)
  assert.match(main, /BASE_PRICE/)
})

test('one-minute film has a 60-second timeline and playback controls', async () => {
  const html = await readFile(join(site, 'one-minute-demo', 'index.html'), 'utf8')
  const main = await readFile(join(site, 'one-minute-demo', 'main.js'), 'utf8')
  assert.match(main, /const DURATION = 60/)
  assert.match(main, /const CHAPTERS = \[/)
  assert.match(main, /requestAnimationFrame/)
  assert.match(main, /prefers-reduced-motion/)
  assert.match(main, /applyTimeline/)
  for (const id of ['play', 'progress', 'replay', 'fullscreen']) {
    assert.match(html, new RegExp(`id="${id}"`), `film control ${id}`)
  }
  assert.match(html, /id="chapter-name"/)
  assert.match(html, /id="end-card"/)
})

test('demo prices are English and tiered', async () => {
  const gallery = await readFile(join(site, 'index.html'), 'utf8')
  const i18n = await readFile(join(site, 'i18n.js'), 'utf8')
  const main = await readFile(join(site, 'configurator-demo', 'main.js'), 'utf8')
  for (const price of [
    "'2-week sprint · from $3.5k'",
    "'4–6 weeks · from $13k'",
    "'Workshop · from $590'",
    "'Single scene: 2 weeks · $3.5k–6k · responsive · performance pass · code handoff'",
    "'Design + modeling: 2 weeks · $6k–9k · visual and model adaptation included'",
    "'MVP: 4–6 weeks · $13k–22k · materials/lighting/pricing/GLB'",
    "'Commerce/CPQ/AR integration: $22k–45k+ · quoted by scope'",
    "'90 minutes: $590 · team intro'",
    "'Half day: $950 · 3–4 hour hands-on'",
    "'Full day: $1,500–2,200 · hands-on workshop'",
    "'2 days: $2,800–4,100 · prompt to production'",
  ]) {
    assert.ok(i18n.includes(price), `English price ${price}`)
  }
  // Tiered USD list prices render on the page itself, not only in the
  // dictionary, so a visitor reading the English gallery sees them.
  for (const price of [
    '$3.5k–6k',
    '$6k–10k',
    '$13k–22k',
    '$22k–45k+',
    '$1,450–2,100',
    '$2,700–4,000',
  ]) {
    assert.ok(gallery.includes(price), `USD tier renders on the page: ${price}`)
  }
  // No CNY price may survive on any demo page now that the gallery is English.
  assert.ok(!gallery.includes('¥'), 'index.html carries no CNY list prices')
  for (const demo of ['agency-demo', 'configurator-demo', 'education-demo']) {
    const html = await readFile(join(site, demo, 'index.html'), 'utf8')
    const js = await readFile(join(site, demo, 'main.js'), 'utf8')
    assert.ok(!html.includes('¥'), demo + ' page carries no CNY prices')
  }
  for (const stale of ['$25k–50k', '$60k–150k', '$3k–8k/day', '$4.5k–9k', '$13k–28k', '$700–1,800/day']) {
    assert.ok(!i18n.includes(stale), `stale symbol-swapped price ${stale}`)
  }
  for (const stale of ['¥25k–50k', '¥60k–150k', '¥3k–8k/天']) {
    assert.ok(!gallery.includes(stale), `stale Chinese price ${stale}`)
    assert.ok(!i18n.includes(stale), `stale Chinese price ${stale}`)
  }
  assert.ok(main.includes("currency: 'USD'"), 'LUMEN has a USD price list')
  assert.ok(main.includes('base: 149'), 'LUMEN USD base price')
  assert.ok(main.includes('add: { forest: 15, chrome: 30, dome: 22 }'), 'LUMEN USD add-ons')
  assert.ok(main.includes('currency: priceTable().currency'), 'config JSON uses the active currency')
})

test('motion demos use shaders and physical materials', async () => {
  const nebula = await readFile(join(site, 'nebula-demo', 'main.js'), 'utf8')
  const kinetic = await readFile(join(site, 'kinetic-demo', 'main.js'), 'utf8')
  assert.match(nebula, /ShaderMaterial/)
  assert.match(nebula, /vertexShader/)
  assert.match(nebula, /AdditiveBlending/)
  assert.match(nebula, /COUNT = isMobile \?/)
  assert.match(kinetic, /MeshPhysicalMaterial/)
  assert.match(kinetic, /iridescence/)
  assert.match(kinetic, /PMREMGenerator/)
  assert.match(kinetic, /TorusKnotGeometry/)
})

test('audio, data and spatial demos use their real APIs', async () => {
  const audio = await readFile(join(site, 'audio-demo', 'main.js'), 'utf8')
  const data = await readFile(join(site, 'data-demo', 'main.js'), 'utf8')
  const atrium = await readFile(join(site, 'atrium-demo', 'main.js'), 'utf8')
  assert.match(audio, /AnalyserNode|createAnalyser/)
  assert.match(audio, /getUserMedia/)
  assert.match(audio, /InstancedMesh/)
  assert.match(data, /QuadraticBezierCurve3/)
  assert.match(data, /latLonToVector/)
  assert.match(data, /ROUTES = \[/)
  assert.match(atrium, /CatmullRomCurve3/)
  assert.match(atrium, /TorusKnotGeometry/)
  assert.match(atrium, /makeArtTexture/)
})

test('education demo has four steps and matching code panel', async () => {
  const html = await readFile(join(site, 'education-demo', 'index.html'), 'utf8')
  const main = await readFile(join(site, 'education-demo', 'main.js'), 'utf8')
  for (let step = 0; step < 4; step += 1) {
    assert.match(html, new RegExp(`data-step="${step}"`))
  }
  assert.match(main, /const STEPS = \[/)
  assert.match(main, /moonOrbit/)
  assert.match(main, /SUN|sunGroup/)
})
