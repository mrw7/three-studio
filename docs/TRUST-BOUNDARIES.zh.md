# 插件信任边界

本页冻结三个信任敏感插件面——MCP 连接器、浏览器自动化、网页面板——允许的
工作方式。它是代码背后的契约；修改应当有意识进行，而不是顺手为之。

## 共同原则

1. **配置归用户所有。** 三者的可信配置都是你手写的文件（`mcp.json`、
   `browser-automation.json`）或你在面板里输入的 URL。Agent 没有任何写入
   这些面的工具。
2. **安装即同意。** 配置缺失时 `mcp-connectors` 与 `browser-automation` 安装
   直接失败并给出具体指引；不存在半启用状态，Agent 也无法自行启用。
3. **最小暴露。** Agent 只拿到通用调用面（`mcp_call_tool`、
   `browser_navigate/screenshot/evaluate`），看不到进程列表、环境变量或 CDP
   端点细节；错误信息截断且不回显密钥。
4. **生命周期随插件。** 卸载会结束 MCP 子进程、关闭 CDP socket、移除路由；
   定时器均 `unref`，不会阻止服务器退出。

## MCP 连接器

- 传输：stdio + 换行分隔 JSON-RPC（MCP 基础协议），每个服务器懒启动一个子
  进程，`cwd` 为 `~/.three-studio/mcp/<id>/`（绝不是存放凭据与会话文件的
  Studio 主目录）。
- 上限：8 个服务器、64 个工具、每调用 30 s、初始化 8 s。
- 隔离：服务器 stderr 一律丢弃（可能含密钥）；只传最小基础环境（`PATH`、
  `HOME`/`USERPROFILE`、临时目录与 locale 变量）加上用户声明的 `env`；
  服务器 id 限制为 `[a-z0-9][a-z0-9_-]`；工具描述在进入提示词前截断。
- 接受的残余风险：本地 MCP 服务器是用户选择运行的程序；Agent 调用其工具正是
  用户选择开启的能力。它与 Studio 使用同一 OS 用户运行，仍可通过绝对路径读取
  Studio 主目录；只安装你信任的 MCP 服务器。

## 浏览器自动化

- 前提：用户以 `--remote-debugging-port` 启动 Chrome 并手写
  `browser-automation.json`；Agent 无法开启。
- 目标守卫：与 `web_fetch` 相同的公网规则（拒绝环回、私网、链路本地与
  CGNAT；域名解析后复查全部地址）。
- CDP 客户端：自研实现（fetch `/json/version` + 全局 WebSocket），零第三方
  依赖；15–20 s 超时，加载事件等待超时后放行而不是挂死。
- 截图：写入 `browser-captures/`（0600），不以二进制进入对话。

## 网页面板

- 纯客户端能力，服务端零贡献。
- iframe sandbox 固定为
  `allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox`——
  **永不加** `allow-same-origin`，因此页面是不透明源，无法访问 Studio 或站点
  存储；`referrerPolicy` 为 `no-referrer`。
- 地址只能由用户输入；客户端拒绝私网与环回主机。iframe 直连目标站点，服务器
  从不代理，因此没有 SSRF 面。
- 已知限制：发送 `X-Frame-Options`/frame-ancestors 的站点无法显示，面板中
  已说明。

## 明确不做

- 任何 Agent 可写入信任配置的路径。
- Agent 驱动网页面板。若将来要做，必须走 `propose_actions` 的用户确认模式。
- MCP 的 HTTP/SSE 传输、sampling 与 roots（只做 stdio + tools）。
