import * as THREE from 'three'
import { t, language } from '../i18n.js'
import { OrbitControls } from 'three/addons/OrbitControls.js'

const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.1

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x03050a)

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 140)
camera.position.set(0, 6, 17.5)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
controls.enableDamping = true
controls.dampingFactor = 0.06
controls.minDistance = 8
controls.maxDistance = 42
controls.maxPolarAngle = Math.PI * 0.62
controls.minPolarAngle = Math.PI * 0.18
controls.enablePan = false
controls.autoRotate = true
controls.autoRotateSpeed = 0.34
controls.update()

const isMobile = window.matchMedia('(max-width: 700px)').matches
const COUNT = isMobile ? 52000 : 120000
const TAU = Math.PI * 2

const PALETTES = [
  {
    name: 'Aurora',
    stops: ['#ffd49a', '#ff9a4d', '#5f7dff', '#b86bff', '#5fe1ff'],
  },
  {
    name: 'Ember',
    stops: ['#ffd49a', '#ff8a3d', '#d92d4a', '#8f1d38', '#ffcf6e'],
  },
  {
    name: 'Ice',
    stops: ['#dfefff', '#9fc6ff', '#5f9dff', '#3f5bd8', '#8fe7ff'],
  },
]
let paletteIndex = 0

function mulberry32(seed) {
  let value = seed >>> 0
  return function random() {
    value += 0x6d2b79f5
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function colorAt(stops, ratio, random) {
  const scaled = Math.min(0.9999, Math.max(0, ratio)) * (stops.length - 1)
  const index = Math.min(stops.length - 2, Math.floor(scaled))
  const mix = scaled - index
  const a = new THREE.Color(stops[index])
  const b = new THREE.Color(stops[index + 1])
  const color = a.lerp(b, mix)
  color.offsetHSL((random() - 0.5) * 0.03, 0, (random() - 0.5) * 0.12)
  return color
}

const geometry = new THREE.BufferGeometry()
const material = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    uTime: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
  },
  vertexShader: `
    uniform float uTime;
    uniform float uPixelRatio;
    attribute vec3 aColor;
    attribute float aSize;
    attribute float aSeed;
    varying vec3 vColor;
    varying float vTwinkle;

    void main() {
      vec3 p = position;
      float radius = length(p.xz);
      float angle = uTime * (0.018 + aSeed * 0.014) * (1.0 - clamp(radius / 12.0, 0.0, 0.85));
      float c = cos(angle);
      float s = sin(angle);
      p.xz = mat2(c, -s, s, c) * p.xz;
      p.y += sin(uTime * 0.22 + aSeed * 31.0 + radius) * 0.035;

      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = clamp(aSize * uPixelRatio * (110.0 / max(1.0, -mv.z)), 0.8, 8.0);
      vColor = aColor;
      vTwinkle = 0.28 + 0.42 * (0.5 + 0.5 * sin(uTime * 1.8 + aSeed * 19.0));
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vTwinkle;

    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv);
      if (d > 0.5) discard;
      float alpha = smoothstep(0.5, 0.02, d) * vTwinkle;
      gl_FragColor = vec4(vColor, alpha * 0.85);
    }
  `,
})

let seed = 20261124
let positions = null
let colors = null
let sizes = null
let seeds = null

