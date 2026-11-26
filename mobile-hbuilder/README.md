# CodexDeck HBuilderX 客户端

这是一个 uni-app Vue 2 的轻量 App 外壳。它加载电脑网关提供的现有移动网页，网页中的聊天、审批和令牌输入逻辑保持不变。

## 使用

1. 在 HBuilderX 中打开本目录。首次云打包前，在 `manifest.json` 的可视化界面获取 DCloud AppID，并设置你自己的 iOS Bundle ID。
2. 电脑上启动 Codex Desktop 与 CodexDeck 网关。手机必须能访问网关地址；不要把 CDP 端口开放到网络。建议在可信私网或 VPN 内访问，并配置网关访问令牌。
3. 在 App 首屏填写网关根地址，例如 `https://deck.example.com/` 或可信私网中的 `http://192.168.1.20:8787/`。真机首次连接会检查 `/api/health`；启用令牌时，网页随后会提示输入。
4. 进入网页后，App 专属的侧栏底部会显示「切换网关」按钮。普通浏览器不会显示这个入口。地址保存在 App 本地；令牌仍由网页放在当前 WebView 会话中。

`nativeResources/ios/info.plist` 允许 iOS WebView 加载 HTTP 网关，供可信私网使用；生产或跨公网访问建议使用 HTTPS。最终 IPA 的签名、云打包和设备安装由 HBuilderX 流程处理。

`manifest.json` 已配置 iOS 和 Android 桌面图标，图片位于 `static/icons/`。H5 预览会直接跳转到填写的网关网页；App WebView 会隐藏原生标题栏、关闭页面回弹、禁止双指缩放。App 根据系统状态栏高度调整网页顶部布局，底部布局保持原位。网页主题切换时，App 状态栏颜色和文字亮度会同步更新。

App 切回前台时，浏览页面的 `onShow` 会通知子网页同步最新对话；网页同时监听原生 `resume` 和浏览器可见性事件。网页反馈可随网关更新生效，新增的原生恢复通知需要重新编译 App 外壳。

## 本地验证

在仓库根目录执行 `node mobile-hbuilder/tests/gateway.mjs`，验证地址规范化和网关响应识别；`node mobile-hbuilder/tests/webview-layout.mjs` 验证布局注入及恢复通知。HBuilderX 编译及 iOS 真机连接仍需在 HBuilderX 和设备上检查。
