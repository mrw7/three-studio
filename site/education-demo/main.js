import * as THREE from 'three'
import { t, language } from '../i18n.js'
import { OrbitControls } from 'three/addons/OrbitControls.js'

const canvas = document.getElementById('scene')
const stage = canvas.parentElement
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.05
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x04070c)
scene.fog = new THREE.FogExp2(0x04070c, 0.012)

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120)
const HOME_POSITION = new THREE.Vector3(8.5, 6.2, 10.5)
camera.position.copy(HOME_POSITION)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)
controls.enableDamping = true
controls.dampingFactor = 0.07
controls.minDistance = 5
controls.maxDistance = 22
controls.enablePan = false
controls.autoRotate = true
controls.autoRotateSpeed = 0.28
controls.update()
controls.addEventListener('start', () => { controls.autoRotate = false })

scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x05070a, 0.65))

const key = new THREE.DirectionalLight(0xffffff, 1.1)
key.position.set(6, 9, 6)
scene.add(key)

const fill = new THREE.DirectionalLight(0x6f8dff, 0.55)
fill.position.set(-7, 4, -5)
scene.add(fill)

const starsGeometry = new THREE.BufferGeometry()
const starCount = 900
const starPositions = new Float32Array(starCount * 3)
for (let i = 0; i < starCount; i += 1) {
  const radius = 18 + Math.random() * 32
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
  starPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.65
  starPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
}
starsGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
const stars = new THREE.Points(starsGeometry, new THREE.PointsMaterial({
  color: 0x9fc6ff,
  size: 0.055,
  transparent: true,
  opacity: 0.65,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
}))
scene.add(stars)

const grid = new THREE.GridHelper(16, 32, 0x29466c, 0x14243a)
grid.position.y = -2
grid.material.transparent = true
grid.material.opacity = 0.3
scene.add(grid)

const placeholder = new THREE.Mesh(
  new THREE.BoxGeometry(1.2, 1.2, 1.2),
  new THREE.MeshStandardMaterial({ color: 0x6f8dff, wireframe: true, transparent: true, opacity: 0.55 }),
)
placeholder.position.y = 0
scene.add(placeholder)

const sunGroup = new THREE.Group()
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(1.25, 64, 32),
  new THREE.MeshStandardMaterial({
    color: 0xffcf6e,
    emissive: 0xff8a2a,
    emissiveIntensity: 2.2,
    roughness: 0.42,
    metalness: 0.1,
  }),
)
sunGroup.add(sun)
function makeSunGlowTexture() {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  gradient.addColorStop(0, 'rgba(255, 220, 150, 0.95)')
  gradient.addColorStop(0.28, 'rgba(255, 180, 90, 0.42)')
  gradient.addColorStop(0.62, 'rgba(255, 140, 50, 0.12)')
  gradient.addColorStop(1, 'rgba(255, 120, 30, 0)')
  g.fillStyle = gradient
  g.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeSunGlowTexture(),
  color: 0xffcf8a,
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}))
sunGlow.scale.set(5.6, 5.6, 1)
sunGroup.add(sunGlow)
const sunLight = new THREE.PointLight(0xffcf6e, 220, 40, 2)
sunGroup.add(sunLight)
sunGroup.visible = false
scene.add(sunGroup)

const planetGroup = new THREE.Group()
const orbitGroup = new THREE.Group()
planetGroup.visible = false
orbitGroup.visible = false
scene.add(planetGroup, orbitGroup)

const PLANETS = [
  { name: 'Mercury', size: 0.18, distance: 2.65, color: 0x9fa6ad, speed: 0.95, phase: 0.4 },
  { name: 'Venus', size: 0.26, distance: 3.55, color: 0xe1b56b, speed: 0.72, phase: 2.1 },
  { name: 'Earth', size: 0.3, distance: 4.65, color: 0x4d8dff, speed: 0.55, phase: 4.0 },
  { name: 'Mars', size: 0.22, distance: 5.8, color: 0xd97755, speed: 0.44, phase: 5.4 },
]
const planets = []
let earthMesh = null
for (const data of PLANETS) {
  const pivot = new THREE.Group()
  pivot.rotation.y = data.phase
  planetGroup.add(pivot)
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(data.size, 32, 20),
    new THREE.MeshStandardMaterial({ color: data.color, roughness: 0.72, metalness: 0.08 }),
  )
  mesh.position.x = data.distance
  mesh.castShadow = true
  mesh.receiveShadow = true
  pivot.add(mesh)
  planets.push({ ...data, pivot, mesh })
  if (data.name === 'Earth') earthMesh = mesh

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(data.distance, 0.006, 6, 160),
    new THREE.MeshBasicMaterial({
      color: 0x6f8dff,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  ring.rotation.x = Math.PI / 2
  orbitGroup.add(ring)
}

const moonOrbit = new THREE.Group()
if (earthMesh !== null) {
  moonOrbit.visible = false
  earthMesh.add(moonOrbit)
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xc8cedb, roughness: 0.8, metalness: 0.05 }),
  )
  moon.position.x = 0.56
  moon.castShadow = true
  moonOrbit.add(moon)
  const moonRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.56, 0.003, 4, 80),
    new THREE.MeshBasicMaterial({
      color: 0x9fc6ff,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  )
  moonRing.rotation.x = Math.PI / 2
  moonOrbit.add(moonRing)
}

