# 开源核心边界

Three Studio 采用 open-core：本仓库中的本地工作台按 **Apache-2.0** 开源；
付费服务、发布密钥和私有商业资产放在仓库之外。本文是“哪些代码能进公开
仓库”的唯一依据。

## 公开部分（Apache-2.0）

| 范围 | 路径 |
| --- | --- |
| Studio 界面与场景引擎 | `client.js`、`index.js` |
| 独立服务器与 Agent 循环 | `standalone/**` |
| 内置 Three.js 与导出辅助库 | `runtime/**`（MIT，见 `THIRD_PARTY_NOTICES.md`） |
| 桌面外壳与许可证验签 | `desktop/main.mjs`、`desktop/preload.cjs`、`desktop/license/core.mjs`、`desktop/scripts/**`、`desktop/build/**`、`desktop/license/public-key.pem` |
| 模板包契约 | `desktop/templates/manifest.json`（空的免费包）、`desktop/templates/README.md` |
| 销售 demo | `site/**` |
| 说明书与影片 | `client.js` 的 presentation/manual/film UI、`index.js` 的 manual 提案与 share `/presentation`、1080p 确定性导出 |
| 测试与示例 | `tests/**`、`examples/**` |
| 公开文档 | `README.md`、`README.zh.md`、`docs/**`（内部笔记除外） |
| 治理文件 | `LICENSE`、`NOTICE`、`CONTRIBUTING.md`、`DCO`、`SECURITY.md`、`GOVERNANCE.md`、`TRADEMARK.md`、`PRIVACY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`ROADMAP.md` |

Apache-2.0 核心包含完整的本地说明书/影片闭环：presentation schema、带 BOM/热点的说明书步骤编辑、带相机关键帧/SRT/本地音乐的
有序影片镜头、AI 说明书提案（本地审核后应用）、share 查看器的说明书侧栏与
打印到 PDF/QR，以及 1080p/16:9/9:16/1:1/4:5 确定性导出。

### 说明书与影片边界

**Apache-2.0 开源核心：**

- 全部本地 Manual/Film 编辑。
- 有序镜头 + 每镜起→终缓动相机关键帧 + 硬切。
- SRT 字幕与 sidecar 导出。
- 本地音乐附加、预览与 Opus 混流；浏览器不支持音频编码时回退纯视频。
- Manual BOM 与步骤热点。
- share 查看器（说明书侧栏、BOM/热点列表、打印到 PDF、QR）。
- 1080p/16:9/9:16/1:1/4:5 确定性导出。
- AI manual 提案（本地审核后应用）。

**Pro/私有服务（必须留在本仓库之外）：**

- 托管发布、评论/审批、团队空间、SSO、审计日志。
- 托管分析。
- 翻译工作流。
- 音乐/音效库与托管 TTS。
- 4K/ProRes。
- 云端/并行渲染队列。
- 批量变体。
- 品牌套件与高级模板。

本地编辑、查看和基础 1080p 导出不得依赖这些服务；公开核心不得引入私有 import、
许可证检查或托管端点。

Ed25519 **公钥**是刻意公开的：应用用它离线验签。公开公钥不能让任何人签发
许可证。

## 私有部分——绝不提交、打包或写入日志

### 密钥与发布材料

- `~/.three-studio-release/private-key.pem`（许可证签名私钥）和已签发的
  `*.tslicense`。
- 代码签名证书（`CSC_LINK`）、`CSC_KEY_PASSWORD`、
  `APPLE_APP_SPECIFIC_PASSWORD`、Apple ID、Team ID。
- 模型 API Key、GitHub/Cloudflare/支付/邮件 Token、MCP 的 `env` 值、
  `credentials.json`。
- 许可证签发记录、订单/客户数据库、支付回调、发票和退款记录。

### 用户与客户数据

- `~/.three-studio/**`：`credentials.json`（0600）、`models.json`、
  `search.json`、`mcp.json`、sessions、scenes、修订历史、assets、分享链接、
  plugins、skills、context。
- Electron 的 `userData` 目录，以及导出给客户的场景/资产。
- 线索名单、报价、合同、支持工单和分析导出。

### 无再分发权的第三方内容

- `.preview-tmp/**` 下的参考 clone 和审计产物。
- `node_modules/`、`desktop/vendor/`、`desktop/dist/`、`desktop/out/`。
- 任何许可证不允许再分发的模型、贴图、字体、插件或 SDK。
- 内部笔记：`AUDIT.md`、`TODO.md`、`docs/BATCH-*.md`、`docs/P*-*.md`、
  `docs/DESIGN-*.md`、`docs/DECISIONS.md`（已在 `.gitignore` 中）。

## 私有商业代码与资产

以下内容可以构建在开源核心之上，但必须放在独立的私有仓库或服务中：

- 托管分享、评论/评审、团队工作区、权限、SSO/SAML、审计日志、计费、
  用量计量、管理后台。
- 模型网关、托管 AI 额度与限流。
- Marketplace 审核、分成，以及任何会执行第三方代码的签名注册表。
- 支付收银台和 License 自动履约 Webhook。
- 高级模板包与付费资产包。当前 Pro 包位于独立的私有目录
  `../three-studio-private/pro-templates`，只在构建时装配。
- 定价实验、外呼脚本、客户名单和未修复的安全报告。

## 构建时的模板拆分

公开仓库只发布包格式，不发布付费场景：

```text
desktop/templates/
  manifest.json      # 免费包；本仓库中为空
  README.md          # 契约与构建说明
  pro/               # 被 git 忽略；由装配脚本创建
```

在 `desktop/` 中执行：

```sh
THREE_STUDIO_PRO_TEMPLATES=/path/to/three-studio-private/pro-templates npm run templates
npm run release-check
npm run dist
```

`scripts/assemble-templates.mjs` 会校验 manifest（`v: 1`、id、标题、扁平
`.js` 文件名），拒绝目录、`..` 路径穿越和符号链接，然后原子替换
`templates/pro/`。`predist` 会自动运行它。开源构建缺少私有包时跳过；
设置 `THREE_STUDIO_REQUIRE_PRO_TEMPLATES=1` 可改为失败。源缺失时脚本会
删除旧的 `templates/pro/`，避免开源构建误打包旧的 Pro 包。

## 规则

1. 本地核心在没有许可证时也保持完整功能。Pro 凭证只解锁徽章、私有模板包
   和支持/更新权益——它不是 DRM，编辑器内没有付费墙。
2. 私有代码放独立仓库或服务；不要合并进本仓库，也不要在公开核心里引用
   私有模块。
3. 只分发公钥。签名私钥离线保存，绝不提交、打包、写日志或粘贴进 CI。
4. 保留第三方许可证和声明；新增内置依赖时同步更新
   `THIRD_PARTY_NOTICES.md`。
5. Apache-2.0 只覆盖代码，不覆盖项目名称和 Logo。Fork 必须遵守
   `TRADEMARK.md`。
6. 外部贡献按 DCO 进入 Apache-2.0 核心；外部贡献不会变成专有代码。
7. 用户数据留在用户机器上。不要提交 Studio 主目录、客户场景或许可证文件。

## 对复用者意味着什么

Apache-2.0 允许任何人运行、修改、再分发，甚至商业托管核心代码，只要保留
许可证和声明。项目的护城河是持续发布的版本、签名安装包、自动更新、支持、
Pro 模板包、私有服务和商标，而不是代码保密。这是有意的交换：开源换分发
和信任，付费层卖便利、责任和持续交付。
