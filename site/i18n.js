/**
 * Tiny bilingual layer for the static demo gallery.
 * Default language is English; the header toggle switches to Chinese and
 * reloads so page-specific dynamic labels are rebuilt from `t()`.
 * Append `?lang=en` or `?lang=zh` to force a language and remember it.
 */
const EN = {
  // Shared
  '导航': 'Navigation',
  '拖动旋转 · 滚轮缩放': 'Drag to rotate · Scroll to zoom',
  '暂停': 'Pause',
  '继续': 'Resume',
  '重置视角': 'Reset view',
  '做同款动效': 'Make this motion',
  '做同款可视化': 'Make this visualizer',
  '做同款数据页': 'Make this data page',
  '做同款空间': 'Make this space',
  '预约同款页面': 'Book this page',
  '预约同款配置器': 'Book this configurator',
  '预约工作坊': 'Book a workshop',
  '预约名额': 'Book a seat',
  '聊聊你的项目': 'Discuss your project',
  '打开 demo': 'Open demo',
  'Demo 列表': 'Demo list',
  'Demo 导航': 'Demo navigation',
  '联系': 'Contact',
  '交付': 'Delivery',
  '工作坊': 'Workshop',
  '代码': 'Code',
  '课程步骤': 'Lesson steps',
  '课程导航': 'Lesson navigation',
  '材质': 'Material',
  '灯罩': 'Shade',
  '光色': 'Light',
  '速度': 'Speed',
  '动画速度': 'Animation speed',
  '选择材质': 'Choose material',
  '选择灯体材质': 'Choose body finish',
  '选择灯罩形状': 'Choose shade shape',
  '选择色温': 'Choose color temperature',
  '选择表款配色': 'Choose watch color',
  '选择数据集': 'Choose dataset',
  '数据集控制': 'Dataset controls',
  '配置器选项': 'Configurator options',
  '配置项导航': 'Option navigation',
  '雕塑控制': 'Sculpture controls',
  '星云控制': 'Nebula controls',
  '音频控制': 'Audio controls',
  '空间漫游控制': 'Walkthrough controls',
  '选择声音来源': 'Choose an audio source',
  '上一步': 'Previous',
  '下一步': 'Next',
  '下一步 →': 'Next →',
  '已完成': 'Complete',
  '暂停动画': 'Pause animation',
  '继续动画': 'Resume animation',
  '暂停漫游': 'Pause tour',
  '继续漫游': 'Resume tour',
  '前进': 'Forward',
  '后退': 'Back',
  '回到入口': 'Back to entrance',
  '重新生成': 'Regenerate',
  '换配色': 'Change palette',
  '下载 GLB': 'Download GLB',
  '复制配置 JSON': 'Copy config JSON',
  '复制代码': 'Copy code',
  '代码已复制': 'Code copied',
  '复制失败': 'Copy failed',
  '麦克风只在本地处理，不上传。Demo 音轨是一段静音驱动的合成信号，点击后开始。': 'The microphone is processed locally and never uploaded. The demo track is a silent procedural signal; click to start.',
  '需要浏览器允许音频/麦克风权限。': 'The browser needs audio/microphone permission.',
  '滚轮 / 拖动前进 · 移动鼠标观察': 'Scroll / drag to move · Move mouse to look',
  '拖动旋转 · 滚轮缩放': 'Drag to rotate · Scroll to zoom',

  // Gallery
  '把 Three.js 做成': 'Turn Three.js into',
  '可交付的产品页。': 'a deliverable product page.',
  '八个可运行的 demo：agency 互动页、产品配置器、教育工作坊、粒子星云、金属雕塑、音频可视化、全球数据网络和空间漫游。 每个都能在浏览器里实时运行，代码归客户，本地优先。': 'Eight runnable demos: agency page, product configurator, education workshop, particle galaxy, metal sculpture, audio visualizer, global data network and spatial walkthrough. Each runs live in the browser, with code ownership and local-first data.',
  'AI-native workflow': 'AI-native workflow',
  '代码归客户': 'Code ownership',
  'BYOK / 本地优先': 'BYOK / local-first',
  '2 周 – 6 周交付': '2–6 week delivery',
  '2 周交付': '2-week delivery',
  'Work demos': 'Work demos',
  'Motion': 'Motion',
  'Data & space': 'Data & space',
  'AGENCY / MARKETING': 'AGENCY / MARKETING',
  'AUREL — 可滚动叙事的 3D 产品页': 'AUREL — scroll-driven 3D product page',
  '滚动驱动相机、四套实时材质、响应式长文叙事。适合品牌发布、营销互动页和 agency 白标交付。': 'Scroll-driven camera, four live materials and responsive long-form storytelling. Built for launches, marketing pages and white-label agency work.',
  '2 周冲刺 · ¥1.5万起': '2-week sprint · from $3.5k',
  '打开 AUREL agency 互动页 demo': 'Open AUREL agency demo',
  'CONFIGURATOR / COMMERCE': 'CONFIGURATOR / COMMERCE',
  'LUMEN — 实时材质、灯光与价格联动': 'LUMEN — live materials, lighting and pricing',
  '材质、灯罩、色温和价格实时联动，支持 GLB 导出与配置 JSON。可接商品目录、Shopify/CPQ 和 AR。': 'Finish, shade, light temperature and price update live, with GLB export and config JSON. Can connect to catalogs, Shopify/CPQ and AR.',
  '4–6 周 · ¥6万起': '4–6 weeks · from $13k',
  '打开 LUMEN 产品配置器 demo': 'Open LUMEN configurator demo',
  'EDUCATION / WORKSHOP': 'EDUCATION / WORKSHOP',
  'ORBIT LAB — 分步骤搭建太阳系': 'ORBIT LAB — build a solar system step by step',
  '四步课程、实时场景、对应代码与提示。适合企业内训、设计/前端团队入门和高校工作坊。': 'Four guided steps, a live scene, matching code and tips. Built for team training, design/frontend onboarding and university workshops.',
  '工作坊 · 90 分钟 ¥2,980 起': 'Workshop · from $590',
  '打开 ORBIT LAB 教育工作坊 demo': 'Open ORBIT LAB workshop demo',
  'MOTION STUDIES': 'MOTION STUDIES',
  '让页面先动起来。': 'Make the page move first.',
  '两个纯程序化的动效 demo：粒子星云与实时金属雕塑。适合 hero 背景、发布页、品牌 ident 和 keynote 开场。': 'Two procedural motion studies: a particle galaxy and a real-time metal sculpture. Built for hero backgrounds, launch pages, brand idents and keynote openers.',
  'MOTION / GPU PARTICLES': 'MOTION / GPU PARTICLES',
  'NEBULA — 120,000 个点的星云': 'NEBULA — a galaxy of 120,000 points',
  '自定义 GLSL、逐粒子旋转、三套配色和实时 FPS。没有视频和贴图，只有可交互的粒子系统。': 'Custom GLSL, per-particle rotation, three palettes and live FPS. No video or textures—only an interactive particle system.',
  'Hero / 背景 / 发布页': 'Hero / background / launch',
  '打开 NEBULA 粒子星云 demo': 'Open NEBULA particle demo',
  'MOTION / REAL-TIME MATERIAL': 'MOTION / REAL-TIME MATERIAL',
  'KINETIC — 不会停下的金属雕塑': 'KINETIC — a metal sculpture that never stops',
  'Chrome / Gold / Iridescent 实时材质，程序化环境反射、速度控制和 pause。适合产品 hero 与品牌动效。': 'Chrome / Gold / Iridescent physical materials, procedural reflections, speed control and pause. Built for product heroes and brand motion.',
  'Hero / 产品 / 品牌': 'Hero / product / brand',
  '打开 KINETIC 金属雕塑 demo': 'Open KINETIC sculpture demo',
  'DATA / AUDIO / SPACE': 'DATA / AUDIO / SPACE',
  '让声音、数据与空间都有表情。': 'Give sound, data and space a face.',
  '三个沉浸式 demo：音频频谱、全球网络和建筑空间。适合发布会、品牌空间、数据叙事和互动装置。': 'Three immersive demos: audio spectrum, global network and architectural space. Built for launches, brand spaces, data narratives and interactive installations.',
  'AUDIO / WEB AUDIO API': 'AUDIO / WEB AUDIO API',
  'SONAR — 让声音被看见': 'SONAR — make sound visible',
  '麦克风或内置合成音轨驱动 96 根频谱柱、波形环和粒子。本地处理，不上传音频。': 'Microphone or built-in synth drives 96 spectrum bars, a waveform ring and particles. Processed locally; no audio upload.',
  '发布会 / 品牌空间': 'Launch / brand space',
  '打开 SONAR 音频可视化 demo': 'Open SONAR audio demo',
  'DATA / 3D GLOBE': 'DATA / 3D GLOBE',
  'SIGNAL — 一张会呼吸的数据网络': 'SIGNAL — a living data network',
  '3D 全球网络、12 条跨洋链路、实时脉冲与数据集切换。适合数据叙事、基础设施和金融科技。': 'A 3D global network with 12 transcontinental routes, live packets and dataset switching. Built for data narratives, infrastructure and fintech.',
  '数据叙事 / 发布会': 'Data narrative / launch',
  '打开 SIGNAL 数据网络 demo': 'Open SIGNAL data demo',
  'SPACE / WALKTHROUGH': 'SPACE / WALKTHROUGH',
  'ATRIUM — 走进一个不存在的美术馆': 'ATRIUM — step into a museum that does not exist',
  '程序化柱廊、天窗、画框、灯光和中央雕塑。滚轮或拖动前进，适合地产、文旅、展览和品牌空间。': 'Procedural colonnade, skylights, framed art, lighting and a central sculpture. Scroll or drag to walk. Built for real estate, cultural tourism, exhibitions and brand spaces.',
  '地产 / 文旅 / 展览': 'Real estate / tourism / exhibition',
  '打开 ATRIUM 空间漫游 demo': 'Open ATRIUM walkthrough demo',
  'DELIVERY': 'DELIVERY',
  '从 demo 到上线，': 'From demo to launch,',
  '只差一次交付。': 'one delivery away.',
  '3D 互动落地页冲刺': 'Interactive 3D landing sprint',
  '单场景：2 周 · ¥1.5万–2.5万 · 响应式 · 性能优化 · 代码交付': 'Single scene: 2 weeks · $3.5k–6k · responsive · performance pass · code handoff',
  '含设计建模：2 周 · ¥2.5万–4万 · 含视觉与模型适配': 'Design + modeling: 2 weeks · $6k–9k · visual and model adaptation included',
  '产品配置器': 'Product configurator',
  'MVP：4–6 周 · ¥6万–10万 · 材质/灯光/价格/GLB': 'MVP: 4–6 weeks · $13k–22k · materials/lighting/pricing/GLB',
  '商城/CPQ/AR 集成：¥10万–20万+ · 按范围报价': 'Commerce/CPQ/AR integration: $22k–45k+ · quoted by scope',
  'AI Three.js 工作坊': 'AI Three.js workshop',
  '90 分钟：¥2,980 · 团队入门': '90 minutes: $590 · team intro',
  '半天：¥4,800 · 3–4 小时实战': 'Half day: $950 · 3–4 hour hands-on',
  '全天：¥6,800–9,800 · 实战工作坊': 'Full day: $1,500–2,200 · hands-on workshop',
  '2 天：¥12,800–18,800 · 从 prompt 到上线': '2 days: $2,800–4,100 · prompt to production',
  'START A PROJECT': 'START A PROJECT',
  '想让你的产品': 'Want your product',
  '也这样被看见？': 'to be seen like this?',
  '把 demo 链接发我，或者直接说你的场景、时间和预算。我会在 48 小时内回复一个可执行的方案。': 'Send me a demo link, or just describe your scenario, timeline and budget. I will reply with an actionable plan within 48 hours.',
  'Three Studio demo gallery · 所有品牌与产品均为 demo 虚构。': 'Three Studio demo gallery · All brands and products are fictional demo content.',
  'Three Studio — Demo 列表': 'Three Studio — Demo Gallery',
  '作品 demo': 'Work demos',
  '动效': 'Motion',
  '数据与空间': 'Data & space',

  // Agency
  'AUREL — 时间，被重新渲染': 'AUREL — time, re-rendered',
  '工艺': 'Craft',
  '表盘': 'Dial',
  '配色': 'Materials',
  '参数': 'Specs',
  '页面导航': 'Page navigation',
  'AUREL 首页': 'AUREL home',
  'AUREL HORLOGERIE': 'AUREL HORLOGERIE',
  '时间，': 'Time,',
  '被重新渲染': 're-rendered.',
  'AUREL Azure 是一枚机械表，也是一段实时运行的 Three.js 场景。 滚动、光照与材质都在浏览器里发生，每一帧都可以被编辑、导出、带走。': 'AUREL Azure is a mechanical watch—and a live Three.js scene. Scroll, light and material happen in the browser; every frame can be edited, exported and taken with you.',
  '探索细节': 'Explore details',
  '切换配色': 'Switch material',
  '表径': 'Case',
  '机芯': 'Movement',
  '防水': 'Water',
  '渲染': 'Render',
  '不是渲染图，': 'Not a render.',
  '是可交互的实物。': 'An interactive object.',
  '表壳、表圈、指针、机芯齿轮和每一颗夜光点都是场景里的真实几何体。 滚轮改变视角，鼠标带来视差，时间轴上的每一帧都能被重新编排。': 'Case, bezel, hands, gears and every lume dot are real geometry in the scene. Scroll changes the view, the mouse adds parallax, and every frame on the timeline can be rearranged.',
  '实时 ACES 色调映射与环境反射': 'Live ACES tone mapping and environment reflections',
  '程序化表盘、陶瓷圈与拉丝钢材质': 'Procedural dial, ceramic bezel and brushed steel',
  '可编辑场景图，而不是固定视频': 'An editable scene graph, not a fixed video',
  '每一束光，': 'Every beam',
  '都来自真实材质。': 'comes from real materials.',
  '表盘不是一张贴图。太阳纹、分钟轨道、日期窗与夜光刻度在程序化纹理中生成， 再被 envMap、clearcoat 和阴影重新点亮。': 'The dial is not a texture. Sunburst, minute track, date window and lume markers are generated procedurally, then relit by envMap, clearcoat and shadows.',
  '四种性格，': 'Four characters,',
  '一套场景。': 'one scene.',
  '深海蓝陶瓷圈，冷光钢壳。像一段被冻结的蓝色时间。': 'Deep-blue ceramic bezel and cool steel case. Like a frozen moment of blue time.',
  '点击色块，材质在场景中实时切换，不需要重新加载。': 'Click a swatch to switch materials live in the scene—no reload.',
  '为屏幕而生的机械感。': 'Mechanical feel, made for screens.',
  '316L 精钢，拉丝与抛光交替': '316L steel, brushed and polished',
  '双面防眩，蓝宝石镜面': 'Double anti-glare sapphire crystal',
  '自动上链，动力储存': 'Automatic winding, power reserve',
  '日常防水': 'Everyday water resistance',
  '蓝色夜光刻度与指针': 'Blue lume markers and hands',
  '场景可导出到 DCC 与 AR': 'Scene exports to DCC and AR',
  '这是 Three Studio 的 agency demo：我们用 AI-native Three.js 工作台， 在 2 周内交付可上线、可编辑、代码归你的 3D 互动页。': 'This is a Three Studio agency demo: we use an AI-native Three.js workbench to deliver a launch-ready, editable 3D interactive page in 2 weeks—with code ownership.',
  '本地优先': 'Local-first',
  '代码归你': 'Code ownership',
  'AUREL 是为 Three Studio agency demo 虚构的产品，不是真实腕表品牌。': 'AUREL is a fictional product created for a Three Studio agency demo; it is not a real watch brand.',
  '这个 demo 需要启用 JavaScript 和 WebGL。': 'This demo requires JavaScript and WebGL.',

  // Configurator
  'LUMEN — 一盏灯，由你定义': 'LUMEN — a lamp, defined by you',
  'LUMEN / MODULAR LIGHT': 'LUMEN / MODULAR LIGHT',
  '一盏灯，': 'A lamp,',
  '由你定义。': 'defined by you.',
  '从材质、灯罩到色温，所有变化都在真实场景里实时发生。 选好配置，直接下载 GLB，或把同一套逻辑接到 Shopify / CPQ / AR。': 'From finish and shade to color temperature, every change happens live in the scene. Pick a configuration, download the GLB, or wire the same logic to Shopify / CPQ / AR.',
  '实时材质与灯光': 'Live materials and lighting',
  '价格/规则联动': 'Price and rule updates',
  'GLB 导出与 AR 就绪': 'GLB export and AR-ready',
  'CONFIGURATOR MVP': 'CONFIGURATOR MVP',
  '4–6 周交付 · 可接商品目录与报价系统': '4–6 week delivery · catalog and quoting integration',
  'YOUR LUMEN': 'YOUR LUMEN',
  '含基础灯体 · 不含运费': 'Base lamp included · shipping excluded',
  '材质': 'Finish',
  '灯罩': 'Shade',
  '光色': 'Light',
  '拖动旋转 · 滚轮缩放': 'Drag to rotate · Scroll to zoom',
  'LUMEN 灯具实时配置预览': 'Live LUMEN configurator preview',
  'LUMEN 是为 Three Studio 配置器 demo 虚构的产品，不是真实灯具品牌。': 'LUMEN is a fictional product created for a Three Studio configurator demo; it is not a real lighting brand.',
  '这是 Three Studio 的配置器 demo。真实项目可接商品目录、价格规则、库存、Shopify/CPQ 和 AR Quick Look。': 'This is a Three Studio configurator demo. A real project can connect to product catalogs, pricing rules, inventory, Shopify/CPQ and AR Quick Look.',

  // Education
  'ORBIT LAB — 用 Three.js 搭一个太阳系': 'ORBIT LAB — build a solar system with Three.js',
  'WORKSHOP 01 / 90 MIN': 'WORKSHOP 01 / 90 MIN',
  '用 Three.js': 'Use Three.js',
  '搭一个太阳系': 'to build a solar system',
  '从空场景开始，一步一步加入太阳、行星、轨道和月球。 每一步都有可运行的代码，适合设计师、前端和创意开发者。': 'Start with an empty scene and add the sun, planets, orbits and moon step by step. Every step has runnable code—built for designers, front-end developers and creative technologists.',
  '搭好舞台': 'Set the stage',
  '场景、相机、灯光': 'Scene, camera, lights',
  '点亮太阳': 'Light the sun',
  '材质与点光源': 'Materials and point lights',
  '让行星公转': 'Make planets orbit',
  '轨道与动画': 'Orbits and animation',
  '加一颗月球': 'Add a moon',
  '层级与相对运动': 'Hierarchy and relative motion',
  'STEP 01 / 04': 'STEP 01 / 04',
  'NEXT WORKSHOP': 'NEXT WORKSHOP',
  'AI Three.js 交付工作坊': 'AI Three.js delivery workshop',
  '2 天 · 企业/团队 · 从 prompt 到可上线页面': '2 days · teams · prompt to production page',
  'LIVE SCENE': 'LIVE SCENE',
  'STEP 01 · STAGE': 'STEP 01 · STAGE',
  '太阳系实时预览': 'Live solar system preview',
  '当前步骤': 'Current step',
  '想学完整流程？预约工作坊': 'Want the full workflow? Book a workshop',
  'ORBIT LAB 是为 Three Studio 教育工作坊 demo 虚构的课程，不是真实课程品牌。': 'ORBIT LAB is a fictional course created for a Three Studio education demo; it is not a real course brand.',

  // Nebula
  'NEBULA — 120,000 个点，组成一片星云': 'NEBULA — 120,000 points form a galaxy',
  'MOTION STUDY 01 / GPU PARTICLES': 'MOTION STUDY 01 / GPU PARTICLES',
  '120,000 个点，': '120,000 points,',
  '组成一片星云。': 'form a galaxy.',
  '位置、颜色、大小和闪烁全部由 shader 驱动。 没有视频，没有贴图，只有一段可实时交互的粒子系统。': 'Position, color, size and twinkle are driven by shaders. No video, no textures—only a live, interactive particle system.',
  'NEBULA 是 Three Studio 的程序化动效 demo。': 'NEBULA is a procedural motion demo for Three Studio.',

  // Kinetic
  'KINETIC — 一件不会停下的金属雕塑': 'KINETIC — a metal sculpture that never stops',
  'MOTION STUDY 02 / REAL-TIME MATERIAL': 'MOTION STUDY 02 / REAL-TIME MATERIAL',
  '一件不会停下的': 'A metal sculpture',
  '金属雕塑。': 'that never stops.',
  '几何、环境反射和材质都在浏览器里实时计算。 切换金属、金色或虹彩表面，观察光在曲面上流动。': 'Geometry, environment reflections and materials are computed live in the browser. Switch chrome, gold or iridescent surfaces and watch light flow across the curves.',
  'KINETIC 是 Three Studio 的程序化动效 demo。': 'KINETIC is a procedural motion demo for Three Studio.',

  // Audio
  'SONAR — 让声音被看见': 'SONAR — make sound visible',
  'MOTION STUDY 03 / AUDIO REACTIVE': 'MOTION STUDY 03 / AUDIO REACTIVE',
  '让声音': 'Make sound',
  '被看见。': 'visible.',
  '麦克风或内置合成音轨，实时驱动 96 根频谱柱、波形环和粒子。 所有反应都来自 Web Audio API 的 AnalyserNode。': 'Microphone or built-in synth drives 96 spectrum bars, a waveform ring and particles live. Every reaction comes from the Web Audio API AnalyserNode.',
  'SONAR 是 Three Studio 的程序化音频可视化 demo。': 'SONAR is a procedural audio visualizer demo for Three Studio.',
  '启用麦克风': 'Enable microphone',
  '播放 Demo 音轨': 'Play demo track',
  'SONAR / AUDIO INPUT': 'SONAR / AUDIO INPUT',

  // Data
  'SIGNAL — 一张会呼吸的数据网络': 'SIGNAL — a living data network',
  'MOTION STUDY 04 / DATA SPACE': 'MOTION STUDY 04 / DATA SPACE',
  '数据不是表格，': 'Data is not a table.',
  '是一张会呼吸的网络。': 'It is a living network.',
  '城市节点、跨洋链路和实时脉冲，全部由 Three.js 实时渲染。 切换数据集，观察网络的重心与延迟如何变化。': 'City nodes, transcontinental links and live packets are rendered in real time with Three.js. Switch datasets to watch the network’s center of gravity and latency change.',
  'SIGNAL 是 Three Studio 的合成数据可视化 demo，不代表真实网络。': 'SIGNAL is a synthetic data visualization demo for Three Studio; it does not represent a real network.',

  // Atrium
  'ATRIUM — 走进一个不存在的美术馆': 'ATRIUM — step into a museum that does not exist',
  'MOTION STUDY 05 / SPATIAL WALKTHROUGH': 'MOTION STUDY 05 / SPATIAL WALKTHROUGH',
  '走进一个': 'Step into a',
  '不存在的美术馆。': 'museum that does not exist.',
  '整座建筑由 Three.js 程序化生成：柱廊、天窗、画框、灯光和一件中央雕塑。 滚轮或拖动前进，观察光在空间里移动。': 'The entire building is procedural: colonnade, skylights, framed art, lighting and a central sculpture. Scroll or drag to walk and watch light move through the space.',
  'ATRIUM 是 Three Studio 的程序化空间漫游 demo。': 'ATRIUM is a procedural spatial walkthrough demo for Three Studio.',
  '01 / ATRIUM': '01 / ATRIUM',
  'ROOM': 'ROOM',
  'POSITION': 'POSITION',

  // Dynamic strings
  '石墨灰表盘与拉丝钢，低调、克制，适合日常佩戴。': 'Graphite dial and brushed steel—quiet, restrained, made for every day.',
  '香槟金与深棕陶瓷，暖光下的复古机械感。': 'Champagne gold and dark brown ceramic; vintage mechanics under warm light.',
  '酒红陶瓷与暖色指针，像一枚仍在燃烧的机芯。': 'Burgundy ceramic and warm hands, like a movement still burning.',
  '导出中…': 'Exporting…',
  'GLB 已导出': 'GLB exported',
  'GLB 导出失败：': 'GLB export failed: ',
  '配置 JSON 已复制': 'Config JSON copied',
  '复制失败': 'Copy failed',
  '视角已重置': 'View reset',
  '先确定相机、灯光和可交互的控制器，再开始放物体。OrbitControls 让用户拖动旋转、滚轮缩放。': 'Set the camera, lights and interactive controls before adding objects. OrbitControls lets users drag to rotate and scroll to zoom.',
  'emissive 让太阳自己发光，PointLight 负责照亮行星。太阳材质本身不会照亮别人，光源要单独加。': 'emissive makes the sun glow; PointLight illuminates the planets. The sun material does not light others—add the light separately.',
  '把公转放在 onFrame 里，用 delta 控制速度；不要用 setInterval。每颗行星用一个 pivot 旋转，位置更稳定。': 'Put orbits in onFrame and use delta for speed; do not use setInterval. One pivot per planet keeps positions stable.',
  '把月球挂在 Earth 下面，它就会自动跟着地球公转；再让 moonOrbit 自己旋转，就有了“月球绕地球”。': 'Parent the moon to Earth and it follows Earth’s orbit automatically; rotate moonOrbit itself to create the moon’s orbit around Earth.',
  '麦克风已接入': 'Microphone connected',
  '麦克风不可用，使用 Demo 音轨': 'Microphone unavailable; using demo track',
  'Demo 音轨已开始（静音驱动）': 'Demo track started (silent driver)',
  '音频初始化失败：': 'Audio initialization failed: ',
  '下载 GLB': 'Download GLB',
  '已完成': 'Complete',
  '代码已复制': 'Code copied',
  '返回 Demo 列表': 'Demo gallery',
  '下一个：NEBULA': 'Next: NEBULA',
  '下一个：KINETIC': 'Next: KINETIC',
  '下一个：SONAR': 'Next: SONAR',
  '下一个：SIGNAL': 'Next: SIGNAL',
  '下一个：ATRIUM': 'Next: ATRIUM',
  '这个 demo 需要启用 JavaScript 和 WebGL。': 'This demo requires JavaScript and WebGL.',
}

