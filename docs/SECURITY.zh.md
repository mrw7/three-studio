# 安全与信任边界

Three Studio 是单用户本地应用。服务器只监听 `127.0.0.1`，没有账号体系。
请把它当作本地开发工具，而不是加固过的多租户服务。

## 浏览器与场景隔离

- 模型编写的场景代码运行在 `srcDoc` iframe 中，sandbox 为
  `allow-scripts allow-pointer-lock allow-downloads`。
- iframe 永不获得 `allow-same-origin`；无法读取应用存储、Cookie、宿主 API
  或 token。
- 场景从不能作为可导航 URL 提供；导出与分享查看器沿用同一沙箱。
- 父页面与 iframe 之间的消息按结构校验，绝不作为可执行输入。

## 数据与凭据

- 数据位于 `~/.three-studio`（可用 `THREE_STUDIO_HOME` 覆盖）。
- `credentials.json` 以 `0600` 写入；API Key 从 UI 只写，API 永不返回。
- 供应商设置只含端点与模型 id，不含密钥。
- 应用不收集也不发送任何遥测。
- 删除 `~/.three-studio` 即删除全部本地 Studio 数据。

## 网络出口

- 出站请求仅限：你配置的模型供应商调用、显式 `web_fetch`、
  `web_search`/`deep_research` 查询、你配置的 MCP 服务器，以及你指定的
  浏览器自动化 CDP 端点。除此之外没有任何出站流量，也没有遥测。
- `web_fetch` 与 `deep_research` 只接受公网 `http(s)` 地址，拒绝
  `localhost`、环回、链路本地、CGNAT、私网 IPv4/IPv6 与 `.local` 主机名；
  请求前解析 DNS，每次重定向后复查，并限制响应大小。
- `web_search` 默认访问 DuckDuckGo HTML 端点；只有你在
  `~/.three-studio/search.json` 配置 key 后才使用 Tavily/Brave。搜索 key
  不会被 API 返回，也不会写入日志。
- `browser-automation` 对每次导航应用同一套公网守卫，拒绝私网与本机主机；
  它不会自行启动 Chrome，也无法自行开启。
- `browser-pane` 由 iframe 直接加载站点（不透明源），服务器不代理这些流量；
  面板不发送 referrer，与 Studio 不共享 Cookie 或存储。

## Agent 与插件

- Agent 只能调用当前注册的工具：场景工具 + 已安装插件工具。
- 插件是本仓库的原生模块；市场不会下载或执行第三方插件代码。
- 技能文件、抓取页面与工具描述是不可信提示输入，可影响模型，但本身不会获得
  代码执行能力。
- 子代理沿用当前供应商凭据，每次调用仅限一次。
- 破坏性场景操作走带 revision 校验的编辑协议；提案在用户应用前是惰性的。
- 信任配置由用户手写且对 Agent 只读：`mcp.json`、`browser-automation.json`、
  `hooks.json`、`search.json` 没有任何写入工具。MCP 与浏览器自动化在配置
  不存在时拒绝安装，不存在半启用状态。
- MCP 服务器是用户选择的子进程（等价于用户自己运行）；stderr 一律丢弃，
  密钥不会进入对话。MCP 工具描述属于不可信提示输入。
- `file-browser` 的工具与路由共用一套守卫：仅相对路径、禁止 `..`、禁止绝对
  路径、永远拒绝 `credentials.json`、拒绝二进制；这些路由仅在插件安装期间存在。
- 插件路由只在内置 API 路由之后、且方法与路径精确匹配时分发；卸载即移除。
- `hooks` 可以观察已完成的回合，但不能注入可执行内容：其记录只是下一段
  提示词里的纯文本。

## 文件、导出与分享

- 资产上传/删除路由按会话隔离并限制大小。
- 导出与分享文档从当前场景生成，不嵌入 API Key、会话 token 或本地路径。
- 离开 Studio 后，生成的 HTML/GLB/PNG/USDZ/FBX 均视为不可信内容。
- 交付文件与工作区读取被限制在 Studio 主目录内；越界路径在触盘前即被拒绝。

## 已知限制

- 回环绑定是唯一的访问控制。请不要在未加认证与 TLS 的情况下把端口暴露到
  不可信网络。
- 磁盘场景存储有锁与恢复路径；`tests/disk.test.mjs` 覆盖失败模式，在当前
  环境的本地默认测试中被排除。
- 模型供应商会收到回答问题所需的提示与工具上下文；发送敏感内容前请审阅
  其留存与数据政策。
- 网页搜索的免费 DuckDuckGo 端点可能限流或改版；需要稳定请使用带 key 的
  供应商。
- MCP 仅支持 stdio + tools（无 HTTP/SSE、sampling、roots）。
- 网页面板无法显示拒绝被嵌入的站点；其渲染内容的安全性由站点自身负责，
  且它无法访问 Studio 数据。
- 定时任务与后台任务仅在本地服务器运行期间执行；后台结果保存在内存中。

## 报告漏洞

请通过仓库的私有 GitHub Security Advisory 报告。不要在公开 issue 中包含
API Key、token 或用户会话内容。
