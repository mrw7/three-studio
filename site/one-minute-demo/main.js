import * as THREE from 'three'
import { t, language } from '../i18n.js'

const DURATION = 60
const TAU = Math.PI * 2
const CHAPTERS = [
  { at: 0, name: 'Seed' },
  { at: 10, name: 'Germinate' },
  { at: 20, name: 'Grow' },
  { at: 30, name: 'Swarm' },
  { at: 40, name: 'Cosmos' },
  { at: 50, name: 'Return' },
]

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const smoothstep = (a, b, x) => {
  if (a === b) return x < a ? 0 : 1
  const value = clamp((x - a) / (b - a), 0, 1)
  return value * value * (3 - 2 * value)
}

function mulberry32(seed) {
  let value = seed >>> 0
  return function random() {
    value += 0x6d2b79f5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0x1a2b3c4d)
const rnd = (min = 0, max = 1) => min + (max - min) * rand()

const canvas = document.getElementById('scene')
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
})
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.15
renderer.outputColorSpace = THREE.SRGBColorSpace

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 260)
camera.position.set(0, 2.8, 22)

scene.add(new THREE.AmbientLight(0x223355, 0.65))
const keyLight = new THREE.DirectionalLight(0x9fc6ff, 1.4)
keyLight.position.set(5, 9, 7)
scene.add(keyLight)
const seedLight = new THREE.PointLight(0xffb25e, 16, 18, 2)
seedLight.position.set(0, 1.3, 0)
scene.add(seedLight)

// Background gradient shell.
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(180, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x050b18) },
      uBottom: { value: new THREE.Color(0x010205) },
      uGlow: { value: new THREE.Color(0x0b2b46) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform vec3 uGlow;
      void main() {
        float h = vDir.y * 0.5 + 0.5;
        vec3 color = mix(uBottom, uTop, pow(h, 0.8));
        float glow = pow(max(0.0, dot(vDir, normalize(vec3(0.0, 0.12, -1.0)))), 5.0);
        color += uGlow * glow * 0.55;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  }),
)
sky.renderOrder = -3
scene.add(sky)

// Starfield.
function makeStars() {
  const count = 4200
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const color = new THREE.Color()
  for (let i = 0; i < count; i += 1) {
    const radius = 35 + rand() * 75
    const theta = rand() * TAU
    const phi = Math.acos(2 * rand() - 1)
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = radius * Math.cos(phi)
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta)
    color.setHSL(0.55 + rand() * 0.1, 0.45, 0.62 + rand() * 0.32)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
    seeds[i] = rand()
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
      attribute vec3 aColor;
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.7 + aSeed * 1.6) * uPixelRatio * (90.0 / max(1.0, -mv.z));
        vColor = aColor;
        vAlpha = 0.45 + 0.55 * sin(uTime * (0.45 + aSeed * 1.5) + aSeed * 6.283);
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a * vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = -2
  scene.add(points)
  return { points, material }
}
const stars = makeStars()

// Seed.
const seedGroup = new THREE.Group()
seedGroup.position.set(0, 0.95, 0)
const seedMesh = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.17, 1),
  new THREE.MeshStandardMaterial({
    color: 0xffe1b0,
    emissive: 0xffb25e,
    emissiveIntensity: 2.4,
    roughness: 0.22,
    metalness: 0.12,
  }),
)
seedGroup.add(seedMesh)
const seedGlowMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uColor: { value: new THREE.Color(0xffd49a) },
    uOpacity: { value: 0.85 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform vec3 uColor;
    uniform float uOpacity;
    void main() {
      float d = length(vUv - 0.5);
      float a = pow(smoothstep(0.5, 0.0, d), 2.4);
      gl_FragColor = vec4(uColor, a * uOpacity);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
})
const seedGlow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), seedGlowMaterial)
seedGlow.renderOrder = 4
seedGroup.add(seedGlow)
scene.add(seedGroup)

// Procedural tree: solid growth is drawn as glowing lines and points.
const gold = new THREE.Color(0xffd49a)
const teal = new THREE.Color(0x5fe1ff)
const violet = new THREE.Color(0xb86bff)

