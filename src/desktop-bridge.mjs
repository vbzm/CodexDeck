const PAGE_URL = 'app://-/index.html';
const LAUNCHER_BINDING = '__codexdeckOpenLauncher';
const THREAD_READ_METHODS = new Set(['thread/read', 'thread/resume', 'thread/turns/list',
  'thread/items/list', 'thread/goal/get']);

// 这些函数会以源码形式交给桌面页面执行，只使用页面内可用的对象。
function rendererRequest(request) {
  const id = 'desktop-gateway-' + crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event) => {
      const data = event.data;
      if (data?.type !== 'mcp-response' || data.message?.id !== id) return;
      cleanup();
      if (data.message.error) reject(Object.assign(new Error(data.message.error.message), { code: data.message.error.code }));
      else resolve(data.message.result);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('桌面 app-server 响应超时'));
    }, 20000);
    window.addEventListener('message', onMessage);
    window.electronBridge.sendMessageFromView({
      type: 'mcp-request',
      hostId: 'local',
      request: { id, method: request.method, params: request.params },
      priority: 'interactive',
      source: 'turn',
    }).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}

function rendererArm() {
  const previous = window.__desktopGatewayApprovalHook;
  if (previous?.version === 5) {
    previous.mountGatewayIcon();
    return true;
  }
  if (previous?.onMessage) window.removeEventListener('message', previous.onMessage);
  const queue = previous?.queue || [];
  const statuses = previous?.statuses || [];
  const mountGatewayIcon = () => {
    const rail = document.querySelector('[data-app-navigation-rail="true"]');
    const footer = rail?.lastElementChild;
    const settings = footer?.querySelector('button[aria-haspopup="menu"]');
    const gear = settings?.querySelector('svg');
    if (!gear) return;
    const buttonBounds = settings.getBoundingClientRect();
    const gearBounds = gear.getBoundingClientRect();
    if (!buttonBounds.width || !buttonBounds.height || !gearBounds.width || !gearBounds.height) return;

    let icon = document.getElementById('codexdeck-gateway-icon');
    if (icon && icon.tagName !== 'BUTTON') {
      icon.remove();
      icon = null;
    }
    if (!icon) {
      icon = document.createElement('button');
      icon.id = 'codexdeck-gateway-icon';
      icon.type = 'button';
      icon.setAttribute('aria-label', '打开 CodexDeck 网关控制台');
      icon.title = '打开 CodexDeck 网关控制台';
      icon.addEventListener('click', () => window.__codexdeckOpenLauncher('show'));
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 20 20');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.4');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const arrows = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arrows.setAttribute('d', 'M3 6h14m-4-4 4 4-4 4M17 14H3m4-4-4 4 4 4');
      svg.append(arrows);
      icon.append(svg);
    }
    // 复用原生按钮的主题、悬停和焦点样式，尺寸跟随齿轮；不复制其菜单行为。
    icon.className = settings.className;
    for (const attribute of ['data-color', 'data-variant', 'data-squircle', 'data-uniform', 'data-size', 'data-icon-size']) {
      const value = settings.getAttribute(attribute);
      if (value === null) icon.removeAttribute(attribute);
      else icon.setAttribute(attribute, value);
    }
    Object.assign(icon.style, {
      display: 'grid', placeItems: 'center', flexShrink: '0', padding: '0',
      width: buttonBounds.width + 'px', height: buttonBounds.height + 'px',
    });
    Object.assign(icon.firstElementChild.style, {
      width: gearBounds.width + 'px', height: gearBounds.height + 'px',
    });
    if (icon.parentElement !== rail || icon.nextElementSibling !== footer) rail.insertBefore(icon, footer);
  };
  mountGatewayIcon();
  const onMessage = (event) => {
    const data = event.data;
    if (data?.type === 'mcp-request') {
      const request = data.request ?? data.message;
      if (!request?.method?.endsWith('/requestApproval')) return;
      queue.push({
        hostId: data.hostId ?? 'local',
        id: request.id,
        method: request.method,
        params: request.params,
      });
      if (queue.length > 100) queue.shift();
    } else if (data?.type === 'mcp-notification') {
      const notification = data.notification ?? data.message ?? data;
      if (data.hostId && data.hostId !== 'local') return;
      if (!['error', 'turn/completed', 'item/started', 'item/completed',
        'thread/goal/updated', 'thread/goal/cleared'].includes(notification?.method)) return;
      statuses.push({ method: notification.method, params: notification.params });
      if (statuses.length > 100) statuses.shift();
    }
  };
  window.addEventListener('message', onMessage);
  window.__desktopGatewayApprovalHook = { version: 5, queue, statuses, onMessage, mountGatewayIcon };
  return true;
}

