// ============================================================
//  程序化城市 · 手绘夜景线稿
//  纸色背景 / 墨线 / 少量填色 / 线条沸腾 / 窗火 / 雾 / 飞行器
// ============================================================

setBackground('#efdfc0');

const PAPER_HEX = 0xf3ecdc;
const SKY_HEX = 0xefdfc0;
const SKY = new THREE.Color(SKY_HEX);
const PAPER = new THREE.Color(PAPER_HEX);
const INK = new THREE.Color(0x26221b);

scene.background = SKY.clone();
scene.fog = new THREE.FogExp2(SKY_HEX, 0.019);
renderer.setClearColor(SKY_HEX, 1);
renderer.toneMapping = THREE.NoToneMapping;

// ---------- 随机数 ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261030);
const vr = [mulberry32(9301), mulberry32(4187), mulberry32(77123)];
const rr = (a, b) => a + (b - a) * rand();
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------- 墨线系统：3 个抖动变体循环，形成手绘“线条沸腾” ----------
const inkPos = [[], [], []];
const inkCol = [[], [], []];
const tmpColor = new THREE.Color();

function pushSeg(v, p, q, g0, g1) {
  inkPos[v].push(p.x, p.y, p.z, q.x, q.y, q.z);
  tmpColor.copy(PAPER).lerp(INK, g0); inkCol[v].push(tmpColor.r, tmpColor.g, tmpColor.b);
  tmpColor.copy(PAPER).lerp(INK, g1); inkCol[v].push(tmpColor.r, tmpColor.g, tmpColor.b);
}

function ink(a, b, opts) {
  opts = opts || {};
  const amp = opts.amp !== undefined ? opts.amp : 0.02;
  const density = opts.density !== undefined ? opts.density : 9;
  const gray = opts.gray !== undefined ? opts.gray : 0.9;

  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  if (len < 1e-4) return;
  const n = Math.max(1, Math.min(48, Math.round(len * density)));

  const ref = Math.abs(dir.y) > len * 0.96 ? V(1, 0, 0) : V(0, 1, 0);
  const perp = new THREE.Vector3().crossVectors(dir, ref);
  if (perp.lengthSq() < 1e-8) perp.set(1, 0, 0);
  perp.normalize();
  const perp2 = new THREE.Vector3().crossVectors(dir, perp).normalize();

  for (let v = 0; v < 3; v++) {
    const rng = vr[v];
    let prevP = null, prevG = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const w = Math.sin(Math.PI * t);
      const p = a.clone().lerp(b, t);
      p.addScaledVector(perp, (rng() * 2 - 1) * amp * w);
      p.addScaledVector(perp2, (rng() * 2 - 1) * amp * 0.45 * w);
      const g = Math.max(0, Math.min(1, gray * (0.86 + rng() * 0.26)));
      if (prevP) pushSeg(v, prevP, p, prevG, g);
      prevP = p; prevG = g;
    }
  }
}

function inkPath(pts, opts) {
  for (let i = 1; i < pts.length; i++) ink(pts[i - 1], pts[i], opts);
}

// ---------- 城市数据 ----------
const city = new THREE.Group();
scene.add(city);
const windowSteady = [];
const windowFlicker = [];
const litTowers = [];

const WARM = [0xffc46a, 0xffd98f, 0xffb85c, 0xffe6b0];
const COOL = [0x9fd0c9, 0xb9d9d2];

const NX = 10, NZ = 10, SP = 1.62;

