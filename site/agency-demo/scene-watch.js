import * as THREE from 'three'

export function buildWatchScene({ renderer, camera, scene, controls, onFrame, wb }) {
/* ============================================================
   Blue mechanical watch showcase
   ============================================================ */
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ---------- tiny helpers ---------- */
function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function mkTex(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = (srgb === false) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function radialTex(inner, outer, size) {
  const s = size || 256;
  const c = mkCanvas(s, s), g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return mkTex(c, false);
}
const dotTex = radialTex('rgba(255,255,255,1)', 'rgba(255,255,255,0)', 128);

/* ---------- renderer / camera ---------- */
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

camera.fov = 36;
camera.position.set(0, 2.42, 6.55);
camera.updateProjectionMatrix();

controls.target.set(0, 1.15, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.rotateSpeed = 0.7;
controls.minDistance = 3.4;
controls.maxDistance = 13;
controls.maxPolarAngle = Math.PI * 0.56;
controls.minPolarAngle = Math.PI * 0.08;
controls.update();

scene.background = new THREE.Color(0x02040a);

/* ---------- studio environment (procedural equirect) ---------- */
function buildEnv() {
  const w = 2048, h = 1024;
  const c = mkCanvas(w, h), g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 0, h);
  lg.addColorStop(0.00, '#05080f');
  lg.addColorStop(0.30, '#0e1c33');
  lg.addColorStop(0.48, '#182741');
  lg.addColorStop(0.60, '#0a1322');
  lg.addColorStop(1.00, '#010206');
  g.fillStyle = lg;
  g.fillRect(0, 0, w, h);

  function blob(x, y, rx, ry, col, alpha) {
    g.save();
    g.translate(x, y);
    g.scale(rx, ry);
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = alpha;
    g.fillStyle = rg;
    g.beginPath();
    g.arc(0, 0, 1, 0, TAU);
    g.fill();
    g.restore();
    g.globalAlpha = 1;
  }
  blob(w * 0.30, h * 0.18, w * 0.20, h * 0.10, 'rgba(255,255,255,1)', 0.95);
  blob(w * 0.70, h * 0.26, w * 0.13, h * 0.07, 'rgba(210,230,255,1)', 0.80);
  blob(w * 0.50, h * 0.56, w * 0.36, h * 0.11, 'rgba(40,100,255,1)', 0.50);
  blob(w * 0.10, h * 0.52, w * 0.09, h * 0.14, 'rgba(120,175,255,1)', 0.40);
  blob(w * 0.90, h * 0.60, w * 0.10, h * 0.16, 'rgba(80,140,255,1)', 0.35);
  return mkTex(c);
}
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = buildEnv();
envTex.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = pmrem.fromEquirectangular(envTex).texture;
envTex.dispose();
pmrem.dispose();

/* ---------- backdrop dome ---------- */
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  vertexShader: `
    varying vec3 vDir;
    void main() {
      vDir = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 col = mix(vec3(0.004, 0.008, 0.020), vec3(0.022, 0.050, 0.120), smoothstep(-0.35, 0.60, h));
      col = mix(vec3(0.001, 0.002, 0.006), col, smoothstep(-0.85, -0.22, h));
      float glow = pow(max(dot(d, normalize(vec3(0.0, 0.12, -1.0))), 0.0), 6.0);
      col += vec3(0.035, 0.130, 0.440) * glow * 0.60;
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(80, 48, 32), skyMat);
sky.frustumCulled = false;
sky.renderOrder = -10;
scene.add(wb.id(sky, 'backdrop'));

/* ---------- lights ---------- */
scene.add(new THREE.HemisphereLight(0x6f9cff, 0x03060e, 0.55));

const key = new THREE.DirectionalLight(0xffffff, 3.0);
key.position.set(3.6, 7.6, 4.6);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1;
key.shadow.camera.far = 26;
key.shadow.camera.left = -5;
key.shadow.camera.right = 5;
key.shadow.camera.top = 5;
key.shadow.camera.bottom = -5;
key.shadow.bias = -0.0008;
key.shadow.normalBias = 0.02;
key.shadow.camera.updateProjectionMatrix();
scene.add(key);

const rim = new THREE.DirectionalLight(0x2f6bff, 4.2);
rim.position.set(-5.2, 3.4, -4.6);
scene.add(rim);

const fill = new THREE.DirectionalLight(0xa9c9ff, 1.1);
fill.position.set(0.6, 1.6, 8.0);
scene.add(fill);

const sparkle = new THREE.PointLight(0xa8d4ff, 26, 9, 2);
sparkle.position.set(-1.6, 4.4, 2.6);
scene.add(sparkle);

/* ---------- floor / pedestal ---------- */
const fadeC = mkCanvas(512, 512), fg = fadeC.getContext('2d');
const fadeGrd = fg.createRadialGradient(256, 256, 20, 256, 256, 256);
fadeGrd.addColorStop(0, '#ffffff');
fadeGrd.addColorStop(0.55, '#ffffff');
fadeGrd.addColorStop(1, '#000000');
fg.fillStyle = fadeGrd;
fg.fillRect(0, 0, 512, 512);
const fadeTex = mkTex(fadeC, false);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(15, 96),
  new THREE.MeshStandardMaterial({
    color: 0x03060d, metalness: 0.75, roughness: 0.30,
    envMapIntensity: 0.7, transparent: true, alphaMap: fadeTex
  })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.206;
floor.receiveShadow = true;
scene.add(wb.id(floor, 'floor'));

const pedMat = new THREE.MeshStandardMaterial({
  color: 0x060a14, metalness: 0.9, roughness: 0.14, envMapIntensity: 1.0
});
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.72, 0.2, 160, 1), pedMat);
pedestal.position.y = -0.1;
pedestal.receiveShadow = true;
pedestal.castShadow = true;
scene.add(wb.id(pedestal, 'pedestal'));

const edgeMat = new THREE.MeshBasicMaterial({
  color: 0x4d8dff, transparent: true, opacity: 0.85,
  blending: THREE.AdditiveBlending, depthWrite: false
});
const edgeRing = new THREE.Mesh(new THREE.TorusGeometry(2.548, 0.011, 10, 240), edgeMat);
edgeRing.rotation.x = -Math.PI / 2;
edgeRing.position.y = 0.004;
scene.add(wb.id(edgeRing, 'pedestal-ring'));

/* contact shadow + glow pool */
const shadowTex = (() => {
  const s = 512, c = mkCanvas(s, s), g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0.00, 'rgba(0,0,0,0.88)');
  grd.addColorStop(0.32, 'rgba(0,0,0,0.52)');
  grd.addColorStop(0.66, 'rgba(0,0,0,0.14)');
  grd.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return mkTex(c, false);
})();
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(4.4, 4.4),
  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.9, depthWrite: false })
);
contact.rotation.x = -Math.PI / 2;
contact.position.set(0, 0.006, 0.15);
scene.add(contact);

const glowTex = radialTex('rgba(70,140,255,0.55)', 'rgba(10,40,120,0)', 256);
const pool = new THREE.Mesh(
  new THREE.PlaneGeometry(6.2, 6.2),
  new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false
  })
);
pool.rotation.x = -Math.PI / 2;
pool.position.set(0, 0.008, 0.2);
scene.add(pool);

/* ---------- dust ---------- */
const DUST = 300;
const dustPos = new Float32Array(DUST * 3);
const dustSeed = new Float32Array(DUST);
for (let i = 0; i < DUST; i++) {
  const r = 0.7 + Math.random() * 5.2;
  const a = Math.random() * TAU;
  dustPos[i * 3] = Math.cos(a) * r;
  dustPos[i * 3 + 1] = Math.random() * 4.6;
  dustPos[i * 3 + 2] = Math.sin(a) * r;
  dustSeed[i] = Math.random();
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
  size: 0.03, map: dotTex, transparent: true, opacity: 0.5,
  depthWrite: false, blending: THREE.AdditiveBlending,
  color: 0x9dc6ff, sizeAttenuation: true
}));
scene.add(dust);

/* ============================================================
   DIAL TEXTURE
   ============================================================ */
function makeDialTexture() {
  const S = 2048;
  const c = mkCanvas(S, S), g = c.getContext('2d');
  const cx = S / 2, cy = S / 2, R = S / 2;

  let grd = g.createRadialGradient(cx, cy * 0.9, R * 0.03, cx, cy, R * 1.05);
  grd.addColorStop(0.00, '#3a7dff');
  grd.addColorStop(0.25, '#1c59e2');
  grd.addColorStop(0.55, '#0e349f');
  grd.addColorStop(0.82, '#071e60');
  grd.addColorStop(1.00, '#030d2c');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);

  /* sunburst rays */
  g.save();
  g.translate(cx, cy);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 1200; i++) {
    const a = (i / 1200) * TAU;
    g.beginPath();
    g.moveTo(Math.cos(a) * R * 0.05, Math.sin(a) * R * 0.05);
    g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
    g.lineWidth = (i % 2) ? 1.0 : 2.2;
    g.strokeStyle = 'rgba(150,195,255,' + ((i % 7 === 0) ? 0.05 : 0.016) + ')';
    g.stroke();
  }
  g.restore();

  /* minute track */
  g.save();
  g.translate(cx, cy);
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU;
    const five = i % 5 === 0;
    const r1 = R * 0.948;
    const r2 = five ? R * 0.884 : R * 0.914;
    g.beginPath();
    g.moveTo(Math.sin(a) * r1, -Math.cos(a) * r1);
    g.lineTo(Math.sin(a) * r2, -Math.cos(a) * r2);
    g.lineWidth = five ? 7 : 3.2;
    g.strokeStyle = five ? 'rgba(228,241,255,0.95)' : 'rgba(186,213,255,0.55)';
    g.stroke();
  }
  g.beginPath();
  g.arc(0, 0, R * 0.872, 0, TAU);
  g.strokeStyle = 'rgba(200,225,255,0.22)';
  g.lineWidth = 4;
  g.stroke();
  g.restore();

  /* typography */
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  g.fillStyle = 'rgba(232,243,255,0.94)';
  g.font = '600 ' + Math.round(S * 0.040) + 'px Georgia, "Times New Roman", serif';
  g.fillText('A Z U R E', cx, cy - R * 0.500);

  g.fillStyle = 'rgba(176,208,255,0.72)';
  g.font = '500 ' + Math.round(S * 0.0165) + 'px Helvetica, Arial, sans-serif';
  g.fillText('A U T O M A T I C', cx, cy - R * 0.396);
  g.fillText('S W I S S   M A D E', cx, cy + R * 0.775);

  /* date window at 3 */
  const dw = S * 0.050, dh = S * 0.041;
  g.save();
  g.translate(cx + R * 0.705, cy);
  g.fillStyle = '#eef4ff';
  g.fillRect(-dw / 2, -dh / 2, dw, dh);
  g.strokeStyle = 'rgba(26,54,110,0.9)';
  g.lineWidth = S * 0.0035;
  g.strokeRect(-dw / 2, -dh / 2, dw, dh);
  g.fillStyle = '#0a2a6e';
  g.font = '600 ' + Math.round(S * 0.032) + 'px Helvetica, Arial, sans-serif';
  g.fillText('4', 0, S * 0.001);
  g.restore();

  /* vignette */
  grd = g.createRadialGradient(cx, cy, R * 0.52, cx, cy, R);
  grd.addColorStop(0.0, 'rgba(0,2,14,0)');
  grd.addColorStop(0.85, 'rgba(0,2,14,0.22)');
  grd.addColorStop(1.0, 'rgba(0,2,14,0.58)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);

  return c;
}

function tintDial(color) {
  const c = mkCanvas(dialCanvas.width, dialCanvas.height);
  const g = c.getContext('2d');
  g.drawImage(dialCanvas, 0, 0);
  g.globalCompositeOperation = 'color';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over';
  return mkTex(c);
}

const dialCanvas = makeDialTexture();
const dialMaps = {
  azure: mkTex(dialCanvas),
  graphite: tintDial('#8b95a3'),
  champagne: tintDial('#e7c181'),
  ember: tintDial('#d47a64'),
};

/* ============================================================
   WATCH
   ============================================================ */
const DIAL_R = 0.838;

const steel = new THREE.MeshStandardMaterial({
  color: 0xd7dee9, metalness: 1.0, roughness: 0.16,
  envMapIntensity: 1.6, side: THREE.DoubleSide
});
const brushed = new THREE.MeshStandardMaterial({
  color: 0x9aa6b6, metalness: 1.0, roughness: 0.48,
  envMapIntensity: 1.0, side: THREE.DoubleSide
});
const blueCeramic = new THREE.MeshPhysicalMaterial({
  color: 0x0a3fd0, metalness: 0.18, roughness: 0.07,
  clearcoat: 1.0, clearcoatRoughness: 0.04, envMapIntensity: 2.2,
  side: THREE.DoubleSide
});
const dialMat = new THREE.MeshStandardMaterial({
  map: dialMaps.azure, metalness: 0.62, roughness: 0.30,
  envMapIntensity: 1.15, side: THREE.DoubleSide
});
const brass = new THREE.MeshStandardMaterial({
  color: 0xc39a4c, metalness: 1.0, roughness: 0.30, envMapIntensity: 1.4
});
const blued = new THREE.MeshStandardMaterial({
  color: 0x1b4fdc, metalness: 1.0, roughness: 0.13,
  envMapIntensity: 1.7, side: THREE.DoubleSide
});
const lumeMat = new THREE.MeshStandardMaterial({
  color: 0xd9f7ff, emissive: 0x74d4ff, emissiveIntensity: 1.7, roughness: 0.35
});
const darkMat = new THREE.MeshStandardMaterial({
  color: 0x0a1020, metalness: 0.85, roughness: 0.35,
  envMapIntensity: 0.9, side: THREE.DoubleSide
});
const rubyMat = new THREE.MeshStandardMaterial({
  color: 0xd0233f, emissive: 0x5a0010, emissiveIntensity: 0.6,
  metalness: 0.3, roughness: 0.12
});

const watch = new THREE.Group();
watch.position.set(0, 1.30, 0);
watch.rotation.set(1.02, 0, 0);
scene.add(wb.id(watch, 'watch'));

/* --- case --- */
const caseProfile = [
  [0.000, -0.160], [0.300, -0.163], [0.560, -0.167], [0.740, -0.163],
  [0.845, -0.152], [0.915, -0.128], [0.960, -0.088], [0.982, -0.040],
  [0.986, 0.005], [0.972, 0.045], [0.938, 0.072], [0.895, 0.085],
  [0.868, 0.086], [0.858, 0.070], [0.856, 0.046], [0.820, 0.044],
  [0.000, 0.044]
].map(function (p) { return new THREE.Vector2(p[0], p[1]); });

const caseMesh = new THREE.Mesh(new THREE.LatheGeometry(caseProfile, 180), steel);
caseMesh.castShadow = true;
caseMesh.receiveShadow = true;
watch.add(caseMesh);

/* caseback */
const caseBack = new THREE.Mesh(new THREE.CylinderGeometry(0.845, 0.845, 0.014, 128), brushed);
caseBack.position.y = -0.166;
caseBack.castShadow = true;
watch.add(caseBack);
const backRing = new THREE.Mesh(new THREE.TorusGeometry(0.60, 0.014, 12, 96), steel);
backRing.rotation.x = -Math.PI / 2;
backRing.position.y = -0.174;
watch.add(backRing);

/* --- dial with open-heart aperture --- */
const dialShape = new THREE.Shape();
dialShape.absarc(0, 0, DIAL_R, 0, TAU, false);
const heartHole = new THREE.Path();
heartHole.absarc(0, -0.345, 0.212, 0, TAU, true);
dialShape.holes.push(heartHole);

const dialGeo = new THREE.ShapeGeometry(dialShape, 180);
dialGeo.rotateX(-Math.PI / 2);
(function remapUV() {
  const pos = dialGeo.attributes.position;
  const uv = dialGeo.attributes.uv;
  const span = DIAL_R * 2;
  for (let i = 0; i < pos.count; i++) {
    uv.setXY(i, pos.getX(i) / span + 0.5, 0.5 - pos.getZ(i) / span);
  }
  uv.needsUpdate = true;
})();
dialGeo.computeVertexNormals();
const dial = new THREE.Mesh(dialGeo, dialMat);
dial.position.y = 0.074;
dial.receiveShadow = true;
watch.add(dial);

/* rehaut */
const rehaut = new THREE.Mesh(
  new THREE.CylinderGeometry(0.850, 0.838, 0.048, 128, 1, true),
  new THREE.MeshStandardMaterial({
    color: 0x0a1730, metalness: 0.9, roughness: 0.22,
    envMapIntensity: 1.2, side: THREE.DoubleSide
  })
);
rehaut.position.y = 0.052;
watch.add(rehaut);

/* --- open heart: well + gears --- */
const well = new THREE.Mesh(
  new THREE.CylinderGeometry(0.214, 0.214, 0.034, 72, 1, true),
  darkMat
);
well.position.set(0, 0.061, 0.345);
watch.add(well);

const wellBase = new THREE.Mesh(new THREE.CircleGeometry(0.216, 72), darkMat);
wellBase.rotation.x = -Math.PI / 2;
wellBase.position.set(0, 0.046, 0.345);
watch.add(wellBase);

const heartRim = new THREE.Mesh(new THREE.TorusGeometry(0.216, 0.013, 12, 96), steel);
heartRim.rotation.x = -Math.PI / 2;
heartRim.position.set(0, 0.0755, 0.345);
watch.add(heartRim);

function gearGeometry(teeth, rOut, thickness, holeR) {
  const shape = new THREE.Shape();
  const step = TAU / teeth;
  const rRoot = rOut * 0.80;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [
      [rRoot, a + step * 0.00], [rRoot, a + step * 0.16],
      [rOut, a + step * 0.30], [rOut, a + step * 0.54],
      [rRoot, a + step * 0.68], [rRoot, a + step * 0.84]
    ];
    for (let j = 0; j < pts.length; j++) {
      const x = Math.cos(pts[j][1]) * pts[j][0];
      const y = Math.sin(pts[j][1]) * pts[j][0];
      if (i === 0 && j === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
  }
  shape.closePath();
  const hole = new THREE.Path();
  hole.absarc(0, 0, holeR, 0, TAU, true);
  shape.holes.push(hole);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true,
    bevelThickness: 0.0015, bevelSize: 0.0015,
    bevelSegments: 1, curveSegments: 6
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

const gearA = new THREE.Mesh(gearGeometry(26, 0.150, 0.012, 0.022), brass);
gearA.position.set(0.015, 0.050, 0.335);
watch.add(gearA);

const gearB = new THREE.Mesh(gearGeometry(16, 0.088, 0.011, 0.016), brass);
gearB.position.set(0.125, 0.055, 0.425);
watch.add(gearB);

const gearC = new THREE.Mesh(gearGeometry(12, 0.070, 0.010, 0.013), brass);
gearC.position.set(-0.115, 0.052, 0.410);
watch.add(gearC);

function addRuby(parent, x, y, z, r) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), rubyMat);
  m.position.set(x, y, z);
  m.scale.y = 0.45;
  parent.add(m);
}
addRuby(watch, 0.015, 0.064, 0.335, 0.016);
addRuby(watch, 0.125, 0.068, 0.425, 0.012);
addRuby(watch, -0.115, 0.064, 0.410, 0.011);

/* balance wheel */
const balance = new THREE.Group();
balance.position.set(-0.055, 0.058, 0.285);
const balRim = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.008, 8, 40), brass);
balRim.rotation.x = -Math.PI / 2;
balance.add(balRim);
for (let i = 0; i < 3; i++) {
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.108, 0.005, 0.007), brass);
  spoke.rotation.y = (i / 3) * Math.PI;
  balance.add(spoke);
}
watch.add(balance);

/* --- applied indices --- */
const idxGeo = new THREE.BoxGeometry(0.040, 0.020, 0.112);
const idxLumeGeo = new THREE.BoxGeometry(0.018, 0.004, 0.084);
for (let i = 0; i < 12; i++) {
  if (i === 3) continue;
  const a = (i / 12) * TAU;
  const grp = new THREE.Group();
  grp.position.set(Math.sin(a) * 0.662, 0.074, -Math.cos(a) * 0.662);
  grp.rotation.y = -a;
  const offs = (i === 0) ? [-0.042, 0.042] : [0];
  for (let k = 0; k < offs.length; k++) {
    const bar = new THREE.Mesh(idxGeo, steel);
    bar.position.set(offs[k], 0.012, 0);
    bar.castShadow = true;
    grp.add(bar);
    const lumeBar = new THREE.Mesh(idxLumeGeo, lumeMat);
    lumeBar.position.set(offs[k], 0.0235, 0);
    grp.add(lumeBar);
  }
  watch.add(grp);
}

/* --- hands --- */
function makeHandGeo(pts, thickness) {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: thickness, bevelEnabled: true,
    bevelThickness: 0.0025, bevelSize: 0.002,
    bevelSegments: 2, curveSegments: 2
  });
  geo.rotateX(-Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

const hourPts = [
  [0, 0.455], [0.028, 0.115], [0.047, 0.030], [0.047, -0.070],
  [0, -0.098], [-0.047, -0.070], [-0.047, 0.030], [-0.028, 0.115]
];
const minutePts = [
  [0, 0.655], [0.024, 0.130], [0.040, 0.035], [0.040, -0.075],
  [0, -0.100], [-0.040, -0.075], [-0.040, 0.035], [-0.024, 0.130]
];

const hourHand = new THREE.Mesh(makeHandGeo(hourPts, 0.007), steel);
hourHand.position.y = 0.082;
hourHand.castShadow = true;
watch.add(hourHand);

const minuteHand = new THREE.Mesh(makeHandGeo(minutePts, 0.007), steel);
minuteHand.position.y = 0.1035;
minuteHand.castShadow = true;
watch.add(minuteHand);

const secondHand = new THREE.Group();
secondHand.position.y = 0.120;
const secBar = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.720), blued);
secBar.position.z = -0.310;
secondHand.add(secBar);
const secTail = new THREE.Mesh(new THREE.BoxGeometry(0.020, 0.008, 0.110), blued);
secTail.position.z = 0.115;
secondHand.add(secTail);
const secWeight = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.008, 24), blued);
secWeight.position.z = 0.165;
secondHand.add(secWeight);
const secDot = new THREE.Mesh(new THREE.SphereGeometry(0.016, 14, 10), lumeMat);
secDot.position.set(0, 0.002, -0.625);
secondHand.add(secDot);
watch.add(secondHand);

/* center cap */
const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.040, 0.046, 0.016, 32), steel);
cap.position.y = 0.134;
watch.add(cap);
const capDot = new THREE.Mesh(new THREE.SphereGeometry(0.020, 16, 10), blued);
capDot.scale.y = 0.55;
capDot.position.y = 0.144;
watch.add(capDot);

/* --- bezel --- */
const bezelProfile = [
  [0.848, 0.070], [0.856, 0.100], [0.872, 0.115], [0.948, 0.115],
  [0.972, 0.100], [0.990, 0.068], [0.996, 0.030], [0.990, 0.006],
  [0.940, 0.006], [0.870, 0.040], [0.848, 0.050]
].map(function (p) { return new THREE.Vector2(p[0], p[1]); });

const bezel = new THREE.Mesh(new THREE.LatheGeometry(bezelProfile, 200), steel);
bezel.castShadow = true;
bezel.receiveShadow = true;
watch.add(bezel);

const bezelInsert = new THREE.Mesh(new THREE.RingGeometry(0.876, 0.944, 200, 1), blueCeramic);
bezelInsert.rotation.x = -Math.PI / 2;
bezelInsert.position.y = 0.1158;
watch.add(bezelInsert);

/* lume pip at 12 */
const pipBase = new THREE.Mesh(new THREE.CylinderGeometry(0.030, 0.030, 0.008, 24), steel);
pipBase.position.set(0, 0.1158, -0.910);
watch.add(pipBase);
const pip = new THREE.Mesh(new THREE.SphereGeometry(0.019, 16, 10), lumeMat);
pip.scale.y = 0.6;
pip.position.set(0, 0.1205, -0.910);
watch.add(pip);

/* --- lugs & spring bars --- */
const lugGeo = new THREE.BoxGeometry(0.150, 0.088, 0.390);
for (let sx = -1; sx <= 1; sx += 2) {
  for (let sz = -1; sz <= 1; sz += 2) {
    const lug = new THREE.Mesh(lugGeo, steel);
    lug.position.set(sx * 0.500, -0.018, sz * 0.945);
    lug.rotation.x = sz * 0.22;
    lug.rotation.z = sx * 0.04;
    lug.castShadow = true;
    watch.add(lug);
  }
}
for (let sz = -1; sz <= 1; sz += 2) {
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.750, 16), brushed);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, -0.062, sz * 1.090);
  watch.add(bar);
}

/* --- crown --- */
const crown = new THREE.Group();
crown.position.set(0.975, 0, 0);
const crownBody = new THREE.Mesh(new THREE.CylinderGeometry(0.084, 0.078, 0.105, 32), steel);
crownBody.rotation.z = Math.PI / 2;
crownBody.position.x = 0.058;
crownBody.castShadow = true;
crown.add(crownBody);
for (let i = 0; i < 18; i++) {
  const a = (i / 18) * TAU;
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.020, 0.026), steel);
  ridge.position.set(0.058, Math.cos(a) * 0.080, Math.sin(a) * 0.080);
  ridge.rotation.x = a;
  crown.add(ridge);
}
const crownNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.055, 20), steel);
crownNeck.rotation.z = Math.PI / 2;
crownNeck.position.x = -0.010;
crown.add(crownNeck);
const crownCap = new THREE.Mesh(new THREE.CylinderGeometry(0.060, 0.060, 0.020, 28), steel);
crownCap.rotation.z = Math.PI / 2;
crownCap.position.x = 0.118;
crown.add(crownCap);
const cabochon = new THREE.Mesh(new THREE.SphereGeometry(0.038, 20, 14), blueCeramic);
cabochon.scale.x = 0.55;
cabochon.position.x = 0.130;
crown.add(cabochon);
watch.add(wb.id(crown, 'crown'));

/* shadows on all watch meshes */
watch.traverse(function (o) {
  if (o.isMesh) {
    o.castShadow = true;
    if (o.material === darkMat || o.material === lumeMat || o.material === rubyMat) {
      o.castShadow = false;
    }
  }
});

/* ============================================================
   ANIMATION
   ============================================================ */
let hourBase = 305, minBase = 60;

onFrame(function (frame) {
  const t = frame.time;
  const dt = Math.min(frame.delta, 0.05);

  /* watch presentation motion */
  watch.rotation.y = Math.sin(t * 0.30) * 0.42;
  watch.rotation.x = 1.02 + Math.sin(t * 0.45) * 0.022;
  watch.position.y = 1.30 + Math.sin(t * 0.80) * 0.032;

  /* time keeping (10:10 base) */
  hourHand.rotation.y = -(hourBase + t * 0.00833) * DEG;
  minuteHand.rotation.y = -(minBase + t * 0.1) * DEG;
  secondHand.rotation.y = -(t * 6) * DEG;

  /* movement */
  gearA.rotation.y = t * 0.55;
  gearB.rotation.y = -t * 0.92;
  gearC.rotation.y = t * 1.25;
  balance.rotation.y = Math.sin(t * 6.2) * 0.55;

  /* light sweep */
  sparkle.position.set(Math.cos(t * 0.45) * 2.7, 4.2 + Math.sin(t * 0.7) * 0.5, Math.sin(t * 0.45) * 2.7 + 0.5);

  /* pedestal ring pulse */
  edgeMat.opacity = 0.58 + Math.sin(t * 1.3) * 0.16;
  pool.material.opacity = 0.46 + Math.sin(t * 0.85) * 0.08;

  /* dust drift */
  const pos = dustGeo.attributes.position;
  for (let i = 0; i < DUST; i++) {
    let y = pos.getY(i) + dt * (0.05 + dustSeed[i] * 0.10);
    if (y > 4.8) y = 0.05;
    pos.setY(i, y);
    pos.setX(i, pos.getX(i) + Math.sin(t * 0.4 + dustSeed[i] * 9.0) * dt * 0.02);
  }
  pos.needsUpdate = true;
});

  const VARIANTS = {
    azure: {
      steel: 0xd7dee9, brushed: 0x9aa6b6, ceramic: 0x0a3fd0, dial: 0xffffff,
      hands: 0x1b4fdc, edge: 0x4f7cff, pedestal: 0x0d1420, pool: 0x1c3f8f, bg: 0x02040a,
    },
    graphite: {
      steel: 0xc3c9d1, brushed: 0x7f8791, ceramic: 0x242a32, dial: 0x9aa4b2,
      hands: 0x9aa4b2, edge: 0x9fb0c8, pedestal: 0x0a0d12, pool: 0x2a3442, bg: 0x05070a,
    },
    champagne: {
      steel: 0xf0d9a6, brushed: 0xb99c63, ceramic: 0x6b4f24, dial: 0xf2d49a,
      hands: 0x8a6a32, edge: 0xf0c97a, pedestal: 0x100d08, pool: 0x6b5428, bg: 0x0b0905,
    },
    ember: {
      steel: 0xc9b4ae, brushed: 0x8a6f68, ceramic: 0x7a2418, dial: 0xd8a38e,
      hands: 0x8a2a1a, edge: 0xff7a5c, pedestal: 0x100807, pool: 0x7a2a1c, bg: 0x0b0504,
    },
  }

  function setVariant(name) {
    const v = VARIANTS[name] || VARIANTS.azure
    steel.color.setHex(v.steel)
    brushed.color.setHex(v.brushed)
    blueCeramic.color.setHex(v.ceramic)
    dialMat.map = dialMaps[name] || dialMaps.azure
    dialMat.color.setHex(0xffffff)
    dialMat.needsUpdate = true
    blued.color.setHex(v.hands)
    pedMat.color.setHex(v.pedestal)
    edgeMat.color.setHex(v.edge)
    if (pool && pool.material && pool.material.color) pool.material.color.setHex(v.pool)
    if (scene.background && typeof scene.background.setHex === 'function') scene.background.setHex(v.bg)
  }

  return {
    setVariant,
    objects: { floor, pedestal, edgeRing, contact, pool, dust, sky, watch },
  }
}