function buildTree() {
  const linePositions = []
  const lineStarts = []
  const lineEnds = []
  const lineLocals = []
  const lineColors = []
  const pointPositions = []
  const pointStarts = []
  const pointEnds = []
  const pointLocals = []
  const pointSizes = []
  const pointSeeds = []
  const pointColors = []
  const tips = []
  const base = new THREE.Vector3(0, 0.95, 0)
  const maxDepth = 4

  function branch(origin, direction, length, depth, start, end) {
    const steps = 6
    const points = [origin.clone()]
    const position = origin.clone()
    const heading = direction.clone().normalize()
    const bendAxis = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize()
    const bend = 0.05 + rnd(-0.02, 0.035)
    for (let i = 1; i <= steps; i += 1) {
      heading.applyAxisAngle(bendAxis, bend)
      heading.y += 0.04
      heading.normalize()
      position.addScaledVector(heading, length / steps)
      points.push(position.clone())
    }
    const branchColor = gold
      .clone()
      .lerp(teal, 0.25 + (1 - depth / maxDepth) * 0.55)
      .lerp(violet, (depth / maxDepth) * 0.22)
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]
      const b = points[i + 1]
      linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z)
      lineStarts.push(start, start)
      lineEnds.push(end, end)
      lineLocals.push(i / (points.length - 1), (i + 1) / (points.length - 1))
      lineColors.push(branchColor.r, branchColor.g, branchColor.b, branchColor.r, branchColor.g, branchColor.b)
    }
    for (let i = 1; i < points.length; i += 1) {
      const point = points[i]
      pointPositions.push(point.x, point.y, point.z)
      pointStarts.push(start)
      pointEnds.push(end)
      pointLocals.push(i / (points.length - 1))
      pointSizes.push(0.1 + (1 - depth / maxDepth) * 0.09)
      pointSeeds.push(rand())
      pointColors.push(branchColor.r, branchColor.g, branchColor.b)
    }
    if (depth > 0) {
      const children = depth >= 2 ? 3 : 2
      for (let i = 0; i < children; i += 1) {
        const axis = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize()
        const childDirection = heading.clone().applyAxisAngle(axis, 0.5 + rnd() * 0.6)
        childDirection.y = Math.abs(childDirection.y) * 0.85 + 0.2
        childDirection.normalize()
        branch(position, childDirection, length * 0.68, depth - 1, start + 1.1, end + 1.4)
      }
    } else {
      tips.push({ position: position.clone(), color: branchColor.clone().lerp(gold, 0.35) })
    }
  }

  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * TAU + rnd(-0.2, 0.2)
    const direction = new THREE.Vector3(Math.cos(angle) * 0.9, -0.12, Math.sin(angle) * 0.9).normalize()
    branch(base, direction, 0.55, 2, 8.5, 12.5)
  }
  branch(base, new THREE.Vector3(0, 1, 0), 1.5, 4, 10, 14)

  return {
    linePositions,
    lineStarts,
    lineEnds,
    lineLocals,
    lineColors,
    pointPositions,
    pointStarts,
    pointEnds,
    pointLocals,
    pointSizes,
    pointSeeds,
    pointColors,
    tips,
  }
}

const treeData = buildTree()

const treeLineMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uFade: { value: 1 },
  },
  vertexShader: `
    attribute float aStart;
    attribute float aEnd;
    attribute float aLocal;
    attribute vec3 aColor;
    uniform float uTime;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      float progress = clamp((uTime - aStart) / max(0.001, aEnd - aStart), 0.0, 1.0);
      float isActive = step(aStart, uTime);
      float visible = isActive * step(aLocal, progress);
      float head = 1.0 - smoothstep(max(0.0, progress - 0.12), max(0.001, progress), aLocal);
      vAlpha = visible * (0.65 + head * 0.35);
      vColor = aColor;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uFade;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      if (vAlpha <= 0.001) discard;
      gl_FragColor = vec4(vColor, vAlpha * uFade);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
})
const treeLineGeometry = new THREE.BufferGeometry()
treeLineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(treeData.linePositions, 3))
treeLineGeometry.setAttribute('aStart', new THREE.Float32BufferAttribute(treeData.lineStarts, 1))
treeLineGeometry.setAttribute('aEnd', new THREE.Float32BufferAttribute(treeData.lineEnds, 1))
treeLineGeometry.setAttribute('aLocal', new THREE.Float32BufferAttribute(treeData.lineLocals, 1))
treeLineGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(treeData.lineColors, 3))
const treeLines = new THREE.LineSegments(treeLineGeometry, treeLineMaterial)
treeLines.frustumCulled = false
treeLines.renderOrder = 2
scene.add(treeLines)

function makeGlowPointMaterial({ sway = 0, pointScale = 240 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uSway: { value: sway },
    },
    vertexShader: `
      attribute float aStart;
      attribute float aEnd;
      attribute float aLocal;
      attribute float aSize;
      attribute float aSeed;
      attribute vec3 aColor;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uSway;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float progress = clamp((uTime - aStart) / max(0.001, aEnd - aStart), 0.0, 1.0);
        float isActive = step(aStart, uTime);
        float visible = isActive * step(aLocal, progress);
        vec3 point = position;
        point.x += sin(uTime * 0.8 + aSeed * 6.283) * uSway;
        point.z += cos(uTime * 0.7 + aSeed * 5.1) * uSway;
        vec4 mv = modelViewMatrix * vec4(point, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (${pointScale}.0 / max(1.0, -mv.z));
        vColor = aColor;
        vAlpha = visible * (0.5 + 0.5 * sin(uTime * 2.0 + aSeed * 6.283));
      }
    `,
    fragmentShader: `
      uniform float uFade;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a * vAlpha * uFade);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
}

