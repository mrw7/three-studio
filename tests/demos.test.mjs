import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const site = join(repo, 'site')
const demos = [
  'agency-demo',
  'configurator-demo',
  'education-demo',
  'nebula-demo',
  'kinetic-demo',
  'audio-demo',
  'data-demo',
  'atrium-demo',
]

test('demo gallery links eight runnable, offline demos', async () => {
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

test('English demo prices are localized and tiered', async () => {
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
  for (const price of [
    '¥1.5万–2.5万',
    '¥2.5万–4万',
    '¥6万–10万',
    '¥10万–20万+',
    '¥2,980',
    '¥4,800',
    '¥6,800–9,800',
    '¥12,800–18,800',
  ]) {
    assert.ok(gallery.includes(price), `Chinese tier ${price}`)
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
