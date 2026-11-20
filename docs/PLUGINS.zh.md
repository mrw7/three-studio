# 插件与市场

独立 Studio 自带原生插件系统和精选市场。它**不会**执行 Harness/Cordis 插件或
任意下载代码。

## 市场

- 入口：左侧栏 **插件市场**，或顶部插头图标。
- 目录：`standalone/plugins/catalog.mjs`。
- 运行时：`standalone/plugins/runtime.mjs`。
- 已安装状态：`~/.three-studio/plugins.json`。
- API：
  - `GET /api/plugins`
  - `POST /api/plugins/:id/install`
  - `DELETE /api/plugins/:id/uninstall`

安装后立即生效，无需重启；卸载会移除该插件添加的全部工具、提示词段落、
路由与定时器。

## 当前可安装（20 个）

| Id | 提供 | 说明 |
| --- | --- | --- |
| `skills` | `read_skill`、`studio:skills` 段 | 读取 `~/.three-studio/skills/*.md`，首次安装生成 Three.js 场景技能 |
| `planning` | `write_plan`、计划优先提示 | 校验目标与步骤列表 |
| `todo` | `todo_write` | 多步工作的可见清单 |
| `subagents` | `spawn_subagent` | 使用当前供应商的一次性调研/审查，不修改场景 |
| `web-fetch` | `web_fetch` | 仅公网 http(s)，拒绝回环/私网并在每次重定向后复查 |
| `memory` | `memory_write`、`memory_forget`、`studio:memory` 段 | 持久项目记忆（`memory.json`，原子写，200 条上限），每会话重新注入 |
| `context-files` | `list_context_files`、`read_context_file`、`studio:context` 段 | 只读 `~/.three-studio/context/` 平面文本（拒绝路径与二进制，128 KiB 上限）；`AGENTS.md` 自动注入 |
| `action-cards` | `propose_actions` | 回合结束时最多 6 个可点击后续；点击只填入输入框，绝不自动发送 |
| `deliverables` | `save_deliverable` | 文本交付落到 `deliverables/<会话>/`（文本扩展名、256 KiB 上限、原子写）；卡片显示路径并可复制小文件 |
| `voice-input` | 输入框麦克风按钮 | 纯客户端：安装后且浏览器有 SpeechRecognition 时显示；每次点击听一句，仅追加草稿 |
| `file-browser` | `list_workspace_files`、`read_workspace_file`、Files 面板 + `/api/plugins/file-browser/*` | 浏览 Studio 主目录；工具与路由共用路径穿越、二进制与凭据守卫；路由仅在安装期间存在 |
| `document-preview` | Files 面板查看器 | 面板内预览文本与图片（有界）；未安装时面板显示提示 |
| `background-jobs` | `start_background_job`、`check_background_job` | 分离式一次性研究（子代理，20 并发、3 分钟预算），后续回合轮询结果 |
| `scheduled-tasks` | `schedule_prompt`、`list_schedules`、`cancel_schedule` | 周期提示持久化于 `schedules.json`（10 条、5–1440 分钟、仅作用于创建会话）；与手动提示共用同一回合管线；卸载停止定时器 |
| `hooks` | `list_hooks` | 用户手写 `hooks.json`（turn-end 事件），事件后把记录注入下一回合上下文；Agent 只读 |
| `web-search` | `web_search` | 默认零配置 DuckDuckGo Lite；Tavily/Brave 在 `search.json` 配 key。只返回结果数据，正文仍用 `web_fetch` |
| `deep-research` | `deep_research` | 最多 3 个查询、读 4 个页面（同 web_fetch 的 SSRF 守卫），由一次子代理综合，输出带来源摘要 |
| `mcp-connectors` | `mcp_list_tools`、`mcp_call_tool` | 用户手写 `mcp.json` 的 MCP stdio 服务器（换行分隔 JSON-RPC，每调用 30 s，卸载杀进程）；配置缺失时安装失败并给指引 |
| `browser-automation` | `browser_navigate`、`browser_screenshot`、`browser_evaluate` | 用户自启带 `--remote-debugging-port` 的 Chrome 并手写配置后，经 CDP 驱动；仅公网目标；截图落 `browser-captures/` |
| `browser-pane` | 网页面板 | 用户驱动的沙箱 iframe（`allow-scripts allow-forms allow-popups`，无同源访问，`no-referrer`）；拒绝私网/本机主机；拒绝被嵌入的站点无法显示 |

## 配置文件

所有信任敏感面都是用户手写的文件。Agent 没有任何写入这些文件的工具，插件在
必需文件缺失时会拒绝安装。可直接复制的示例见
[`examples/plugin-config/`](../examples/plugin-config/README.zh.md)。

