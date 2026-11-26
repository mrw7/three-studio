// ============================================================
//  TURBOFAN — product scene for the digital manual
//
//  A two-spool, high-bypass turbofan, modelled procedurally.
//  No external assets: every surface is a lathe profile or a
//  generated blade mesh.
//
//  Proportions follow published high-bypass engines of the
//  CFM56 / LEAP class and the NASA Glenn turbofan description:
//    - fan tip radius 1.0  ->  2.0 unit fan diameter
//    - overall length 1.68 x fan diameter (LEAP: 3.33 m / 1.98 m)
//    - the nacelle runs from the inlet highlight to the fan
//      nozzle, about 57% of overall length; the core cowl and
//      plug then extend well aft of it, which is what makes the
//      two flow paths legible
//    - the inlet lip is a thin rounded ring, the barrel swells
//      slightly behind it and tapers aft to the fan nozzle
//    - bypass duct = annulus between nacelle inner barrel and
//      core cowl; core = booster -> HP compressor -> annular
//      combustor -> HP turbine -> LP turbine -> nozzle + plug
//
//  Manual UIDs relied on by the steps:
//    engine-fan / engine-core / engine-combustor / engine-turbine
//    engine-nozzle / engine-nacelle / engine-pylon
// ============================================================

setBackground('#090c11');

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
scene.background = new THREE.Color(0x090c11);
scene.fog = new THREE.FogExp2(0x090c11, 0.016);

camera.fov = 30;
// Broadside 3/4 view. Looking into the inlet (what this used to do) puts the
// nacelle in front of everything: the engine is 3.4 units long and 2.1 across,
// so a head-on angle hides the whole core. From +X and slightly forward the
// axis runs across the frame — inlet at one end, core and plug at the other —
// which is how every engine cutaway is photographed. Distance and fov are set
// so the full 3.4-unit length clears the manual panel on the left.
camera.position.set(9.1, 3.0, -7.9);
camera.updateProjectionMatrix();
controls.target.set(0.30, 0.30, -0.10);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 5.0;
controls.maxDistance = 26;
controls.maxPolarAngle = Math.PI * 0.53;
controls.update();

// ------------------------------------------------------------
//  Key dimensions (fan tip radius = 1)
// ------------------------------------------------------------
const R_FAN = 1.0;            // fan tip radius
const R_HUB = 0.315;          // fan hub / spinner base radius
const R_NACELLE_MAX = 1.075;  // widest point, just aft of the lip

const Z_LIP = -1.62;          // inlet highlight
const Z_FAN = -0.80;          // fan rotor plane
const Z_OGV = -0.44;          // outlet guide vanes
const Z_FAN_NOZZLE = 0.30;    // nacelle trailing edge = fan nozzle

const Z_CORE_FRONT = -0.60;   // fan frame / core cowl leading edge
const Z_CORE_EXIT = 1.30;     // core nozzle exit plane
const Z_PLUG_TIP = 1.78;      // exhaust plug tip

// Core casing radii: widest at the fan frame, tapering aft as the
// annulus closes down through the compressor and turbine.
const R_CORE_FRONT = 0.505;
const R_CORE_AFT = 0.415;

// ------------------------------------------------------------
//  Materials
// ------------------------------------------------------------
function brushedTexture() {
  const w = 512;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#8d949c';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i += 1) {
    const y = Math.random() * h;
    const len = 40 + Math.random() * 220;
    const a = 0.02 + Math.random() * 0.06;
    g.strokeStyle = Math.random() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    g.lineWidth = 0.6 + Math.random() * 1.2;
    g.beginPath();
    g.moveTo(Math.random() * w, y);
    g.lineTo(Math.random() * w + len, y + (Math.random() - 0.5) * 1.5);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 2);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

const brushed = brushedTexture();

