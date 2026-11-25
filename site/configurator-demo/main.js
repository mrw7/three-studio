import * as THREE from 'three'
import { t, language } from '../i18n.js'
import { OrbitControls } from 'three/addons/OrbitControls.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'

const canvas = document.getElementById('scene')
const viewer = canvas.parentElement
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.15
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x0b0907)
scene.fog = new THREE.Fog(0x0b0907, 13, 25)

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100)
camera.position.set(4.6, 3.6, 5.8)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 1.45, 0)
controls.enableDamping = true
controls.dampingFactor = 0.07
controls.minDistance = 3.8
controls.maxDistance = 9
controls.maxPolarAngle = Math.PI * 0.52
controls.enablePan = false
controls.autoRotate = true
controls.autoRotateSpeed = 0.45
controls.update()
controls.addEventListener('start', () => { controls.autoRotate = false })

function makeEnvironment() {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 512
  const g = c.getContext('2d')
  const gradient = g.createLinearGradient(0, 0, 0, 512)
  gradient.addColorStop(0, '#24170f')
  gradient.addColorStop(0.48, '#0e0b08')
  gradient.addColorStop(1, '#050403')
  g.fillStyle = gradient
  g.fillRect(0, 0, 1024, 512)
  const blob = (x, y, r, color, alpha) => {
    const glow = g.createRadialGradient(x, y, 0, x, y, r)
    glow.addColorStop(0, color)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    g.globalAlpha = alpha
    g.fillStyle = glow
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
    g.globalAlpha = 1
  }
  blob(260, 120, 220, '#fff3dc', 0.95)
  blob(760, 160, 170, '#ffd7a0', 0.65)
  blob(520, 360, 300, '#b56b2d', 0.32)
  blob(80, 330, 130, '#6f8dff', 0.18)
  const texture = new THREE.CanvasTexture(c)
  texture.mapping = THREE.EquirectangularReflectionMapping
  texture.colorSpace = THREE.SRGBColorSpace
  const pmrem = new THREE.PMREMGenerator(renderer)
  const environment = pmrem.fromEquirectangular(texture).texture
  texture.dispose()
  pmrem.dispose()
  return environment
}
scene.environment = makeEnvironment()

scene.add(new THREE.HemisphereLight(0xffe5c4, 0x120c08, 0.6))

const key = new THREE.DirectionalLight(0xfff1df, 2.6)
key.position.set(4.5, 6.5, 4.2)
key.castShadow = true
key.shadow.mapSize.set(1024, 1024)
key.shadow.camera.near = 1
key.shadow.camera.far = 22
key.shadow.camera.left = -5
key.shadow.camera.right = 5
key.shadow.camera.top = 5
key.shadow.camera.bottom = -5
key.shadow.bias = -0.0008
key.shadow.normalBias = 0.02
key.shadow.camera.updateProjectionMatrix()
scene.add(key)

const rim = new THREE.DirectionalLight(0x6f8dff, 1.2)
rim.position.set(-4.5, 3.3, -4)
scene.add(rim)

const metalMat = new THREE.MeshPhysicalMaterial({
  color: 0xd8c5a4,
  metalness: 0.28,
  roughness: 0.5,
  clearcoat: 0.55,
  clearcoatRoughness: 0.22,
  envMapIntensity: 1.25,
  // FrontSide only. A double-sided highly reflective shell makes its own inner
  // wall mirror the outer one, which is what produced the moiré bands on the
  // shade; the inner surface is now a separate matte cone.
  side: THREE.FrontSide,
})
const bulbMat = new THREE.MeshStandardMaterial({
  color: 0xfff1d0,
  emissive: 0xffa34d,
  emissiveIntensity: 2.4,
  roughness: 0.3,
})
const glowMat = new THREE.MeshBasicMaterial({
  color: 0xffb25e,
  transparent: true,
  opacity: 0.26,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
})
const darkMat = new THREE.MeshStandardMaterial({ color: 0x17120d, metalness: 0.6, roughness: 0.5 })

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(10, 96),
  new THREE.MeshStandardMaterial({ color: 0x0c0907, metalness: 0.15, roughness: 0.72 }),
)
floor.rotation.x = -Math.PI / 2
floor.position.y = -0.012
floor.receiveShadow = true
scene.add(floor)