const treePointMaterial = makeGlowPointMaterial()
const treePointGeometry = new THREE.BufferGeometry()
treePointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(treeData.pointPositions, 3))
treePointGeometry.setAttribute('aStart', new THREE.Float32BufferAttribute(treeData.pointStarts, 1))
treePointGeometry.setAttribute('aEnd', new THREE.Float32BufferAttribute(treeData.pointEnds, 1))
treePointGeometry.setAttribute('aLocal', new THREE.Float32BufferAttribute(treeData.pointLocals, 1))
treePointGeometry.setAttribute('aSize', new THREE.Float32BufferAttribute(treeData.pointSizes, 1))
treePointGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(treeData.pointSeeds, 1))
treePointGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(treeData.pointColors, 3))
const treePoints = new THREE.Points(treePointGeometry, treePointMaterial)
treePoints.frustumCulled = false
treePoints.renderOrder = 3
scene.add(treePoints)

const tipPositions = []
const tipStarts = []
const tipEnds = []
const tipLocals = []
const tipSizes = []
const tipSeeds = []
const tipColors = []
for (const tip of treeData.tips) {
  tipPositions.push(tip.position.x, tip.position.y, tip.position.z)
  const start = 19 + rnd() * 5
  tipStarts.push(start)
  tipEnds.push(start + 2)
  tipLocals.push(0.5)
  tipSizes.push(0.2 + rnd() * 0.16)
  tipSeeds.push(rand())
  tipColors.push(tip.color.r, tip.color.g, tip.color.b)
}
const tipMaterial = makeGlowPointMaterial({ sway: 0.045 })
const tipGeometry = new THREE.BufferGeometry()
tipGeometry.setAttribute('position', new THREE.Float32BufferAttribute(tipPositions, 3))
tipGeometry.setAttribute('aStart', new THREE.Float32BufferAttribute(tipStarts, 1))
tipGeometry.setAttribute('aEnd', new THREE.Float32BufferAttribute(tipEnds, 1))
tipGeometry.setAttribute('aLocal', new THREE.Float32BufferAttribute(tipLocals, 1))
tipGeometry.setAttribute('aSize', new THREE.Float32BufferAttribute(tipSizes, 1))
tipGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(tipSeeds, 1))
tipGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(tipColors, 3))
const tipPoints = new THREE.Points(tipGeometry, tipMaterial)
tipPoints.frustumCulled = false
tipPoints.renderOrder = 3
scene.add(tipPoints)

