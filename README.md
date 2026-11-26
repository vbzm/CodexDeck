# CodexDeck

CodexDeck 是运行在 Windows 本机的 Codex Desktop 网关和自适应网页。它通过 Desktop 当前页面读取 Desktop 的项目状态，并把聊天与回合请求转发给 Desktop 已连接的**同一个 app-server**；网关不启动独立的 Codex CLI 会话。

## 当前功能

- 读取 Desktop 项目列表；展开项目查看对应工作目录的聊天，并从项目中新建聊天草稿。
- 在网页浏览电脑磁盘和文件夹，选择已有目录注册为 Desktop 本地项目；“信任并创建”会确认 Desktop 对该目录的信任提示。
- 新建聊天先保存在当前浏览器会话，发送首条消息时才创建 Desktop 聊天。
- 侧边栏不显示工作目录输入；全局新建聊天沿用当前聊天目录，项目内“＋”使用该项目根目录，均无选择时回退到网关默认目录。
- 分页读取回合、发送消息、中断回合、显示运行状态和命令审批；发送按钮在运行时变为停止按钮。
- Desktop 提问显示为可交互面板，支持选项、自填、多题和异步跳过；只展示待答题，回答成功后卡片移除，答案回传原问题或原回合。
- 切回 App 或网页时显示最新对话的同步进度，失败或超时可重试；停止按钮点击后立即转圈并显示“正在停止”。
- 长回合按过程条目分页读取，保留首条消息和最终回复，可按需加载更早过程；折叠的工具输出在展开时才格式化，避免长历史拖住页面。
- 输入框上方显示 Desktop 目标状态、目标内容及用量；通过目标图标或 `/goal 目标内容` 设置目标，并支持编辑、暂停、恢复和清除。停止带目标的任务时先暂停目标，再中断回合。
- 对话中独立显示“正在压缩上下文”“上下文已压缩”或“上下文已自动压缩”；压缩超过 10 秒显示 Desktop 的等待提示，中断时显示“压缩已中断”。
- Markdown 消息、默认折叠的两层活动详情、浅色/深色主题、桌面和手机布局。
- 从 Desktop 模型目录选择模型与思考等级，下一回合沿用所选设置；用圆环和悬停说明显示上下文用量。
- 在输入框选择“请求批准”“帮我批准”或“完全访问权限”；新聊天默认允许写入工作目录，已有聊天在发送下一条消息时应用所选权限。
- 侧边栏按“进行中 → 项目 → 最近”排序并可折叠，未读完成聊天显示蓝点，阅读后同步 Desktop 未读状态。

## Windows 桌面启动器

安装版和便携版 exe 打开约 820×580 的控制台并在系统托盘常驻。默认只检查 Desktop 与网关状态；点击“启动全部”后，启动器按 Desktop/CDP → 网关的顺序启动。已有 Desktop 未启用 CDP 时，会先要求保存工作并确认重启。分发版自带网关运行环境，不要求用户安装 Node.js。完整操作、配置、冲突处理和打包说明见 [Windows 启动器](Docs/启动器.md)。

开发环境运行 `npm run desktop:start`；执行 `npm run dist:win` 可在 `release/` 构建 NSIS 安装程序与便携版 exe。

## 源码手动启动

要求：Windows 上已安装并配置好 Codex Desktop，Node.js 24 或更新版本。**不需要 ChatGPT 登录态；Desktop 使用 API 形式也可以。**

在此目录运行：

```powershell
npm ci
./scripts/start-desktop-cdp.ps1 -ProbeOnly
npm start
```

打开 [http://127.0.0.1:8787/](http://127.0.0.1:8787/)。如果探测提示 CDP 未启用，请先在 Codex Desktop 中保存工作、手动退出 Desktop，再运行 `./scripts/start-desktop-cdp.ps1`。此脚本只在 Desktop 未运行时启动 Windows Store 版应用，并把 CDP 绑定到 `127.0.0.1:49397`；它不会强制关闭已有 Desktop。随后运行 `npm start`。

Desktop 已启用 CDP 时可直接运行 `npm start`。Desktop 临时退出时，网关会等待它回来并重连。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEX_CDP_PORT` | `49397` | Desktop 本机 CDP 端口；自定义时启动脚本的 `-Port` 也要相同。 |
| `CODEX_GATEWAY_PORT` | `8787` | 网关 HTTP 端口。 |
| `CODEX_GATEWAY_HOST` | `127.0.0.1` | 网关监听地址。 |
| `CODEX_GATEWAY_WORKSPACE` | CodexDeck 目录 | 网页新聊天的默认工作目录。 |
| `CODEX_GATEWAY_TOKEN` | 空 | 可自行设置任意长度，也可留空。 |

手机访问时，在可信的私网/VPN 中设置 `CODEX_GATEWAY_HOST` 为电脑的私网地址；建议配置访问令牌，网页会提示输入，令牌仅存于该浏览器会话。留空时该监听地址上的设备可直接调用网关。CDP 端口始终只绑定本机，不应映射到其他设备或公网。本原型提供 HTTP，跨设备传输应通过可信 VPN 或受保护的反向代理。尚未验证真实手机到电脑的网络连通性。

## 验证与开发

```powershell
npm test
npm run test:live
npm run test:ui
npm run test:goals:ui
npm run test:questions:ui
npm run test:sync:ui
npm run test:activity:ui
node mobile-hbuilder/tests/webview-layout.mjs
```

`npm test` 检查模块语法与模型参数校验；`test:live` 在网关和 Desktop 运行时只读检查页面资源、连接、模型、目录、未读状态、项目和聊天接口；`test:ui` 在独立 Electron 窗口检查网页交互，并将截图保存到本地 `Docs/截图/`。启动器另有 `npm run desktop:test`、`npm run desktop:test:ui` 和 `npm run desktop:test:gateway`。详见 [接手指南](Docs/接手指南.md)、[开发说明](Docs/开发说明.md) 和 [架构与接口](Docs/架构.md)。

## 已知边界

- Desktop 页面桥接、本地项目服务和状态请求并非稳定公开 API；Desktop 更新后需要重新验证。
- 模型列表取自 Desktop；当前 API 中转服务未必支持列表中的每个模型，实际发送失败时页面会显示上游错误。
- 项目内旧聊天按项目根目录的**精确**工作目录读取。旧聊天若在根目录下的子目录创建，仍可在“最近对话”中看到，但可能不在项目展开列表中。
- 网页支持命令审批和 Desktop 的同步／异步提问；文件和其他审批仍需回 Desktop。断线前没捕获的命令审批也需在 Desktop 处理。
- “中断”结束当前回合，下一条消息会开始新回合，不会继续原推理位置。
- 当前版本没有附件、推送通知或 WebSocket 实时流。网页状态采用定时轮询；`mobile-hbuilder/` 提供加载同一网页的轻量 App 外壳。

## 许可证

本项目采用 MIT 许可证。详见 [LICENSE](LICENSE)。