const normalize = value => String(value).replace(/\s+/g, ' ').trim()
const ZH = Object.fromEntries(Object.entries(EN).map(([zh, en]) => [en, zh]))
const LANG_KEY = 'three-studio-demo-lang-v2'
const LEGACY_LANG_KEY = 'three-studio-demo-lang'

const requestedLanguage = (() => {
  try {
    const value = new URLSearchParams(window.location.search).get('lang')
    return value === 'zh' || value === 'en' ? value : null
  } catch (error) {
    return null
  }
})()

function language() {
  if (requestedLanguage !== null) return requestedLanguage
  try {
    const stored = localStorage.getItem(LANG_KEY)
    return stored === 'zh' ? 'zh' : 'en'
  } catch (error) {
    return 'en'
  }
}

function t(value) {
  const key = normalize(value)
  const lang = language()
  const map = lang === 'zh' ? ZH : EN
  return map[key] ?? value
}

function translateTextNode(node, lang) {
  const original = node.nodeValue
  const key = normalize(original)
  if (key === '') return
  const map = lang === 'zh' ? ZH : EN
  const translated = map[key]
  if (translated === undefined) return
  const leading = original.match(/^\s*/)?.[0] ?? ''
  const trailing = original.match(/\s*$/)?.[0] ?? ''
  node.nodeValue = `${leading}${translated}${trailing}`
}