const MAT = {
  // Nacelle skin: painted composite, not bare metal.
  paint: new THREE.MeshStandardMaterial({
    color: 0xd6dbe2, metalness: 0.16, roughness: 0.44, envMapIntensity: 0.85,
  }),
  paintDark: new THREE.MeshStandardMaterial({
    color: 0x98a1ab, metalness: 0.2, roughness: 0.5, envMapIntensity: 0.8,
  }),
  // Titanium fan / compressor.
  titanium: new THREE.MeshStandardMaterial({
    color: 0xb9c2cc, metalness: 0.95, roughness: 0.28, map: brushed, envMapIntensity: 1.25,
  }),
  // Nickel hot section.
  nickel: new THREE.MeshStandardMaterial({
    color: 0x8d8478, metalness: 1.0, roughness: 0.3, envMapIntensity: 1.35,
  }),
  // Dark internal structure.
  structure: new THREE.MeshStandardMaterial({
    color: 0x2a3037, metalness: 0.8, roughness: 0.5, envMapIntensity: 0.8,
  }),
  // Acoustic liner inside the inlet and bypass duct.
  liner: new THREE.MeshStandardMaterial({
    color: 0x171c22, metalness: 0.35, roughness: 0.85,
  }),
  brass: new THREE.MeshStandardMaterial({
    color: 0xd8a760, metalness: 1.0, roughness: 0.22, envMapIntensity: 1.6,
  }),
  combustor: new THREE.MeshStandardMaterial({
    color: 0x3c2f24, metalness: 0.85, roughness: 0.45,
    emissive: 0xff6a18, emissiveIntensity: 1.3,
  }),
  exhaust: new THREE.MeshStandardMaterial({
    color: 0x6a6155, metalness: 1.0, roughness: 0.34,
    emissive: 0x2a1608, emissiveIntensity: 0.5,
    side: THREE.DoubleSide,
  }),
};

// ------------------------------------------------------------
//  Studio environment (procedural equirect) for metal reflections
// ------------------------------------------------------------
function buildStudioEnvironment() {
  const w = 1024;
  const h = 512;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const lg = g.createLinearGradient(0, 0, 0, h);
  lg.addColorStop(0.0, '#0a0f16');
  lg.addColorStop(0.42, '#1f2c3a');
  lg.addColorStop(0.52, '#2d4157');
  lg.addColorStop(0.62, '#19222c');
  lg.addColorStop(1.0, '#05070a');
  g.fillStyle = lg;
  g.fillRect(0, 0, w, h);

  const strip = (cx, cy, sw, sh, color, alpha) => {
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(sw, sh));
    grad.addColorStop(0, color.replace('ALPHA', String(alpha)));
    grad.addColorStop(1, color.replace('ALPHA', '0'));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(cx, cy, sw, sh, 0, 0, Math.PI * 2);
    g.fill();
  };
  strip(w * 0.24, h * 0.32, 200, 120, 'rgba(255,247,234,ALPHA)', 0.95);
  strip(w * 0.72, h * 0.26, 150, 105, 'rgba(150,196,255,ALPHA)', 0.6);
  strip(w * 0.80, h * 0.10, 120, 60, 'rgba(255,255,255,ALPHA)', 0.55);
  strip(w * 0.48, h * 0.88, 360, 60, 'rgba(255,176,96,ALPHA)', 0.28);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
scene.environment = buildStudioEnvironment();

// ------------------------------------------------------------
//  Stage
// ------------------------------------------------------------
const world = new THREE.Group();
world.name = 'engine-world';
scene.add(world);