// Orbiting swarm.
function makeSwarm() {
  const count = 5200
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const radii = new Float32Array(count)
  const angles = new Float32Array(count)
  const heights = new Float32Array(count)
  const sizes = new Float32Array(count)
  const colors = new Float32Array(count * 3)
  const color = new THREE.Color()
  for (let i = 0; i < count; i += 1) {
    seeds[i] = rand()
    radii[i] = 4.5 + rand() * 10.5
    angles[i] = rand() * TAU
    heights[i] = (rand() - 0.5) * 6.5
    sizes[i] = 0.035 + rand() * 0.065
    color.copy(gold).lerp(teal, rand() * 0.7).lerp(violet, rand() * 0.25)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1))
  geometry.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1))
  geometry.setAttribute('aHeight', new THREE.BufferAttribute(heights, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uGather: { value: 0 },
      uDisperse: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
    },
    vertexShader: `
      attribute float aSeed;
      attribute float aRadius;
      attribute float aAngle;
      attribute float aHeight;
      attribute float aSize;
      attribute vec3 aColor;
      uniform float uTime;
      uniform float uGather;
      uniform float uDisperse;
      uniform float uOpacity;
      uniform float uPixelRatio;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float angle = aAngle + uTime * (0.08 + aSeed * 0.16);
        float radius = mix(aRadius, 0.8 + aSeed * 2.6, uGather);
        float height = mix(aHeight, aHeight * 0.22, uGather);
        vec3 point = vec3(cos(angle) * radius, 2.2 + height, sin(angle) * radius);
        point += vec3(
          sin(uTime * 0.7 + aSeed * 10.0),
          cos(uTime * 0.6 + aSeed * 8.0),
          sin(uTime * 0.9 + aSeed * 12.0)
        ) * (0.08 + uDisperse * 0.55);
        point *= mix(1.0, 2.35, uDisperse);
        vec4 mv = modelViewMatrix * vec4(point, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (220.0 / max(1.0, -mv.z));
        vColor = aColor;
        vAlpha = uOpacity * (0.4 + 0.6 * sin(uTime * 2.5 + aSeed * 6.283));
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a * max(0.0, vAlpha));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = 5
  scene.add(points)
  return { points, material }
}
const swarm = makeSwarm()

// Planet, atmosphere and ring.
const planetGroup = new THREE.Group()
planetGroup.position.set(0, 2.4, -14)
scene.add(planetGroup)

const planetMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
  },
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      vNormal = normalize(mat3(modelMatrix) * normal);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform float uOpacity;
    varying vec3 vNormal;
    varying vec3 vWorld;
    float hash(vec3 p) {
      p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
      p *= 17.0;
      return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float noise(vec3 x) {
      vec3 i = floor(x);
      vec3 f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(hash(i + vec3(0, 0, 0)), hash(i + vec3(1, 0, 0)), f.x),
            mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
        mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
            mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
        f.z
      );
    }
    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;
      for (int i = 0; i < 4; i += 1) {
        value += amplitude * noise(p);
        p *= 2.03;
        amplitude *= 0.5;
      }
      return value;
    }
    void main() {
      vec3 normal = normalize(vNormal);
      float field = fbm(normal * 2.2 + vec3(0.0, uTime * 0.015, 0.0));
      float bands = 0.5 + 0.5 * sin(normal.y * 9.0 + field * 3.2);
      vec3 deep = vec3(0.006, 0.02, 0.05);
      vec3 sea = vec3(0.025, 0.26, 0.34);
      vec3 gold = vec3(0.95, 0.62, 0.26);
      vec3 color = mix(deep, sea, smoothstep(0.18, 0.85, bands));
      color = mix(color, gold, smoothstep(0.62, 0.95, field) * 0.35);
      float rim = pow(1.0 - max(dot(normal, normalize(cameraPosition - vWorld)), 0.0), 2.4);
      color += vec3(0.18, 0.45, 0.9) * rim * 0.75;
      gl_FragColor = vec4(color, uOpacity);
    }
  `,
  transparent: true,
  depthWrite: false,
  side: THREE.FrontSide,
})
const planet = new THREE.Mesh(new THREE.SphereGeometry(6, 96, 64), planetMaterial)
planet.renderOrder = -1
planetGroup.add(planet)

