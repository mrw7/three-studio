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
renderer.toneMappingExposure = 1.1

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x04070d)

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
camera.position.set(0.4, 3.5, 9.6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(-1.1, 0.1, 0)
controls.enableDamping = true
controls.dampingFactor = 0.065
controls.minDistance = 5.5
controls.maxDistance = 16
controls.enablePan = false
controls.autoRotate = true
controls.autoRotateSpeed = 0.3
controls.update()

const TAU = Math.PI * 2
const GLOBE_RADIUS = 2.5
const globeGroup = new THREE.Group()
scene.add(globeGroup)

const graticuleMaterial = new THREE.LineBasicMaterial({
  color: 0x2b5d8c,
  transparent: true,
  opacity: 0.18,
  blending: THREE.AdditiveBlending,
})
for (let latitude = -75; latitude <= 75; latitude += 15) {
  const phi = THREE.MathUtils.degToRad(90 - latitude)
  const radius = Math.sin(phi) * GLOBE_RADIUS
  const y = Math.cos(phi) * GLOBE_RADIUS
  const points = []
  for (let i = 0; i <= 96; i += 1) {
    const theta = (i / 96) * TAU
    points.push(new THREE.Vector3(Math.cos(theta) * radius, y, Math.sin(theta) * radius))
  }
  globeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), graticuleMaterial))
}
for (let longitude = 0; longitude < 360; longitude += 15) {
  const theta = THREE.MathUtils.degToRad(longitude)
  const points = []
  for (let i = 0; i <= 96; i += 1) {
    const phi = (i / 96) * Math.PI
    points.push(new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * GLOBE_RADIUS,
      Math.cos(phi) * GLOBE_RADIUS,
      Math.sin(phi) * Math.sin(theta) * GLOBE_RADIUS,
    ))
  }
  globeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), graticuleMaterial))
}

const shell = new THREE.Mesh(
  new THREE.SphereGeometry(GLOBE_RADIUS * 1.002, 48, 32),
  new THREE.MeshBasicMaterial({
    color: 0x1b3657,
    wireframe: true,
    transparent: true,
    opacity: 0.09,
    depthWrite: false,
  }),
)
globeGroup.add(shell)

const surfacePoints = new THREE.BufferGeometry()
const surfaceCount = 2600
const surfacePositions = new Float32Array(surfaceCount * 3)
for (let i = 0; i < surfaceCount; i += 1) {
  const phi = Math.acos(2 * Math.random() - 1)
  const theta = Math.random() * TAU
  surfacePositions[i * 3] = Math.sin(phi) * Math.cos(theta) * GLOBE_RADIUS * 1.004
  surfacePositions[i * 3 + 1] = Math.cos(phi) * GLOBE_RADIUS * 1.004
  surfacePositions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * GLOBE_RADIUS * 1.004
}
surfacePoints.setAttribute('position', new THREE.BufferAttribute(surfacePositions, 3))
globeGroup.add(new THREE.Points(surfacePoints, new THREE.PointsMaterial({
  color: 0x4b7fb5,
  size: 0.018,
  transparent: true,
  opacity: 0.48,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
})))

function makeGlowTexture(inner, outer) {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  gradient.addColorStop(0, inner)
  gradient.addColorStop(0.45, outer)
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = gradient
  g.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

const atmosphere = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture('rgba(80, 160, 255, 0.4)', 'rgba(30, 80, 180, 0.14)'),
  color: 0x6f8dff,
  transparent: true,
  opacity: 0.55,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}))
atmosphere.scale.set(7.2, 7.2, 1)
scene.add(atmosphere)

function latLonToVector(latitude, longitude, radius = GLOBE_RADIUS) {
  const phi = THREE.MathUtils.degToRad(90 - latitude)
  const theta = THREE.MathUtils.degToRad(longitude + 180)
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

const CITIES = [
  { name: 'Shanghai', lat: 31.23, lon: 121.47 },
  { name: 'Singapore', lat: 1.35, lon: 103.82 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69 },
  { name: 'London', lat: 51.51, lon: -0.13 },
  { name: 'New York', lat: 40.71, lon: -74.01 },
  { name: 'São Paulo', lat: -23.55, lon: -46.63 },
  { name: 'Dubai', lat: 25.2, lon: 55.27 },
  { name: 'Sydney', lat: -33.87, lon: 151.21 },
]

function makeLabel(text) {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 96
  const g = c.getContext('2d')
  g.font = '600 34px ui-sans-serif, system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = 'rgba(4, 7, 13, 0.55)'
  const width = g.measureText(text).width + 34
  g.fillRect((512 - width) / 2, 14, width, 68)
  g.fillStyle = '#dceaff'
  g.fillText(text, 256, 48)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  }))
  sprite.scale.set(1.55, 0.29, 1)
  return sprite
}

const nodes = []
const nodeGlowTexture = makeGlowTexture('rgba(255, 228, 160, 0.95)', 'rgba(255, 180, 90, 0.2)')
for (const city of CITIES) {
  const position = latLonToVector(city.lat, city.lon)
  const node = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffcf6e, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }),
  )
  node.position.copy(position)
  globeGroup.add(node)

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: nodeGlowTexture,
    color: 0xffcf6e,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  glow.position.copy(position).multiplyScalar(1.008)
  glow.scale.set(0.38, 0.38, 1)
  globeGroup.add(glow)

  const label = makeLabel(city.name)
  label.position.copy(position).multiplyScalar(1.09)
  label.position.y += 0.16
  globeGroup.add(label)
  nodes.push({ ...city, position, node, glow })
}

