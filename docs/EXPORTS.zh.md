# 导出

所有导出都在沙箱预览 iframe 内执行，通过 `postMessage` 把字节交给父页面下载。
导出内容不包含编辑器界面、控制台日志、HUD 或任何 API Key。

## 目标格式

| 菜单项 | 命令 | 输出 | 说明 |
| --- | --- | --- | --- |
| 快照 | `capture` | PNG | 当前帧，按预览分辨率 |
| 录制 | `record` | WebM | `MediaRecorder` 实时录制 |
| 导出 MP4 | 导出任务 | MP4 | 固定网格采样（默认 960×540） |
| 导出 GIF | 导出任务 | GIF | 同一帧计划，调色板量化 |
| 导出 glTF | `export-gltf` | `.glb` | 静态场景，二进制 glTF |
| 导出动画 glTF | `export-gltf` + `animated` | `.glb` | 采样关键帧轨道，带帧数上限 |
| 导出 STL | `export-stl` | `.stl` | 二进制 STL，适合 3D 打印 |
| 导出 OBJ | `export-obj` | `.obj` | 文本几何，不含材质 |
| 导出 USDZ | `export-usdz` | `.usdz` | AR Quick Look；STORE（不压缩）zip，含 `model.usda` |
| 导出 FBX | `export-fbx` | `.fbx` | 二进制 FBX 7.4（version 7400），静态网格 |
| 项目 ZIP | — | `.zip` | 场景、资产与编辑器状态归档；尚未实现重新导入 |
| 独立 HTML | — | `.html` | 单文件场景页，沿用同一沙箱；从 jsDelivr 加载 Three.js，需要联网 |

## USDZ

- 导出器：vendored `three@0.186.0` 的 `USDZExporter`，按 USDZ 规范（及 Apple
  要求）写入 STORE 条目。贴图按导出器默认 1024 px 上限嵌入。
- 范围：导出时刻的可见场景，包含编辑器 override 与手动对象；辅助对象先被移除。
- 不含：动画（导出当前姿态）、编辑器辅助线、控制台输出。
- 用途：AR Quick Look、macOS 预览或任意 USDZ 查看器。

## FBX

- 写出器：`runtime/exporters/FBXExporter.js`，自研、零依赖的二进制 FBX 7.4
  写出器；已用 vendored three.js `FBXLoader` 对真实输出做往返验证（层级、
  复合旋转、逐角几何、UV、法线、Phong 颜色）。
- 坐标与单位：以米书写，`GlobalSettings UnitScaleFactor = 100`
  （1 单位 = 100 cm），与 Blender 米制 FBX 输出一致；顶点不重缩放。
- 几何：三角网格 + 逐角法线 + 一套 UV；缺失法线回退面法线。
  `InstancedMesh` 展开为共享同一几何的兄弟模型。
- 层级：Group 转为 FBX `Null` Model 以保留父子关系；每个 Model 携带局部
  平移/旋转/缩放（XYZ 欧拉，`Rz·Ry·Rx`），父级变换只应用一次。
- 材质：转为 FBX Phong；漫反射/自发光/高光颜色以 sRGB 写入，roughness 与
  metalness 映射为 shininess/specular 强度，opacity 映射为
  `TransparencyFactor`；PBR 通道、贴图与顶点色不随行。材质组转为逐多边形分配。
- 命名：转写为可打印 ASCII，并按对象类型去重。
- 不含：动画、蒙皮、灯光、相机、morph target。
- 用途：导入 Blender、Maya、3ds Max、Unity 等 FBX 7.4 消费方。由于不含动画，
  请在 DCC 中重新绑定动画，或改用 glTF 交接动画。

## 安全说明

- USDZ/FBX 由预览 iframe 内的代码生成，父页面从不执行场景内容。
- FBX 与 glTF 使用同一场景快照，因此 override、手动对象与层级意图都会生效。
- 导出文件离开 Studio 后即为不可信内容，请只在可信查看器中打开。

## 验证

```sh
~/.local/node24/bin/node --test tests/export-fbx.test.mjs
~/.local/node24/bin/node tests/e2e/exports.mjs   # npm run test:e2e:exports
```

浏览器探针通过真实导出菜单（mock 供应商）校验文件魔数、zip 存储方式、
FBX 版本与节点名。