const atmosphereMaterial = new THREE.ShaderMaterial({
  uniforms: { uOpacity: { value: 0 } },
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      vNormal = normalize(mat3(modelMatrix) * normal);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform float uOpacity;
    varying vec3 vNormal;
    varying vec3 vWorld;
    void main() {
      float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(cameraPosition - vWorld))), 3.0);
      gl_FragColor = vec4(vec3(0.28, 0.62, 1.0), rim * uOpacity * 0.6);
    }
  `,
  transparent: true,
  depthWrite: false,
  side: THREE.BackSide,
  blending: THREE.AdditiveBlending,
})
const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(6.55, 64, 48), atmosphereMaterial)
atmosphere.renderOrder = 0
planetGroup.add(atmosphere)

const ringTilt = new THREE.Group()
ringTilt.rotation.x = 1.18
ringTilt.rotation.z = 0.3
planetGroup.add(ringTilt)
const ringMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uOpacity: { value: 0 },
    uPixelRatio: { value: renderer.getPixelRatio() },
  },
  vertexShader: `
    attribute vec3 aColor;
    attribute float aSeed;
    attribute float aSize;
    uniform float uTime;
    uniform float uOpacity;
    uniform float uPixelRatio;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPixelRatio * (180.0 / max(1.0, -mv.z));
      vColor = aColor;
      vAlpha = uOpacity * (0.35 + 0.65 * sin(uTime * 1.8 + aSeed * 6.283));
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.0, d);
      gl_FragColor = vec4(vColor, a * max(0.0, vAlpha));
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
})
const ringPositions = []
const ringColors = []
const ringSeeds = []
const ringSizes = []
for (let i = 0; i < 4200; i += 1) {
  const radius = 7 + Math.pow(rand(), 0.6) * 4.2
  const angle = rand() * TAU
  ringPositions.push(Math.cos(angle) * radius, (rand() - 0.5) * 0.16, Math.sin(angle) * radius)
  const color = gold.clone().lerp(teal, rand() * 0.75).lerp(violet, rand() * 0.2)
  ringColors.push(color.r, color.g, color.b)
  ringSeeds.push(rand())
  ringSizes.push(0.12 + rand() * 0.18)
}
const ringGeometry = new THREE.BufferGeometry()
ringGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3))
ringGeometry.setAttribute('aColor', new THREE.Float32BufferAttribute(ringColors, 3))
ringGeometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(ringSeeds, 1))
ringGeometry.setAttribute('aSize', new THREE.Float32BufferAttribute(ringSizes, 1))
const ringPoints = new THREE.Points(ringGeometry, ringMaterial)
ringPoints.frustumCulled = false
ringPoints.renderOrder = 1
ringTilt.add(ringPoints)

// Camera choreography.
const CAMERA_KEYS = [
  { t: 0, pos: [0, 2.8, 22], target: [0, 1.5, 0] },
  { t: 8, pos: [1.2, 2.0, 9], target: [0, 1.1, 0] },
  { t: 14, pos: [3.2, 2.2, 4.4], target: [0, 1.6, 0] },
  { t: 22, pos: [4.8, 4.0, 6.4], target: [0, 2.8, 0] },
  { t: 30, pos: [-3.8, 3.4, 5.6], target: [0, 3.2, 0] },
  { t: 38, pos: [-1.2, 3.0, 7.6], target: [0, 2.6, 0] },
  { t: 46, pos: [0, 4.6, 16.5], target: [0, 2.4, -5] },
  { t: 54, pos: [0, 3.8, 13], target: [0, 1.8, 0] },
  { t: 60, pos: [0, 3.2, 10.8], target: [0, 1.4, 0] },
].map((key) => ({
  ...key,
  pos: new THREE.Vector3(...key.pos),
  target: new THREE.Vector3(...key.target),
}))
const cameraPosition = new THREE.Vector3()
const cameraTarget = new THREE.Vector3()

function sampleCamera(time) {
  let index = 0
  while (index < CAMERA_KEYS.length - 2 && time > CAMERA_KEYS[index + 1].t) index += 1
  const from = CAMERA_KEYS[index]
  const to = CAMERA_KEYS[index + 1]
  const value = smoothstep(from.t, to.t, time)
  cameraPosition.copy(from.pos).lerp(to.pos, value)
  cameraTarget.copy(from.target).lerp(to.target, value)
  cameraPosition.x += Math.sin(time * 0.23) * 0.09
  cameraPosition.y += Math.sin(time * 0.31 + 1.7) * 0.05
  cameraTarget.x += Math.sin(time * 0.19 + 0.4) * 0.06
  cameraTarget.y += Math.sin(time * 0.27 + 2.1) * 0.03
  camera.position.copy(cameraPosition)
  camera.lookAt(cameraTarget)
}

