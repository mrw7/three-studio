// TURBOFAN digital manual — drives the generated stage with the manual steps
// from examples/turbofan-manual.json (emitted as ./manual.js).
import * as THREE from 'three'
import { t } from '../i18n.js'
import { createStage } from './scene.js'
import { MANUAL } from './manual.js'

const canvas = document.getElementById('scene')
const stage = createStage(canvas)

const els = {
  title: document.getElementById('manual-title'),
  sub: document.getElementById('manual-sub'),
  list: document.getElementById('step-list'),
  stepTitle: document.getElementById('step-title'),
  stepText: document.getElementById('step-text'),
  hotspots: document.getElementById('step-hotspots'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  count: document.getElementById('step-count'),
  bomCount: document.getElementById('bom-count'),
  bomList: document.getElementById('bom-list'),
}

const steps = MANUAL.steps
let index = 0
let cameraTween = null
let tweenStart = 0
const CAMERA_DURATION = 700

// ---- camera: tween between step poses instead of snapping ----
const easeInOut = value => (value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2)

function applyCamera(step, animate) {
  const pose = step.camera
  const to = {
    position: new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
    target: new THREE.Vector3(pose.target[0], pose.target[1], pose.target[2]),
    fov: pose.fov,
  }
  if (!animate) {
    stage.camera.position.copy(to.position)
    stage.controls.target.copy(to.target)
    stage.camera.fov = to.fov
    stage.camera.updateProjectionMatrix()
    stage.controls.update()
    cameraTween = null
    return
  }
  cameraTween = {
    from: {
      position: stage.camera.position.clone(),
      target: stage.controls.target.clone(),
      fov: stage.camera.fov,
    },
    to,
  }
  tweenStart = performance.now()
}

function stepTween() {
  if (cameraTween === null) return
  const raw = Math.min(1, (performance.now() - tweenStart) / CAMERA_DURATION)
  const k = easeInOut(raw)
  stage.camera.position.lerpVectors(cameraTween.from.position, cameraTween.to.position, k)
  stage.controls.target.lerpVectors(cameraTween.from.target, cameraTween.to.target, k)
  stage.camera.fov = cameraTween.from.fov + (cameraTween.to.fov - cameraTween.from.fov) * k
  stage.camera.updateProjectionMatrix()
  if (raw >= 1) cameraTween = null
}

// ---- authored visibility and highlight, both restored per step ----
const baseVisible = new Map()
stage.scene.traverse(node => {
  if (node.userData && typeof node.userData.wbId === 'string') {
    baseVisible.set(node.userData.wbId, node.visible)
  }
})

let highlighted = []

function clearHighlight() {
  for (const entry of highlighted) {
    entry.material.emissive.copy(entry.emissive)
    entry.material.emissiveIntensity = entry.emissiveIntensity
  }
  highlighted = []
  stage.scene.traverse(node => {
    if (node.userData && node.userData.wbId !== undefined) node.userData.highlighted = false
  })
}

function applyHighlight(uid) {
  clearHighlight()
  if (uid === null) return
  const object = stage.byId(uid)
  if (object === null) return
  object.traverse(node => {
    if (node.material === undefined || node.material === null) return
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      if (material.emissive === undefined || material.emissive === null) continue
      highlighted.push({
        material,
        emissive: material.emissive.clone(),
        emissiveIntensity: material.emissiveIntensity,
      })
      material.emissive.lerp(new THREE.Color(0x6f8dff), 0.5)
      material.emissiveIntensity = Math.max(material.emissiveIntensity, 0.42)
    }
  })
}

function applyHidden(uids) {
  for (const [uid, visible] of baseVisible) {
    const object = stage.byId(uid)
    if (object !== null) object.visible = visible
  }
  for (const uid of uids) {
    const object = stage.byId(uid)
    if (object !== null) object.visible = false
  }
}

// ---- per-step render ----
function render(next) {
  const step = steps[next]
  els.stepTitle.textContent = step.title
  els.stepText.textContent = step.body
  els.count.textContent = String(next + 1) + ' / ' + String(steps.length)
  els.prev.disabled = next === 0
  els.next.disabled = next === steps.length - 1

  for (const button of els.list.querySelectorAll('button')) {
    button.setAttribute('aria-current', button.dataset.step === step.id ? 'true' : 'false')
  }

  els.hotspots.textContent = ''
  for (const hotspot of step.hotspots) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = hotspot.label
    button.addEventListener('click', () => focusUid(hotspot.uid))
    els.hotspots.appendChild(button)
  }

  applyHidden(step.hidden)
  applyHighlight(step.highlight)
  applyCamera(step, next !== 0)
}

function focusUid(uid) {
  const object = stage.byId(uid)
  if (object === null) return
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(0.6, box.getSize(new THREE.Vector3()).length() * 0.5)
  const direction = stage.camera.position.clone().sub(stage.controls.target).normalize()
  stage.controls.target.copy(center)
  stage.camera.position.copy(center).addScaledVector(direction, radius * 2.2)
  stage.camera.updateProjectionMatrix()
  stage.controls.update()
  cameraTween = null
}

function goTo(next) {
  const clamped = Math.max(0, Math.min(steps.length - 1, next))
  if (clamped === index) return
  index = clamped
  render(index)
}

// ---- step list, title and BOM ----
els.title.textContent = MANUAL.title
els.sub.textContent = [MANUAL.product, MANUAL.version].filter(part => part !== '').join(' · ')

steps.forEach((step, position) => {
  const item = document.createElement('li')
  const button = document.createElement('button')
  button.type = 'button'
  button.dataset.step = step.id
  button.setAttribute('aria-current', 'false')
  const num = document.createElement('span')
  num.className = 'num'
  num.textContent = String(position + 1).padStart(2, '0')
  const label = document.createElement('span')
  label.textContent = step.title
  button.append(num, label)
  button.addEventListener('click', () => goTo(position))
  item.appendChild(button)
  els.list.appendChild(item)
})

els.bomCount.textContent = String(MANUAL.parts.length)
for (const part of MANUAL.parts) {
  const item = document.createElement('li')
  const no = document.createElement('span')
  no.className = 'no'
  no.textContent = part.number
  const name = document.createElement('span')
  name.textContent = part.name
  const qty = document.createElement('span')
  qty.className = 'qty'
  qty.textContent = '×' + String(part.qty)
  item.append(no, name, qty)
  if (part.uid !== null) {
    item.style.cursor = 'pointer'
    item.title = 'Click to focus this part'
    item.addEventListener('click', () => {
      applyHighlight(part.uid)
      focusUid(part.uid)
    })
  }
  els.bomList.appendChild(item)
}

els.prev.addEventListener('click', () => goTo(index - 1))
els.next.addEventListener('click', () => goTo(index + 1))
window.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  goTo(index + (event.key === 'ArrowRight' ? 1 : -1))
})

// ---- loop ----
let elapsed = 0
let last = performance.now()
function tick() {
  const now = performance.now()
  elapsed += Math.min(0.1, (now - last) / 1000)
  last = now
  stepTween()
  stage.frame(elapsed)
  requestAnimationFrame(tick)
}

render(0)
requestAnimationFrame(tick)