const ROUTES = [
  ['Shanghai', 'Singapore', 1.1],
  ['Tokyo', 'Singapore', 0.9],
  ['Singapore', 'Dubai', 1.0],
  ['Dubai', 'London', 0.8],
  ['London', 'New York', 1.2],
  ['New York', 'São Paulo', 0.75],
  ['São Paulo', 'London', 0.65],
  ['Shanghai', 'Sydney', 0.7],
  ['Sydney', 'Singapore', 0.9],
  ['Tokyo', 'New York', 0.7],
  ['New York', 'Dubai', 0.6],
  ['London', 'Singapore', 0.55],
]

const routeObjects = []
for (const [fromName, toName, speed] of ROUTES) {
  const from = nodes.find(node => node.name === fromName)
  const to = nodes.find(node => node.name === toName)
  if (from === undefined || to === undefined) continue
  const start = from.position.clone().multiplyScalar(1.008)
  const end = to.position.clone().multiplyScalar(1.008)
  const mid = start.clone().add(end).normalize().multiplyScalar(GLOBE_RADIUS * 1.54)
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end)
  const points = curve.getPoints(72)
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({
    color: 0x6f8dff,
    transparent: true,
    opacity: 0.42,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }))
  globeGroup.add(line)
  const pulse = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0x7ce7ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }),
  )
  globeGroup.add(pulse)
  routeObjects.push({ curve, line, pulse, speed, offset: Math.random() })
}

const starsGeometry = new THREE.BufferGeometry()
const starCount = 900
const starPositions = new Float32Array(starCount * 3)
for (let i = 0; i < starCount; i += 1) {
  const radius = 15 + Math.random() * 26
  const theta = Math.random() * TAU
  const phi = Math.acos(2 * Math.random() - 1)
  starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
  starPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.7
  starPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
}
starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
const stars = new THREE.Points(starsGeometry, new THREE.PointsMaterial({
  color: 0x9fc6ff,
  size: 0.05,
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
}))
scene.add(stars)

const DATASETS = {
  traffic: {
    color: 0x6f8dff,
    label: 'TRAFFIC',
    value: '8.4 TB/s',
    latency: '42 ms',
  },
  latency: {
    color: 0x7ce7ff,
    label: 'P95 LATENCY',
    value: '38 ms',
    latency: '12 ms',
  },
  capacity: {
    color: 0xb86bff,
    label: 'CAPACITY',
    value: '78%',
    latency: '42 ms',
  },
}
let datasetName = 'traffic'
let playing = true
let elapsed = 0
let frames = 0
let fpsStarted = performance.now()

const routesEl = document.getElementById('routes')
const metricALabel = document.getElementById('metric-a-label')
const metricA = document.getElementById('metric-a')
const latencyEl = document.getElementById('latency')
const fpsEl = document.getElementById('fps')
const pauseButton = document.getElementById('pause')

function applyDataset(name) {
  const dataset = DATASETS[name] === undefined ? DATASETS.traffic : DATASETS[name]
  datasetName = name in DATASETS ? name : 'traffic'
  for (const route of routeObjects) {
    route.line.material.color.setHex(dataset.color)
    route.pulse.material.color.setHex(dataset.color)
  }
  for (const button of document.querySelectorAll('[data-dataset]')) {
    button.setAttribute('aria-pressed', button.dataset.dataset === datasetName ? 'true' : 'false')
  }
  if (metricALabel !== null) metricALabel.textContent = dataset.label
  if (metricA !== null) metricA.textContent = dataset.value
  if (latencyEl !== null) latencyEl.textContent = dataset.latency
}

for (const button of document.querySelectorAll('[data-dataset]')) {
  button.addEventListener('click', () => applyDataset(button.dataset.dataset))
}

pauseButton?.addEventListener('click', () => {
  playing = !playing
  pauseButton.textContent = playing ? t('Pause') : t('Resume')
  pauseButton.setAttribute('aria-pressed', playing ? 'true' : 'false')
  controls.autoRotate = playing
})

document.getElementById('reset')?.addEventListener('click', () => {
  camera.position.set(0.4, 3.5, 9.6)
  controls.target.set(-1.1, 0.1, 0)
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
    globeGroup.rotation.y += delta * 0.045
    stars.rotation.y += delta * 0.003
    atmosphere.material.rotation += delta * 0.02
    for (const route of routeObjects) {
      const t = (elapsed * route.speed * 0.25 + route.offset) % 1
      route.pulse.position.copy(route.curve.getPointAt(t))
      const pulseScale = 0.8 + Math.sin(elapsed * 2 + route.offset * 10) * 0.2
      route.pulse.scale.setScalar(pulseScale)
    }
    for (const node of nodes) {
      node.glow.material.opacity = 0.42 + Math.sin(elapsed * 1.6 + node.lon) * 0.15
    }
  }
  controls.autoRotate = playing
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

if (routesEl !== null) routesEl.textContent = String(routeObjects.length)
applyDataset('traffic')
animate()