function translateAttributes(root, lang) {
  for (const element of root.querySelectorAll('[title],[aria-label],[alt],[placeholder]')) {
    for (const attribute of ['title', 'aria-label', 'alt', 'placeholder']) {
      const value = element.getAttribute(attribute)
      if (value === null) continue
      const key = normalize(value)
      const map = lang === 'zh' ? ZH : EN
      const translated = map[key]
      if (translated !== undefined) element.setAttribute(attribute, translated)
    }
  }
}

function apply(root = document) {
  const lang = language()
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes = []
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.parentElement?.closest('script, style, code, pre, textarea')) continue
    nodes.push(node)
  }
  for (const node of nodes) translateTextNode(node, lang)
  translateAttributes(root, lang)
}

function ensureToggle() {
  if (document.querySelector('[data-lang-toggle]') !== null) return
  const header = document.querySelector('.topbar, header')
  if (header === null) return
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'lang-toggle'
  button.dataset.langToggle = ''
  button.setAttribute('aria-label', 'Switch language')
  button.textContent = language() === 'zh' ? 'EN' : '中文'
  button.addEventListener('click', () => {
    const next = language() === 'zh' ? 'en' : 'zh'
    try { localStorage.setItem(LANG_KEY, next) } catch (error) { void error }
    window.location.reload()
  })
  header.append(button)
  if (!document.getElementById('demo-lang-style')) {
    const style = document.createElement('style')
    style.id = 'demo-lang-style'
    style.textContent = '.lang-toggle{height:30px;padding:0 10px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;opacity:.72;font:9px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;cursor:pointer;transition:opacity .2s ease}.lang-toggle:hover{opacity:1}'
    document.head.append(style)
  }
}

function init() {
  try {
    localStorage.removeItem(LEGACY_LANG_KEY)
    if (requestedLanguage !== null) localStorage.setItem(LANG_KEY, requestedLanguage)
  } catch (error) { void error }
  apply()
  ensureToggle()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}

window.DemoI18N = { t, language, apply }
export { t, language, apply }
