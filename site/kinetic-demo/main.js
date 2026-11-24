import * as THREE from 'three'
import { t, language } from '../i18n.js'
import { OrbitControls } from 'three/addons/OrbitControls.js'

const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.35
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x05070b)
scene.fog = new THREE.FogExp2(0x05070b, 0.018)

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
const HOME_POSITION = new THREE.Vector3(0.35, 2.35, 9.6)
camera.position.copy(HOME_POSITION)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(-0.7, 0.1, 0)
controls.enableDamping = true
controls.dampingFactor = 0.065
controls.minDistance = 5.5
controls.maxDistance = 15
controls.enablePan = false
controls.autoRotate = true
controls.autoRotateSpeed = 0.35
controls.update()
let autoRotate = true
controls.addEventListener('start', () => {
  autoRotate = false
  controls.autoRotate = false
})

function makeEnvironment() {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 512
  const g = c.getContext('2d')
  const gradient = g.createLinearGradient(0, 0, 0, 512)
  gradient.addColorStop(0, '#0b1424')
  gradient.addColorStop(0.46, '#06090f')
  gradient.addColorStop(1, '#020306')
  g.fillStyle = gradient
  g.fillRect(0, 0, 1024, 512)

  const band = (x, y, w, h, color, alpha) => {
    const glow = g.createLinearGradient(x, y, x + w, y + h)
    glow.addColorStop(0, color)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    g.globalAlpha = alpha
    g.fillStyle = glow
    g.fillRect(x, y, w, h)
    g.globalAlpha = 1
  }
  band(0, 40, 1024, 54, '#ffffff', 0.9)
  band(120, 240, 500, 38, '#e8c98a', 0.55)
  band(540, 110, 420, 42, '#6f8dff', 0.6)
  band(0, 390, 1024, 48, '#1d2f4c', 0.5)

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
  blob(220, 170, 150, '#fff4dc', 0.85)
  blob(800, 230, 130, '#9fc6ff', 0.55)
  blob(500, 430, 200, '#b56b2d', 0.22)

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

scene.add(new THREE.HemisphereLight(0xa9c6ff, 0x05070b, 0.38))

const key = new THREE.DirectionalLight(0xffffff, 4.2)
key.position.set(4.5, 6.5, 4.5)
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

const rim = new THREE.DirectionalLight(0x6f8dff, 3.0)
rim.position.set(-5, 3, -4)
scene.add(rim)

const warm = new THREE.DirectionalLight(0xe8c98a, 1.5)
warm.position.set(0, -2, 5)
scene.add(warm)

const knotMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xdfe6f0,
  metalness: 1,
  roughness: 0.05,
  clearcoat: 1,
  clearcoatRoughness: 0.04,
  envMapIntensity: 2.25,
  iridescence: 0,
})
const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.1, 0.34, 320, 64, 2, 3), knotMaterial)
knot.castShadow = true
knot.receiveShadow = true
scene.add(knot)

const ghostMaterial = new THREE.MeshBasicMaterial({
  color: 0x8fb0ff,
  wireframe: true,
  transparent: true,
  opacity: 0.035,
  depthWrite: false,
})
const ghost = new THREE.Mesh(new THREE.TorusKnotGeometry(1.45, 0.42, 220, 36, 2, 3), ghostMaterial)
scene.add(ghost)

const haloMaterial = new THREE.MeshBasicMaterial({
  color: 0x6f8dff,
  transparent: true,
  opacity: 0.45,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})
const halo = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.008, 8, 220), haloMaterial)
halo.rotation.x = Math.PI * 0.32
halo.rotation.z = Math.PI * 0.12
scene.add(halo)

const orbitGroup = new THREE.Group()
scene.add(orbitGroup)
const satellites = []
for (let i = 0; i < 5; i += 1) {
  const angle = (i / 5) * Math.PI * 2
  const satellite = new THREE.Mesh(
    new THREE.SphereGeometry(0.035 + (i % 2) * 0.018, 16, 10),
    new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? 0xffd49a : 0x9fc6ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
    }),
  )
  satellite.position.set(Math.cos(angle) * 2.25, Math.sin(angle * 2) * 0.22, Math.sin(angle) * 2.25)
  orbitGroup.add(satellite)
  satellites.push(satellite)
}

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 96),
  new THREE.MeshStandardMaterial({
    color: 0x080b11,
    metalness: 0.8,
    roughness: 0.28,
    envMapIntensity: 0.8,
  }),
)
floor.rotation.x = -Math.PI / 2
floor.position.y = -1.85
floor.receiveShadow = true
scene.add(floor)