const STEPS = [
  {
    title: t('搭好舞台'),
    stage: 'STEP 01 · STAGE',
    code: `const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 120)
camera.position.set(8.5, 6.2, 10.5)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0, 0)

scene.add(new THREE.HemisphereLight(0x9fc6ff, 0x05070a, 0.65))
scene.add(new THREE.DirectionalLight(0xffffff, 1.1))`,
    tip: t('先确定相机、灯光和可交互的控制器，再开始放物体。OrbitControls 让用户拖动旋转、滚轮缩放。'),
  },
  {
    title: t('点亮太阳'),
    stage: 'STEP 02 · SUN',
    code: `const sun = new THREE.Mesh(
  new THREE.SphereGeometry(1.25, 64, 32),
  new THREE.MeshStandardMaterial({
    color: 0xffcf6e,
    emissive: 0xff8a2a,
    emissiveIntensity: 2.2,
  })
)

const sunLight = new THREE.PointLight(0xffcf6e, 220, 40, 2)
sun.add(sunLight)
scene.add(sun)`,
    tip: t('emissive 让太阳自己发光，PointLight 负责照亮行星。太阳材质本身不会照亮别人，光源要单独加。'),
  },
  {
    title: t('让行星公转'),
    stage: 'STEP 03 · ORBITS',
    code: `const planets = [
  { distance: 2.65, size: 0.18, color: 0x9fa6ad, speed: 0.95 },
  { distance: 3.55, size: 0.26, color: 0xe1b56b, speed: 0.72 },
  { distance: 4.65, size: 0.30, color: 0x4d8dff, speed: 0.55 },
  { distance: 5.80, size: 0.22, color: 0xd97755, speed: 0.44 },
]

for (const data of planets) {
  const pivot = new THREE.Group()
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(data.size, 32, 20),
    new THREE.MeshStandardMaterial({ color: data.color })
  )
  mesh.position.x = data.distance
  pivot.add(mesh)
  scene.add(pivot)
  pivots.push({ pivot, speed: data.speed })
}

// onFrame
for (const { pivot, speed } of pivots) pivot.rotation.y += delta * speed`,
    tip: t('把公转放在 onFrame 里，用 delta 控制速度；不要用 setInterval。每颗行星用一个 pivot 旋转，位置更稳定。'),
  },
  {
    title: t('加一颗月球'),
    stage: 'STEP 04 · MOON',
    code: `const moonOrbit = new THREE.Group()
earth.add(moonOrbit)

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(0.075, 20, 14),
  new THREE.MeshStandardMaterial({ color: 0xc8cedb })
)
moon.position.x = 0.56
moonOrbit.add(moon)

// onFrame
moonOrbit.rotation.y += delta * 2.4`,
    tip: t('把月球挂在 Earth 下面，它就会自动跟着地球公转；再让 moonOrbit 自己旋转，就有了“月球绕地球”。'),
  },
]

const codeTitle = document.getElementById('code-title')
const codeBlock = document.getElementById('code-block')
const tip = document.getElementById('tip')
const stageLabel = document.getElementById('stage-label')
const stepCount = document.getElementById('step-count')
const progressBar = document.getElementById('progress-bar')
const prevButton = document.getElementById('prev-step')
const nextButton = document.getElementById('next-step')
const playButton = document.getElementById('play-toggle')
const toastEl = document.getElementById('toast')
let step = 0
let playing = true
let toastTimer = null

function toast(message) {
  if (toastEl === null) return
  toastEl.textContent = message
  toastEl.classList.add('is-visible')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2400)
}

function applyStep(nextStep) {
  step = Math.max(0, Math.min(STEPS.length - 1, nextStep))
  const current = STEPS[step]
  sunGroup.visible = step >= 1
  placeholder.visible = step === 0
  grid.visible = step === 0
  planetGroup.visible = step >= 2
  orbitGroup.visible = step >= 2
  moonOrbit.visible = step >= 3

  codeTitle.textContent = current.title
  codeBlock.textContent = current.code
  tip.textContent = current.tip
  stageLabel.textContent = current.stage
  stepCount.textContent = `STEP 0${String(step + 1)} / 04`
  progressBar.style.width = `${String(((step + 1) / STEPS.length) * 100)}%`
  for (const button of document.querySelectorAll('[data-step]')) {
    const active = Number(button.dataset.step) === step
    if (active) button.setAttribute('aria-current', 'true')
    else button.removeAttribute('aria-current')
  }
  prevButton.disabled = step === 0
  nextButton.disabled = step === STEPS.length - 1
  nextButton.textContent = step === STEPS.length - 1 ? t('已完成') : t('下一步 →')
}

for (const button of document.querySelectorAll('[data-step]')) {
  button.addEventListener('click', () => applyStep(Number(button.dataset.step)))
}
prevButton.addEventListener('click', () => applyStep(step - 1))
nextButton.addEventListener('click', () => applyStep(step + 1))
playButton.addEventListener('click', () => {
  playing = !playing
  playButton.setAttribute('aria-pressed', playing ? 'true' : 'false')
  playButton.textContent = playing ? t('暂停动画') : t('继续动画')
  controls.autoRotate = playing
})

document.getElementById('copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(codeBlock.textContent)
    toast(t('代码已复制'))
  } catch (error) {
    const area = document.createElement('textarea')
    area.value = codeBlock.textContent
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    try { document.execCommand('copy'); toast(t('代码已复制')) } catch (copyError) { toast(t('复制失败')) }
    area.remove()
  }
})

function resize() {
  const width = stage.clientWidth
  const height = stage.clientHeight
  if (width <= 0 || height <= 0) return
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}
new ResizeObserver(resize).observe(stage)
resize()

const clock = new THREE.Clock()
let elapsed = 0
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (playing) {
    elapsed += delta
    for (const planet of planets) planet.pivot.rotation.y += delta * planet.speed
    moonOrbit.rotation.y += delta * 2.4
    sun.rotation.y += delta * 0.18
    sunGlow.material.rotation += delta * 0.05
    stars.rotation.y += delta * 0.006
  }
  controls.update(delta)
  renderer.render(scene, camera)
}

applyStep(0)
animate()