// Player UI.
const playButton = document.getElementById('play')
const replayButton = document.getElementById('replay')
const replayEndButton = document.getElementById('replay-end')
const fullscreenButton = document.getElementById('fullscreen')
const progress = document.getElementById('progress')
const progressFill = document.getElementById('progress-fill')
const ticks = document.getElementById('ticks')
const timeLabel = document.getElementById('time')
const chapterIndex = document.getElementById('chapter-index')
const chapterName = document.getElementById('chapter-name')
const chapterHud = document.querySelector('.chapter-hud')
const titleCard = document.getElementById('title-card')
const endCard = document.getElementById('end-card')
const hint = document.getElementById('hint')
const fade = document.getElementById('fade')

for (const chapter of CHAPTERS) {
  const tick = document.createElement('span')
  tick.style.left = `${(chapter.at / DURATION) * 100}%`
  ticks.append(tick)
}

const params = new URLSearchParams(window.location.search)
const requestedTime = Number.parseFloat(params.get('t') ?? '')
const hasRequestedTime = Number.isFinite(requestedTime)
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
const still = params.get('still') === '1'
if (still) document.body.classList.add('is-still')
let time = hasRequestedTime ? clamp(requestedTime, 0, DURATION) : reduceMotion ? 24 : 0
let playing = !reduceMotion && !hasRequestedTime && params.get('paused') !== '1'
let lastSecond = -1
let lastChapter = -1
let dragging = false
let wasPlaying = false

function formatTime(value) {
  const seconds = clamp(Math.floor(value), 0, DURATION)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function updatePlayButton() {
  playButton.textContent = t(playing ? 'Pause' : 'Play')
  playButton.setAttribute('aria-label', t(playing ? 'Pause' : 'Play'))
}

function updateFullscreenButton() {
  fullscreenButton.textContent = t(document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen')
}

function setPlaying(next) {
  if (next && time >= DURATION) {
    time = 0
    endCard.classList.remove('is-visible')
    endCard.hidden = true
    lastChapter = -1
  }
  playing = next
  updatePlayButton()
}

function replay() {
  time = 0
  lastChapter = -1
  setPlaying(true)
  applyTimeline(0)
}

function updateChapter(value) {
  let index = 0
  while (index < CHAPTERS.length - 1 && value >= CHAPTERS[index + 1].at) index += 1
  if (index === lastChapter) return
  lastChapter = index
  chapterIndex.textContent = `CHAPTER ${String(index + 1).padStart(2, '0')} / ${String(CHAPTERS.length).padStart(2, '0')}`
  chapterName.textContent = CHAPTERS[index].name
}

function updateUI(value) {
  progressFill.style.transform = `scaleX(${clamp(value / DURATION, 0, 1)})`
  updateChapter(value)
  const second = Math.floor(value)
  if (second !== lastSecond) {
    lastSecond = second
    timeLabel.textContent = `${formatTime(value)} / 1:00`
    progress.setAttribute('aria-valuenow', String(second))
  }
  titleCard.classList.toggle('is-hidden', value > 5.2)
  hint.classList.toggle('is-hidden', value > 8)
  chapterHud.classList.toggle('is-hidden', value > 54.5)
  const ended = value >= 55.5
  if (ended && endCard.hidden) {
    endCard.hidden = false
    requestAnimationFrame(() => {
      if (time >= 55.5) endCard.classList.add('is-visible')
    })
  } else if (!ended && !endCard.hidden) {
    endCard.classList.remove('is-visible')
    endCard.hidden = true
  }
}

function applyTimeline(value) {
  sampleCamera(value)
  seedMesh.rotation.y = value * 0.4
  seedMesh.rotation.x = value * 0.2
  const pulse = 1 + Math.sin(value * 2.4) * 0.06
  seedGroup.scale.setScalar(pulse)
  seedGlow.quaternion.copy(camera.quaternion)
  seedGlowMaterial.uniforms.uOpacity.value = 0.7 + 0.22 * Math.sin(value * 2.0) + smoothstep(50, 56, value) * 0.18
  seedLight.intensity = 14 + Math.sin(value * 2.4) * 3

  const treeFade = 1 - smoothstep(42, 50, value)
  treeLineMaterial.uniforms.uTime.value = value
  treeLineMaterial.uniforms.uFade.value = treeFade
  treePointMaterial.uniforms.uTime.value = value
  treePointMaterial.uniforms.uFade.value = treeFade
  tipMaterial.uniforms.uTime.value = value
  tipMaterial.uniforms.uFade.value = treeFade

  swarm.material.uniforms.uTime.value = value
  swarm.material.uniforms.uGather.value = smoothstep(24, 34, value)
  swarm.material.uniforms.uDisperse.value = smoothstep(40, 52, value)
  swarm.material.uniforms.uOpacity.value =
    smoothstep(9, 15, value) * (1 - smoothstep(52, 58, value))

  const planetOpacity = smoothstep(36, 46, value) * (1 - smoothstep(53, 59, value))
  planetMaterial.uniforms.uTime.value = value
  planetMaterial.uniforms.uOpacity.value = planetOpacity
  atmosphereMaterial.uniforms.uOpacity.value = planetOpacity
  ringMaterial.uniforms.uTime.value = value
  ringMaterial.uniforms.uOpacity.value = planetOpacity
  ringPoints.rotation.y = value * 0.025
  planetGroup.rotation.y = value * 0.006

  stars.material.uniforms.uTime.value = value
  stars.points.rotation.y = value * 0.004

  const opening = 1 - smoothstep(0, 2.4, value)
  const closing = smoothstep(55.5, 60, value) * 0.86
  fade.style.opacity = String(clamp(opening + closing, 0, 0.92))
  updateUI(value)
}

function seekFromEvent(event) {
  const rect = progress.getBoundingClientRect()
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1)
  time = ratio * DURATION
  if (time >= DURATION) playing = false
  applyTimeline(time)
}

playButton.addEventListener('click', () => setPlaying(!playing))
replayButton.addEventListener('click', replay)
replayEndButton.addEventListener('click', replay)
fullscreenButton.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch (error) {
    void error
  }
})
document.addEventListener('fullscreenchange', updateFullscreenButton)

