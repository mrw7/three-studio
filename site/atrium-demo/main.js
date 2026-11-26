import * as THREE from 'three'
import { t, language } from '../i18n.js'

const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.18
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x070605)
scene.fog = new THREE.FogExp2(0x070605, 0.028)

const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 80)
camera.position.set(0, 2.1, 13)

function makeEnvironment() {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 512
  const g = c.getContext('2d')
  const gradient = g.createLinearGradient(0, 0, 0, 512)
  gradient.addColorStop(0, '#2a1b10')
  gradient.addColorStop(0.4, '#0f0a06')
  gradient.addColorStop(1, '#030202')
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
  band(0, 50, 1024, 60, '#fff1d6', 0.9)
  band(180, 260, 420, 50, '#e8c98a', 0.5)
  band(560, 110, 360, 42, '#6f8dff', 0.3)
  band(0, 380, 1024, 52, '#2b1a10', 0.45)
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
  blob(250, 170, 160, '#fff4dc', 0.8)
  blob(760, 230, 140, '#ffd7a0', 0.5)
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

scene.add(new THREE.HemisphereLight(0xffe8cc, 0x050403, 0.52))

const hall = new THREE.Group()
scene.add(hall)
const floorMaterial = new THREE.MeshStandardMaterial({
  color: 0x2a2118,
  metalness: 0.55,
  roughness: 0.3,
  envMapIntensity: 0.8,
})
const floor = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.12, 30), floorMaterial)
floor.position.y = -0.06
floor.receiveShadow = true
hall.add(floor)

const ceilingMaterial = new THREE.MeshStandardMaterial({ color: 0x1a130d, roughness: 0.85 })
const ceiling = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.16, 30), ceilingMaterial)
ceiling.position.y = 5.08
hall.add(ceiling)

const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x241b13, roughness: 0.8 })
for (const x of [-4.25, 4.25]) {
  const wall = new THREE.Mesh(new THREE.BoxGeometry(0.22, 5.2, 30), wallMaterial)
  wall.position.set(x, 2.55, 0)
  wall.receiveShadow = true
  hall.add(wall)
}
const endWall = new THREE.Mesh(new THREE.BoxGeometry(8.5, 5.2, 0.22), wallMaterial)
endWall.position.set(0, 2.55, -15.05)
hall.add(endWall)
const backWall = new THREE.Mesh(new THREE.BoxGeometry(8.5, 5.2, 0.22), wallMaterial)
backWall.position.set(0, 2.55, 15.05)
hall.add(backWall)

const columnMaterial = new THREE.MeshStandardMaterial({ color: 0x3a2e21, roughness: 0.62, metalness: 0.08 })
for (const z of [-12, -8, -4, 0, 4, 8, 12]) {
  for (const x of [-3.45, 3.45]) {
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 5, 20), columnMaterial)
    column.position.set(x, 2.5, z)
    column.castShadow = true
    column.receiveShadow = true
    hall.add(column)
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.18, 0.62), columnMaterial)
    base.position.set(x, 0.09, z)
    hall.add(base)
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(7.1, 0.16, 0.22), columnMaterial)
  beam.position.set(0, 4.92, z)
  hall.add(beam)
}

const skylightMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0d2 })
for (const x of [-1.55, 0, 1.55]) {
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 27), skylightMaterial)
  strip.position.set(x, 4.985, 0)
  hall.add(strip)
}