const ring = new THREE.Mesh(
  new THREE.TorusGeometry(2.7, 0.008, 8, 160),
  new THREE.MeshBasicMaterial({ color: 0x6f8dff, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false }),
)
ring.rotation.x = -Math.PI / 2
ring.position.y = 0.004
scene.add(ring)

const lamp = new THREE.Group()
lamp.position.y = 0.02
scene.add(lamp)

// The product is a lathe-turned metal lamp: every part is a profile revolved
// around Y, so the body has a real chamfer, lip and wall thickness instead of
// stacked cylinders. `metalMat` carries the configurable finish; `innerMat` is
// the matt white reflector and must never take the body finish.
const innerMat = new THREE.MeshStandardMaterial({
  color: 0xf6efe2,
  metalness: 0.0,
  roughness: 0.92,
  envMapIntensity: 0.5,
  side: THREE.DoubleSide,
})

function lathe(profile, material, segments = 96) {
  const points = profile.map(([radius, height]) => new THREE.Vector2(radius, height))
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(points, segments), material)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

// Cast base: flat underside, chamfered edge, domed top rising into a collar.
const base = lathe([
  [0.00, 0.00], [1.34, 0.00], [1.44, 0.035], [1.45, 0.090],
  [1.41, 0.150], [1.30, 0.196], [1.10, 0.226], [0.84, 0.242],
  [0.62, 0.258], [0.46, 0.310], [0.34, 0.372], [0.22, 0.404],
  [0.13, 0.414], [0.00, 0.414],
], metalMat)
lamp.add(base)

// Turned collar the stem screws into, plus a dark seam ring for definition.
const collar = lathe([
  [0.000, 0.400], [0.150, 0.400], [0.150, 0.452], [0.128, 0.470],
  [0.104, 0.470], [0.098, 0.452], [0.098, 0.400], [0.000, 0.400],
], metalMat)
lamp.add(collar)

const baseRing = new THREE.Mesh(new THREE.TorusGeometry(0.60, 0.010, 8, 96), darkMat)
baseRing.rotation.x = Math.PI / 2
baseRing.position.y = 0.262
lamp.add(baseRing)

// Stem: slight taper, a knurled band, and a machined shoulder at the top.
const stem = lathe([
  [0.000, 0.440], [0.094, 0.440], [0.088, 0.470], [0.080, 1.90],
  [0.086, 1.96], [0.096, 2.02], [0.104, 2.10], [0.104, 2.16],
  [0.086, 2.20], [0.000, 2.20],
], metalMat)
lamp.add(stem)

const knurl = new THREE.Mesh(new THREE.CylinderGeometry(0.088, 0.088, 0.10, 32, 1, true), darkMat)
knurl.position.y = 1.02
lamp.add(knurl)

// Shoulder + pivot joint.
const shoulder = lathe([
  [0.000, 2.16], [0.104, 2.16], [0.140, 2.20], [0.150, 2.26],
  [0.132, 2.31], [0.060, 2.325], [0.000, 2.325],
], metalMat)
lamp.add(shoulder)

const joint = new THREE.Mesh(new THREE.SphereGeometry(0.145, 32, 20), metalMat)
joint.position.y = 2.335
joint.castShadow = true
lamp.add(joint)

const jointPin = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.36, 20), darkMat)
jointPin.rotation.z = Math.PI / 2
jointPin.position.y = 2.335
lamp.add(jointPin)

const armPivot = new THREE.Group()
armPivot.position.set(0, 2.335, 0)
armPivot.rotation.z = -0.28
lamp.add(armPivot)

// Tapered arm with a counterweight behind the pivot, which is what makes a
// balanced task lamp read as a real mechanism rather than a floating stick.
const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.070, 1.52, 24), metalMat)
arm.rotation.z = Math.PI / 2
arm.position.x = 0.76
arm.castShadow = true
arm.receiveShadow = true
armPivot.add(arm)

const armEnd = new THREE.Mesh(new THREE.SphereGeometry(0.082, 24, 16), metalMat)
armEnd.position.x = 1.52
armEnd.castShadow = true
armPivot.add(armEnd)

// Counterweight behind the pivot. The lathe profile revolves around Y, so it is
// rotated to sit on the arm's -X axis; without the z spin its cap faced sideways
// and the weight read as a floating disc rather than a turned knob.
const weight = lathe([
  [0.000, 0.000], [0.118, 0.000], [0.118, 0.052], [0.104, 0.074],
  [0.064, 0.086], [0.000, 0.086],
], darkMat, 48)
weight.rotation.z = Math.PI / 2
weight.position.set(-0.30, 0, 0)
armPivot.add(weight)