const shadowCanvas = document.createElement('canvas')
shadowCanvas.width = 512
shadowCanvas.height = 512
const shadowContext = shadowCanvas.getContext('2d')
const shadowGradient = shadowContext.createRadialGradient(256, 256, 0, 256, 256, 256)
shadowGradient.addColorStop(0, 'rgba(0,0,0,0.7)')
shadowGradient.addColorStop(0.55, 'rgba(0,0,0,0.2)')
shadowGradient.addColorStop(1, 'rgba(0,0,0,0)')
shadowContext.fillStyle = shadowGradient
shadowContext.fillRect(0, 0, 512, 512)
const shadowTexture = new THREE.CanvasTexture(shadowCanvas)
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(4.6, 4.6),
  new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
)
contact.rotation.x = -Math.PI / 2
contact.position.y = -1.84
scene.add(contact)

const MATERIALS = {
  chrome: {
    label: 'Chrome',
    color: 0xdfe6f0,
    metalness: 1,
    roughness: 0.05,
    clearcoat: 1,
    iridescence: 0,
  },
  gold: {
    label: 'Gold',
    color: 0xe8c98a,
    metalness: 1,
    roughness: 0.12,
    clearcoat: 0.7,
    iridescence: 0,
  },
  iridescent: {
    label: 'Iridescent',
    color: 0x9ab7ff,
    metalness: 0.85,
    roughness: 0.16,
    clearcoat: 1,
    iridescence: 1,
  },
}
let materialName = 'iridescent'

function applyMaterial(name) {
  const next = MATERIALS[name] === undefined ? MATERIALS.chrome : MATERIALS[name]
  materialName = next.label === 'Chrome' ? 'chrome' : next.label === 'Gold' ? 'gold' : 'iridescent'
  knotMaterial.color.setHex(next.color)
  knotMaterial.metalness = next.metalness
  knotMaterial.roughness = next.roughness
  knotMaterial.clearcoat = next.clearcoat
  knotMaterial.iridescence = next.iridescence
  knotMaterial.iridescenceIOR = 1.32
  knotMaterial.iridescenceThicknessRange = [100, 700]
  knotMaterial.needsUpdate = true
  haloMaterial.color.setHex(name === 'gold' ? 0xe8c98a : name === 'iridescent' ? 0xb86bff : 0x6f8dff)
  for (const button of document.querySelectorAll('[data-material]')) {
    button.setAttribute('aria-pressed', button.dataset.material === materialName ? 'true' : 'false')
  }
  const nameEl = document.getElementById('material-name')
  if (nameEl !== null) nameEl.textContent = next.label
}

for (const button of document.querySelectorAll('[data-material]')) {
  button.addEventListener('click', () => applyMaterial(button.dataset.material))
}

let speed = 1
let playing = true
let elapsed = 0
let frames = 0
let fpsStarted = performance.now()
const fpsEl = document.getElementById('fps')
const pauseButton = document.getElementById('pause')

document.getElementById('speed')?.addEventListener('input', event => {
  speed = Number(event.target.value)
})

pauseButton?.addEventListener('click', () => {
  playing = !playing
  pauseButton.textContent = playing ? t('暂停') : t('继续')
  pauseButton.setAttribute('aria-pressed', playing ? 'true' : 'false')
  controls.autoRotate = playing && autoRotate
})

document.getElementById('reset')?.addEventListener('click', () => {
  camera.position.copy(HOME_POSITION)
  controls.target.set(-0.7, 0.1, 0)
  autoRotate = true
  controls.autoRotate = playing
  controls.update()
})

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (playing) {
    elapsed += delta
    const step = delta * speed
    knot.rotation.x += step * 0.16
    knot.rotation.y += step * 0.23
    ghost.rotation.x -= step * 0.09
    ghost.rotation.y -= step * 0.13
    halo.rotation.z += step * 0.10
    halo.rotation.y += step * 0.05
    orbitGroup.rotation.y += step * 0.38
    for (let i = 0; i < satellites.length; i += 1) {
      satellites[i].position.y = Math.sin(elapsed * 0.7 + i * 1.7) * 0.32
    }
    knot.position.y = Math.sin(elapsed * 0.55) * 0.045
    haloMaterial.opacity = 0.3 + Math.sin(elapsed * 0.8) * 0.12
    controls.autoRotate = autoRotate
    controls.autoRotateSpeed = 0.35 * speed
  }
  controls.update(delta)
  renderer.render(scene, camera)

  frames += 1
  const now = performance.now()
  if (now - fpsStarted >= 500 && fpsEl !== null) {
    const fps = Math.round(frames * 1000 / (now - fpsStarted))
    fpsEl.textContent = fps < 5 ? '—' : String(fps)
    frames = 0
    fpsStarted = now
  }
}

applyMaterial('iridescent')
animate()
