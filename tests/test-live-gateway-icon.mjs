import assert from 'node:assert/strict';
import { DesktopBridge } from '../src/desktop-bridge.mjs';

const bridge = new DesktopBridge(Number(process.env.CODEX_CDP_PORT || 49397));
let opened = 0;
bridge.onOpenLauncher = () => { opened++; };
const inspect = `(() => {
  const icon = document.getElementById('codexdeck-gateway-icon');
  const footer = icon?.nextElementSibling;
  const settings = footer?.querySelector('button[aria-haspopup="menu"]');
  const rect = (element) => {
    const bounds = element?.getBoundingClientRect();
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
  };
  return {
    count: document.querySelectorAll('#codexdeck-gateway-icon').length,
    button: icon?.tagName === 'BUTTON' && icon.type === 'button',
    nativeStyle: icon?.className === settings?.className &&
      icon?.getAttribute('data-variant') === settings?.getAttribute('data-variant'),
    inRail: icon?.parentElement?.matches('[data-app-navigation-rail="true"]') || false,
    icon: rect(icon), settings: rect(settings),
    glyph: rect(icon?.firstElementChild), gear: rect(settings?.querySelector('svg')),
  };
})()`;

function verify(value) {
  assert.equal(value.count, 1, '网关图标应只有一个');
  assert.equal(value.button, true, '网关图标应为支持键盘操作的按钮');
  assert.equal(value.nativeStyle, true, '网关按钮应复用设置按钮的交互样式');
  assert.equal(value.inRail, true, '网关图标应位于 Desktop 图标栏内');
  for (const key of ['width', 'height']) {
    assert.equal(value.icon[key], value.settings[key], '图标占位应与设置按钮一致');
    assert.equal(value.glyph[key], value.gear[key], '图案尺寸应与设置齿轮一致');
  }
  assert.equal(value.icon.x, value.settings.x, '网关图标应与设置按钮对齐');
  assert.ok(value.icon.y + value.icon.height <= value.settings.y, '网关图标应位于设置按钮上方');
}

try {
  verify(await bridge.evaluate(inspect));
  await bridge.evaluate(`window.__desktopGatewayApprovalHook.mountGatewayIcon();
    window.__desktopGatewayApprovalHook.mountGatewayIcon()`);
  verify(await bridge.evaluate(inspect));
  // 只移除本项目插入的节点，验证页面重绘后的恢复，不刷新正在工作的 Desktop。
  await bridge.evaluate(`document.getElementById('codexdeck-gateway-icon').remove();
    window.__desktopGatewayApprovalHook.mountGatewayIcon()`);
  const value = await bridge.evaluate(inspect);
  verify(value);
  await bridge.evaluate("document.getElementById('codexdeck-gateway-icon').click()");
  for (let attempt = 0; attempt < 20 && !opened; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(opened, 1, '一次点击应发送一次唤起控制台的事件');
  console.log('网关按钮验证通过：原生样式、位置、尺寸、重复挂载、节点恢复和点击事件均正常');
  console.log(JSON.stringify(value));
} finally {
  bridge.close();
}