function makeBuilding(cx, cz, w, d, h) {
  // 8 个角点（顶部手工歪斜 + 轻微倾斜）
  const lean = rr(-0.05, 0.05) * h / 3;
  const leanZ = rr(-0.05, 0.05) * h / 3;
  const base = [
    V(cx - w / 2, 0, cz - d / 2),
    V(cx + w / 2, 0, cz - d / 2),
    V(cx + w / 2, 0, cz + d / 2),
    V(cx - w / 2, 0, cz + d / 2)
  ];
  const top = base.map(p => V(
    cx + (p.x - cx) * rr(0.93, 1.04) + lean + rr(-0.05, 0.05),
    h + rr(-0.07, 0.07),
    cz + (p.z - cz) * rr(0.93, 1.04) + leanZ + rr(-0.05, 0.05)
  ));

  // 少量填色：大部分留纸白，少数淡彩，高楼偶尔整栋落墨
  const pick = rand();
  let wash = -1;
  if (pick < 0.18) wash = 0x3a352c;
  else if (pick < 0.32) wash = 0x655f53;
  else if (pick < 0.46) wash = 0xd9c9ad;
  else if (pick < 0.58) wash = 0xc9d4cc;
  else if (pick < 0.65) wash = 0xc4ced4;

  if (wash === 0x3a352c) litTowers.push({ x: cx, z: cz, w, d, h });

  const baseColor = new THREE.Color(wash === -1 ? PAPER_HEX : wash);
  const pos = [], col = [];
  const cTmp = new THREE.Color();

  function quad(p0, p1, p2, p3, shade) {
    const verts = [p0, p1, p2, p0, p2, p3];
    for (let i = 0; i < 6; i++) {
      const p = verts[i];
      pos.push(p.x, p.y, p.z);
      const ty = Math.max(0, Math.min(1, p.y / Math.max(0.01, h)));
      cTmp.copy(baseColor).multiplyScalar(shade * (0.90 + 0.10 * ty));
      col.push(cTmp.r, cTmp.g, cTmp.b);
    }
  }

  quad(base[3], base[2], top[2], top[3], 1.00);
  quad(base[1], base[0], top[0], top[1], 0.93);
  quad(base[2], base[1], top[1], top[2], 0.97);
  quad(base[0], base[3], top[3], top[0], 0.86);
  quad(top[0], top[1], top[2], top[3], 1.03);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  }));
  city.add(mesh);

  // 轮廓墨线：主描 + 压力描 + 淡复描，叠出钢笔线宽
  const edges = [
    [base[0], base[1]], [base[1], base[2]], [base[2], base[3]], [base[3], base[0]],
    [top[0], top[1]], [top[1], top[2]], [top[2], top[3]], [top[3], top[0]],
    [base[0], top[0]], [base[1], top[1]], [base[2], top[2]], [base[3], top[3]]
  ];
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i][0], b = edges[i][1];
    ink(a, b, { amp: 0.02, density: 10, gray: 1.0 });
    ink(V(a.x + 0.013, a.y + 0.006, a.z + 0.013), V(b.x + 0.013, b.y + 0.006, b.z + 0.013),
      { amp: 0.026, density: 9, gray: 0.95 });
    ink(V(a.x - 0.016, a.y + 0.012, a.z + 0.007), V(b.x - 0.016, b.y + 0.012, b.z + 0.007),
      { amp: 0.036, density: 8, gray: 0.7 });
    ink(V(a.x + 0.007, a.y - 0.014, a.z - 0.016), V(b.x + 0.007, b.y - 0.014, b.z - 0.016),
      { amp: 0.045, density: 6, gray: 0.35 });
  }
  // 竖向加强
  for (let i = 0; i < 4; i++) {
    ink(base[i], top[i], { amp: 0.03, density: 10, gray: 0.75 });
  }

  // 接地线（更实，压住体块）
  for (let i = 0; i < 4; i++) {
    const a = base[i], b = base[(i + 1) % 4];
    ink(V(a.x, 0.006, a.z), V(b.x, 0.006, b.z), { amp: 0.014, density: 16, gray: 1.0 });
    ink(V(a.x + 0.02, 0.006, a.z + 0.02), V(b.x + 0.02, 0.006, b.z + 0.02),
      { amp: 0.02, density: 12, gray: 0.35 });
  }

  // 楼层横线（手绘分格）
  const floors = Math.max(2, Math.min(18, Math.round(h / 0.34)));
  const bands = Math.min(4, Math.max(1, Math.floor(floors / 3)));
  for (let k = 0; k < bands; k++) {
    const y = h * ((k + 0.5) / bands);
    ink(V(cx - w * 0.46, y, cz + d / 2 + 0.008), V(cx + w * 0.46, y, cz + d / 2 + 0.008),
      { amp: 0.01, density: 14, gray: 0.2 });
    if (rand() < 0.55) {
      ink(V(cx + w / 2 + 0.008, y, cz - d * 0.46), V(cx + w / 2 + 0.008, y, cz + d * 0.46),
        { amp: 0.01, density: 14, gray: 0.2 });
    }
  }

  // 屋顶天线 / 小水箱
  if (h > 1.3 && rand() < 0.5) {
    const ax = cx + rr(-w * 0.22, w * 0.22);
    const az = cz + rr(-d * 0.22, d * 0.22);
    const tip = V(ax + rr(-0.06, 0.06), h + rr(0.32, 0.9), az + rr(-0.06, 0.06));
    ink(V(ax, h - 0.02, az), tip, { amp: 0.016, density: 15, gray: 0.95 });
    ink(V(tip.x - 0.17, tip.y - 0.07, tip.z), V(tip.x + 0.17, tip.y - 0.07, tip.z),
      { amp: 0.012, density: 18, gray: 0.8 });
    ink(V(ax, h + 0.04, az), V(tip.x, tip.y - 0.03, tip.z), { amp: 0.01, density: 22, gray: 0.3 });
  }
  if (h > 1.7 && rand() < 0.3) {
    const tx = cx + rr(-w * 0.2, w * 0.2), tz = cz + rr(-d * 0.2, d * 0.2);
    const tw = rr(0.16, 0.28), th = rr(0.14, 0.24);
    const b4 = [V(tx - tw / 2, h, tz - tw / 2), V(tx + tw / 2, h, tz - tw / 2),
                V(tx + tw / 2, h, tz + tw / 2), V(tx - tw / 2, h, tz + tw / 2)];
    const t4 = b4.map(p => V(p.x, h + th, p.z));
    const tankEdges = [
      [b4[0], b4[1]], [b4[1], b4[2]], [b4[2], b4[3]], [b4[3], b4[0]],
      [t4[0], t4[1]], [t4[1], t4[2]], [t4[2], t4[3]], [t4[3], t4[0]],
      [b4[0], t4[0]], [b4[1], t4[1]], [b4[2], t4[2]], [b4[3], t4[3]]
    ];
    for (let i = 0; i < tankEdges.length; i++) {
      ink(tankEdges[i][0], tankEdges[i][1], { amp: 0.012, density: 18, gray: 0.65 });
    }
  }

  // 尖顶塔楼
  let spireApex = null;
  if (h > 2.2 && rand() < 0.2) {
    spireApex = V(cx + rr(-0.08, 0.08), h + rr(0.6, 1.4), cz + rr(-0.08, 0.08));
    const sp = [], sc = [];
    const spireBase = baseColor.clone();
    for (let i = 0; i < 4; i++) {
      const p0 = top[i], p1 = top[(i + 1) % 4];
      const verts = [p0, p1, spireApex];
      const shade = i % 2 === 0 ? 0.84 : 0.94;
      for (let k = 0; k < 3; k++) {
        sp.push(verts[k].x, verts[k].y, verts[k].z);
        cTmp.copy(spireBase).multiplyScalar(shade);
        sc.push(cTmp.r, cTmp.g, cTmp.b);
      }
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    const sm = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
    }));
    city.add(sm);

    for (let i = 0; i < 4; i++) {
      ink(top[i], spireApex, { amp: 0.018, density: 12, gray: 1.0 });
      ink(V(top[i].x + 0.012, top[i].y, top[i].z + 0.012),
          V(spireApex.x + 0.012, spireApex.y, spireApex.z + 0.012),
          { amp: 0.028, density: 8, gray: 0.35 });
    }
    const tip = V(spireApex.x + rr(-0.04, 0.04), spireApex.y + rr(0.25, 0.55), spireApex.z + rr(-0.04, 0.04));
    ink(spireApex, tip, { amp: 0.008, density: 24, gray: 0.9 });
    windowFlicker.push({ x: tip.x, y: tip.y + 0.02, z: tip.z, color: new THREE.Color(0xff6f45) });
  }

  // 窗火（世界坐标点）
  const faces = [
    { nx: 0, nz: 1, span: w, isX: false, off: d / 2 },
    { nx: 0, nz: -1, span: w, isX: false, off: -d / 2 },
    { nx: 1, nz: 0, span: d, isX: true, off: w / 2 },
    { nx: -1, nz: 0, span: d, isX: true, off: -w / 2 }
  ];
  const litProb = wash === 0x3a352c ? 0.85 : (wash === 0x655f53 ? 0.7 : 0.58);
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const cols = Math.max(3, Math.min(7, Math.round(f.span / 0.24)));
    const litCol = (rand() * cols) | 0;
    for (let fl = 0; fl < floors; fl++) {
      const wy = h * ((fl + 0.62) / floors);
      if (wy > h - 0.06) continue;
      for (let c = 0; c < cols; c++) {
        if (c !== litCol && rand() > litProb) continue;
        const u = ((c + 0.5) / cols - 0.5) * f.span * 0.88;
        const colHex = rand() < 0.88
          ? WARM[(rand() * WARM.length) | 0]
          : COOL[(rand() * COOL.length) | 0];
        const x = cx + (f.isX ? f.off + f.nx * 0.03 : u);
        const z = cz + (f.isX ? u : f.off + f.nz * 0.03);
        const item = {
          x: x, y: wy, z: z,
          color: new THREE.Color(colHex).multiplyScalar(rr(0.9, 1.0))
        };
        if (rand() < 0.16) windowFlicker.push(item); else windowSteady.push(item);
      }
    }
  }

  // 楼脚排线
  const hx = cx + rr(-w * 0.3, w * 0.3);
  const hz = cz + d / 2 + 0.02;
  for (let i = 0; i < 4; i++) {
    const a = V(hx + (i - 1) * 0.07, 0.012, hz + 0.02);
    ink(a, V(a.x + rr(-0.14, 0.14), 0.012, hz + rr(0.10, 0.26)),
      { amp: 0.008, density: 26, gray: 0.4 });
  }
}