const shadeGroup = new THREE.Group()
shadeGroup.position.set(1.52, 0, 0)
shadeGroup.rotation.z = 0.175
armPivot.add(shadeGroup)

const shadeNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.135, 0.16, 28), metalMat)
shadeNeck.position.y = 0.05
shadeNeck.castShadow = true
shadeGroup.add(shadeNeck)

// Conical shade: outer metal shell + inner matte reflector, 30 mm apart.
//
// Two failed attempts are worth recording. A single closed lathe rendered as
// concentric moiré rings, because the metal is double-sided and highly
// reflective, so the inner and outer walls reflected each other. Two shells
// only 2 mm apart still z-fought. The shade is therefore an open outer cone
// (metal, front faces) plus a separate open inner cone (matte white, back
// faces) with a full 30 mm of air between them — which is also how a real lamp
// shade is built.
const SHADE_WALL = 0.030
const coneOuter = [
  [0.170, 0.020], [0.300, -0.120], [0.430, -0.280], [0.545, -0.450], [0.596, -0.575],
]
const coneShade = lathe(coneOuter, metalMat)
shadeGroup.add(coneShade)

const coneInner = lathe(
  coneOuter.map(([radius, height]) => [radius - SHADE_WALL, height + SHADE_WALL * 0.5]),
  innerMat,
)
shadeGroup.add(coneInner)

const coneRim = new THREE.Mesh(new THREE.TorusGeometry(0.583, 0.014, 10, 96), darkMat)
coneRim.rotation.x = Math.PI / 2
coneRim.position.y = -0.586
shadeGroup.add(coneRim)

// Dome shade: the same two-shell construction, hemispherical.
const domeOuter = [
  [0.590, -0.600], [0.582, -0.500], [0.552, -0.360], [0.472, -0.200],
  [0.342, -0.060], [0.186, 0.030],
]
const domeShade = lathe(domeOuter, metalMat)
domeShade.visible = false
shadeGroup.add(domeShade)

const domeInner = lathe(
  domeOuter.map(([radius, height]) => [radius - SHADE_WALL, height + SHADE_WALL * 0.5]),
  innerMat,
)
domeInner.visible = false
shadeGroup.add(domeInner)

const domeRim = new THREE.Mesh(new THREE.TorusGeometry(0.560, 0.014, 10, 96), darkMat)
domeRim.rotation.x = Math.PI / 2
domeRim.position.y = -0.598
domeRim.visible = false
shadeGroup.add(domeRim)

// Bulb sits behind a frosted diffuser disc so the light source has a body and
// the glow sprite is not the only thing reading.
const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.135, 28, 20), bulbMat)
bulb.position.y = -0.38
shadeGroup.add(bulb)

const diffuser = new THREE.Mesh(new THREE.CircleGeometry(0.175, 40), innerMat)
diffuser.rotation.x = -Math.PI / 2
diffuser.position.y = -0.30
shadeGroup.add(diffuser)

const glow = new THREE.Mesh(new THREE.CircleGeometry(0.52, 48), glowMat)
glow.rotation.x = Math.PI / 2
glow.position.y = -0.6
shadeGroup.add(glow)

const lampLight = new THREE.PointLight(0xffa34d, 30, 8, 2)
lampLight.position.set(0, -0.38, 0)
shadeGroup.add(lampLight)

const cableCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-1.0, 0.03, 0.5),
  new THREE.Vector3(-1.8, 0.03, 1.0),
  new THREE.Vector3(-2.6, 0.03, 0.8),
  new THREE.Vector3(-3.2, 0.03, 1.5),
])
const cable = new THREE.Mesh(
  new THREE.TubeGeometry(cableCurve, 64, 0.022, 8, false),
  new THREE.MeshStandardMaterial({ color: 0x15110d, roughness: 0.8, metalness: 0.1 }),
)
cable.castShadow = true
scene.add(cable)