function makeArtTexture(seed, palette) {
  let value = seed >>> 0
  const random = () => {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 720
  const g = c.getContext('2d')
  const bg = g.createLinearGradient(0, 0, 512, 720)
  bg.addColorStop(0, palette[0])
  bg.addColorStop(1, palette[1])
  g.fillStyle = bg
  g.fillRect(0, 0, 512, 720)
  for (let i = 0; i < 14; i += 1) {
    const x = random() * 512
    const y = random() * 720
    const radius = 30 + random() * 190
    const color = palette[2 + Math.floor(random() * (palette.length - 2))]
    g.globalAlpha = 0.18 + random() * 0.35
    g.fillStyle = color
    g.beginPath()
    g.ellipse(x, y, radius, radius * (0.35 + random() * 0.65), random() * Math.PI, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 0.8
  g.strokeStyle = palette[palette.length - 1]
  g.lineWidth = 2
  for (let i = 0; i < 4; i += 1) {
    g.beginPath()
    g.moveTo(random() * 512, random() * 720)
    g.lineTo(random() * 512, random() * 720)
    g.stroke()
  }
  g.globalAlpha = 0.65
  g.fillStyle = '#f6ead4'
  g.font = '600 18px ui-monospace, monospace'
  g.fillText(`ATRIUM / No. 0${String(seed % 8 + 1)}`, 28, 690)
  g.globalAlpha = 1
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const ART_PALETTES = [
  ['#2a1c12', '#0c0906', '#e8c98a', '#ff9a4d', '#6f8dff', '#f6ead4'],
  ['#101827', '#05070b', '#7ce7ff', '#6f8dff', '#e8c98a', '#dceaff'],
  ['#24101a', '#070305', '#ff7a5c', '#b86bff', '#e8c98a', '#ffe3cf'],
  ['#0d1a16', '#030605', '#7ce7ff', '#5fe1a0', '#e8c98a', '#e6fff1'],
]

const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x1d1610, metalness: 0.7, roughness: 0.25 })
const artMeshes = []
const artPositions = [-10, -5.5, -1, 3.5, 8, 12.5]
for (const [index, z] of artPositions.entries()) {
  for (const side of [-1, 1]) {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.5, 1.9), frameMaterial)
    frame.position.set(side * 3.96, 2.45, z)
    hall.add(frame)
    const art = new THREE.Mesh(
      new THREE.PlaneGeometry(1.52, 2.12),
      new THREE.MeshBasicMaterial({ map: makeArtTexture(index * 3 + side + 5, ART_PALETTES[index % ART_PALETTES.length]) }),
    )
    art.position.set(side * 3.89, 2.45, z)
    art.rotation.y = side === 1 ? -Math.PI / 2 : Math.PI / 2
    hall.add(art)
    artMeshes.push(art)
  }
}

const endArt = new THREE.Mesh(
  new THREE.PlaneGeometry(5.4, 3.2),
  new THREE.MeshBasicMaterial({ map: makeArtTexture(24, ART_PALETTES[1]) }),
)
endArt.position.set(0, 2.7, -14.93)
hall.add(endArt)

const benchMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2017, roughness: 0.6, metalness: 0.15 })
for (const z of [-6.5, 6.5]) {
  const bench = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.34, 0.55), benchMaterial)
  bench.position.set(0, 0.36, z)
  bench.castShadow = true
  bench.receiveShadow = true
  hall.add(bench)
}

const plinth = new THREE.Mesh(
  new THREE.BoxGeometry(1.3, 1.15, 1.3),
  new THREE.MeshStandardMaterial({ color: 0x201810, roughness: 0.45, metalness: 0.2 }),
)
plinth.position.set(0, 0.58, 0)
plinth.castShadow = true
plinth.receiveShadow = true
hall.add(plinth)

const sculptureMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xe8c98a,
  metalness: 1,
  roughness: 0.12,
  clearcoat: 1,
  clearcoatRoughness: 0.06,
  envMapIntensity: 1.8,
})
const sculpture = new THREE.Mesh(new THREE.TorusKnotGeometry(0.48, 0.15, 200, 36, 2, 3), sculptureMaterial)
sculpture.position.set(0, 1.95, 0)
sculpture.castShadow = true
hall.add(sculpture)

const contactCanvas = document.createElement('canvas')
contactCanvas.width = 256
contactCanvas.height = 256
const contactContext = contactCanvas.getContext('2d')
const contactGradient = contactContext.createRadialGradient(128, 128, 0, 128, 128, 128)
contactGradient.addColorStop(0, 'rgba(0,0,0,0.55)')
contactGradient.addColorStop(0.6, 'rgba(0,0,0,0.15)')
contactGradient.addColorStop(1, 'rgba(0,0,0,0)')
contactContext.fillStyle = contactGradient
contactContext.fillRect(0, 0, 256, 256)
const contactTexture = new THREE.CanvasTexture(contactCanvas)
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(3.2, 3.2),
  new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false }),
)
contact.rotation.x = -Math.PI / 2
contact.position.y = 0.012
hall.add(contact)

const spot = new THREE.SpotLight(0xffd6a0, 160, 10, 0.42, 0.55, 2)
spot.position.set(0, 4.8, 0)
spot.target.position.set(0, 1.2, 0)
spot.castShadow = false
hall.add(spot, spot.target)

