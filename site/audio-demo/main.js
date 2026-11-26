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
scene.background = new THREE.Color(0x05070b)
scene.fog = new THREE.FogExp2(0x05070b, 0.018)

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 80)
camera.position.set(0, 2.8, 7.6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.7, 0)
controls.enableDamping = true
controls.dampingFactor = 0.065
controls.minDistance = 4
controls.maxDistance = 13
controls.maxPolarAngle = Math.PI * 0.58
controls.enablePan = false
controls.autoRotate = true
controls.autoRotateSpeed = 0.3
controls.update()

const BAR_COUNT = 96
const BAR_RADIUS = 2.65
const bars = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.075, 1, 0.075).translate(0, 0.5, 0),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 }),
  BAR_COUNT,
)
bars.frustumCulled = false
scene.add(bars)

const barAngles = []
const colorA = new THREE.Color(0x7ce7ff)
const colorB = new THREE.Color(0x6f8dff)
const colorC = new THREE.Color(0xb86bff)
const tempColor = new THREE.Color()
for (let i = 0; i < BAR_COUNT; i += 1) {
  const angle = (i / BAR_COUNT) * Math.PI * 2
  barAngles.push(angle)
  const ratio = i / (BAR_COUNT - 1)
  if (ratio < 0.55) tempColor.copy(colorA).lerp(colorB, ratio / 0.55)
  else tempColor.copy(colorB).lerp(colorC, (ratio - 0.55) / 0.45)
  bars.setColorAt(i, tempColor)
}
if (bars.instanceColor !== null) bars.instanceColor.needsUpdate = true

const matrix = new THREE.Matrix4()
const quaternion = new THREE.Quaternion()
const position = new THREE.Vector3()
const scale = new THREE.Vector3(1, 1, 1)
for (let i = 0; i < BAR_COUNT; i += 1) {
  const angle = barAngles[i]
  position.set(Math.cos(angle) * BAR_RADIUS, 0, Math.sin(angle) * BAR_RADIUS)
  quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle)
  scale.set(1, 0.2, 1)
  matrix.compose(position, quaternion, scale)
  bars.setMatrixAt(i, matrix)
}
bars.instanceMatrix.needsUpdate = true

const waveformCount = 160
const waveformPositions = new Float32Array(waveformCount * 3)
for (let i = 0; i < waveformCount; i += 1) {
  const angle = (i / waveformCount) * Math.PI * 2
  waveformPositions[i * 3] = Math.cos(angle) * 3.45
  waveformPositions[i * 3 + 1] = 0.35
  waveformPositions[i * 3 + 2] = Math.sin(angle) * 3.45
}
const waveformGeometry = new THREE.BufferGeometry()
waveformGeometry.setAttribute('position', new THREE.BufferAttribute(waveformPositions, 3))
const waveform = new THREE.LineLoop(waveformGeometry, new THREE.LineBasicMaterial({
  color: 0x7ce7ff,
  transparent: true,
  opacity: 0.75,
  blending: THREE.AdditiveBlending,
}))
scene.add(waveform)

const coreMaterial = new THREE.MeshBasicMaterial({
  color: 0x9ffcff,
  transparent: true,
  opacity: 1,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})
const core = new THREE.Mesh(new THREE.SphereGeometry(0.42, 32, 20), coreMaterial)
core.position.y = 0.55
scene.add(core)

function makeAudioGlow() {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const g = c.getContext('2d')
  const gradient = g.createRadialGradient(128, 128, 0, 128, 128, 128)
  gradient.addColorStop(0, 'rgba(190, 250, 255, 0.95)')
  gradient.addColorStop(0.28, 'rgba(80, 200, 255, 0.45)')
  gradient.addColorStop(0.65, 'rgba(90, 110, 255, 0.12)')
  gradient.addColorStop(1, 'rgba(80, 80, 255, 0)')
  g.fillStyle = gradient
  g.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeAudioGlow(),
  color: 0x7ce7ff,
  transparent: true,
  opacity: 0.75,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}))
coreGlow.position.y = 0.55
coreGlow.scale.set(5.6, 5.6, 1)
coreGlow.material.opacity = 0.9
scene.add(coreGlow)

const haloMaterial = new THREE.MeshBasicMaterial({
  color: 0x6f8dff,
  transparent: true,
  opacity: 0.4,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})