const shadowCanvas = document.createElement('canvas')
shadowCanvas.width = 512
shadowCanvas.height = 512
const shadowContext = shadowCanvas.getContext('2d')
const shadowGradient = shadowContext.createRadialGradient(256, 256, 0, 256, 256, 256)
shadowGradient.addColorStop(0, 'rgba(0,0,0,0.65)')
shadowGradient.addColorStop(0.55, 'rgba(0,0,0,0.22)')
shadowGradient.addColorStop(1, 'rgba(0,0,0,0)')
shadowContext.fillStyle = shadowGradient
shadowContext.fillRect(0, 0, 512, 512)
const shadowTexture = new THREE.CanvasTexture(shadowCanvas)
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(3.8, 3.8),
  new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
)
contact.rotation.x = -Math.PI / 2
contact.position.y = 0.002
scene.add(contact)

const FINISHES = {
  sand: { label: 'Sand', color: 0xd8c5a4, metalness: 0.28, roughness: 0.5, env: 1.25 },
  graphite: { label: 'Graphite', color: 0x2b3037, metalness: 0.82, roughness: 0.32, env: 1.5 },
  forest: { label: 'Forest', color: 0x2f4a3a, metalness: 0.42, roughness: 0.42, env: 1.35 },
  chrome: { label: 'Chrome', color: 0xdbe2ea, metalness: 1.0, roughness: 0.08, env: 1.9 },
}
const SHADES = {
  cone: { label: 'Cone' },
  dome: { label: 'Dome' },
}
const TEMPS = {
  warm: { label: '2700K', light: 0xffa34d, bulb: 0xffb25e, glow: 0xffb25e, intensity: 30 },
  neutral: { label: '4000K', light: 0xffd9a8, bulb: 0xffe3bd, glow: 0xffd9a8, intensity: 27 },
  cool: { label: '5600K', light: 0xbfe0ff, bulb: 0xd8ecff, glow: 0xbfe0ff, intensity: 24 },
}
const BASE_PRICE = 899
// CNY is the canonical demo price; USD is a separate English-market list.
// Keep the two lists explicit instead of swapping the currency symbol, which
// would overstate the USD price by the CNY/USD exchange rate.
const PRICES = {
  zh: {
    currency: 'CNY',
    locale: 'zh-CN',
    symbol: '¥',
    base: BASE_PRICE,
    add: { forest: 100, chrome: 200, dome: 150 },
  },
  en: {
    currency: 'USD',
    locale: 'en-US',
    symbol: '$',
    base: 149,
    add: { forest: 15, chrome: 30, dome: 22 },
  },
}
const config = { finish: 'sand', shade: 'cone', temp: 'warm' }

const priceEl = document.getElementById('price')
const liveLabel = document.getElementById('live-label')
const toastEl = document.getElementById('toast')
let toastTimer = null

function toast(message) {
  if (toastEl === null) return
  toastEl.textContent = message
  toastEl.classList.add('is-visible')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2600)
}

function priceTable() {
  return PRICES[language()] ?? PRICES.en
}

function currentPrice() {
  const table = priceTable()
  return table.base + (table.add[config.finish] ?? 0) + (table.add[config.shade] ?? 0)
}

function formatPrice(value) {
  const table = priceTable()
  return `${table.symbol}${new Intl.NumberFormat(table.locale).format(value)}`
}

function applyPriceLabels() {
  const table = priceTable()
  for (const key of Object.keys(FINISHES)) {
    const label = document.querySelector(`[data-finish="${key}"] small`)
    if (label !== null) label.textContent = `+${formatPrice(table.add[key] ?? 0)}`
  }
  for (const key of Object.keys(SHADES)) {
    const label = document.querySelector(`[data-shade="${key}"] small`)
    if (label !== null) label.textContent = `+${formatPrice(table.add[key] ?? 0)}`
  }
}

function applyFinish() {
  const finish = FINISHES[config.finish]
  metalMat.color.setHex(finish.color)
  metalMat.metalness = finish.metalness
  metalMat.roughness = finish.roughness
  metalMat.envMapIntensity = finish.env
  metalMat.needsUpdate = true
}

function applyShade() {
  const dome = config.shade === 'dome'
  // Each shade is an outer metal cone plus an inner matte cone; all four meshes
  // and both rims have to follow the switch, or the hidden shade keeps drawing.
  coneShade.visible = !dome
  coneInner.visible = !dome
  coneRim.visible = !dome
  domeShade.visible = dome
  domeInner.visible = dome
  domeRim.visible = dome
  bulb.position.y = dome ? -0.48 : -0.38
  diffuser.position.y = dome ? -0.40 : -0.30
  diffuser.rotation.x = dome ? Math.PI / 2 : -Math.PI / 2
  glow.position.y = -0.6
  lampLight.position.y = dome ? -0.48 : -0.38
}

