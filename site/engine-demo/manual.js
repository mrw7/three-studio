// Generated from examples/turbofan-manual.json by
// site/scripts/generate-demos.mjs — do not edit by hand.
export const MANUAL = {
  "title": "涡扇发动机 · 结构与工作原理",
  "product": "TURBOFAN TF-900",
  "version": "1.0",
  "parts": [
    {
      "id": "part-fan",
      "number": "TF-01",
      "name": "风扇转子（22 片宽弦叶片）",
      "qty": 1,
      "uid": "s:engine-fan"
    },
    {
      "id": "part-nacelle",
      "number": "TF-02",
      "name": "短舱与进气道",
      "qty": 1,
      "uid": "s:engine-nacelle"
    },
    {
      "id": "part-pylon",
      "number": "TF-03",
      "name": "吊挂",
      "qty": 1,
      "uid": "s:engine-pylon"
    },
    {
      "id": "part-core",
      "number": "TF-04",
      "name": "核心机（5 级压气机）",
      "qty": 1,
      "uid": "s:engine-core"
    },
    {
      "id": "part-comb",
      "number": "TF-05",
      "name": "环形燃烧室与 16 个喷油嘴",
      "qty": 1,
      "uid": "s:engine-combustor"
    },
    {
      "id": "part-turb",
      "number": "TF-06",
      "name": "三级涡轮",
      "qty": 1,
      "uid": "s:engine-turbine"
    },
    {
      "id": "part-noz",
      "number": "TF-07",
      "name": "尾喷管与中心锥",
      "qty": 1,
      "uid": "s:engine-nozzle"
    }
  ],
  "steps": [
    {
      "id": "step-1",
      "title": "整机概览",
      "body": "双转子高涵道比涡扇发动机。进气从左侧唇口进入，经风扇、核心机、涡轮，最后从右侧尾喷管排出。外涵道气流提供约 80% 的推力，内涵道驱动核心机做功。",
      "camera": {
        "position": [
          7.4,
          4.2,
          -9.6
        ],
        "target": [
          0,
          0.9,
          0
        ],
        "fov": 34
      },
      "hidden": [],
      "highlight": null,
      "hotspots": [
        {
          "id": "hs-1a",
          "uid": "s:engine-fan",
          "label": "风扇"
        },
        {
          "id": "hs-1b",
          "uid": "s:engine-nacelle",
          "label": "短舱"
        }
      ]
    },
    {
      "id": "step-2",
      "title": "进气道与风扇",
      "body": "进气唇口为圆形截面，内壁敷设吸音层以降低风扇噪声。22 片宽弦风扇叶片由钛合金制成，叶根到叶尖有约 24° 的桨距扭转，兼顾低噪声与抗外物损伤能力。",
      "camera": {
        "position": [
          2.1,
          1.5,
          -6.4
        ],
        "target": [
          0,
          0.6,
          -1.6
        ],
        "fov": 38
      },
      "hidden": [],
      "highlight": "s:engine-fan",
      "hotspots": [
        {
          "id": "hs-2a",
          "uid": "s:engine-fan",
          "label": "风扇转子"
        }
      ]
    },
    {
      "id": "step-3",
      "title": "短舱与反推格栅",
      "body": "短舱整流罩包住风扇与部分核心机，后段两圈格栅是反推装置的气流出口。短舱同时承担吊挂载荷，通过上方的吊挂与机翼连接。",
      "camera": {
        "position": [
          5.2,
          2.6,
          1.2
        ],
        "target": [
          0,
          0.9,
          0.4
        ],
        "fov": 36
      },
      "hidden": [
        "s:engine-pylon"
      ],
      "highlight": "s:engine-nacelle",
      "hotspots": [
        {
          "id": "hs-3a",
          "uid": "s:engine-nacelle",
          "label": "反推格栅"
        }
      ]
    },
    {
      "id": "step-4",
      "title": "核心机：五级轴流压气机",
      "body": "核心机前段是五级轴流压气机，每级由转子叶片与静子叶片组成。空气逐级压缩后温度升至约 600 K，再进入燃烧室。",
      "camera": {
        "position": [
          3.4,
          1.2,
          0.6
        ],
        "target": [
          0,
          0.5,
          -0.4
        ],
        "fov": 30
      },
      "hidden": [
        "s:engine-nacelle"
      ],
      "highlight": "s:engine-core",
      "hotspots": [
        {
          "id": "hs-4a",
          "uid": "s:engine-core",
          "label": "压气机级"
        }
      ]
    },
    {
      "id": "step-5",
      "title": "环形燃烧室",
      "body": "环形火焰筒内布置 16 个燃油喷嘴。燃油与高压空气混合燃烧，燃气温度可达 1800 K 以上；火焰筒内壁的冷却气膜保护金属不被烧穿。",
      "camera": {
        "position": [
          2.6,
          1.4,
          1.9
        ],
        "target": [
          0,
          0.65,
          0.5
        ],
        "fov": 30
      },
      "hidden": [
        "s:engine-nacelle"
      ],
      "highlight": "s:engine-combustor",
      "hotspots": [
        {
          "id": "hs-5a",
          "uid": "s:engine-combustor",
          "label": "喷油嘴环"
        }
      ]
    },
    {
      "id": "step-6",
      "title": "涡轮与尾喷",
      "body": "三级涡轮从燃气中提取能量，经内轴带动压气机、经外轴带动风扇。做功后的燃气经尾喷管加速排出，中心锥用于整流并降低底部阻力。",
      "camera": {
        "position": [
          4.2,
          1.6,
          4.4
        ],
        "target": [
          0,
          0.7,
          1.4
        ],
        "fov": 34
      },
      "hidden": [
        "s:engine-nacelle"
      ],
      "highlight": "s:engine-turbine",
      "hotspots": [
        {
          "id": "hs-6a",
          "uid": "s:engine-turbine",
          "label": "涡轮级"
        },
        {
          "id": "hs-6b",
          "uid": "s:engine-nozzle",
          "label": "尾喷管"
        }
      ]
    },
    {
      "id": "step-7",
      "title": "吊挂与安装",
      "body": "吊挂把发动机的推力与重量传给机翼，内部走燃油、滑油与引气管路。发动机附件齿轮箱从内轴取轴功率，驱动燃油泵与发电机。",
      "camera": {
        "position": [
          -5.6,
          3.6,
          -5.2
        ],
        "target": [
          0,
          1.3,
          0
        ],
        "fov": 36
      },
      "hidden": [],
      "highlight": "s:engine-pylon",
      "hotspots": [
        {
          "id": "hs-7a",
          "uid": "s:engine-pylon",
          "label": "吊挂根部"
        }
      ]
    },
    {
      "id": "step-8",
      "title": "整机复检",
      "body": "完成装配后按 ATA 72 章执行整机试车：检查风扇配平、核心机振动、滑油压力与排气温度。所有紧固件力矩与保险丝状态需逐项签字确认。",
      "camera": {
        "position": [
          8.2,
          4.8,
          -6.2
        ],
        "target": [
          0,
          0.9,
          0
        ],
        "fov": 32
      },
      "hidden": [],
      "highlight": null,
      "hotspots": []
    }
  ]
}
