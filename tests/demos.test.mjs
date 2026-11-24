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
