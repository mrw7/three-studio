# 插件配置示例

信任敏感的插件面从 `~/.three-studio` 读取文件。复制示例、按需修改，然后重新
安装插件：

```sh
mkdir -p ~/.three-studio/context
cp examples/plugin-config/mcp.example.json ~/.three-studio/mcp.json
```

| 文件 | 复制到 | 插件 | 说明 |
| --- | --- | --- | --- |
| `mcp.example.json` | `~/.three-studio/mcp.json` | `mcp-connectors` | `command` 会以子进程执行，工作目录为 Studio 主目录。只添加你信任的服务器；不需要的 `env` 项请删除。 |
| `browser-automation.example.json` | `~/.three-studio/browser-automation.json` | `browser-automation` | 请自行启动 Chrome：`chrome --remote-debugging-port=9222`（先关闭其他实例，或使用独立 profile）。 |
| `search.example.json` | `~/.three-studio/search.json` | `web-search`、`deep-research` | 不创建该文件即使用 DuckDuckGo；把 `provider` 设为 `tavily` 或 `brave` 并填入 key。key 只留在本地，API 永不返回。 |
| `hooks.example.json` | `~/.three-studio/hooks.json` | `hooks` | `say` 内容会在回合完成后作为纯文本注入（最近 5 条、≤1000 字符）。 |
| `AGENTS.example.md` | `~/.three-studio/context/AGENTS.md` | `context-files` | 每个会话都会注入的项目约定（≤6000 字符）。 |

共同规则：

- 这些文件刻意由用户手写。Agent 没有任何写入它们的工具，因此无法自行获得新的
  网络或进程能力。
- 不要把凭据放进这些文件；模型 API Key 存在 `credentials.json`（由设置界面管理）。
- 修改后请卸载并重新安装插件（`hooks`/`mcp` 在安装时加载的配置需要重启服务器）。

完整契约见 [docs/PLUGINS.zh.md](../../docs/PLUGINS.zh.md)，信任模型见
[docs/SECURITY.zh.md](../../docs/SECURITY.zh.md)。