function buildGalaxy(nextSeed) {
  const random = mulberry32(nextSeed)
  positions = new Float32Array(COUNT * 3)
  colors = new Float32Array(COUNT * 3)
  sizes = new Float32Array(COUNT)
  seeds = new Float32Array(COUNT)
  const stops = PALETTES[paletteIndex].stops

  for (let i = 0; i < COUNT; i += 1) {
    const radius = Math.pow(random(), 0.62) * 9.2 + 0.08
    const branch = i % 3
    const angle = (branch / 3) * TAU + radius * 0.58 + (random() - 0.5) * (0.55 + radius * 0.04)
    const spread = (random() - 0.5) * (0.35 + radius * 0.16)
    const x = Math.cos(angle) * radius + spread
    const z = Math.sin(angle) * radius + spread
    const y = (random() - 0.5) * (0.95 - radius * 0.055) + Math.sin(radius * 0.9) * 0.12
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = z

    const ratio = Math.min(1, radius / 9.2)
    const color = colorAt(stops, ratio, random)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
    sizes[i] = 0.08 + random() * 0.38 + (1 - ratio) * 0.28
    seeds[i] = random()
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.attributes.position.needsUpdate = true
  geometry.attributes.aColor.needsUpdate = true
  geometry.attributes.aSize.needsUpdate = true
  geometry.attributes.aSeed.needsUpdate = true
}

function recolor() {
  if (positions === null) return
  const random = mulberry32(seed + 17)
  const stops = PALETTES[paletteIndex].stops
  for (let i = 0; i < COUNT; i += 1) {
    const x = positions[i * 3]
    const z = positions[i * 3 + 2]
    const ratio = Math.min(1, Math.hypot(x, z) / 9.2)
    const color = colorAt(stops, ratio, random)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geometry.attributes.aColor.needsUpdate = true
}

buildGalaxy(seed)
const galaxy = new THREE.Points(geometry, material)
galaxy.frustumCulled = false
scene.add(galaxy)

const backgroundGeometry = new THREE.BufferGeometry()
const backgroundCount = 1400
const backgroundPositions = new Float32Array(backgroundCount * 3)
const backgroundRandom = mulberry32(99)
for (let i = 0; i < backgroundCount; i += 1) {
  const radius = 22 + backgroundRandom() * 28
  const theta = backgroundRandom() * TAU
  const phi = Math.acos(2 * backgroundRandom() - 1)
  backgroundPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
  backgroundPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.7
  backgroundPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
}
backgroundGeometry.setAttribute('position', new THREE.BufferAttribute(backgroundPositions, 3))
const backgroundStars = new THREE.Points(backgroundGeometry, new THREE.PointsMaterial({
  color: 0x9fc6ff,
  size: 0.05,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
}))
scene.add(backgroundStars)

function makeCoreGlow() {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  gradient.addColorStop(0, 'rgba(255, 244, 214, 0.95)')
  gradient.addColorStop(0.2, 'rgba(255, 196, 110, 0.55)')
  gradient.addColorStop(0.5, 'rgba(255, 150, 70, 0.16)')
  gradient.addColorStop(1, 'rgba(255, 120, 40, 0)')
  g.fillStyle = gradient
  g.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeCoreGlow(),
  color: 0xffd49a,
  transparent: true,
  opacity: 0.9,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}))
coreGlow.scale.set(3.0, 3.0, 1)
coreGlow.material.opacity = 0.7
scene.add(coreGlow)

const countEl = document.getElementById('count')
const fpsEl = document.getElementById('fps')
const paletteName = document.getElementById('palette-name')
const pauseButton = document.getElementById('pause')
if (countEl !== null) countEl.textContent = `${String(COUNT / 1000)}K`
if (paletteName !== null) paletteName.textContent = PALETTES[paletteIndex].name

let playing = true
let elapsed = 0
let frames = 0
let fpsStarted = performance.now()
const clock = new THREE.Clock()

pauseButton?.addEventListener('click', () => {
  playing = !playing
  pauseButton.textContent = playing ? t('Pause') : t('Resume')
  pauseButton.setAttribute('aria-pressed', playing ? 'true' : 'false')
  controls.autoRotate = playing
})

document.getElementById('regenerate')?.addEventListener('click', () => {
  seed += 1
  buildGalaxy(seed)
  paletteIndex = (paletteIndex + 0) % PALETTES.length
  if (paletteName !== null) paletteName.textContent = PALETTES[paletteIndex].name
})

document.getElementById('palette')?.addEventListener('click', () => {
  paletteIndex = (paletteIndex + 1) % PALETTES.length
  recolor()
  if (paletteName !== null) paletteName.textContent = PALETTES[paletteIndex].name
})

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  material.uniforms.uPixelRatio.value = renderer.getPixelRatio()
}
window.addEventListener('resize', resize)
resize()

function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (playing) {
    elapsed += delta
    material.uniforms.uTime.value = elapsed
    backgroundStars.rotation.y += delta * 0.004
    coreGlow.material.rotation += delta * 0.03
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

animate()