| 文件 | 插件 | 结构 |
| --- | --- | --- |
| `~/.three-studio/mcp.json` | `mcp-connectors` | `{"servers":[{"id":"blender","command":"node","args":["server.js"],"env":{"TOKEN":"…"}}]}` |
| `~/.three-studio/browser-automation.json` | `browser-automation` | `{"cdp":"127.0.0.1:9222"}` |
| `~/.three-studio/search.json` | `web-search`、`deep-research` | `{"provider":"tavily","key":"tvly-…"}` 或 `{"provider":"brave","key":"…"}`；省略则用 DuckDuckGo |
| `~/.three-studio/hooks.json` | `hooks` | `{"hooks":[{"event":"turn-end","say":"记住用米。"}]}` |
| `~/.three-studio/schedules.json` | `scheduled-tasks` | 插件写入；通过工具管理 |
| `~/.three-studio/memory.json` | `memory` | 插件写入；通过工具管理 |
| `~/.three-studio/context/*` | `context-files` | 平面文本文件；`AGENTS.md` 自动注入 |
| `~/.three-studio/deliverables/<会话>/` | `deliverables` | Agent 通过 `save_deliverable` 写入 |

MCP 服务器首次使用时懒启动，工作目录为 Studio 主目录，卸载时结束进程。
浏览器自动化只连接你自行启动的 Chrome，且只打开公网 `http(s)` 地址。
网页面板是不透明源的沙箱 iframe，不共享任何存储。

## 已知限制

- `web-search` 默认的 DuckDuckGo HTML 端点可能限流或改版；正式使用请配置
  Tavily/Brave。搜索结果只是数据，页面正文来自 `web_fetch`。
- `deep-research` 每次最多 3 个查询、4 个页面，并由一次子代理综合；无法读取
  付费墙或纯 JavaScript 渲染的页面。
- `browser-automation` 只支持导航、截图与表达式求值（不做点击/填表），且需要
  用户自行启动 Chrome。
- `browser-pane` 无法显示拒绝被嵌入的站点；按设计拒绝私网与回环主机。
- `mcp-connectors` 仅支持 stdio 传输与 tools 能力；MCP stderr 一律丢弃，
  密钥不会进入对话。
- `scheduled-tasks` 仅在独立服务器运行期间触发，且只作用于创建它的会话。
- `background-jobs` 只存在内存中：重启服务器会遗忘待处理任务。
- `voice-input` 依赖浏览器 SpeechRecognition 且需安装插件；每次点击听一句，
  不会自动发送。

## 目录条目

```js
{
  id: 'skills',
  nameZh: '技能库',
  nameEn: 'Skills library',
  descriptionZh: '...',
  descriptionEn: '...',
  category: 'agent',        // agent | workflow | connectors | content | interface
  glyph: 'bolt',            // StudioGlyph 名称
  source: 'packages/skill/skill + packages/client/ui-skill',
  tags: ['skills', 'prompt'],
  recommended: true,
  available: true,
  installed: false,         // 运行时计算
}
```

## 运行时契约

插件实现是一个 `activate(options)` 函数，返回清理函数。options 包括：

- `dataDir` — `~/.three-studio`
- `tools` — Agent 使用的实时 `Map<name, definition>`
- `promptSections` — 实时 `{name, order, text}` 数组
- `pluginRoutes` — 插件贡献的路由（`{method, path, handler(request, url)}`），
  仅安装期间存在
- `subscribe(event, handler)` — 尽力而为的事件总线（Agent 回合完成后触发
  `turn-end`）
- `submitPrompt(sessionId, text)` — 以与手动提示相同的管线启动回合
  （`scheduled-tasks` 使用）
- `modelSettings` — 供应商/凭据存储
- `runSubagent` — 一次性供应商补全
- `selectionOf(sessionId)` — 当前供应商/模型选择
- `scheduleTickMs` — 缩短定时任务 tick 的测试钩子

工具定义：

```js
{
  name,
  description,
  parameters: { /* JSON Schema */ },
  output: { schema, render(args, value), presentationMeta?(args, value) },
  async execute(args, exec) { /* 返回 JSON 安全值 */ },
}
```

`exec.agent.session.id` 是当前会话 id。工具结果会流入对话；`presentationMeta`
可附带场景/提案元数据。

## 新增插件

1. 在 `catalog.mjs` 添加目录条目（仅当确有实现时 `available: true`）。
2. 在 `runtime.mjs` 的 `IMPLEMENTATIONS` 添加入口。
3. 通过辅助函数注册工具/提示词段落；返回精确移除所添加内容的清理函数。
4. 校验全部工具参数，限制输出长度。
5. 在 `standalone/plugins/runtime.test.mjs` 或同级测试文件补测试。涉及新信任面的
   插件先写设计（参考 [TRUST-BOUNDARIES.zh.md](TRUST-BOUNDARIES.zh.md)）。
6. 运行：

```sh
~/.local/node24/bin/node --test standalone/plugins/runtime.test.mjs
```

## 安全规则

- 不执行第三方包代码，不从网络安装插件。
- 把技能文件、网页与 MCP 描述视为不可信提示输入。
- 网络工具拒绝私网/回环目标，并复查 DNS 与重定向。
- 限制工具输出、模型轮数与子代理调用次数。
- 工具输出与日志中不出现 API Key、token 或原始会话 id。
- 优先只读工具；破坏性操作必须经 UI 中用户明确批准后才执行。
