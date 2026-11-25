// ============================================================
//  《点灯人》The Lamplighter — 60 秒十镜短片
//  雾夜 · 小机器人用胸口最后一颗灯泡点亮整条街
//
//  镜头表（硬切，每镜独立机位）：
//    S1  0–5   大全景  雾夜空街，远处一个微小光点
//    S2  5–12  中景    抱着胸口的灯涉水前行
//    S3 12–20  仰拍    停在灯柱下抬头
//    S4 20–26  跟拍    沿灯柱攀爬
//    S5 26–32  特写    手滑坠落，灯闪两下
//    S6 32–38  中景    再次攀爬，把灯泡拧进灯座
//    S7 38–42  全景    第一盏灯亮，光刺破雾
//    S8 42–48  横移    光沿街传递，一排灯依次亮起
//    S9 48–54  反打    胸口光灭，坐在灯柱下成为剪影
//    S10 54–60 缓推升起 暖光漫回，灯带连成星河，标题浮现
//
//  时间轴：onFrame 的 time 就是全片绝对时间（0–60），
//  与 Film 面板导出的 capture-frame 采样时间一致。
// ============================================================

setBackground('#05070c');

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth = v => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const easeInOut = v => { const t = clamp01(v); return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- 渲染设定：电影感优先 ----------
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
scene.background = new THREE.Color(0x05070c);
scene.fog = new THREE.FogExp2(0x0d1420, 0.062);

camera.fov = 34;
camera.near = 0.1;
camera.far = 220;
camera.position.set(0, 2.2, 16);
camera.updateProjectionMatrix();
controls.enabled = false;

// ---------- 程序化贴图 ----------
function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// 水渍路面：深色沥青 + 湿反光条纹
const roadTex = canvasTexture(512, 512, (g, w, h) => {
  g.fillStyle = '#0a0e14';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i += 1) {
    const a = 0.012 + Math.random() * 0.03;
    g.fillStyle = Math.random() > 0.5 ? `rgba(120,150,190,${a})` : `rgba(0,0,0,${a * 1.6})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 40, 1 + Math.random() * 2);
  }
  for (let i = 0; i < 26; i += 1) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const r = 18 + Math.random() * 70;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(150,180,215,0.05)');
    grd.addColorStop(1, 'rgba(150,180,215,0)');
    g.fillStyle = grd;
    g.beginPath();
    g.ellipse(x, y, r * 1.9, r * 0.5, 0, 0, TAU);
    g.fill();
  }
});
roadTex.wrapS = roadTex.wrapT = THREE.RepeatWrapping;
roadTex.repeat.set(4, 22);

// 光晕贴片（灯泡 / 灯柱光斑）
const glowTex = canvasTexture(128, 128, (g, w, h) => {
  const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  grd.addColorStop(0, 'rgba(255,238,205,1)');
  grd.addColorStop(0.22, 'rgba(255,206,140,0.72)');
  grd.addColorStop(0.55, 'rgba(255,168,90,0.18)');
  grd.addColorStop(1, 'rgba(255,150,70,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, w, h);
});

// ---------- 世界 ----------
const world = new THREE.Group();
world.name = 'lamplighter';
scene.add(world);

const STREET_LEN = 96;
const STREET_HALF = 5.2;

// 地面
const road = new THREE.Mesh(
  new THREE.PlaneGeometry(STREET_HALF * 2, STREET_LEN),
  new THREE.MeshStandardMaterial({
    // Wet asphalt: dielectric-ish so the chest lamp makes a soft, wide
    // reflection instead of a hard mirror blob directly under the camera.
    map: roadTex, color: 0x1a2430, metalness: 0.22, roughness: 0.62,
    envMapIntensity: 0.5,
  }),
);
road.rotation.x = -Math.PI / 2;
road.receiveShadow = true;
world.add(road);

// 两侧人行道
for (const side of [-1, 1]) {
  const walk = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 0.16, STREET_LEN),
    new THREE.MeshStandardMaterial({ color: 0x161c25, metalness: 0.3, roughness: 0.72 }),
  );
  walk.position.set(side * (STREET_HALF + 1.2), 0.08, 0);
  walk.receiveShadow = true;
  world.add(walk);
}

// 剪影建筑：两侧错落的楼体
const buildingMat = new THREE.MeshStandardMaterial({ color: 0x080b11, metalness: 0.1, roughness: 0.95 });
let seed = 20261125;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
for (let i = 0; i < 34; i += 1) {
  const side = i % 2 === 0 ? -1 : 1;
  const h = 7 + rand() * 17;
  const d = 3 + rand() * 5;
  const w = 3.6 + rand() * 4.4;
  const z = -42 + (i / 34) * 84 + rand() * 3;
  const b = new THREE.Mesh(new THREE.BoxGeometry(d, h, w), buildingMat);
  b.position.set(side * (STREET_HALF + 3.4 + rand() * 5), h / 2, z);
  world.add(b);

  // 零星窗火：极少数亮着的窗
  if (rand() > 0.62) {
    const winMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc98a).multiplyScalar(0.7) });
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), winMat);
    win.position.set(b.position.x - side * (d / 2 + 0.02), 2 + rand() * (h - 4), z + (rand() - 0.5) * w * 0.7);
    win.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    world.add(win);
  }
}

// 远景天际线剪影
const skyline = new THREE.Group();
for (let i = 0; i < 40; i += 1) {
  const h = 6 + rand() * 26;
  const b = new THREE.Mesh(new THREE.BoxGeometry(3 + rand() * 5, h, 2 + rand() * 4), buildingMat);
  b.position.set(-60 + rand() * 120, h / 2, -52 - rand() * 26);
  skyline.add(b);
}
world.add(skyline);

// ---------- 路灯 ----------
const LAMP_COUNT = 9;
const LAMP_Z = [];
const lamps = [];
const LAMP_HEIGHT = 6.4;
const HERO_LAMP = 4;
// The hero lamp sits exactly where the robot climbs (z = -2.35), so the pole it
// scales is the pole that lights up. Neighbours space outward from it.
const HERO_LAMP_Z = -2.35;
const LAMP_X = -(STREET_HALF - 0.5);

for (let i = 0; i < LAMP_COUNT; i += 1) {
  const z = HERO_LAMP_Z + (i - HERO_LAMP) * 6.4;
  LAMP_Z.push(z);
  const group = new THREE.Group();
  group.position.set(LAMP_X, 0, z);
  world.add(group);

  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c232c, metalness: 0.85, roughness: 0.42 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.32, 0.5, 16), poleMat);
  base.position.y = 0.25;
  base.castShadow = true;
  group.add(base);

  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.13, LAMP_HEIGHT, 14), poleMat);
  pole.position.y = LAMP_HEIGHT / 2 + 0.4;
  pole.castShadow = true;
  group.add(pole);

  // 灯臂
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.9, 10), poleMat);
  arm.rotation.z = -Math.PI / 2.6;
  arm.position.set(0.34, LAMP_HEIGHT + 0.28, 0);
  group.add(arm);

  // 灯头灯罩
  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 0.34, 18, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x232b35, metalness: 0.9, roughness: 0.36, side: THREE.DoubleSide }),
  );
  shade.position.set(0.68, LAMP_HEIGHT + 0.34, 0);
  shade.castShadow = true;
  group.add(shade);

  // 灯泡（默认灭）
  const bulbMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a18, emissive: 0xffcf8f, emissiveIntensity: 0, roughness: 0.32,
  });
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 16), bulbMat);
  bulb.position.set(0.68, LAMP_HEIGHT + 0.16, 0);
  group.add(bulb);

  // 光晕贴片
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(2.6, 2.6),
    new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  halo.position.copy(bulb.position);
  group.add(halo);

  // 点光源（默认关）
  const light = new THREE.PointLight(0xffc178, 0, 26, 2);
  light.position.copy(bulb.position);
  group.add(light);

  // 落在地面/身体上的光斑
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 7.5),
    new THREE.MeshBasicMaterial({
      map: glowTex, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, color: 0xffb765,
    }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(1.2, 0.02, 0);
  group.add(pool);

  lamps.push({ group, bulb, bulbMat, halo, light, pool, lit: 0, z });
}
wb.id(lamps[HERO_LAMP].group, 'lamp-hero');

// ---------- 主角：小机器人 ----------
const robot = new THREE.Group();
robot.name = 'lamplighter';
robot.position.set(0, 0, 2.2);
world.add(robot);

const metalDark = new THREE.MeshStandardMaterial({ color: 0x2a3138, metalness: 0.88, roughness: 0.42 });
const metalLight = new THREE.MeshStandardMaterial({ color: 0x4d5865, metalness: 0.92, roughness: 0.34 });
const rubber = new THREE.MeshStandardMaterial({ color: 0x0d1116, metalness: 0.2, roughness: 0.9 });

const BODY_H = 0.62;
const BODY_R = 0.26;

const body = new THREE.Group();
body.position.y = 0.72;
robot.add(body);

const torso = new THREE.Mesh(new THREE.CapsuleGeometry(BODY_R, BODY_H - BODY_R * 2, 10, 20), metalDark);
torso.castShadow = true;
body.add(torso);

// 胸口灯座
const socketRing = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.028, 10, 24), metalLight);
socketRing.position.set(0, 0.06, BODY_R * 0.94);
body.add(socketRing);

// 胸口灯泡（角色唯一的光源）
const chestLightMat = new THREE.MeshStandardMaterial({
  color: 0x2a2018, emissive: 0xffd39a, emissiveIntensity: 3.4, roughness: 0.28,
});
const chestBulb = new THREE.Mesh(new THREE.SphereGeometry(0.088, 18, 14), chestLightMat);
chestBulb.position.set(0, 0.06, BODY_R * 0.98);
body.add(chestBulb);

const chestGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(0.95, 0.95),
  new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, opacity: 0.85, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }),
);
chestGlow.position.set(0, 0.06, BODY_R * 1.02);
body.add(chestGlow);

const chestLight = new THREE.PointLight(0xffc98d, 3.4, 6.5, 2);
chestLight.position.set(0, 0.06, BODY_R * 1.1);
body.add(chestLight);

// 头
const head = new THREE.Group();
head.position.y = 0.48;
body.add(head);
const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 16), metalLight);
skull.scale.set(1, 0.92, 0.95);
skull.castShadow = true;
head.add(skull);

// 眼睛：两条细缝，由胸口光反射点亮
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd7a3 });
for (const side of [-1, 1]) {
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.016, 0.01), eyeMat);
  eye.position.set(side * 0.062, 0.012, 0.185);
  head.add(eye);
}
const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.2, 6), metalLight);
antenna.position.set(0.05, 0.24, 0);
head.add(antenna);
const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), chestLightMat);
antennaTip.position.set(0.05, 0.34, 0);
head.add(antennaTip);

// 手臂（可摆动 / 攀爬）
function makeArm(side) {
  const shoulder = new THREE.Group();
  shoulder.position.set(side * (BODY_R + 0.03), 0.26, 0);
  body.add(shoulder);
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.2, 6, 10), metalDark);
  upper.position.y = -0.13;
  upper.castShadow = true;
  shoulder.add(upper);
  const elbow = new THREE.Group();
  elbow.position.y = -0.26;
  shoulder.add(elbow);
  const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.18, 6, 10), metalLight);
  fore.position.y = -0.12;
  fore.castShadow = true;
  elbow.add(fore);
  const hand = new THREE.Group();
  hand.position.y = -0.24;
  elbow.add(hand);
  for (let f = 0; f < 3; f += 1) {
    const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.05, 4, 6), metalDark);
    finger.position.set((f - 1) * 0.026, -0.028, 0.008);
    finger.rotation.x = 0.28;
    hand.add(finger);
  }
  return { shoulder, elbow, hand };
}
const armL = makeArm(-1);
const armR = makeArm(1);

// 腿
function makeLeg(side) {
  const hip = new THREE.Group();
  hip.position.set(side * 0.105, 0.44, 0);
  robot.add(hip);
  const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.2, 6, 10), metalDark);
  thigh.position.y = -0.14;
  thigh.castShadow = true;
  hip.add(thigh);
  const knee = new THREE.Group();
  knee.position.y = -0.28;
  hip.add(knee);
  const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.18, 6, 10), metalLight);
  shin.position.y = -0.13;
  shin.castShadow = true;
  knee.add(shin);
  const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.05, 0.19), rubber);
  foot.position.set(0, -0.25, 0.03);
  foot.castShadow = true;
  knee.add(foot);
  return { hip, knee, foot };
}
const legL = makeLeg(-1);
const legR = makeLeg(1);

// 胸口灯的湿地反光：小尺寸、低强度，贴在路面上跟随机器人水平移动
const chestPool = new THREE.Mesh(
  new THREE.PlaneGeometry(2.0, 2.0),
  new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, opacity: 0.18, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffb877,
  }),
);
chestPool.rotation.x = -Math.PI / 2;
chestPool.position.y = 0.02;
world.add(chestPool);

wb.id(robot, 'lamplighter-robot');

// ---------- 雾 / 雨丝 ----------
const fogParticles = (() => {
  const count = 1400;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    pos[i * 3] = (Math.random() - 0.5) * 46;
    pos[i * 3 + 1] = Math.random() * 14;
    pos[i * 3 + 2] = -34 + Math.random() * 60;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9fb6d4, size: 0.1, transparent: true, opacity: 0.28,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const pts = new THREE.Points(geo, mat);
  world.add(pts);
  return { pts, mat, pos };
})();

// ---------- 标题 ----------
const titleTexture = canvasTexture(1024, 512, (g, w, h) => {
  g.clearRect(0, 0, w, h);
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,236,206,0.96)';
  g.font = '600 74px Georgia, "Times New Roman", serif';
  g.fillText('The Lamplighter', w / 2, h * 0.44);
  g.fillStyle = 'rgba(255,222,180,0.62)';
  g.font = '400 30px Georgia, serif';
  g.fillText('点 灯 人', w / 2, h * 0.58);
  g.fillStyle = 'rgba(255,210,160,0.34)';
  g.font = '400 18px system-ui, sans-serif';
  g.fillText('a sixty-second night', w / 2, h * 0.68);
});
const titleMat = new THREE.MeshBasicMaterial({
  map: titleTexture, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
});
const title = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.2), titleMat);
title.position.set(0, 3.4, -18);
title.renderOrder = 10;
scene.add(title);

// ---------- 机位表 ----------
// 每镜独立机位，切换即硬切。构图围绕灯柱（x = POLE_X, z = -2.35）。
const SHOTS = [
  { id: 'S1', start: 0, end: 5, pos: V3(-2.0, 2.9, 15.5), target: V3(-4.2, 2.6, -6), fov: 40 },
  { id: 'S2', start: 5, end: 12, pos: V3(-1.35, 1.05, 1.6), target: V3(-3.4, 0.72, -3.0), fov: 34 },
  { id: 'S3', start: 12, end: 20, pos: V3(-3.0, 0.26, 1.15), target: V3(-4.55, 6.2, -2.35), fov: 48 },
  { id: 'S4', start: 20, end: 26, pos: V3(-2.05, 3.2, -0.35), target: V3(-4.35, 3.6, -2.35), fov: 40 },
  { id: 'S5', start: 26, end: 32, pos: V3(-2.05, 2.35, 1.55), target: V3(-4.5, 1.15, -2.35), fov: 40 },
  { id: 'S6', start: 32, end: 38, pos: V3(-2.15, 5.6, 0.65), target: V3(-4.05, 5.9, -2.35), fov: 36 },
  { id: 'S7', start: 38, end: 42, pos: V3(1.4, 1.9, 4.2), target: V3(-4.1, 6.0, -2.35), fov: 46 },
  { id: 'S8', start: 42, end: 48, pos: V3(4.6, 2.4, 4.6), target: V3(-4.0, 5.2, -12.5), fov: 42 },
  { id: 'S9', start: 48, end: 54, pos: V3(-2.35, 0.92, -0.55), target: V3(-4.62, 0.62, -2.35), fov: 36 },
  { id: 'S10', start: 54, end: 60, pos: V3(0.4, 1.5, 4.4), target: V3(-3.6, 2.6, -8.5), fov: 42 },
];

// ---------- 关键帧曲线：机器人位置 / 姿态 ----------
// 灯柱在世界坐标 x = LAMP_X (-4.7)、z = -2.35；灯头灯泡在 x ≈ -4.02、y ≈ 6.56。
// 机器人必须贴着这根柱子走/爬，否则会悬在半空。
const POLE_X = LAMP_X;               // -4.7
const CLIMB_X = POLE_X + 0.38;       // 贴着柱面（柱半径 + 机身半径）
const BULB_Y = LAMP_HEIGHT + 0.16;   // 6.56
const CLIMB_TOP = BULB_Y - 1.2;      // 站到这个高度，抬手正好够到灯座
const LAMP_Z_HERO = HERO_LAMP_Z;     // -2.35

const ROBOT_PATH = [
  { t: 0, p: V3(-2.4, 0, -9.6) },                                   // 远处光点
  { t: 5, p: V3(-3.0, 0, -3.4) },                                   // 走进中景
  { t: 12, p: V3(CLIMB_X + 0.22, 0, LAMP_Z_HERO) },                 // 停到灯柱下
  { t: 20, p: V3(CLIMB_X, 0, LAMP_Z_HERO) },                        // 攀爬起点（贴柱）
  { t: 26, p: V3(CLIMB_X, CLIMB_TOP * 0.46, LAMP_Z_HERO) },
  { t: 27.2, p: V3(CLIMB_X, 0.0, LAMP_Z_HERO) },                    // 坠落
  { t: 32, p: V3(CLIMB_X, 0.0, LAMP_Z_HERO) },                      // 爬起来
  { t: 38, p: V3(CLIMB_X, CLIMB_TOP, LAMP_Z_HERO) },                // 到灯座
  { t: 42, p: V3(CLIMB_X, CLIMB_TOP, LAMP_Z_HERO) },
  { t: 44, p: V3(CLIMB_X, CLIMB_TOP, LAMP_Z_HERO) },
  { t: 48, p: V3(CLIMB_X, 0, LAMP_Z_HERO) },                        // 坐回灯柱下
  { t: 54, p: V3(CLIMB_X, 0, LAMP_Z_HERO) },
  { t: 60, p: V3(CLIMB_X, 0, LAMP_Z_HERO) },
];

function robotAt(t) {
  for (let i = 0; i < ROBOT_PATH.length - 1; i += 1) {
    const a = ROBOT_PATH[i];
    const b = ROBOT_PATH[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return { p: a.p.clone().lerp(b.p, easeInOut(k)), k };
    }
  }
  return { p: ROBOT_PATH[ROBOT_PATH.length - 1].p.clone(), k: 1 };
}

// 攀爬高度（世界 y）。第二次攀爬在 36.4s 到顶，随后在 S6 内完成拧灯。
const CLIMB_REACH = 36.4;
const climbHeight = t => {
  if (t < 20) return 0;
  if (t < 26) return smooth((t - 20) / 6) * CLIMB_TOP * 0.46;
  // 手滑：从半途失手坠落
  if (t < 27.2) return lerp(CLIMB_TOP * 0.46, 0, smooth((t - 26) / 1.2));
  if (t < 32) return 0;
  if (t < CLIMB_REACH) return smooth((t - 32) / (CLIMB_REACH - 32)) * CLIMB_TOP;
  return CLIMB_TOP;
};

// 胸口灯亮度曲线：全片的情绪线
function chestIntensity(t) {
  // S1–S3：稳定微亮
  if (t < 12) return 3.1;
  // S3–S4：紧张地稳一点
  if (t < 26) return 3.0 + Math.sin(t * 2.2) * 0.12;
  // S5 坠落：闪两下，几乎熄灭
  if (t < 26.55) return 2.6;
  if (t < 26.75) return 0.15;
  if (t < 26.95) return 2.2;
  if (t < 27.15) return 0.1;
  if (t < 27.6) return 1.5;
  if (t < 32) return 1.5 + smooth((t - 27.6) / 4.4) * 1.3;
  // S6：拧进灯座，全功率输出
  if (t < 38) return 2.8 + smooth((t - 34) / 4) * 2.5;
  if (t < 40.5) return 5.3;
  // S7–S8：光被转移出去，胸口急剧衰减
  if (t < 48) return lerp(5.3, 0.35, smooth((t - 40.5) / 7.5));
  // S9：熄灭
  if (t < 54) return 0.35 * (1 - smooth((t - 48) / 2.4));
  // S10：不再点亮（暖光来自街道）
  return 0;
}

// 街道点灯时刻：S7 点亮第一盏，S8 逐盏传递
const LAMP_ORDER = [4, 3, 5, 2, 6, 1, 7, 0, 8];
const LAMP_LIGHT_TIME = [38.4, 43.0, 43.9, 44.8, 45.7, 46.5, 47.2, 47.9, 48.5];

// ---------- 每帧 ----------
const tmpVec = new THREE.Vector3();
let shakeSeed = 0;

onFrame(({ time }) => {
  const t = time % 60;

  // ---- 机位：硬切 ----
  let shot = SHOTS[SHOTS.length - 1];
  for (const s of SHOTS) {
    if (t >= s.start && t < s.end) { shot = s; break; }
  }
  camera.position.copy(shot.pos);
  camera.fov = shot.fov;
  camera.lookAt(shot.target);

  // S10 缓推升起
  if (shot.id === 'S10') {
    const k = easeInOut((t - 54) / 6);
    camera.position.x = lerp(0.4, 2.6, k);
    camera.position.y = lerp(1.5, 9.2, k);
    camera.position.z = lerp(4.4, 10.5, k);
    camera.lookAt(tmpVec.set(-3.6, lerp(2.6, 1.9, k), -8.5));
    camera.fov = lerp(42, 33, k);
  }
  // S4 跟拍：沿柱上升时轻微手持晃动
  if (shot.id === 'S4' || shot.id === 'S6') {
    const w = t * 2.4;
    camera.position.x += Math.sin(w) * 0.035;
    camera.position.y += Math.cos(w * 1.3) * 0.028;
  }
  // S5 坠落：镜头震动
  if (t >= 26.55 && t < 27.6) {
    const amp = 0.11 * (1 - (t - 26.55) / 1.05);
    shakeSeed += 1;
    camera.position.x += Math.sin(shakeSeed * 12.9) * amp;
    camera.position.y += Math.cos(shakeSeed * 17.3) * amp;
    camera.position.z += Math.sin(shakeSeed * 7.7) * amp * 0.6;
    camera.lookAt(shot.target);
  }
  camera.updateProjectionMatrix();

  // ---- 机器人 ----
  const { p } = robotAt(t);
  const h = climbHeight(t);
  const climbing = (t >= 20 && t < 26) || (t >= 32 && t < 38);
  const falling = t >= 26 && t < 27.4;
  const sitting = t >= 48;

  if (climbing) {
    robot.position.set(p.x, h, p.z);
    robot.rotation.y = Math.PI * 0.5;
    const phase = t * 5.2;
    armL.shoulder.rotation.x = -2.3 + Math.sin(phase) * 0.42;
    armR.shoulder.rotation.x = -2.3 + Math.sin(phase + Math.PI) * 0.42;
    armL.elbow.rotation.x = 0.5 + Math.cos(phase) * 0.3;
    armR.elbow.rotation.x = 0.5 + Math.cos(phase + Math.PI) * 0.3;
    legL.hip.rotation.x = -0.5 + Math.sin(phase + 0.8) * 0.34;
    legR.hip.rotation.x = -0.5 + Math.sin(phase + Math.PI + 0.8) * 0.34;
    legL.knee.rotation.x = 0.7;
    legR.knee.rotation.x = 0.7;
    robot.rotation.z = Math.sin(phase * 0.5) * 0.06;
    body.rotation.x = -0.12;
    head.rotation.x = 0.42;
  } else if (falling) {
    const k = smooth((t - 26) / 1.15);
    robot.position.set(p.x, Math.max(0.16, h), p.z);
    robot.rotation.y = Math.PI * 0.5;
    robot.rotation.z = k * 0.85;
    armL.shoulder.rotation.x = -1.4 - k * 1.6;
    armR.shoulder.rotation.x = -1.4 - k * 1.4;
    legL.hip.rotation.x = -0.9 * k;
    legR.hip.rotation.x = 0.5 * k;
    body.rotation.x = k * 0.5;
    head.rotation.x = k * 0.7;
  } else if (sitting) {
    // 坐下：身体下沉、腿前伸
    const k = smooth((t - 48) / 2.2);
    robot.position.set(p.x, lerp(0.0, -0.16, k), p.z);
    robot.rotation.y = Math.PI * 0.62;
    robot.rotation.z = 0;
    body.rotation.x = lerp(0, 0.16, k);
    head.rotation.x = lerp(0, 0.3, k);
    legL.hip.rotation.x = lerp(0, -1.35, k);
    legR.hip.rotation.x = lerp(0, -1.2, k);
    legL.knee.rotation.x = lerp(0.2, 1.5, k);
    legR.knee.rotation.x = lerp(0.2, 1.35, k);
    armL.shoulder.rotation.x = lerp(0, -0.5, k);
    armR.shoulder.rotation.x = lerp(0, -0.44, k);
    armL.elbow.rotation.x = 0.42;
    armR.elbow.rotation.x = 0.4;
  } else if (t >= 38 && t < 48) {
    // 站在灯座高度拧灯泡：右手高举
    robot.position.set(p.x, h, p.z);
    robot.rotation.y = Math.PI * 0.5;
    robot.rotation.z = 0;
    body.rotation.x = 0;
    const twist = t < 38 ? 0 : Math.sin((t - 38) * 7.5) * 0.34;
    armR.shoulder.rotation.x = -2.75;
    armR.elbow.rotation.x = 0.15 + twist * 0.2;
    armR.hand.rotation.z = twist;
    armL.shoulder.rotation.x = -0.9;
    armL.elbow.rotation.x = 0.55;
    legL.hip.rotation.x = 0.32;
    legR.hip.rotation.x = -0.28;
    legL.knee.rotation.x = 0.5;
    legR.knee.rotation.x = 0.42;
    head.rotation.x = -0.28;
  } else {
    // 走路：程序化步态
    const walking = t >= 1.2 && t < 12.4;
    robot.position.set(p.x, 0, p.z);
    robot.rotation.y = 0;
    robot.rotation.z = 0;
    if (walking) {
      const stride = t * 4.6;
      const bob = Math.abs(Math.sin(stride)) * 0.028;
      robot.position.y = bob;
      body.rotation.x = -0.13 + Math.sin(stride * 2) * 0.02;
      head.rotation.x = 0.1;
      legL.hip.rotation.x = Math.sin(stride) * 0.62;
      legR.hip.rotation.x = Math.sin(stride + Math.PI) * 0.62;
      legL.knee.rotation.x = Math.max(0, Math.sin(stride + 1.1)) * 0.85;
      legR.knee.rotation.x = Math.max(0, Math.sin(stride + Math.PI + 1.1)) * 0.85;
      armL.shoulder.rotation.x = Math.sin(stride + Math.PI) * 0.34 - 0.1;
      armR.shoulder.rotation.x = Math.sin(stride) * 0.34 - 0.1;
      armL.elbow.rotation.x = 0.36;
      armR.elbow.rotation.x = 0.36;
    } else {
      // 站立：抱着胸口的灯
      robot.position.y = 0;
      body.rotation.x = 0;
      head.rotation.x = t < 5 ? -0.15 : 0.55;
      legL.hip.rotation.x = 0;
      legR.hip.rotation.x = 0;
      legL.knee.rotation.x = 0.06;
      legR.knee.rotation.x = 0.06;
      const hug = t < 12 ? 1 : 0.5;
      armL.shoulder.rotation.x = -1.05 * hug;
      armR.shoulder.rotation.x = -1.05 * hug;
      armL.elbow.rotation.x = 1.25 * hug;
      armR.elbow.rotation.x = 1.25 * hug;
    }
  }

  // ---- 胸口灯 ----
  const intensity = chestIntensity(t);
  const norm = clamp01(intensity / 5.3);
  chestLightMat.emissiveIntensity = intensity;
  chestLight.intensity = intensity * 0.9;
  chestGlow.material.opacity = norm * 0.9;
  chestGlow.scale.setScalar(0.55 + norm * 0.7);
  // The light pool stays on the street, so it follows the robot horizontally
  // only: climbing must not lift the glow off the ground.
  chestPool.position.set(robot.position.x, 0.02, robot.position.z);
  chestPool.material.opacity = norm * 0.18;
  antennaTip.material.emissiveIntensity = Math.max(0.1, intensity * 0.7);

  // 眼睛随胸口光变暗
  const eyeLevel = 0.15 + norm * 0.85;
  for (const eye of head.children) {
    if (eye.material === eyeMat) eye.material.color.setRGB(1 * eyeLevel, 0.84 * eyeLevel, 0.64 * eyeLevel);
  }

  // ---- 路灯 ----
  for (let i = 0; i < lamps.length; i += 1) {
    const order = LAMP_ORDER.indexOf(i);
    const onAt = LAMP_LIGHT_TIME[order];
    let lit = 0;
    if (t >= onAt) {
      const age = t - onAt;
      // 起亮时的爆闪，然后稳定
      const burst = age < 0.32 ? 1 + (1 - age / 0.32) * 2.6 : 1;
      lit = smooth(age / 0.5) * burst;
      // 电流不稳的细微抖动
      lit *= 0.94 + Math.sin(t * 21 + i * 3.1) * 0.03 + Math.sin(t * 7.3 + i) * 0.03;
    }
    const lamp = lamps[i];
    lamp.bulbMat.emissiveIntensity = lit * 3.6;
    lamp.light.intensity = lit * 16;
    lamp.halo.material.opacity = Math.min(1, lit * 0.85);
    lamp.halo.scale.setScalar(1 + lit * 0.32);
    lamp.pool.material.opacity = Math.min(0.62, lit * 0.5);

    // S10 暖光漫回：全街柔和铺满
    if (t > 55.5) {
      const warm = smooth((t - 55.5) / 3.4);
      lamp.light.intensity = Math.max(lamp.light.intensity, warm * 9);
      lamp.halo.material.opacity = Math.max(lamp.halo.material.opacity, warm * 0.5);
    }
  }

  // 主灯柱的灯头正对主角，S6 拧灯时才有真正的受光
  const hero = lamps[HERO_LAMP];
  hero.light.intensity += norm * 0.05;

  // ---- 雾粒子缓慢漂移 ----
  const arr = fogParticles.pos;
  for (let i = 0; i < arr.length; i += 3) {
    arr[i + 2] += 0.014;
    if (arr[i + 2] > 32) arr[i + 2] = -34;
    arr[i] += Math.sin((t + i) * 0.12) * 0.0016;
  }
  fogParticles.pts.geometry.attributes.position.needsUpdate = true;

  // ---- S1 远处光点（机器人尚未入画时，用胸口光代替）----
  // ---- S10 标题 ----
  titleMat.opacity = smooth((t - 55.2) / 2.6) * (t > 58.8 ? 1 - smooth((t - 58.8) / 1.2) : 1);
  title.position.y = lerp(3.0, 4.1, smooth((t - 55.2) / 4));
  title.lookAt(camera.position);

  // ---- 环境光随剧情变化 ----
  const storyWarmth = t < 38 ? 0.06 : lerp(0.06, 0.42, smooth((t - 38) / 14));
  scene.fog.color.setRGB(0.05 + storyWarmth * 0.34, 0.078 + storyWarmth * 0.28, 0.125 + storyWarmth * 0.16);
  scene.fog.density = t < 38 ? 0.062 : lerp(0.062, 0.036, smooth((t - 38) / 16));
  renderer.toneMappingExposure = t < 38 ? 1.16 : lerp(1.16, 1.34, smooth((t - 38) / 18));
});