progress.addEventListener('pointerdown', (event) => {
  dragging = true
  wasPlaying = playing
  playing = false
  updatePlayButton()
  try { progress.setPointerCapture(event.pointerId) } catch (error) { void error }
  seekFromEvent(event)
})
progress.addEventListener('pointermove', (event) => {
  if (dragging) seekFromEvent(event)
})
function endDrag(event) {
  if (!dragging) return
  dragging = false
  try { progress.releasePointerCapture(event.pointerId) } catch (error) { void error }
  if (wasPlaying && time < DURATION) playing = true
  updatePlayButton()
}
progress.addEventListener('pointerup', endDrag)
progress.addEventListener('pointercancel', endDrag)
progress.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    event.stopPropagation()
    time = clamp(time + (event.key === 'ArrowLeft' ? -5 : 5), 0, DURATION)
    applyTimeline(time)
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    event.stopPropagation()
    time = event.key === 'Home' ? 0 : DURATION
    applyTimeline(time)
  }
})

window.addEventListener('keydown', (event) => {
  const target = event.target
  if (target instanceof Element && target.closest('button, input, textarea, select')) return
  if (event.code === 'Space') {
    event.preventDefault()
    setPlaying(!playing)
  } else if (event.key.toLowerCase() === 'r') {
    replay()
  } else if (event.key.toLowerCase() === 'f') {
    fullscreenButton.click()
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    time = clamp(time + (event.key === 'ArrowLeft' ? -5 : 5), 0, DURATION)
    applyTimeline(time)
  }
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) setPlaying(false)
})

function resize() {
  const width = window.innerWidth
  const height = window.innerHeight
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75))
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  const pixelRatio = renderer.getPixelRatio()
  stars.material.uniforms.uPixelRatio.value = pixelRatio
  treePointMaterial.uniforms.uPixelRatio.value = pixelRatio
  tipMaterial.uniforms.uPixelRatio.value = pixelRatio
  swarm.material.uniforms.uPixelRatio.value = pixelRatio
  ringMaterial.uniforms.uPixelRatio.value = pixelRatio
}
window.addEventListener('resize', resize)

window.addEventListener('error', (event) => {
  document.body.dataset.error = String(event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  document.body.dataset.error = String(event.reason)
})

resize()
updatePlayButton()
updateFullscreenButton()
applyTimeline(time)
renderer.render(scene, camera)

const clock = new THREE.Clock()
function animate() {
  requestAnimationFrame(animate)
  const delta = Math.min(clock.getDelta(), 0.05)
  if (playing) {
    time += delta
    if (time >= DURATION) {
      time = DURATION
      playing = false
      updatePlayButton()
    }
  }
  applyTimeline(time)
  renderer.render(scene, camera)
}
animate()
