import * as THREE from 'three'
import { t, language } from '../i18n.js'
import { buildWatchScene } from './scene-watch.js'

const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 120)
const controls = {
  target: new THREE.Vector3(0, 1.15, 0),
  enableDamping: false,
  dampingFactor: 0,
  rotateSpeed: 0,
  minDistance: 1,
  maxDistance: 100,
  maxPolarAngle: Math.PI,
  minPolarAngle: 0,
  update() {},
}
const frameCallbacks = []
const watch = buildWatchScene({
  renderer,
  camera,
  scene,
  controls,
  onFrame: callback => frameCallbacks.push(callback),
  wb: { id: object => object },
})
// The Studio example includes a dark floor/pedestal for a viewport shot. The
// marketing page looks cleaner as a floating product against the sky gradient;
// keep the glowing edge ring and pool.
for (const key of ['floor', 'pedestal', 'contact']) {
  const object = watch.objects?.[key]
  if (object !== undefined && object !== null) object.visible = false
}
window.__agencyWatch = watch

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const finePointer = window.matchMedia('(pointer: fine)').matches
const clock = new THREE.Clock()
let elapsed = 0
let progress = 0
let targetProgress = 0
let mobileView = false
const mouse = { x: 0, y: 0 }
const smoothMouse = { x: 0, y: 0 }

const CAMERA_KEYS = [
  { position: [0.0, 2.45, 6.55], target: [0.0, 1.15, 0.0], fov: 36 },
  { position: [1.35, 1.95, 4.85], target: [0.0, 1.25, 0.0], fov: 32 },
  { position: [-0.85, 2.95, 4.65], target: [0.0, 1.02, 0.0], fov: 30 },
  { position: [1.55, 1.55, 5.15], target: [0.0, 1.20, 0.0], fov: 34 },
  { position: [0.0, 2.25, 7.15], target: [0.0, 1.05, 0.0], fov: 38 },
]

const clamp = value => Math.max(0, Math.min(1, value))
const lerp = (a, b, t) => a + (b - a) * t
const ease = t => t * t * (3 - 2 * t)

function sampleCamera(value) {
  const scaled = clamp(value) * (CAMERA_KEYS.length - 1)
  const index = Math.min(CAMERA_KEYS.length - 2, Math.floor(scaled))
  const t = ease(scaled - index)
  const a = CAMERA_KEYS[index]
  const b = CAMERA_KEYS[index + 1]
  return {
    position: a.position.map((v, i) => lerp(v, b.position[i], t)),
    target: a.target.map((v, i) => lerp(v, b.target[i], t)),
    fov: lerp(a.fov, b.fov, t),
  }
}

function updateScroll() {
  const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
  targetProgress = clamp(window.scrollY / max)
  document.body.classList.toggle('is-scrolled', window.scrollY > 24)
  document.documentElement.style.setProperty('--scroll-progress', String(targetProgress))
}

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  mobileView = width < 720
  renderer.setSize(width, height, false)
  camera.aspect = width / Math.max(1, height)
  camera.updateProjectionMatrix()
}

function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  elapsed += delta
  progress += (targetProgress - progress) * (reducedMotion ? 1 : 0.075)
  smoothMouse.x += (mouse.x - smoothMouse.x) * 0.06
  smoothMouse.y += (mouse.y - smoothMouse.y) * 0.06

  for (const callback of frameCallbacks) callback({ time: elapsed, delta })

  const view = sampleCamera(progress)
  // The hero headline owns the left half of the page, so frame the watch right
  // of centre by sliding camera and target together: that keeps the viewing
  // angle (and therefore the reflections) while moving the subject on screen.
  // The offset fades out as soon as the first chapter panel takes over.
  const heroShift = 1.45 * (1 - clamp(progress / 0.11))
  view.position[0] -= heroShift
  view.target[0] -= heroShift
  if (mobileView) {
    view.position[1] += 1.0
    view.position[2] += 2.4
    view.target[1] += 1.45
    view.fov += 2
  }
  const parallaxX = reducedMotion || !finePointer ? 0 : smoothMouse.x * 0.16
  const parallaxY = reducedMotion || !finePointer ? 0 : -smoothMouse.y * 0.11
  camera.position.set(view.position[0] + parallaxX, view.position[1] + parallaxY, view.position[2])
  camera.fov = view.fov
  camera.updateProjectionMatrix()
  const target = new THREE.Vector3(...view.target)
  if (finePointer && !reducedMotion) {
    target.x += smoothMouse.x * 0.035
    target.y += smoothMouse.y * 0.025
  }
  camera.lookAt(target)
  renderer.render(scene, camera)
}

const swatches = [...document.querySelectorAll('[data-variant]')]
const variantTitle = document.getElementById('variant-title')
const variantCopy = document.getElementById('variant-copy')
const variantNames = {
  azure: ['Azure Blue', t('深海蓝陶瓷圈，冷光钢壳。像一段被冻结的蓝色时间。')],
  graphite: ['Graphite', t('石墨灰表盘与拉丝钢，低调、克制，适合日常佩戴。')],
  champagne: ['Champagne', t('香槟金与深棕陶瓷，暖光下的复古机械感。')],
  ember: ['Ember', t('酒红陶瓷与暖色指针，像一枚仍在燃烧的机芯。')],
}

function setVariant(name) {
  const resolved = variantNames[name] === undefined ? 'azure' : name
  watch.setVariant(resolved)
  for (const button of swatches) {
    const active = button.dataset.variant === resolved
    button.setAttribute('aria-pressed', active ? 'true' : 'false')
  }
  const [title, copy] = variantNames[resolved]
  if (variantTitle !== null) variantTitle.textContent = title
  if (variantCopy !== null) variantCopy.textContent = copy
  document.body.dataset.variant = resolved
}

for (const button of swatches) {
  button.addEventListener('click', () => setVariant(button.dataset.variant))
}

const reveal = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting) entry.target.classList.add('is-visible')
  }
}, { threshold: 0.18, rootMargin: '0px 0px -8% 0px' })
for (const element of document.querySelectorAll('[data-reveal]')) reveal.observe(element)

window.addEventListener('scroll', updateScroll, { passive: true })
window.addEventListener('resize', resize)
window.addEventListener('pointermove', event => {
  if (!finePointer || reducedMotion) return
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1
  mouse.y = (event.clientY / window.innerHeight) * 2 - 1
}, { passive: true })

resize()
updateScroll()
setVariant('azure')
animate()

requestAnimationFrame(() => {
  document.body.classList.add('is-ready')
  const loading = document.getElementById('loading')
  if (loading !== null) {
    window.setTimeout(() => loading.remove(), 550)
  }
})