// 外围低矮、中心高耸
for (let ix = 0; ix < NX; ix++) {
  for (let iz = 0; iz < NZ; iz++) {
    if (rand() < 0.12) continue;
    const gx = (ix - (NX - 1) / 2) * SP + rr(-0.16, 0.16);
    const gz = (iz - (NZ - 1) / 2) * SP + rr(-0.16, 0.16);
    const dist = Math.sqrt(gx * gx + gz * gz);
    const t = Math.max(0, 1 - dist / 7.6);
    const w = rr(0.5, 1.08);
    const d = rr(0.5, 1.08);
    let h = rr(0.55, 1.35) + Math.pow(t, 1.6) * rr(2.0, 4.6);
    if (t > 0.55 && rand() < 0.14) h += rr(0.6, 1.6);
    makeBuilding(gx, gz, w, d, h);
  }
}

const lampTips = [];

// ---------- 环形道路与路灯 ----------
(function ringRoad() {
  for (let pass = 0; pass < 3; pass++) {
    const R = pass === 2 ? 7.55 : 8.0 + pass * 0.32;
    const pts = [];
    const N = 96;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const r = R + Math.sin(a * 7) * 0.06 + (rand() - 0.5) * 0.04;
      pts.push(V(Math.cos(a) * r, 0.012, Math.sin(a) * r));
    }
    inkPath(pts, { amp: 0.025, density: 10, gray: pass === 0 ? 0.5 : (pass === 1 ? 0.2 : 0.26) });
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2 + rr(-0.05, 0.05);
    const r = rr(8.05, 8.55);
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r;
    const lh = rr(0.8, 1.25);
    const tip = V(lx + rr(-0.06, 0.06), lh, lz + rr(-0.06, 0.06));
    ink(V(lx, 0, lz), tip, { amp: 0.008, density: 24, gray: 0.85 });
    ink(V(tip.x - 0.11, tip.y - 0.025, tip.z), V(tip.x + 0.02, tip.y, tip.z),
      { amp: 0.006, density: 30, gray: 0.55 });
    windowSteady.push({ x: tip.x + 0.01, y: tip.y + 0.04, z: tip.z, color: new THREE.Color(0xffcf8a) });
    lampTips.push(tip.clone());
  }
})();