const haloA = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.008, 6, 120), haloMaterial)
haloA.rotation.x = Math.PI * 0.5
haloA.position.y = 0.55
scene.add(haloA)
const haloB = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.006, 6, 140), haloMaterial.clone())
haloB.rotation.x = Math.PI * 0.34
haloB.rotation.z = Math.PI * 0.12
haloB.position.y = 0.55
scene.add(haloB)

const particlesGeometry = new THREE.BufferGeometry()
const particleCount = 700
const particlePositions = new Float32Array(particleCount * 3)
const particleSeeds = new Float32Array(particleCount)
for (let i = 0; i < particleCount; i += 1) {
  const angle = Math.random() * Math.PI * 2
  const radius = 3.1 + Math.random() * 3.2
  particlePositions[i * 3] = Math.cos(angle) * radius
  particlePositions[i * 3 + 1] = Math.random() * 3.6
  particlePositions[i * 3 + 2] = Math.sin(angle) * radius
  particleSeeds[i] = Math.random()
}
particlesGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
const particles = new THREE.Points(particlesGeometry, new THREE.PointsMaterial({
  color: 0x9fc6ff,
  size: 0.035,
  transparent: true,
  opacity: 0.45,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
}))
scene.add(particles)

const backgroundGeometry = new THREE.BufferGeometry()
const backgroundCount = 800
const backgroundPositions = new Float32Array(backgroundCount * 3)
for (let i = 0; i < backgroundCount; i += 1) {
  const radius = 16 + Math.random() * 24
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(2 * Math.random() - 1)
  backgroundPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
  backgroundPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.7
  backgroundPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
}
backgroundGeometry.setAttribute('position', new THREE.BufferAttribute(backgroundPositions, 3))
const backgroundStars = new THREE.Points(backgroundGeometry, new THREE.PointsMaterial({
  color: 0x9fc6ff,
  size: 0.05,
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
}))
scene.add(backgroundStars)

const sourceLabel = document.getElementById('source-label')
const levelEl = document.getElementById('level')
const fpsEl = document.getElementById('fps')
const pauseButton = document.getElementById('pause')
const toastEl = document.getElementById('toast')

let audioContext = null
let analyser = null
let frequencyData = null
let timeData = null
let sourceNode = null
let stream = null
let demoTimer = null
let demoNodes = []
let sourceName = 'IDLE'
let paused = false
let frames = 0
let fpsStarted = performance.now()
let elapsed = 0
let toastTimer = null

function toast(message) {
  if (toastEl === null) return
  toastEl.textContent = message
  toastEl.classList.add('is-visible')
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2600)
}

function ensureContext() {
  if (audioContext === null) {
    const Context = window.AudioContext || window.webkitAudioContext
    if (Context === undefined) throw new Error('Web Audio is not supported.')
    audioContext = new Context()
    analyser = audioContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.82
    frequencyData = new Uint8Array(analyser.frequencyBinCount)
    timeData = new Uint8Array(analyser.fftSize)
    const silent = audioContext.createGain()
    silent.gain.value = 0.00001
    analyser.connect(silent)
    silent.connect(audioContext.destination)
  }
  return audioContext
}

function stopInput() {
  if (demoTimer !== null) {
    clearInterval(demoTimer)
    demoTimer = null
  }
  for (const node of demoNodes) {
    try { node.stop() } catch (error) { void error }
  }
  demoNodes = []
  if (stream !== null) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
  }
  if (sourceNode !== null) {
    try { sourceNode.disconnect() } catch (error) { void error }
    sourceNode = null
  }
}

function setSource(name) {
  sourceName = name
  if (sourceLabel !== null) sourceLabel.textContent = name
  if (pauseButton !== null) pauseButton.disabled = false
  document.body.classList.add('is-live')
}

async function startMic() {
  try {
    stopInput()
    const context = ensureContext()
    await context.resume()
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    sourceNode = context.createMediaStreamSource(stream)
    sourceNode.connect(analyser)
    setSource('MIC')
    toast(t('Microphone connected'))
  } catch (error) {
    toast(t('Microphone unavailable; using demo track'))
    startDemo()
  }
}