const FLOOR_Y = -1.72;
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(16, 96),
  new THREE.MeshStandardMaterial({ color: 0x0e1218, metalness: 0.4, roughness: 0.68 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = FLOOR_Y;
floor.receiveShadow = true;
world.add(floor);

const grid = new THREE.GridHelper(26, 52, 0x1b2733, 0x121a24);
grid.position.y = FLOOR_Y + 0.005;
grid.material.transparent = true;
grid.material.opacity = 0.45;
world.add(grid);

const keyLight = new THREE.DirectionalLight(0xfff3e2, 4.0);
keyLight.position.set(5.0, 7.2, -4.8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.near = 1;
keyLight.shadow.camera.far = 30;
keyLight.shadow.camera.left = -8;
keyLight.shadow.camera.right = 8;
keyLight.shadow.camera.top = 8;
keyLight.shadow.camera.bottom = -8;
keyLight.shadow.bias = -0.0006;
world.add(keyLight);

const rimLight = new THREE.DirectionalLight(0x86bcff, 3.2);
rimLight.position.set(-6.2, 3.2, 4.8);
world.add(rimLight);

const fillLight = new THREE.DirectionalLight(0xcfe0ff, 1.4);
fillLight.position.set(-3.0, 1.0, -7.0);
world.add(fillLight);

// Light inside the inlet so the fan face reads against the dark barrel. The
// acoustic liner is near-black by design, so without a dedicated light the
// cutaway opens onto a void instead of the rotor.
const inletGlow = new THREE.PointLight(0xffe8cc, 42, 6.5, 2);
inletGlow.position.set(0, 0.25, -1.30);
world.add(inletGlow);

// A second, tighter light aimed straight at the fan disc.
const fanLight = new THREE.PointLight(0xdce8ff, 26, 3.6, 2);
fanLight.position.set(0.35, 0.20, -1.02);
world.add(fanLight);

const bounce = new THREE.PointLight(0xffb070, 22, 16, 2);
bounce.position.set(0, -1.1, 1.6);
world.add(bounce);

world.add(new THREE.HemisphereLight(0x9dc4ff, 0x090c11, 0.95));

// ------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------
// A lathe profile is authored as [radius, z] pairs. LatheGeometry revolves
// around +Y, so rotating the mesh by +90° about X maps the profile height onto
// +Z: no per-part axis juggling.
const lathe = (profile, material, options = {}) => {
  const segments = options.segments ?? 128;
  const points = profile.map(([radius, z]) => new THREE.Vector2(Math.max(0.0005, radius), z));
  const geo = new THREE.LatheGeometry(
    points,
    segments,
    options.phiStart ?? 0,
    options.phiLength ?? Math.PI * 2,
  );
  const mesh = new THREE.Mesh(geo, material);
  mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  return mesh;
};

// NACA-4-digit style section: cosine-spaced chord, 4-16% camber.
function airfoilLoop(chord, thickRatio, camberRatio, samples) {
  const upper = [];
  const lower = [];
  const p = 0.4;
  const m = camberRatio;
  for (let i = 0; i <= samples; i += 1) {
    const x = 0.5 * (1 - Math.cos((Math.PI * i) / samples));
    const yt = 5 * thickRatio * (0.2969 * Math.sqrt(x) - 0.126 * x
      - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
    const yc = x < p
      ? (m / (p * p)) * (2 * p * x - x * x)
      : (m / ((1 - p) ** 2)) * ((1 - 2 * p) + 2 * p * x - x * x);
    upper.push([x * chord, (yc + yt) * chord]);
    lower.push([x * chord, (yc - yt) * chord]);
  }
  // LE -> TE on the suction side, TE -> LE on the pressure side.
  return upper.concat(lower.reverse().slice(1, -1));
}

// One blade: sections along the span, each an airfoil loop rotated to the
// local stagger angle. Stagger is measured from the engine axis, so a 58° root
// and a 27° tip produce the wide-chord twist that flat boxes cannot fake.
function bladeGeometry(options) {
  const {
    hubR, tipR, chordRoot, chordTip,
    staggerRoot, staggerTip, thickRoot, thickTip,
    camber = 0.05, z = 0, lean = 0, sections = 9, loopSamples = 12,
  } = options;

  const loopCount = loopSamples * 2;
  const positions = [];
  const indices = [];

  for (let s = 0; s < sections; s += 1) {
    const u = sections === 1 ? 0 : s / (sections - 1);
    const r = hubR + (tipR - hubR) * u;
    const chord = chordRoot + (chordTip - chordRoot) * u;
    const stagger = (staggerRoot + (staggerTip - staggerRoot) * u) * (Math.PI / 180);
    const thick = thickRoot + (thickTip - thickRoot) * u;
    const zs = z + lean * u * u;

    const axial = [Math.cos(stagger), Math.sin(stagger)];   // (z, tangential)
    const normal = [-Math.sin(stagger), Math.cos(stagger)];

    const loop = airfoilLoop(chord, thick, camber, loopSamples);
    for (const [cx, cy] of loop) {
      const dz = (cx - chord * 0.5) * axial[0] + cy * normal[0];
      const dt = (cx - chord * 0.5) * axial[1] + cy * normal[1];
      const phi = dt / r;
      positions.push(Math.cos(phi) * r, Math.sin(phi) * r, zs + dz);
    }
  }

  for (let s = 0; s < sections - 1; s += 1) {
    for (let k = 0; k < loopCount; k += 1) {
      const a = s * loopCount + k;
      const b = s * loopCount + ((k + 1) % loopCount);
      const c = (s + 1) * loopCount + k;
      const d = (s + 1) * loopCount + ((k + 1) % loopCount);
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// A ring of identical blades, one draw call.
function bladeRing(options) {
  const { count, material, phase = 0 } = options;
  const geo = bladeGeometry(options);
  const mesh = new THREE.InstancedMesh(geo, material, count);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i += 1) {
    m.makeRotationZ(phase + (i / count) * Math.PI * 2);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ------------------------------------------------------------
//  Assembly
// ------------------------------------------------------------
const engine = new THREE.Group();
engine.name = 'turbofan';
engine.position.set(0, 0.5, 0);
world.add(engine);

// ---- Nacelle -------------------------------------------------
// Each section is one closed lathe: outer skin forward-to-aft to a trailing
// edge, across the thin TE, then back along the inner barrel and around the
// inlet lip. A closed shell with FrontSide normals is what stops the inner and
// outer walls from mirroring each other.
//
// The nacelle is split at Z_NACELLE_SPLIT instead of being one piece: the
// forward section (inlet + fan cowl) is cut open with a 110° wedge on the +X
// camera side, so step 01 shows the fan and the bypass duct instead of a blank
// white drum. The aft section stays a complete barrel, which keeps the exhaust
// silhouette intact and matches how display cutaways are actually made.
const nacelleGroup = new THREE.Group();
nacelleGroup.name = 'nacelle';
engine.add(nacelleGroup);

const Z_NACELLE_SPLIT = -0.55;
const R_OUT_SPLIT = 1.026;
const R_IN_SPLIT = 1.009;

const nacelleLipGap = (150 * Math.PI) / 180;
const nacelleLip = lathe([
  // outer skin, forward to aft — swells behind the lip
  [R_FAN + 0.008, Z_LIP],
  [R_NACELLE_MAX - 0.012, -1.575],
  [R_NACELLE_MAX, -1.480],
  [R_NACELLE_MAX, -1.360],
  [1.070, -1.150],
  [1.052, -0.900],
  [R_OUT_SPLIT, Z_NACELLE_SPLIT],
  // trailing edge thickness at the split
  [R_IN_SPLIT, Z_NACELLE_SPLIT],
  // inner barrel, aft to forward
  [1.016, -0.900],
  [1.014, -1.150],
  [1.010, -1.320],
  [1.002, -1.430],
  [0.994, -1.510],
  [0.990, -1.570],
  // inlet lip: rounded nose back to the highlight
  [0.994, -1.612],
  [1.004, -1.630],
  [1.014, -1.628],
], MAT.paint, {
  segments: 160,
  phiStart: Math.PI * 0.5 + nacelleLipGap * 0.5,
  phiLength: Math.PI * 2 - nacelleLipGap,
});
nacelleGroup.add(nacelleLip);

// Aft fan cowl and fan nozzle: full 360°.
const nacelleAft = lathe([
  [R_OUT_SPLIT, Z_NACELLE_SPLIT],
  [1.004, -0.300],
  [0.974, 0.010],
  [0.942, 0.170],
  [0.918, Z_FAN_NOZZLE],
  // trailing edge thickness
  [0.900, Z_FAN_NOZZLE],
  // inner barrel
  [0.930, 0.170],
  [0.962, 0.010],
  [0.992, -0.300],
  [R_IN_SPLIT, Z_NACELLE_SPLIT],
], MAT.paint, { segments: 160 });
nacelleGroup.add(nacelleAft);

// Acoustic liner on the inlet barrel (a touch inside the skin).
// The liner follows the cutaway: the same wedge is removed from it, otherwise
// it closes the window the nacelle just opened and the fan stays invisible.
const inletLiner = lathe([
  [1.000, -1.560],
  [0.996, -1.480],
  [0.996, -1.300],
  [0.995, -1.120],
  [0.992, -0.960],
], MAT.liner, {
  segments: 128,
  castShadow: false,
  phiStart: Math.PI * 0.5 + nacelleLipGap * 0.5,
  phiLength: Math.PI * 2 - nacelleLipGap,
});
inletLiner.material.side = THREE.DoubleSide;
nacelleGroup.add(inletLiner);

// Fan-case joint ring, just forward of the fan plane.
const caseJoint = new THREE.Mesh(
  new THREE.TorusGeometry(1.004, 0.007, 8, 160),
  MAT.paintDark,
);
caseJoint.position.z = -0.60;
nacelleGroup.add(caseJoint);

// Thrust-reverser split lines: two trim bands around the fan cowl.
for (const z of [-0.28, 0.04]) {
  const band = new THREE.Mesh(
    new THREE.TorusGeometry(1.008, 0.006, 6, 160),
    MAT.paintDark,
  );
  band.position.z = z;
  nacelleGroup.add(band);
}

// Reverser cascade grille: a recessed dark band with visible slats.
const cascadeZ = 0.13;
const cascade = lathe([
  [1.000, cascadeZ - 0.070],
  [0.990, cascadeZ - 0.050],
  [0.990, cascadeZ + 0.050],
  [1.000, cascadeZ + 0.070],
], MAT.structure, { segments: 96, castShadow: false });
nacelleGroup.add(cascade);

const slatGeo = new THREE.BoxGeometry(0.010, 0.135, 0.018);
for (let i = 0; i < 56; i += 1) {
  const a = (i / 56) * Math.PI * 2;
  const slat = new THREE.Mesh(slatGeo, MAT.paintDark);
  slat.position.set(Math.cos(a) * 0.996, Math.sin(a) * 0.996, cascadeZ);
  slat.rotation.z = a - Math.PI / 2;
  slat.rotation.x = 0.22;
  nacelleGroup.add(slat);
}

wb.id(nacelleGroup, 'engine-nacelle');

// ---- Pylon ---------------------------------------------------
// A wing pylon is a swept fairing that grows out of the nacelle crown, so its
// base is buried inside the nacelle skin (y < R_NACELLE_MAX) and it narrows
// toward the wing attach point. The previous shape floated above the nacelle
// and read as a separate white slab.
const pylonGroup = new THREE.Group();
pylonGroup.name = 'pylon';
engine.add(pylonGroup);

const pylonShape = new THREE.Shape();
pylonShape.moveTo(-0.34, -0.22);
pylonShape.lineTo(-0.50, 0.14);
pylonShape.lineTo(-0.54, 0.44);
pylonShape.lineTo(0.10, 0.52);
pylonShape.lineTo(0.38, 0.40);
pylonShape.lineTo(0.32, -0.22);
pylonShape.closePath();
const pylon = new THREE.Mesh(
  new THREE.ExtrudeGeometry(pylonShape, {
    depth: 0.17, bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2,
  }),
  MAT.paint,
);
// Sunk into the crown: base at 0.86 of the nacelle radius.
pylon.position.set(0, R_NACELLE_MAX - 0.215, -0.10);
pylon.rotation.y = -Math.PI / 2;
pylon.castShadow = true;
pylon.receiveShadow = true;
pylonGroup.add(pylon);

// Forward and aft mount links between pylon and fan case.
for (const z of [-0.46, 0.16]) {
  const link = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.16, 12), MAT.structure);
  link.position.set(0, R_NACELLE_MAX - 0.02, z);
  pylonGroup.add(link);
}
wb.id(pylonGroup, 'engine-pylon');

// ---- Fan -----------------------------------------------------
const fanGroup = new THREE.Group();
fanGroup.name = 'fan';
fanGroup.position.z = Z_FAN;
engine.add(fanGroup);

// Spinner: an ogive that meets the hub with a slight concave break.
const spinnerProfile = [];
for (let i = 0; i <= 26; i += 1) {
  const t = i / 26;
  spinnerProfile.push([Math.max(0.0005, Math.pow(t, 0.78) * R_HUB), -0.400 + t * 0.400]);
}
const spinner = lathe(spinnerProfile, MAT.structure, { segments: 64 });
fanGroup.add(spinner);

// Fan hub disc.
const hub = lathe([
  [0.0005, 0.000],
  [R_HUB, 0.000],
  [R_HUB, 0.115],
  [R_HUB - 0.035, 0.150],
  [0.0005, 0.150],
], MAT.titanium, { segments: 64 });
fanGroup.add(hub);

// 22 wide-chord blades: 58° stagger at the root falling to 27° at the tip.
const FAN_BLADES = 22;
const fanRotor = bladeRing({
  count: FAN_BLADES,
  material: MAT.titanium,
  hubR: R_HUB + 0.005,
  tipR: R_FAN - 0.012,
  chordRoot: 0.30,
  chordTip: 0.34,
  staggerRoot: 58,
  staggerTip: 27,
  thickRoot: 0.10,
  thickTip: 0.035,
  camber: 0.06,
  lean: 0.035,
  sections: 10,
  z: 0.055,
});
fanGroup.add(fanRotor);

// Fan-case rub strip the tips run against.
const rubStrip = lathe([
  [1.000, -0.020],
  [0.994, -0.020],
  [0.994, 0.130],
  [1.000, 0.130],
], MAT.structure, { segments: 128, castShadow: false });
fanGroup.add(rubStrip);

wb.id(fanGroup, 'engine-fan');

// ---- Outlet guide vanes --------------------------------------
// 44 OGVs de-swirl the bypass flow; they sit just aft of the fan.
const ogvRing = bladeRing({
  count: 44,
  material: MAT.titanium,
  hubR: R_CORE_FRONT + 0.01,
  tipR: 0.995,
  chordRoot: 0.125,
  chordTip: 0.145,
  staggerRoot: 16,
  staggerTip: 10,
  thickRoot: 0.075,
  thickTip: 0.055,
  camber: 0.09,
  sections: 4,
  z: Z_OGV,
});
engine.add(ogvRing);

// ---- Core cowl (cut away) ------------------------------------
// The cowl is the inner wall of the bypass duct. A 70° wedge is removed on the
// +X side so the compressor, combustor and turbine stay visible without the
// manual having to hide the whole core.
const cowlGap = (70 * Math.PI) / 180;
const coreCowlProfile = [
  // outer surface, forward to aft
  [R_CORE_FRONT, Z_CORE_FRONT],
  [R_CORE_FRONT + 0.005, -0.42],
  [0.498, -0.20],
  [0.484, 0.06],
  [0.464, 0.34],
  [0.442, 0.62],
  [0.424, 0.86],
  [R_CORE_AFT, 1.02],
  [R_CORE_AFT - 0.01, 1.08],
  // inner surface, aft to forward
  [R_CORE_AFT - 0.045, 1.08],
  [R_CORE_AFT - 0.04, 1.02],
  [0.390, 0.86],
  [0.408, 0.62],
  [0.430, 0.34],
  [0.450, 0.06],
  [0.464, -0.20],
  [R_CORE_FRONT - 0.042, -0.42],
  [R_CORE_FRONT - 0.045, Z_CORE_FRONT],
];
const coreCowl = lathe(coreCowlProfile, MAT.paintDark, {
  segments: 128,
  phiStart: Math.PI * 0.5 + cowlGap * 0.5,
  phiLength: Math.PI * 2 - cowlGap,
});
engine.add(coreCowl);

// ---- Core engine --------------------------------------------
const coreGroup = new THREE.Group();
coreGroup.name = 'core';
engine.add(coreGroup);

// Rotor rings turn with their spool; stator rings stay bolted to the case.
// The two spools turn at different rates, so they are tracked separately.
const hpRotorRings = [];
const lpRotorRings = [];

// Static front frame.
coreGroup.add(lathe([
  [0.300, Z_CORE_FRONT],
  [R_CORE_FRONT - 0.045, Z_CORE_FRONT],
  [R_CORE_FRONT - 0.045, -0.555],
  [0.300, -0.555],
], MAT.structure, { segments: 96 }));

// Booster (LP compressor), 3 stages. Turns with the LP spool.
for (let s = 0; s < 3; s += 1) {
  const z = -0.535 + s * 0.085;
  const booster = bladeRing({
    count: 46,
    material: MAT.titanium,
    hubR: 0.215,
    tipR: 0.452 - s * 0.010,
    chordRoot: 0.068,
    chordTip: 0.076,
    staggerRoot: 44,
    staggerTip: 30,
    thickRoot: 0.08,
    thickTip: 0.06,
    camber: 0.07,
    sections: 4,
    z,
    phase: s * 0.13,
  });
  coreGroup.add(booster);
  lpRotorRings.push(booster);
}

// HP compressor, 8 stages, radius falling aft as the flow is compressed.
for (let s = 0; s < 8; s += 1) {
  const z = -0.250 + s * 0.078;
  const tip = 0.424 - s * 0.0085;
  const rotor = bladeRing({
    count: 38 + s * 2,
    material: MAT.titanium,
    hubR: 0.222 + s * 0.004,
    tipR: tip,
    chordRoot: 0.054,
    chordTip: 0.060,
    staggerRoot: 46,
    staggerTip: 33,
    thickRoot: 0.08,
    thickTip: 0.06,
    camber: 0.07,
    sections: 4,
    z,
    phase: s * 0.09,
  });
  coreGroup.add(rotor);
  hpRotorRings.push(rotor);
  // Stator ring between rotors: bolted to the case, so it does not spin.
  coreGroup.add(bladeRing({
    count: 44,
    material: MAT.nickel,
    hubR: 0.238 + s * 0.004,
    tipR: tip - 0.004,
    chordRoot: 0.034,
    chordTip: 0.038,
    staggerRoot: 22,
    staggerTip: 18,
    thickRoot: 0.1,
    thickTip: 0.08,
    camber: 0.10,
    sections: 3,
    z: z + 0.039,
    phase: s * 0.21,
  }));
}

// HP compressor rear casing and the diffuser into the combustor.
coreGroup.add(lathe([
  [0.290, 0.372],
  [0.352, 0.402],
  [0.352, 0.452],
  [0.300, 0.474],
], MAT.nickel, { segments: 96 }));

// Combustor: annular liner, 20 fuel nozzles.
const combustorGroup = new THREE.Group();
combustorGroup.name = 'combustor';
combustorGroup.position.z = 0.60;
coreGroup.add(combustorGroup);

const linerOuter = lathe([
  [0.332, -0.070],
  [0.352, -0.030],
  [0.354, 0.050],
  [0.332, 0.088],
], MAT.combustor, { segments: 96 });
combustorGroup.add(linerOuter);

const linerInner = lathe([
  [0.258, -0.070],
  [0.238, -0.030],
  [0.236, 0.050],
  [0.258, 0.088],
], MAT.combustor, { segments: 96 });
combustorGroup.add(linerInner);

// Dome at the front of the annulus.
const dome = lathe([
  [0.258, -0.070],
  [0.278, -0.098],
  [0.314, -0.098],
  [0.332, -0.070],
], MAT.combustor, { segments: 96 });
combustorGroup.add(dome);

const nozzleStem = new THREE.CylinderGeometry(0.016, 0.022, 0.115, 10);
for (let i = 0; i < 20; i += 1) {
  const a = (i / 20) * Math.PI * 2;
  const nozzle = new THREE.Mesh(nozzleStem, MAT.brass);
  nozzle.position.set(Math.cos(a) * 0.292, Math.sin(a) * 0.292, -0.092);
  nozzle.rotation.x = Math.PI / 2;
  combustorGroup.add(nozzle);
}
wb.id(combustorGroup, 'engine-combustor');

// ---- Turbines ------------------------------------------------
const turbineGroup = new THREE.Group();
turbineGroup.name = 'turbine';
coreGroup.add(turbineGroup);

// HP turbine: 2 stages. Nozzle guide vanes are static; the rotors turn with
// the HP spool, so they are collected into hpRotorRings.
for (let s = 0; s < 2; s += 1) {
  const z = 0.720 + s * 0.084;
  turbineGroup.add(bladeRing({
    count: 52,
    material: MAT.nickel,
    hubR: 0.264,
    tipR: 0.348 - s * 0.004,
    chordRoot: 0.050,
    chordTip: 0.055,
    staggerRoot: 30,
    staggerTip: 22,
    thickRoot: 0.16,
    thickTip: 0.12,
    camber: 0.16,
    sections: 4,
    z: z - 0.032,
    phase: 0.1,
  }));
  const rotor = bladeRing({
    count: 56,
    material: MAT.nickel,
    hubR: 0.262,
    tipR: 0.344 - s * 0.004,
    chordRoot: 0.047,
    chordTip: 0.051,
    staggerRoot: -34,
    staggerTip: -26,
    thickRoot: 0.15,
    thickTip: 0.11,
    camber: 0.14,
    sections: 4,
    z,
    phase: 0.05,
  });
  turbineGroup.add(rotor);
  hpRotorRings.push(rotor);
}

// LP turbine: 5 stages, growing radius as the gas expands. The rotors drive
// the fan through the inner shaft, so they turn at N1 with the fan.
for (let s = 0; s < 5; s += 1) {
  const z = 0.900 + s * 0.074;
  const tip = 0.360 + s * 0.010;
  const rotor = bladeRing({
    count: 60,
    material: MAT.nickel,
    hubR: 0.268,
    tipR: tip - 0.012,
    chordRoot: 0.050,
    chordTip: 0.056,
    staggerRoot: -30,
    staggerTip: -22,
    thickRoot: 0.13,
    thickTip: 0.09,
    camber: 0.13,
    sections: 4,
    z,
    phase: s * 0.08,
  });
  turbineGroup.add(rotor);
  lpRotorRings.push(rotor);
  turbineGroup.add(bladeRing({
    count: 64,
    material: MAT.structure,
    hubR: 0.272,
    tipR: tip,
    chordRoot: 0.032,
    chordTip: 0.036,
    staggerRoot: 20,
    staggerTip: 15,
    thickRoot: 0.12,
    thickTip: 0.09,
    camber: 0.10,
    sections: 3,
    z: z + 0.036,
    phase: s * 0.17,
  }));
}

// Turbine rear frame: struts that carry the bearing load into the exhaust.
for (let i = 0; i < 8; i += 1) {
  const a = (i / 8) * Math.PI * 2;
  const strut = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.110, 0.110), MAT.nickel);
  strut.position.set(Math.cos(a) * 0.330, Math.sin(a) * 0.330, 1.205);
  strut.rotation.z = a - Math.PI / 2;
  strut.castShadow = true;
  turbineGroup.add(strut);
}
wb.id(turbineGroup, 'engine-turbine');
wb.id(coreGroup, 'engine-core');

// ---- Exhaust -------------------------------------------------
const nozzleGroup = new THREE.Group();
nozzleGroup.name = 'nozzle';
engine.add(nozzleGroup);

// Core nozzle: a converging duct from the rear frame to the exit plane.
const coreNozzle = lathe([
  [0.418, 1.020],
  [0.398, 1.120],
  [0.362, 1.235],
  [0.332, Z_CORE_EXIT],
  [0.316, Z_CORE_EXIT + 0.012],
  [0.346, 1.235],
  [0.382, 1.120],
  [0.402, 1.020],
], MAT.exhaust, { segments: 128 });
nozzleGroup.add(coreNozzle);

// Exhaust plug: the centre body that fairs the last turbine stage.
const plugProfile = [
  [0.300, 1.090],
  [0.310, 1.170],
  [0.302, 1.270],
  [0.278, 1.380],
  [0.238, 1.490],
  [0.180, 1.600],
  [0.104, 1.700],
  [0.0005, Z_PLUG_TIP],
];
const plug = lathe(plugProfile, MAT.exhaust, { segments: 96 });
nozzleGroup.add(plug);

wb.id(nozzleGroup, 'engine-nozzle');

// ---- Accessories --------------------------------------------
const accessory = new THREE.Group();
accessory.name = 'accessory';
engine.add(accessory);

// Accessory gearbox hangs off the fan case at the bottom.
const gearbox = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.18, 0.40), MAT.structure);
gearbox.position.set(0, -1.02, -0.52);
gearbox.castShadow = true;
accessory.add(gearbox);

const gearboxFace = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.02, 0.32), MAT.brass);
gearboxFace.position.set(0, -1.115, -0.52);
accessory.add(gearboxFace);