// 环外的排线（铺地/荒草）
for (let i = 0; i < 74; i++) {
  const a = (i / 74) * Math.PI * 2 + rr(-0.03, 0.03);
  const r0 = rr(8.55, 8.74);
  const r1 = r0 + rr(0.12, 0.3);
  const x0 = Math.cos(a) * r0, z0 = Math.sin(a) * r0;
  const x1 = Math.cos(a) * r1, z1 = Math.sin(a) * r1;
  ink(V(x0, 0.012, z0), V(x1 + rr(-0.15, 0.15), 0.012, z1 + rr(-0.15, 0.15)),
    { amp: 0.01, density: 26, gray: i % 3 === 0 ? 0.4 : 0.24 });
}

// 水面波纹
for (let ring = 0; ring < 9; ring++) {
  const R = 9.4 + ring * 1.5;
  const N = 70;
  for (let i = 0; i < N; i++) {
    if (rand() < 0.32) continue;
    const a0 = (i / N) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2 / N) * rr(0.45, 1.1);
    const r0 = R + rr(-0.08, 0.08);
    const r1 = R + rr(-0.08, 0.08);
    ink(V(Math.cos(a0) * r0, -0.045, Math.sin(a0) * r0),
        V(Math.cos(a1) * r1, -0.045, Math.sin(a1) * r1),
        { amp: 0.02, density: 9, gray: rr(0.22, 0.42) });
  }
}
for (let i = 0; i < 90; i++) {
  const a = rand() * Math.PI * 2;
  const r0 = rr(9.1, 20);
  const len = rr(0.12, 0.5);
  const x0 = Math.cos(a) * r0, z0 = Math.sin(a) * r0;
  ink(V(x0, -0.044, z0),
      V(Math.cos(a) * (r0 + len) + rr(-0.08, 0.08), -0.044, Math.sin(a) * (r0 + len) + rr(-0.08, 0.08)),
      { amp: 0.008, density: 24, gray: rr(0.24, 0.42) });
}

// 水面暖光反射
const reflectGeo = new THREE.BufferGeometry();
const rp = [], rc = [];
const reflCol = new THREE.Color(0xffc06a);
for (let i = 0; i < 150; i++) {
  const a = rand() * Math.PI * 2;
  const r0 = rr(8.85, 12.5);
  const len = rr(0.25, 1.0);
  const x0 = Math.cos(a) * r0, z0 = Math.sin(a) * r0;
  const x1 = Math.cos(a) * (r0 + len), z1 = Math.sin(a) * (r0 + len);
  rp.push(x0, -0.03, z0, x1, -0.03, z1);
  const k = rr(0.35, 1.0);
  rc.push(reflCol.r * k, reflCol.g * k, reflCol.b * k, reflCol.r * k, reflCol.g * k, reflCol.b * k);
}
reflectGeo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
reflectGeo.setAttribute('color', new THREE.Float32BufferAttribute(rc, 3));
const reflections = new THREE.LineSegments(reflectGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, opacity: 0.75,
  blending: THREE.AdditiveBlending, depthWrite: false, fog: true
}));
reflections.renderOrder = 2;
scene.add(reflections);



// ---------- 远景剪影（只有墨线，被雾冲淡） ----------
for (let i = 0; i < 84; i++) {
  const ang = (i / 56) * Math.PI * 2 + rr(-0.04, 0.04);
  const rad = rr(22, 31);
  const sx = Math.sin(ang) * rad;
  const sz = Math.cos(ang) * rad;
  const w = rr(0.8, 2.6), d = rr(0.8, 2.6), h = rr(0.7, 4.4);
  const b = [
    V(sx - w / 2, 0, sz - d / 2), V(sx + w / 2, 0, sz - d / 2),
    V(sx + w / 2, 0, sz + d / 2), V(sx - w / 2, 0, sz + d / 2)
  ];
  const tp = b.map(p => V(p.x + rr(-0.08, 0.08), h + rr(-0.08, 0.08), p.z + rr(-0.08, 0.08)));
  const es = [
    [b[0], b[1]], [b[1], b[2]], [b[2], b[3]], [b[3], b[0]],
    [tp[0], tp[1]], [tp[1], tp[2]], [tp[2], tp[3]], [tp[3], tp[0]],
    [b[0], tp[0]], [b[1], tp[1]], [b[2], tp[2]], [b[3], tp[3]]
  ];
  for (let k = 0; k < es.length; k++) {
    ink(es[k][0], es[k][1], { amp: 0.05, density: 5, gray: 0.34 });
  }
  // 远景灯点
  if (rand() < 0.7) {
    const lx = sx + rr(-w * 0.35, w * 0.35);
    const lz = sz + (rand() < 0.5 ? d / 2 + 0.02 : -d / 2 - 0.02);
    const ly = rr(0.5, Math.max(0.6, h - 0.3));
    windowFlicker.push({ x: lx, y: ly, z: lz, color: new THREE.Color(0xffc46a) });
  }
}

