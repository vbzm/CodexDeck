<template>
  <web-view
    v-if="gatewayUrl"
    :src="gatewayUrl"
    :update-title="false"
    :webview-styles="webviewStyles"
  ></web-view>
</template>

<script>
import { GATEWAY_URL_KEY, normalizeGatewayUrl } from '../../utils/gateway.js';
import { createWebviewSetupScript } from '../../utils/webview-layout.js';

export default {
  data() {
    return {
      gatewayUrl: '',
      statusBarHeight: 0,
      webviewStyles: {
        bottom: '0px',
        bounce: 'none',
        background: '#f7f7f5',
        backgroundColorTop: '#f7f7f5',
        backgroundColorBottom: '#f7f7f5'
      }
    };
  },
  onLoad() {
    const systemInfo = uni.getSystemInfoSync();
    const statusBarHeight = Math.max(
      Number(systemInfo.statusBarHeight) || 0,
      Number(systemInfo.safeAreaInsets && systemInfo.safeAreaInsets.top) || 0
    );
    this.statusBarHeight = statusBarHeight;

    const saved = uni.getStorageSync(GATEWAY_URL_KEY);
    const gatewayUrl = normalizeGatewayUrl(saved);
    if (!gatewayUrl) {
      uni.redirectTo({ url: '/pages/connect/connect?edit=1' });
      return;
    }
    this.gatewayUrl = gatewayUrl;
  },
  onReady() {
    // #ifdef APP-PLUS
    this.attachWebview();
    // #endif
  },
  onShow() {
    // #ifdef APP-PLUS
    // 原生页面恢复时通知子网页，部分 WebView 不会触发可见性事件。
    try {
      if (this.childWebview) {
        this.childWebview.evalJS("window.dispatchEvent(new Event('codexdeck-app-resume'));");
      }
    } catch (error) {
      console.warn('CodexDeck 恢复通知发送失败', error);
    }
    // #endif
  },
  onUnload() {
    // #ifdef APP-PLUS
    clearTimeout(this.webviewTimer);
    if (this.childWebview) {
      this.childWebview.removeEventListener('loaded', this.onWebviewLoaded);
    }
    // #endif
  },
  methods: {
    attachWebview(attempt = 0) {
      // #ifdef APP-PLUS
      const pageWebview = this.$scope.$getAppWebview();
      const childWebview = pageWebview && pageWebview.children()[0];
      if (!childWebview) {
        if (attempt < 20) this.webviewTimer = setTimeout(() => this.attachWebview(attempt + 1), 100);
        else console.warn('CodexDeck 网页容器未就绪');
        return;
      }
      this.childWebview = childWebview;
      this.statusBarHeight = Math.max(
        this.statusBarHeight,
        Number(plus.navigator.getStatusbarHeight()) || 0
      );
      // App-PLUS 原生 WebView 仍可能响应系统缩放手势，显式关闭它。
      childWebview.setStyle({
        bottom: '0px',
        scalable: false
      });
      childWebview.overrideUrlLoading({
        mode: 'reject',
        match: '^codexdeck-app://switch-gateway/?$'
      }, () => uni.redirectTo({ url: '/pages/connect/connect?edit=1' }));
      childWebview.addEventListener('loaded', this.onWebviewLoaded);
      this.onWebviewLoaded();
      // #endif
    },
    onWebviewLoaded() {
      // #ifdef APP-PLUS
      try {
        if (this.childWebview) {
          this.childWebview.evalJS(createWebviewSetupScript(this.statusBarHeight));
        }
      } catch (error) {
        // WebView 已经可以显示时，注入失败不应阻断网页使用。
        console.warn('CodexDeck App 通信初始化失败', error);
      }
      // #endif
    }
  }
};
</script>

<style>
page {
  overflow: hidden;
  background: #f7f7f5;
}
</style>