function scheduleDemoNote(context, frequency, index) {
  const now = context.currentTime
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = index % 3 === 0 ? 'sine' : 'triangle'
  oscillator.frequency.setValueAtTime(frequency, now)
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(index % 4 === 0 ? 0.16 : 0.09, now + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
  oscillator.connect(gain)
  gain.connect(analyser)
  oscillator.start(now)
  oscillator.stop(now + 0.32)
  demoNodes.push(oscillator)
  if (demoNodes.length > 18) demoNodes.splice(0, demoNodes.length - 18)
}

async function startDemo() {
  try {
    stopInput()
    const context = ensureContext()
    await context.resume()
    const notes = [110, 146.83, 164.81, 220, 261.63, 329.63, 392, 329.63, 261.63, 220]
    let index = 0
    const trigger = () => {
      const frequency = notes[index % notes.length]
      scheduleDemoNote(context, frequency, index)
      if (index % 4 === 0) scheduleDemoNote(context, frequency / 2, index + 1)
      index += 1
    }
    trigger()
    demoTimer = setInterval(trigger, 230)
    setSource('DEMO')
    toast(t('Demo track started (silent driver)'))
  } catch (error) {
    toast(t('Audio initialization failed: ') + (error instanceof Error ? error.message : String(error)))
  }
}

document.getElementById('mic')?.addEventListener('click', startMic)
document.getElementById('demo')?.addEventListener('click', startDemo)
document.getElementById('gate-mic')?.addEventListener('click', startMic)
document.getElementById('gate-demo')?.addEventListener('click', startDemo)
pauseButton?.addEventListener('click', () => {
  paused = !paused
  pauseButton.textContent = paused ? t('Resume') : t('Pause')
})
document.getElementById('reset')?.addEventListener('click', () => {
  camera.position.set(0, 2.8, 7.6)
  controls.target.set(0, 0.7, 0)
  controls.autoRotate = true
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
const tmpMatrix = new THREE.Matrix4()
const tmpQuaternion = new THREE.Quaternion()
const tmpPosition = new THREE.Vector3()
const tmpScale = new THREE.Vector3(1, 1, 1)
let smoothedLevel = 0

function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  elapsed += delta

  let level = 0
  if (!paused && analyser !== null) {
    analyser.getByteFrequencyData(frequencyData)
    analyser.getByteTimeDomainData(timeData)
    for (let i = 0; i < 48; i += 1) level += frequencyData[i] ?? 0
    level = level / (48 * 255)
  }
  smoothedLevel += (level - smoothedLevel) * 0.15
  if (levelEl !== null) levelEl.textContent = `${String(Math.round(smoothedLevel * 100))}%`
  if (sourceName === 'IDLE') {
    if (levelEl !== null) levelEl.textContent = '—'
  }

  for (let i = 0; i < BAR_COUNT; i += 1) {
    let value
    if (!paused && analyser !== null && sourceName !== 'IDLE' && smoothedLevel > 0.005) {
      const index = Math.floor((i / BAR_COUNT) * 96)
      value = (frequencyData[index] ?? 0) / 255
    } else {
      value = 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(elapsed * 1.4 + i * 0.42))
    }
    const angle = barAngles[i]
    const height = 0.16 + Math.min(2.2, value * 2.9)
    tmpPosition.set(Math.cos(angle) * BAR_RADIUS, 0, Math.sin(angle) * BAR_RADIUS)
    tmpQuaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle)
    tmpScale.set(1, height, 1)
    tmpMatrix.compose(tmpPosition, tmpQuaternion, tmpScale)
    bars.setMatrixAt(i, tmpMatrix)
  }
  bars.instanceMatrix.needsUpdate = true

  if (!paused && analyser !== null && timeData !== null) {
    for (let i = 0; i < waveformCount; i += 1) {
      const sample = (timeData[Math.floor((i / waveformCount) * timeData.length)] ?? 128) - 128
      waveformPositions[i * 3 + 1] = 0.35 + (sample / 128) * 0.65
    }
    waveformGeometry.attributes.position.needsUpdate = true
  }

  core.scale.setScalar(0.8 + smoothedLevel * 0.45 + Math.sin(elapsed * 1.8) * 0.03)
  coreMaterial.opacity = 0.85 + smoothedLevel * 0.15
  coreGlow.scale.setScalar(5.6 + smoothedLevel * 2.2)
  coreGlow.material.opacity = 0.8 + smoothedLevel * 0.2
  haloA.rotation.z += delta * 0.3
  haloB.rotation.z -= delta * 0.22
  haloA.scale.setScalar(1 + smoothedLevel * 0.22)
  haloB.scale.setScalar(1 + smoothedLevel * 0.35)
  particles.rotation.y += delta * 0.02
  backgroundStars.rotation.y += delta * 0.004

  controls.autoRotate = !paused
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