// ---------- 地面：城市岛 + 水面 ----------
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(240, 240),
  new THREE.MeshBasicMaterial({ color: 0xacb4a9 })
);
water.rotation.x = -Math.PI / 2;
water.position.y = -0.09;
scene.add(water);

const ISLAND_R = 8.8;
const island = new THREE.Mesh(
  new THREE.CircleGeometry(ISLAND_R, 96),
  new THREE.MeshBasicMaterial({ color: 0xcdbd9f })
);
island.rotation.x = -Math.PI / 2;
island.position.y = -0.02;
scene.add(island);

// 岸线
for (let pass = 0; pass < 2; pass++) {
  const pts = [];
  const N = 110;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = ISLAND_R + 0.02 + pass * 0.06 + Math.sin(a * 9) * 0.025 + (rand() - 0.5) * 0.03;
    pts.push(V(Math.cos(a) * r, 0.005, Math.sin(a) * r));
  }
  inkPath(pts, { amp: 0.015, density: 8, gray: pass === 0 ? 0.8 : 0.3 });
}

// 纸质天空：低处暖、高处冷，给夜一点层次
const skyTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = 8; cv.height = 256;
  const ctx = cv.getContext('2d');
  const grd = ctx.createLinearGradient(0, 256, 0, 0);
  grd.addColorStop(0, '#efdfc0');
  grd.addColorStop(0.28, '#f2ddb4');
  grd.addColorStop(0.33, '#d8cbaf');
  grd.addColorStop(0.40, '#aaa9a1');
  grd.addColorStop(0.50, '#8b9494');
  grd.addColorStop(1, '#6d777a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 8, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
const skyDome = new THREE.Mesh(
  new THREE.CylinderGeometry(72, 72, 130, 48, 1, true),
  new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false })
);
skyDome.position.y = 32;
skyDome.renderOrder = -10;
scene.add(skyDome);

// 街道
for (let i = 0; i <= 11; i++) {
  const p = (i - 5.5) * SP;
  ink(V(p, 0.008, -9.0), V(p, 0.008, 9.0), { amp: 0.06, density: 2.2, gray: 0.26 });
  ink(V(-9.0, 0.008, p), V(9.0, 0.008, p), { amp: 0.06, density: 2.2, gray: 0.26 });
}

// ---------- 光晕贴图 ----------
const glowTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.20, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.52, 'rgba(255,255,255,0.30)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

const shoreGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(36, 36),
  new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffb060, transparent: true, opacity: 0.16,
    depthWrite: false, blending: THREE.AdditiveBlending
  })
);
shoreGlow.rotation.x = -Math.PI / 2;
shoreGlow.position.y = -0.055;
shoreGlow.renderOrder = 1;
scene.add(shoreGlow);

// 路灯暖光
for (let i = 0; i < lampTips.length; i++) {
  const t = lampTips[i];
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffbe72, transparent: true, opacity: 0.5, depthWrite: false
  }));
  halo.scale.setScalar(0.55);
  halo.position.set(t.x + 0.01, t.y + 0.05, t.z);
  scene.add(halo);
}

// 地面暖光池
for (let i = 0; i < litTowers.length; i++) {
  const t = litTowers[i];
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: glowTex, color: 0xffb15a, transparent: true, opacity: 0.16,
      depthWrite: false, blending: THREE.AdditiveBlending
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(t.x, 0.03, t.z);
  pool.scale.set(t.w * 4.5, t.d * 4.5, 1);
  pool.renderOrder = 2;
  scene.add(pool);
}

// 楼底接触阴影（让体块坐在地上）
for (let i = 0; i < 0; i++) {
  // 占位：阴影在楼体生成时直接收集于 city 阴影组
}

const cityGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xffa552, transparent: true, opacity: 0.07,
    depthWrite: false, blending: THREE.AdditiveBlending
  })
);
cityGlow.rotation.x = -Math.PI / 2;
cityGlow.position.set(0, 0.018, 0);
cityGlow.scale.set(30, 30, 1);
cityGlow.renderOrder = 1;
scene.add(cityGlow);

