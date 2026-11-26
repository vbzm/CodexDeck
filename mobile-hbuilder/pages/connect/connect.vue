<template>
	<view class="page">
		<view class="card">
			<text class="eyebrow">CODEXDECK</text>
			<text class="title">连接电脑网关</text>
			<text class="description">输入手机浏览器访问 CodexDeck 时使用的地址。</text>

			<text class="label">网关地址</text>
			<input v-model="address" class="address" type="text" placeholder="https://your-gateway.example/"
				:disabled="checking" confirm-type="go" @confirm="connect" />
			<text v-if="error" class="error">{{ error }}</text>
			<button class="connect-button" :loading="checking" :disabled="checking" @click="connect">
				{{ checking ? '正在连接…' : '打开 CodexDeck' }}
			</button>

			<text class="hint">网关启用令牌时，打开网页后会提示输入。HTTP 地址仅适合可信私网或 VPN。</text>
		</view>
	</view>
</template>

<script>
	import {
		GATEWAY_URL_KEY,
		normalizeGatewayUrl,
		isGatewayHealthResponse
	} from '../../utils/gateway.js';

	export default {
		data() {
			return {
				address: '',
				checking: false,
				error: ''
			};
		},
		onLoad(options) {
			this.address = uni.getStorageSync(GATEWAY_URL_KEY) || '';
			// #ifdef APP-PLUS
			if (this.address && options.edit !== '1') {
				uni.redirectTo({
					url: '/pages/browser/browser'
				});
			}
			// #endif
		},
		methods: {
			connect() {
				if (this.checking) return;
				this.error = '';
				const gatewayUrl = normalizeGatewayUrl(this.address);
				// 以下校验在部分 App 运行环境中误拦截可用地址，暂按实际连接结果判断。
				// if (!gatewayUrl) {
				// 	this.error = '请输入以 http:// 或 https:// 开头的网关根地址';
				// 	return;
				// }
				// H5 预览受跨域和 iframe 限制，直接以顶层页面打开网关。
				// #ifdef H5
				window.location.assign(gatewayUrl);
				return;
				// #endif
				this.checking = true;
				uni.request({
					url: gatewayUrl + 'api/health',
					method: 'GET',
					timeout: 5000,
					success: ({
						statusCode,
						data
					}) => {
						if (!isGatewayHealthResponse(statusCode, data)) {
							this.error = '该地址没有返回 CodexDeck 网关信息';
							return;
						}
						uni.setStorageSync(GATEWAY_URL_KEY, gatewayUrl);
						uni.redirectTo({
							url: '/pages/browser/browser'
						});
					},
					fail: () => {
						this.error = '连接失败，请检查电脑网关、地址和网络';
					},
					complete: () => {
						this.checking = false;
					}
				});
			}
		}
	};
</script>

<style>
	.page {
		min-height: 100vh;
		padding: 24px 16px;
		box-sizing: border-box;
		background: #f7f7f5;
	}

	.card {
		max-width: 380px;
		margin: 30px auto 0;
		padding: 24px 20px;
		box-sizing: border-box;
		border: 1px solid #e4e4e0;
		border-radius: 12px;
		background: #fff;
	}

	.eyebrow,
	.title,
	.description,
	.label,
	.error,
	.hint {
		display: block;
	}

	.eyebrow {
		color: #747777;
		font-size: 11px;
		letter-spacing: 1.5px;
	}

	.title {
		margin-top: 9px;
		font-size: 22px;
		font-weight: 600;
	}

	.description {
		margin-top: 10px;
		color: #666a69;
		font-size: 14px;
		line-height: 1.6;
	}

	.label {
		margin-top: 26px;
		margin-bottom: 8px;
		font-size: 14px;
		font-weight: 600;
	}

	.address {
		height: 44px;
		padding: 0 11px;
		border: 1px solid #c9ccca;
		border-radius: 7px;
		font-size: 14px;
		background: #fff;
	}

	.error {
		margin-top: 9px;
		color: #b42318;
		font-size: 13px;
		line-height: 1.5;
	}

	.connect-button {
		margin-top: 18px;
		border-radius: 7px;
		background: #252626;
		color: #fff;
		font-size: 15px;
	}

	.hint {
		margin-top: 14px;
		color: #777b79;
		font-size: 12px;
		line-height: 1.6;
	}
</style>