for (const z of [-10, -4, 4, 10]) {
  const light = new THREE.PointLight(0xffcf9a, 55, 12, 2)
  light.position.set(0, 4.4, z)
  hall.add(light)
}

const dustGeometry = new THREE.BufferGeometry()
const dustCount = 500
const dustPositions = new Float32Array(dustCount * 3)
for (let i = 0; i < dustCount; i += 1) {
  dustPositions[i * 3] = (Math.random() - 0.5) * 7.4
  dustPositions[i * 3 + 1] = Math.random() * 4.6
  dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 27
}
dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
const dust = new THREE.Points(dustGeometry, new THREE.PointsMaterial({
  color: 0xffe3bd,
  size: 0.025,
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
}))
hall.add(dust)

const path = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 2.1, 13),
  new THREE.Vector3(0.22, 2.06, 9),
  new THREE.Vector3(-0.28, 2.1, 5),
  new THREE.Vector3(0.28, 2.0, 1),
  new THREE.Vector3(0, 2.12, -3),
  new THREE.Vector3(-0.2, 2.12, -7),
  new THREE.Vector3(0, 2.18, -11),
  new THREE.Vector3(0, 2.2, -13.4),
])

let progress = 0
let targetProgress = 0
let playing = true
let dragging = false
let dragStartY = 0
let dragStartProgress = 0
const mouse = { x: 0, y: 0 }
const positionEl = document.getElementById('position')
const trackFill = document.getElementById('track-fill')
const fpsEl = document.getElementById('fps')
const pauseButton = document.getElementById('pause')
let frames = 0
let fpsStarted = performance.now()
let elapsed = 0

function updateUI() {
  const percent = Math.round(progress * 100)
  if (positionEl !== null) positionEl.textContent = `${String(percent).padStart(2, '0')}%`
  if (trackFill !== null) trackFill.style.width = `${String(percent)}%`
}

function setPlaying(value) {
  playing = value
  if (pauseButton !== null) pauseButton.textContent = playing ? t('Pause tour') : t('Resume tour')
  if (pauseButton !== null) pauseButton.setAttribute('aria-pressed', playing ? 'true' : 'false')
}

pauseButton?.addEventListener('click', () => setPlaying(!playing))
document.getElementById('back')?.addEventListener('click', () => {
  targetProgress = Math.max(0, targetProgress - 0.07)
  setPlaying(false)
})
document.getElementById('forward')?.addEventListener('click', () => {
  targetProgress = Math.min(1, targetProgress + 0.07)
  setPlaying(false)
})
document.getElementById('reset')?.addEventListener('click', () => {
  progress = 0
  targetProgress = 0
  setPlaying(true)
})

canvas.addEventListener('pointerdown', event => {
  dragging = true
  dragStartY = event.clientY
  dragStartProgress = targetProgress
  canvas.setPointerCapture?.(event.pointerId)
})
canvas.addEventListener('pointermove', event => {
  if (dragging) {
    const delta = (event.clientY - dragStartY) / window.innerHeight
    targetProgress = Math.min(1, Math.max(0, dragStartProgress - delta * 1.4))
    setPlaying(false)
  }
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1
  mouse.y = (event.clientY / window.innerHeight) * 2 - 1
})
canvas.addEventListener('pointerup', () => { dragging = false })
canvas.addEventListener('pointercancel', () => { dragging = false })
canvas.addEventListener('wheel', event => {
  event.preventDefault()
  targetProgress = Math.min(1, Math.max(0, targetProgress + event.deltaY * 0.00035))
  setPlaying(false)
}, { passive: false })

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}
window.addEventListener('resize', resize)
resize()

const lookTarget = new THREE.Vector3()
const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  elapsed += delta
  if (playing) targetProgress = Math.min(1, targetProgress + delta * 0.028)
  progress += (targetProgress - progress) * Math.min(1, delta * 3.2)
  const point = path.getPointAt(progress)
  const ahead = path.getPointAt(Math.min(1, progress + 0.055))
  camera.position.copy(point)
  lookTarget.copy(ahead)
  lookTarget.x += mouse.x * 0.45
  lookTarget.y += -mouse.y * 0.22
  camera.lookAt(lookTarget)

  sculpture.rotation.x += delta * 0.22
  sculpture.rotation.y += delta * 0.34
  dust.rotation.y += delta * 0.006
  updateUI()
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

animate()
