// Deterministic synthetic scene + route interception. The Host's real scene,
// asset, thumbnail and capture endpoints are never used by the E2E specs; the
// only network traffic that reaches the Host is the app shell, session list and
// the read-only endpoints needed to open an existing preview.

export const FIXTURE_TITLE = 'P5 fixture'

/**
 * Small scene with stable names/UUIDs:
 *  - P5Hero  -> wb.id `p5-hero`, transform target
 *  - P5Other -> wb.id `p5-other`, rotates so frame stepping can be observed
 *  - P5Light -> wb.id `p5-light`, directional light used by timeline/light tests
 *  - ambient light with no wb.id (untracked, non-selectable)
 *
 * `wb.expose` declares number `speed` (0..5 step .1) and boolean `fail`; the
 * apply callback throws when `fail` is true so the params error path is real.
 */
export const FIXTURE_CODE = `
const heroMaterial = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.55, metalness: 0.1 })
const hero = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), heroMaterial)
hero.name = 'P5Hero'
wb.id(hero, 'p5-hero')
hero.userData.speed = 1
scene.add(hero)

const otherMaterial = new THREE.MeshStandardMaterial({ color: 0x66bb88, roughness: 0.4 })
const other = new THREE.Mesh(new THREE.IcosahedronGeometry(0.58, 2), otherMaterial)
other.name = 'P5Other'
wb.id(other, 'p5-other')
other.position.set(2, 0.25, 0)
scene.add(other)

const light = new THREE.DirectionalLight(0xffffff, 2.2)
light.name = 'P5Light'
wb.id(light, 'p5-light')
light.position.set(3, 5, 4)
scene.add(light)

const ambient = new THREE.AmbientLight(0xffffff, 0.55)
ambient.name = 'P5Ambient'
scene.add(ambient)

// P5Throw exists to exercise the apply-failure paths. Its position refuses the
// sentinel x=13 with an injected throw, so a valid track/mutation still fails
// while applying. Other values behave normally.
let injectedFailures = 0
const throwing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xcc8844 }))
throwing.name = 'P5Throw'
wb.id(throwing, 'p5-throw')
throwing.position.set(4, 0, 0)
const nativeSet = throwing.position.set.bind(throwing.position)
const nativeFromArray = throwing.position.fromArray.bind(throwing.position)
const sentinel = value => Array.isArray(value) && value[0] === 13
throwing.position.set = function (x, y, z) {
  if (x === 13) {
    injectedFailures += 1
    throw new Error('P5 injected apply failure')
  }
  return nativeSet(x, y, z)
}
throwing.position.fromArray = function (value, offset) {
  if (sentinel(value)) {
    injectedFailures += 1
    throw new Error('P5 injected apply failure')
  }
  return nativeFromArray(value, offset)
}
scene.add(throwing)

let frameCount = 0
onFrame(() => {
  frameCount += 1
  other.rotation.y = frameCount * 0.01
})

setCamera([3.2, 3.2, 6.2], [0.8, 0.2, 0])

wb.expose({
  speed: { type: 'number', label: { zh: '速度', en: 'Speed' }, default: 1, min: 0, max: 5, step: 0.1 },
  fail: { type: 'boolean', label: { zh: '应用失败', en: 'Fail apply' }, default: false },
}, values => {
  if (values.fail === true) throw new Error('P5 injected parameter failure')
  hero.userData.speed = values.speed
})

window.__p5 = {
  hero, other, light, throwing, scene, camera, controls,
  frames: () => frameCount,
  injectedFailures: () => injectedFailures,
  pose(which) {
    const object = which === 'other' ? other : which === 'light' ? light : which === 'throwing' ? throwing : hero
    return {
      name: object.name,
      position: object.position.toArray(),
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray(),
      visible: object.visible,
    }
  },
  cameraState() {
    return {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
      distance: camera.position.distanceTo(controls.target),
    }
  },
  screen(which) {
    const object = which === 'other' ? other : which === 'light' ? light : hero
    const vector = new THREE.Vector3()
    object.getWorldPosition(vector)
    vector.project(camera)
    const rect = canvas.getBoundingClientRect()
    return {
      fx: (vector.x + 1) / 2,
      fy: (1 - vector.y) / 2,
      canvasWidth: rect.width,
      canvasHeight: rect.height,
      canvasX: rect.x,
      canvasY: rect.y,
      visible: Math.abs(vector.x) <= 1 && Math.abs(vector.y) <= 1 && vector.z < 1,
    }
  },
  params() {
    return { speed: hero.userData.speed }
  },
  read() {
    return {
      ready: true,
      frames: frameCount,
      injectedFailures,
      hero: this.pose('hero'),
      other: this.pose('other'),
      throwing: this.pose('throwing'),
      camera: this.cameraState(),
      params: this.params(),
    }
  },
}
window.__p5Ready = true
`