// ---------- 窗火 Points ----------
function pointsGeometry(list) {
  const n = list.length;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const e = list[i];
    pos[i * 3] = e.x; pos[i * 3 + 1] = e.y; pos[i * 3 + 2] = e.z;
    col[i * 3] = e.color.r; col[i * 3 + 1] = e.color.g; col[i * 3 + 2] = e.color.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const steadyGeo = pointsGeometry(windowSteady);
const steadyMat = new THREE.PointsMaterial({
  size: 0.205, map: glowTex, vertexColors: true, transparent: true,
  opacity: 0.95, depthWrite: false, sizeAttenuation: true, alphaTest: 0.01
});
const steady = new THREE.Points(steadyGeo, steadyMat);
steady.renderOrder = 4;
scene.add(steady);

const haloMat = new THREE.PointsMaterial({
  size: 0.78, map: glowTex, vertexColors: true, transparent: true,
  opacity: 0.17, depthWrite: false, sizeAttenuation: true, alphaTest: 0.005
});
const halo = new THREE.Points(steadyGeo, haloMat);
halo.renderOrder = 3;
scene.add(halo);

const flickerGeo = pointsGeometry(windowFlicker);
const flickerMat = new THREE.PointsMaterial({
  size: 0.22, map: glowTex, vertexColors: true, transparent: true,
  opacity: 0.9, depthWrite: false, sizeAttenuation: true, alphaTest: 0.01
});
const flickerPoints = new THREE.Points(flickerGeo, flickerMat);
flickerPoints.renderOrder = 5;
scene.add(flickerPoints);

// ---------- 月亮（手绘新月，始终面向镜头） ----------
const moonGroup = new THREE.Group();
moonGroup.position.set(-8.7, 8.7, -12);
scene.add(moonGroup);
const MOON_R = 1.8;
const cutR = MOON_R * 0.82;
const cutD = MOON_R * 0.45;
const ix = (cutD * cutD + MOON_R * MOON_R - cutR * cutR) / (2 * cutD);
const iy = Math.sqrt(Math.max(0, MOON_R * MOON_R - ix * ix));
const outerA = Math.atan2(iy, ix);
const innerA = Math.atan2(iy, ix - cutD);

const outerArc = [];
const innerArc = [];
const contour = [];
for (let i = 0; i <= 48; i++) {
  const a = outerA + (Math.PI * 2 - 2 * outerA) * (i / 48);
  outerArc.push(new THREE.Vector2(Math.cos(a) * MOON_R, Math.sin(a) * MOON_R));
}
for (let i = 0; i <= 36; i++) {
  const a = (Math.PI * 2 - innerA) + (innerA - (Math.PI * 2 - innerA)) * (i / 36);
  innerArc.push(new THREE.Vector2(cutD + Math.cos(a) * cutR, Math.sin(a) * cutR));
}
for (let i = 0; i < outerArc.length - 1; i++) contour.push(outerArc[i]);
for (let i = 1; i < innerArc.length - 1; i++) contour.push(innerArc[i]);

const tris = THREE.ShapeUtils.triangulateShape(contour, []);
const cPos = [];
for (let i = 0; i < tris.length; i++) {
  const t = tris[i];
  for (let k = 0; k < 3; k++) {
    const p = contour[t[k]];
    cPos.push(p.x, p.y, 0);
  }
}
const crescentGeo = new THREE.BufferGeometry();
crescentGeo.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
const crescent = new THREE.Mesh(crescentGeo, new THREE.MeshBasicMaterial({
  color: 0xfdf7e8, side: THREE.DoubleSide, fog: false
}));
moonGroup.add(crescent);

function arcLine(pts, opacity, width) {
  const geo = new THREE.BufferGeometry().setFromPoints(
    pts.map(p => V(p.x, p.y, 0.02))
  );
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: 0x2f2a21, transparent: true, opacity: opacity, fog: false
  }));
  moonGroup.add(line);
  return line;
}
arcLine(outerArc, 0.9);
arcLine(innerArc, 0.8);

// 淡淡的整圆辅助线
const guide = new THREE.LineSegments(
  new THREE.BufferGeometry().setFromPoints(
    (() => {
      const pts = [];
      for (let i = 0; i < 72; i++) {
        const a0 = (i / 72) * Math.PI * 2, a1 = ((i + 1) / 72) * Math.PI * 2;
        pts.push(V(Math.cos(a0) * MOON_R, Math.sin(a0) * MOON_R, 0.01));
        pts.push(V(Math.cos(a1) * MOON_R, Math.sin(a1) * MOON_R, 0.01));
      }
      return pts;
    })()
  ),
  new THREE.LineBasicMaterial({ color: 0x6b6250, transparent: true, opacity: 0.16, fog: false })
);
moonGroup.add(guide);

// 月晕
const moonGlowPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(MOON_R * 6.4, MOON_R * 6.4),
  new THREE.MeshBasicMaterial({
    map: glowTex, color: 0xfff2d8, transparent: true, opacity: 0.14,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false
  })
);
moonGlowPlane.position.z = -0.03;
moonGlowPlane.renderOrder = 1;
moonGroup.add(moonGlowPlane);

// ---------- 星星 & 云 ----------
for (let i = 0; i < 84; i++) {
  const ang = rand() * Math.PI * 2;
  const rad = rr(24, 32);
  const sx = Math.sin(ang) * rad;
  const sz = Math.cos(ang) * rad;
  const sy = rr(9.5, 16.5);
  const s = rr(0.16, 0.36);
  ink(V(sx - s, sy, sz), V(sx + s, sy, sz), { amp: 0.006, density: 30, gray: 0.85 });
  ink(V(sx, sy - s, sz), V(sx, sy + s, sz), { amp: 0.006, density: 30, gray: 0.85 });
}