function rendererDrain() {
  const hook = window.__desktopGatewayApprovalHook;
  // 复用已有轮询，在侧边栏重绘后恢复图标，避免增加整页 DOM 监听。
  hook?.mountGatewayIcon?.();
  return hook ? { approvals: hook.queue.splice(0, 100), statuses: hook.statuses.splice(0, 100) } : null;
}

function rendererApprovalResponse(approval) {
  return window.electronBridge.sendMessageFromView({
    type: 'mcp-response',
    hostId: approval.hostId,
    response: { id: approval.id, result: { decision: approval.decision } },
  });
}

async function rendererDesktopServices(matches) {
  // Desktop 的打包方式会变化：旧版直接导出服务，新版从已加载的 Rspack 模块缓存读取。
  const shared = document.querySelector('link[href*="/assets/app-shared-"][href$=".js"]');
  const urls = [...new Set([shared?.href, ...Array.from(document.scripts || [])
    .filter((script) => script.type === 'module' && script.src).reverse().map((script) => script.src)]
    .filter(Boolean))];
  if (!urls.length) throw new Error('Desktop 状态模块未加载');
  const findHost = (exports) => {
    if (!exports || !['object', 'function'].includes(typeof exports)) return null;
    if (matches(exports)) return exports;
    for (const key of Object.keys(exports)) {
      // 某些无关模块的导出 getter 尚未初始化，不应阻断其它模块的查找。
      let value;
      try { value = exports[key]; } catch { continue; }
      if (value && typeof value === 'object' && matches(value)) return value;
    }
    return null;
  };
  for (const url of urls) {
    const module = await import(url);
    const direct = findHost(module);
    if (direct) return direct;
    // 只检查已经执行过的模块，避免主动加载无关功能或创建第二套服务实例。
    for (const cached of Object.values(module.__webpack_require__?.c || {})) {
      const host = findHost(cached.exports);
      if (host) return host;
    }
  }
  return null;
}

async function rendererListProjects(loadServices) {
  // Desktop 侧边栏使用本地项目表；app-server 的 project/list 可能包含未在侧边栏注册的项目。
  // 新版项目与排序已迁入专用服务，直接读取可与侧边栏保持同步。
  const host = await loadServices((value) =>
    typeof value.projectCatalog?.readLocalProjects === 'function' &&
    typeof value.projectPresentation?.readOrder === 'function');
  if (!host) throw new Error('Desktop 状态接口已变化');
  const [projects = {}, order = []] = await Promise.all([
    host.projectCatalog.readLocalProjects(),
    host.projectPresentation.readOrder(),
  ]);
  return Object.values(projects).map((project) => ({
    id: project.id,
    name: project.name,
    roots: (project.rootPaths || []).map((path) => ({ path })),
    position: order.indexOf(project.id) < 0 ? order.length : order.indexOf(project.id),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }));
}

async function rendererCreateLocalProject(loadServices, project) {
  // 通过 Desktop 自己的项目服务注册，才能同步其侧边栏与任务创建列表。
  const host = await loadServices((value) =>
    typeof value.projects?.createLocal === 'function');
  if (!host) throw new Error('Desktop 项目接口已变化');
  return host.projects.createLocal({
    appearance: null,
    initializeDefaultWorkspaceGitRepository: false,
    name: project.name,
    setActive: false,
    sources: [project.path],
  });
}