function applyTemp() {
  const temp = TEMPS[config.temp]
  lampLight.color.setHex(temp.light)
  lampLight.intensity = temp.intensity
  bulbMat.emissive.setHex(temp.bulb)
  bulbMat.emissiveIntensity = 2.5
  bulbMat.needsUpdate = true
  glowMat.color.setHex(temp.glow)
  glowMat.opacity = config.temp === 'cool' ? 0.22 : 0.28
}

function syncButtons(group, key, value) {
  for (const button of document.querySelectorAll(`[data-${group}]`)) {
    button.setAttribute('aria-pressed', button.dataset[group] === value ? 'true' : 'false')
  }
  return key
}

function applyConfig() {
  applyFinish()
  applyShade()
  applyTemp()
  syncButtons('finish', 'data-finish', config.finish)
  syncButtons('shade', 'data-shade', config.shade)
  syncButtons('temp', 'data-temp', config.temp)
  applyPriceLabels()
  if (priceEl !== null) priceEl.textContent = formatPrice(currentPrice())
  if (liveLabel !== null) {
    liveLabel.textContent = `${FINISHES[config.finish].label} / ${SHADES[config.shade].label} / ${TEMPS[config.temp].label}`
  }
}

for (const button of document.querySelectorAll('[data-finish]')) {
  button.addEventListener('click', () => {
    config.finish = button.dataset.finish
    applyConfig()
  })
}
for (const button of document.querySelectorAll('[data-shade]')) {
  button.addEventListener('click', () => {
    config.shade = button.dataset.shade
    applyConfig()
  })
}
for (const button of document.querySelectorAll('[data-temp]')) {
  button.addEventListener('click', () => {
    config.temp = button.dataset.temp
    applyConfig()
  })
}

function exportGLB() {
  const button = document.getElementById('export-glb')
  if (button !== null) {
    button.disabled = true
    button.textContent = t('导出中…')
  }
  const exporter = new GLTFExporter()
  exporter.parse(lamp, result => {
    const blob = new Blob([result], { type: 'model/gltf-binary' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'lumen-config.glb'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
    if (button !== null) {
      button.disabled = false
      button.innerHTML = `${t('下载 GLB')} <span aria-hidden="true">↓</span>`
    }
    toast(t('GLB 已导出'))
  }, error => {
    if (button !== null) {
      button.disabled = false
      button.innerHTML = `${t('下载 GLB')} <span aria-hidden="true">↓</span>`
    }
    toast(t('GLB 导出失败：') + (error instanceof Error ? error.message : String(error)))
  }, { binary: true, onlyVisible: true })
}

async function copyConfig() {
  const payload = JSON.stringify({
    v: 1,
    product: 'LUMEN',
    finish: config.finish,
    shade: config.shade,
    temp: config.temp,
    price: currentPrice(),
    currency: priceTable().currency,
  }, null, 2)
  try {
    await navigator.clipboard.writeText(payload)
    toast(t('配置 JSON 已复制'))
  } catch (error) {
    const area = document.createElement('textarea')
    area.value = payload
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    try { document.execCommand('copy'); toast(t('配置 JSON 已复制')) } catch (copyError) { toast(t('复制失败')) }
    area.remove()
  }
}

document.getElementById('export-glb')?.addEventListener('click', exportGLB)
document.getElementById('copy-config')?.addEventListener('click', copyConfig)
document.getElementById('reset-view')?.addEventListener('click', () => {
  camera.position.set(4.6, 3.6, 5.8)
  controls.target.set(0, 1.45, 0)
  controls.autoRotate = true
  controls.update()
  toast(t('视角已重置'))
})

function resize() {
  const width = viewer.clientWidth
  const height = viewer.clientHeight
  if (width <= 0 || height <= 0) return
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}
new ResizeObserver(resize).observe(viewer)
resize()

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  ring.material.opacity = 0.24 + Math.sin(clock.elapsedTime * 1.2) * 0.06
  controls.update(delta)
  renderer.render(scene, camera)
}

applyConfig()
animate()
document.body.classList.add('is-ready')