function cloud(cx, cy, cz, width, gray) {
  const pts = [];
  const n = 30;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = cx + (t - 0.5) * width;
    const y = cy + Math.sin(t * Math.PI * 3 + 0.6) * 0.12 + Math.sin(t * 11) * 0.045;
    const z = cz + Math.sin(t * 4) * 0.2;
    pts.push(V(x, y, z));
  }
  inkPath(pts, { amp: 0.02, density: 14, gray: gray });
}
cloud(5.5, 8.4, -13, 4.6, 0.26);
cloud(-2.5, 10.8, -17, 5.8, 0.18);

// ---------- 环路上的车灯 ----------
const cars = [];
for (let i = 0; i < 6; i++) {
  const g = new THREE.Group();

  const head = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffe0a8, transparent: true, opacity: 0.9, depthWrite: false
  }));
  head.scale.setScalar(0.2);
  head.position.x = 0.12;
  g.add(head);

  const tail = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xff5a3a, transparent: true, opacity: 0.8, depthWrite: false
  }));
  tail.scale.setScalar(0.12);
  tail.position.x = -0.12;
  g.add(tail);

  const bodyGeo = new THREE.BufferGeometry().setFromPoints([
    V(0.14, 0, 0.05), V(-0.14, 0, 0.05),
    V(-0.14, 0, 0.05), V(-0.14, 0, -0.05),
    V(-0.14, 0, -0.05), V(0.14, 0, -0.05),
    V(0.14, 0, -0.05), V(0.14, 0, 0.05)
  ]);
  const body = new THREE.LineSegments(bodyGeo, new THREE.LineBasicMaterial({
    color: 0x2f281f, transparent: true, opacity: 0.5
  }));
  body.position.y = 0.03;
  g.add(body);

  scene.add(g);
  cars.push({
    g: g, head: head, tail: tail,
    radius: rr(8.0, 8.35),
    speed: rr(0.07, 0.16) * (rand() < 0.5 ? 1 : -1),
    phase: rand() * Math.PI * 2,
  });
}

// ---------- 飞行器 ----------
const crafts = [];
const craftGlowMat = new THREE.SpriteMaterial({
  map: glowTex, color: 0xffb257, transparent: true, opacity: 0.85, depthWrite: false
});
const craftCoreMat = new THREE.SpriteMaterial({
  map: glowTex, color: 0xfff4d6, transparent: true, opacity: 1, depthWrite: false
});
const blinkMatBase = new THREE.SpriteMaterial({
  map: glowTex, color: 0xff6a4a, transparent: true, opacity: 0.9, depthWrite: false
});

for (let i = 0; i < 7; i++) {
  const g = new THREE.Group();

  const glow = new THREE.Sprite(craftGlowMat.clone());
  glow.scale.setScalar(rr(0.30, 0.46));
  g.add(glow);

  const core = new THREE.Sprite(craftCoreMat.clone());
  core.scale.setScalar(0.13);
  core.position.y = 0.03;
  g.add(core);

  const blink = new THREE.Sprite(blinkMatBase.clone());
  blink.scale.setScalar(0.12);
  blink.position.set(-0.18, 0.02, 0);
  g.add(blink);

  const triGeo = new THREE.BufferGeometry().setFromPoints([
    V(0.13, 0, 0.06), V(-0.06, 0, 0.13),
    V(-0.06, 0, 0.13), V(-0.06, 0, -0.13),
    V(-0.06, 0, -0.13), V(0.13, 0, 0.06)
  ]);
  const tri = new THREE.LineSegments(triGeo, new THREE.LineBasicMaterial({
    color: 0x3a3127, transparent: true, opacity: 0.4
  }));
  tri.position.y = 0.01;
  g.add(tri);

  const trailPts = [];
  for (let k = 0; k < 3; k++) {
    const x0 = -0.3 - k * 0.2;
    trailPts.push(V(x0, 0, 0), V(x0 - 0.09, 0, 0));
  }
  const trailGeo = new THREE.BufferGeometry().setFromPoints(trailPts);
  const trail = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({
    color: 0x6b6152, transparent: true, opacity: 0.45
  }));
  g.add(trail);

  scene.add(g);
  crafts.push({
    g: g, glow: glow, blink: blink,
    radius: rr(4.8, 7.6),
    h: rr(6.1, 8.6),
    speed: rr(0.045, 0.11) * (rand() < 0.4 ? -1 : 1),
    scale: rr(0.8, 1.35),
    phase: rand() * Math.PI * 2,
    bob: rr(0.1, 0.35)
  });
}

// ---------- 飞鸟（墨色 V 字，朝向镜头） ----------
const birds = [];
const birdMat = new THREE.LineBasicMaterial({ color: 0x2c2720, transparent: true, opacity: 0.6 });
for (let i = 0; i < 7; i++) {
  const g = new THREE.Group();
  const wl = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(0.22, 0.03, 0)]), birdMat);
  const wr = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, 0, 0), V(-0.22, 0.03, 0)]), birdMat);
  g.add(wl, wr);
  scene.add(g);
  birds.push({
    g: g, wl: wl, wr: wr,
    radius: rr(3.6, 8.2),
    h: rr(6.0, 8.4),
    speed: rr(0.012, 0.035),
    phase: rand() * Math.PI * 2,
    flap: rr(4.5, 7.5)
  });
}

