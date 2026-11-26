import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createWebviewSetupScript } from '../utils/webview-layout.js';

function run(readyState) {
  const app = { style: {} };
  const conversation = { style: {} };
  const sidebar = { style: {} };
  const conversationHead = { style: {} };
  const viewport = { content: '' };
  const elements = new Map([
    ['.app', app],
    ['.conversation', conversation],
    ['.sidebar', sidebar],
    ['.conversation-head', conversationHead],
    ['meta[name="viewport"]', viewport]
  ]);
  const events = [];
  let onReady;
  const context = {
    document: {
      readyState,
      querySelector: (selector) => elements.get(selector),
      addEventListener: (name, listener) => {
        assert.equal(name, 'DOMContentLoaded');
        onReady = listener;
      }
    },
    window: { innerWidth: 390, dispatchEvent: (event) => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } }
  };
  vm.runInNewContext(createWebviewSetupScript(47), context);
  if (readyState === 'loading') {
    assert.equal(app.style.paddingTop, undefined);
    onReady();
  }
  const inset = 'max(47px, env(safe-area-inset-top, 0px))';
  assert.equal(app.style.paddingTop, inset);
  assert.equal(conversation.style.height, `calc(100dvh - ${inset})`);
  assert.equal(sidebar.style.paddingTop, inset);
  assert.equal(conversationHead.style.minHeight, '68px');
  assert.equal(conversationHead.style.paddingTop, '2px');
  assert.equal(conversationHead.style.paddingBottom, '2px');
  assert.equal(app.style.paddingBottom, undefined);
  assert.equal(viewport.content.includes('user-scalable=no'), true);
  assert.deepEqual(events, ['codexdeck-app-ready']);
}

run('complete');
run('loading');

const source = readFileSync(new URL('../pages/browser/browser.vue', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace(/^import .*;\r?$/gm, '')
  .replace('export default', 'globalThis.page =');
const context = { console: { warn() {} } };
vm.runInNewContext(source, context);
context.page.onShow();
const events = [];
context.page.childWebview = { evalJS(script) {
  vm.runInNewContext(script, {
    window: { dispatchEvent: (event) => events.push(event.type) },
    Event: class { constructor(type) { this.type = type; } }
  });
} };
context.page.onShow();
assert.deepEqual(events, ['codexdeck-app-resume']);
console.log('App 顶部安全区布局与原生恢复通知验证通过');
