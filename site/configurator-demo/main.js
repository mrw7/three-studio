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
  side: THREE.DoubleSide,
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

const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.44, 0.22, 64), metalMat)
base.position.y = 0.11
base.castShadow = true
base.receiveShadow = true
lamp.add(base)

const baseRing = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.012, 8, 96), darkMat)
baseRing.rotation.x = Math.PI / 2
baseRing.position.y = 0.225
lamp.add(baseRing)

const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 2.05, 24), metalMat)
stem.position.y = 1.22
stem.castShadow = true
stem.receiveShadow = true
lamp.add(stem)

const joint = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 16), metalMat)
joint.position.y = 2.23
joint.castShadow = true
lamp.add(joint)

const armPivot = new THREE.Group()
armPivot.position.set(0, 2.23, 0)
armPivot.rotation.z = -0.28
lamp.add(armPivot)

const arm = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.085, 0.12), metalMat)
arm.position.x = 0.775
arm.castShadow = true
arm.receiveShadow = true
armPivot.add(arm)

const shadeGroup = new THREE.Group()
shadeGroup.position.set(1.55, 0, 0)
shadeGroup.rotation.z = 0.28
armPivot.add(shadeGroup)

const coneShade = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.6, 0.62, 64, 1, true), metalMat)
coneShade.position.y = -0.31
coneShade.castShadow = true
coneShade.receiveShadow = true
shadeGroup.add(coneShade)

const coneRim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.018, 10, 64), darkMat)
coneRim.rotation.x = Math.PI / 2
coneRim.position.y = -0.62
shadeGroup.add(coneRim)

const domeShade = new THREE.Mesh(
  new THREE.SphereGeometry(0.6, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
  metalMat,
)
domeShade.position.y = -0.6
domeShade.castShadow = true
domeShade.receiveShadow = true
domeShade.visible = false
shadeGroup.add(domeShade)

const domeRim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.018, 10, 64), darkMat)
domeRim.rotation.x = Math.PI / 2
domeRim.position.y = -0.6
domeRim.visible = false
shadeGroup.add(domeRim)

const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), bulbMat)
bulb.position.y = -0.38
shadeGroup.add(bulb)

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
  sand: { label: 'Sand', color: 0xd8c5a4, metalness: 0.28, roughness: 0.5, env: 1.25, add: 0 },
  graphite: { label: 'Graphite', color: 0x2b3037, metalness: 0.82, roughness: 0.32, env: 1.5, add: 0 },
  forest: { label: 'Forest', color: 0x2f4a3a, metalness: 0.42, roughness: 0.42, env: 1.35, add: 100 },
  chrome: { label: 'Chrome', color: 0xdbe2ea, metalness: 1.0, roughness: 0.08, env: 1.9, add: 200 },
}
const SHADES = {
  cone: { label: 'Cone', add: 0 },
  dome: { label: 'Dome', add: 150 },
}
const TEMPS = {
  warm: { label: '2700K', light: 0xffa34d, bulb: 0xffb25e, glow: 0xffb25e, intensity: 30, add: 0 },
  neutral: { label: '4000K', light: 0xffd9a8, bulb: 0xffe3bd, glow: 0xffd9a8, intensity: 27, add: 0 },
  cool: { label: '5600K', light: 0xbfe0ff, bulb: 0xd8ecff, glow: 0xbfe0ff, intensity: 24, add: 0 },
}
const BASE_PRICE = 899
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

function currentPrice() {
  return BASE_PRICE + FINISHES[config.finish].add + SHADES[config.shade].add + TEMPS[config.temp].add
}

function formatPrice(value) {
  const symbol = language() === 'zh' ? '¥' : '$'
  const locale = language() === 'zh' ? 'zh-CN' : 'en-US'
  return `${symbol}${new Intl.NumberFormat(locale).format(value)}`
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
  coneShade.visible = !dome
  coneRim.visible = !dome
  domeShade.visible = dome
  domeRim.visible = dome
  bulb.position.y = dome ? -0.48 : -0.38
  glow.position.y = dome ? -0.6 : -0.6
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
    currency: 'CNY',
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