function rendererTrustProjectFolder(expectedPath) {
  const normalize = (value) => value.replaceAll('/', '\\').replace(/[\\/]+$/, '').toLowerCase();
  const target = normalize(expectedPath);
  for (const dialog of document.querySelectorAll('[role="dialog"], dialog')) {
    const lines = dialog.innerText.split(/\r?\n/).map((line) => line.trim());
    if (!lines.some((line) => normalize(line) === target)) continue;
    const trust = [...dialog.querySelectorAll('button')].find((button) =>
      ['信任文件夹', 'Trust folder', 'Trust folders'].includes(button.innerText.trim()));
    if (!trust) continue;
    trust.click();
    return true;
  }
  return false;
}

async function rendererReadState(loadServices, threadId = null) {
  const host = await loadServices((value) =>
    typeof value.threadReadState?.open === 'function');
  if (!host) throw new Error('Desktop 未读状态接口已变化');
  const changes = [];
  const state = await host.threadReadState.open((event) => changes.push(event));
  try {
    if (state.status !== 'ready') throw new Error('Desktop 未读状态暂不可用');
    const ids = new Set(state.unreadThreadIdsByHostId.local || []);
    if (threadId) {
      const result = await state.session.set({ hostId: 'local', threadId, hasUnreadTurn: false });
      if (result.status !== 'ok') throw new Error('Desktop 已读状态保存失败');
    }
    // 处理读取期间的更新；账号切换会使会话失效，不能把旧账号快照当作当前状态。
    for (const event of changes) {
      if (event.type === 'retired') throw new Error('Desktop 未读状态已失效，请重试');
      if (event.hostId === 'local') {
        if (event.hasUnreadTurn) ids.add(event.threadId);
        else ids.delete(event.threadId);
      }
    }
    if (threadId) ids.delete(threadId);
    return [...ids];
  } finally {
    // 每次请求结束后释放订阅，避免定时刷新不断积累监听。
    state[Symbol.dispose]();
  }
}

async function rendererUserInput(loadServices, input) {
  const host = await loadServices((value) => value.appServerManagers != null);
  if (!host) throw new Error('Desktop 提问接口已变化');
  const opened = await host.appServerManagers.open('local');
  if (opened.status !== 'ready') throw new Error('Desktop 提问服务暂不可用');
  const manager = opened.manager;
  try {
    // 只取待处理请求，避免每次轮询复制整段聊天和工具输出；已有问题也能恢复。
    const requests = await manager.getConversation(input.threadId).requests;
    const pending = (requests || []).filter((request) => request.method === 'item/tool/requestUserInput');
    if (!input.response) return pending;
    const current = pending.find((request) => request.id === input.requestId && request.params?.turnId === input.turnId);
    if (!current) return false;
    await manager.replyWithUserInputResponse(input.threadId, input.requestId, input.response);
    return true;
  } finally {
    manager[Symbol.dispose]();
  }
}

export class DesktopBridge {
  constructor(port = 49397) {
    this.baseUrl = 'http://127.0.0.1:' + port;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = 0;
    this.onDisconnect = null;
    this.onOpenLauncher = null;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async ensureConnected() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connect() {
    let targets;
    try {
      const response = await fetch(this.baseUrl + '/json/list', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      targets = await response.json();
    } catch {
      throw new Error('Codex Desktop 的本机 CDP 端口不可用');
    }
    const page = targets.find((target) => target.type === 'page' && target.url === PAGE_URL);
    if (!page) throw new Error('未找到 Codex Desktop 主页面');

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接桌面页面超时')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('连接桌面页面失败')); }, { once: true });
    });
    this.socket = socket;
    this.generation += 1;
    socket.addEventListener('message', (event) => this.receive(event));
    socket.addEventListener('close', () => this.disconnect(socket));
    socket.addEventListener('error', () => this.disconnect(socket));
    try {
      await this.sendCommand('Runtime.addBinding', { name: LAUNCHER_BINDING });
      await this.evaluateRaw('(' + rendererArm.toString() + ')()');
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  disconnect(socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('桌面连接已断开'));
    }
    this.pending.clear();
    this.onDisconnect?.();
  }