export const THUMBNAIL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export function fixtureRecord(id) {
  const code = FIXTURE_CODE
  return {
    sceneId: id,
    revision: 7,
    title: FIXTURE_TITLE,
    code,
    bytes: Buffer.byteLength(code, 'utf8'),
    updatedAt: 1700000000000,
  }
}

function fixtureRecordResponse(id) {
  const record = fixtureRecord(id)
  return {
    ...record,
    revisions: [{
      revision: record.revision,
      title: record.title,
      bytes: record.bytes,
      updatedAt: record.updatedAt,
    }],
  }
}

function recordFromRequest(request) {
  try {
    const pathname = new URL(request.url()).pathname
    return decodeURIComponent(pathname.split('/').slice(-1)[0] || 'fixture')
  } catch {
    return 'fixture'
  }
}

function json(body, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

/**
 * Install fixture routes on a page before navigation. Every mutation-capable
 * endpoint that the editor can reach is answered locally. Counters only track
 * route classes, never URLs or ids.
 */
export async function installFixtureRoutes(page) {
  const stats = { state: 0, scene: 0, assets: 0, assetWrite: 0, thumbnail: 0, capture: 0, otherHost: 0 }

  await page.route('**/three-workbench/state/**', route => {
    stats.state += 1
    return route.fulfill(json(fixtureRecordResponse(recordFromRequest(route.request()))))
  })

  await page.route('**/three-workbench/scene/**', route => {
    let pathname = ''
    try {
      pathname = new URL(route.request().url()).pathname
    } catch {
      // Fall through to fixture.
    }
    if (pathname.endsWith('/demo')) {
      stats.otherHost += 1
      return route.fallback()
    }
    stats.scene += 1
    return route.fulfill(json(fixtureRecord(recordFromRequest(route.request()))))
  })

  await page.route('**/three-workbench/assets', route => {
    if (route.request().method() !== 'GET') {
      stats.assetWrite += 1
      return route.fulfill(json({ ok: false, error: 'e2e-read-only' }, 403))
    }
    stats.assets += 1
    return route.fulfill(json({ ok: true, assets: [], usage: { count: 0, bytes: 0 } }))
  })

  await page.route('**/three-workbench/assets/**', route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/upload') || pathname.endsWith('/delete')) {
      stats.assetWrite += 1
      return route.fulfill(json({ ok: false, error: 'e2e-read-only' }, 403))
    }
    stats.assets += 1
    return route.fulfill(json({ ok: false, error: 'not-found' }, 404))
  })

  await page.route('**/three-workbench/thumbnail**', route => {
    stats.thumbnail += 1
    if (route.request().method() === 'POST') return route.fulfill(json({ ok: true }))
    return route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from(THUMBNAIL_PNG_BASE64, 'base64'),
    })
  })

  await page.route('**/three-workbench/capture**', route => {
    stats.capture += 1
    return route.fulfill({ status: 204, body: '' })
  })

  return stats
}