// ---------- 墨线网格生成 ----------
const inkMeshes = [];
for (let v = 0; v < 3; v++) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(inkPos[v], 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(inkCol[v], 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 3;
  scene.add(lines);
  inkMeshes.push(lines);
}

// ---------- 纸纹 + 暗角（贴在相机上） ----------
function makePaperOverlay() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const ctx = cv.getContext('2d');
  for (let i = 0; i < 1100; i++) {
    const x = Math.random() * 512, y = Math.random() * 512;
    const len = 1 + Math.random() * 9;
    ctx.strokeStyle = 'rgba(92,80,60,' + (0.015 + Math.random() * 0.045) + ')';
    ctx.lineWidth = 0.7 + Math.random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (Math.random() - 0.5) * 2.5);
    ctx.stroke();
  }
  for (let i = 0; i < 1600; i++) {
    ctx.fillStyle = 'rgba(70,60,45,' + (0.02 + Math.random() * 0.06) + ')';
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
  }
  const grd = ctx.createRadialGradient(256, 256, 150, 256, 256, 360);
  grd.addColorStop(0, 'rgba(70,58,40,0)');
  grd.addColorStop(0.62, 'rgba(70,58,40,0.03)');
  grd.addColorStop(1, 'rgba(70,58,40,0.32)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const overlay = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({
    map: makePaperOverlay(),
    transparent: true,
    opacity: 0.5,
    depthTest: false,
    depthWrite: false,
    fog: false
  })
);
overlay.position.z = -1;
overlay.renderOrder = 999;
overlay.frustumCulled = false;
camera.add(overlay);
scene.add(camera);

// ---------- 相机 ----------
camera.fov = 52;
camera.position.set(0, 4.6, 18);
camera.updateProjectionMatrix();

controls.target.set(0, 3.4, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.6;
controls.minDistance = 12;
controls.maxDistance = 26;
controls.minPolarAngle = 0.8;
controls.maxPolarAngle = 1.53;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.55;
controls.update();

// ---------- 动画 ----------
let lastBoil = -1;

onFrame((frame) => {
  const time = frame.time;
  const cam = frame.camera;

  // 线条沸腾（每 0.17s 换一张抖动变体）
  const b = Math.floor(time / 0.17);
  if (b !== lastBoil) {
    lastBoil = b;
    const active = b % 3;
    for (let i = 0; i < 3; i++) inkMeshes[i].visible = (i === active);
  }

  // 窗火呼吸
  flickerMat.opacity = 0.35 + 0.6 * (0.5 + 0.5 * Math.sin(time * 2.3 + 0.7));
  haloMat.opacity = 0.085 + 0.02 * Math.sin(time * 0.9);

  // 车灯
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const a = car.phase + time * car.speed;
    const x = Math.cos(a) * car.radius;
    const z = Math.sin(a) * car.radius;
    car.g.position.set(x, 0.1, z);
    const vx = -Math.sin(a) * car.speed;
    const vz = Math.cos(a) * car.speed;
    car.g.rotation.y = Math.atan2(-vz, vx);
    car.head.material.opacity = 0.8 + 0.15 * Math.sin(time * 6 + car.phase);
  }

  // 飞行器
  for (let i = 0; i < crafts.length; i++) {
    const c = crafts[i];
    const a = c.phase + time * c.speed;
    const x = Math.cos(a) * c.radius;
    const z = Math.sin(a) * c.radius;
    const y = c.h + Math.sin(time * 0.55 + c.phase * 2.1) * c.bob;
    c.g.position.set(x, y, z);
    const vx = -Math.sin(a) * c.speed;
    const vz = Math.cos(a) * c.speed;
    c.g.rotation.y = Math.atan2(-vz, vx);
    c.g.scale.setScalar(c.scale);
    c.glow.material.opacity = 0.6 + 0.25 * Math.sin(time * 1.7 + c.phase * 3.0);
    c.blink.material.opacity = (Math.sin(time * 3.4 + c.phase * 5.0) > 0.15) ? 0.95 : 0.05;
  }

  // 飞鸟
  for (let i = 0; i < birds.length; i++) {
    const bd = birds[i];
    const a = bd.phase + time * bd.speed;
    const x = Math.cos(a) * bd.radius;
    const z = Math.sin(a) * bd.radius;
    const y = bd.h + Math.sin(time * 0.6 + bd.phase) * 0.4;
    bd.g.position.set(x, y, z);
    bd.g.rotation.y = Math.atan2(cam.position.x - x, cam.position.z - z);
    const flap = Math.sin(time * bd.flap + bd.phase) * 0.55;
    bd.wl.rotation.z = flap;
    bd.wr.rotation.z = -flap;
  }

  // 月亮面向镜头
  moonGroup.lookAt(cam.position);

  // 纸纹铺满视野
  const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
  overlay.scale.set(2 * halfH * cam.aspect * 1.02, 2 * halfH * 1.02, 1);

  // 极轻微的画面摇晃（手绘感）
  cam.up.set(Math.sin(time * 0.21) * 0.035, 1, 0);
});