// Fuel and oil lines running aft along the core.
for (let i = 0; i < 5; i += 1) {
  const a = -0.55 + i * 0.14;
  const pipe = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(Math.cos(a) * 0.50, Math.sin(a) * 0.50, -0.34),
        new THREE.Vector3(Math.cos(a) * 0.53, Math.sin(a) * 0.53, 0.10),
        new THREE.Vector3(Math.cos(a) * 0.50, Math.sin(a) * 0.50, 0.55),
        new THREE.Vector3(Math.cos(a) * 0.40, Math.sin(a) * 0.40, 0.92),
      ]),
      26,
      0.012,
      6,
      false,
    ),
    i % 2 === 0 ? MAT.brass : MAT.structure,
  );
  accessory.add(pipe);
}

// Exhaust-gas temperature probes in the turbine rear frame.
for (let i = 0; i < 6; i += 1) {
  const a = (i / 6) * Math.PI * 2 + 0.4;
  const probe = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.14, 8), MAT.nickel);
  probe.position.set(Math.cos(a) * 0.340, Math.sin(a) * 0.340, 1.090);
  probe.rotation.x = Math.PI / 2;
  accessory.add(probe);
}

// ---- Contact shadow ------------------------------------------
const contactTex = (() => {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(0,0,0,0.5)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.16)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
})();
const contact = new THREE.Mesh(
  new THREE.PlaneGeometry(6.2, 6.2),
  new THREE.MeshBasicMaterial({ map: contactTex, transparent: true, depthWrite: false }),
);
contact.rotation.x = -Math.PI / 2;
contact.position.set(0, FLOOR_Y + 0.008, 0.05);
world.add(contact);

// ------------------------------------------------------------
//  Animation: two spools. N1 (fan, booster, LP turbine) turns at
//  1x; N2 (HP compressor and HP turbine) at ~1.63x, which is the
//  visual signature of a two-spool engine. Stators never move.
// ------------------------------------------------------------
onFrame(({ time, delta }) => {
  const dt = Math.min(delta ?? 1 / 60, 0.05);
  fanGroup.rotation.z -= dt * 1.9 * Math.PI;
  for (const ring of lpRotorRings) ring.rotation.z -= dt * 1.9 * Math.PI;
  for (const ring of hpRotorRings) ring.rotation.z -= dt * 3.1 * Math.PI;

  const pulse = 0.92 + Math.sin(time * 8.5) * 0.14 + Math.sin(time * 21.0) * 0.05;
  MAT.combustor.emissiveIntensity = 1.05 * pulse;
  MAT.exhaust.emissiveIntensity = 0.32 + 0.22 * pulse;
  bounce.intensity = 18 + Math.sin(time * 3.1) * 3.0;
  inletGlow.intensity = 38 + Math.sin(time * 1.7) * 4.0;
  fanLight.intensity = 24 + Math.sin(time * 1.7 + 0.8) * 2.5;
});