  receive(event) {
    let packet;
    try {
      packet = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (packet.method === 'Runtime.bindingCalled' &&
        packet.params?.name === LAUNCHER_BINDING && packet.params.payload === 'show') {
      this.onOpenLauncher?.();
      return;
    }
    const entry = this.pending.get(packet.id);
    if (!entry) return;
    this.pending.delete(packet.id);
    clearTimeout(entry.timer);
    entry.resolve(packet);
  }

  async sendCommand(method, params, timeoutMs = 25000) {
    if (!this.connected) throw new Error('桌面连接尚未建立');
    const id = this.nextId++;
    const packet = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('等待桌面响应超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({
          id, method, params,
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
    if (packet.error) throw new Error(packet.error.message);
    return packet.result;
  }

  async evaluateRaw(expression, timeoutMs = 25000) {
    const result = await this.sendCommand('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result?.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text);
    }
    return result?.result?.value;
  }

  async evaluate(expression, timeoutMs) {
    await this.ensureConnected();
    return this.evaluateRaw(expression, timeoutMs);
  }

  async request(method, params) {
    const argument = JSON.stringify({ method, params });
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.evaluate('(' + rendererRequest.toString() + ')(' + argument + ')');
      } catch (error) {
        // 首条回合确认时，rollout 元数据可能还未落盘；只重试读取，避免重复发送消息。
        if (!THREAD_READ_METHODS.has(method) || attempt >= 4 ||
            !error.message?.includes('failed to read session metadata') ||
            !/rollout at [^\r\n]+ is empty\b/.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt));
      }
    }
  }

  async listProjects() {
    return this.evaluate('(' + rendererListProjects.toString() + ')(' + rendererDesktopServices.toString() + ')');
  }

  async unreadThreads() {
    return this.evaluate('(' + rendererReadState.toString() + ')(' + rendererDesktopServices.toString() + ')');
  }

  async markThreadRead(threadId) {
    return this.evaluate('(' + rendererReadState.toString() + ')(' + rendererDesktopServices.toString() + ',' + JSON.stringify(threadId) + ')');
  }

  async pendingUserInputs(threadId) {
    return this.evaluate('(' + rendererUserInput.toString() + ')(' + rendererDesktopServices.toString() + ',' + JSON.stringify({ threadId }) + ')');
  }

  async respondToUserInput(threadId, requestId, turnId, response) {
    return this.evaluate('(' + rendererUserInput.toString() + ')(' + rendererDesktopServices.toString() + ',' + JSON.stringify({ threadId, requestId, turnId, response }) + ')');
  }

  async createLocalProject(name, root) {
    const project = { name, path: root };
    let finished = false;
    const creation = this.evaluate('(' + rendererCreateLocalProject.toString() + ')(' + rendererDesktopServices.toString() + ',' + JSON.stringify(project) + ')', 120000)
      .finally(() => { finished = true; });
    // Web 的“信任并创建”按钮已向用户说明权限；仅确认 Desktop 中同一路径的提示。
    const trust = (async () => {
      for (let attempt = 0; attempt < 240 && !finished; attempt++) {
        try {
          const accepted = await this.evaluate('(' + rendererTrustProjectFolder.toString() + ')(' + JSON.stringify(root) + ')');
          if (accepted) return;
        } catch {
          if (finished) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    try {
      return await creation;
    } finally {
      finished = true;
      await trust;
    }
  }

  async drainEvents() {
    let events = await this.evaluate('(' + rendererDrain.toString() + ')()');
    if (events === null) {
      await this.evaluate('(' + rendererArm.toString() + ')()');
      events = { approvals: [], statuses: [] };
    }
    return events;
  }

  async respondToApproval(approval, decision) {
    const argument = JSON.stringify({
      hostId: approval.hostId,
      id: approval.id,
      decision,
    });
    await this.evaluate('(' + rendererApprovalResponse.toString() + ')(' + argument + ')');
  }

  close() {
    this.socket?.close();
  }
}
