const rasterData = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon);base64,/i;
const imageCache = new Map();
const imageSources = new WeakMap();

function localSource(source) {
  return /^(?:file:|\/?[a-z]:[\\/])/i.test(source) ||
    (!/^[a-z][a-z\d+.-]*:/i.test(source) && !source.startsWith('//'));
}

export function configureMarkdownImages(markdown) {
  const validateLink = markdown.validateLink?.bind(markdown);
  if (!validateLink) return;
  // 允许解析本地图片语法；实际路径由下方 renderer 移除，交给鉴权接口读取。
  markdown.validateLink = (url) => /^file:\/\//i.test(url) || validateLink(url);
  const render = markdown.renderer.rules.image;
  markdown.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const source = token.attrGet('src') || '';
    token.attrSet(localSource(source) ? 'data-local-src' : 'data-image-src', source);
    token.attrs = token.attrs.filter(([name]) => name !== 'src');
    return render(tokens, index, options, env, self);
  };
}

function updateImageLayout(image, change) {
  const box = image.closest('#messages');
  if (!box) { change(); return; }
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
  const top = box.getBoundingClientRect().top;
  const anchor = [...box.querySelectorAll('.item-body > *, .item-label, .message-image')]
    .find((item) => item.getBoundingClientRect().bottom > top);
  const before = anchor?.getBoundingClientRect().top;
  change();
  // 图片解码后才显露，先记录阅读位置，再同步补偿高度变化。
  if (pinned) box.scrollTop = box.scrollHeight;
  else if (anchor) {
    const offset = anchor.getBoundingClientRect().top - before;
    // 浏览器可能已自动补偿滚动；只叠加剩余偏移，不能写回加载前的 scrollTop。
    box.scrollTop += offset;
  }
  box.dispatchEvent(new Event('scroll'));
}

async function gatewayImage(source) {
  const token = sessionStorage.getItem('gatewayToken') || '';
  const key = token + '\n' + source;
  let entry = imageCache.get(key);
  if (!entry) {
    entry = { users: 0, url: null };
    entry.promise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(source, { headers: token ? { Authorization: 'Bearer ' + token } : {},
          cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('图片读取失败');
        const blob = await response.blob();
        if (!/^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$/i.test(blob.type)) throw new Error('图片类型无效');
        entry.url = URL.createObjectURL(blob);
        return entry.url;
      } finally { clearTimeout(timer); }
    })();
    imageCache.set(key, entry);
  }
  entry.users++;
  try {
    const url = await entry.promise;
    return { url, release() {
      entry.users--;
      // 只回收已完成解码的地址，防止一页多图时提前撤销仍在加载的 URL。
      for (const [oldKey, oldEntry] of imageCache) {
        if (imageCache.size <= 24) break;
        if (oldEntry.users || !oldEntry.url) continue;
        imageCache.delete(oldKey);
        URL.revokeObjectURL(oldEntry.url);
      }
    } };
  } catch (error) {
    entry.users--;
    if (imageCache.get(key) === entry) imageCache.delete(key);
    throw error;
  }
}

function mountImage(image, source) {
  const figure = document.createElement('figure');
  figure.className = 'message-image';
  imageSources.set(figure, source);
  const status = document.createElement('span');
  status.className = 'image-status';
  status.setAttribute('role', 'status');
  status.textContent = '正在加载图片…';
  image.hidden = true;
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.removeAttribute('src');
  figure.append(image, status);
  let release = null;
  const failed = () => updateImageLayout(image, () => {
    release?.();
    release = null;
    image.hidden = true;
    figure.dataset.failed = 'true';
    status.hidden = false;
    status.textContent = '图片加载失败，文件可能已移动或无法访问';
  });
  image.addEventListener('load', () => updateImageLayout(image, () => {
    release?.();
    release = null;
    image.hidden = false;
    status.hidden = true;
  }), { once: true });
  image.addEventListener('error', failed, { once: true });
  if (!source) { failed(); return figure; }
  let url;
  try { url = new URL(source, location.href); } catch { failed(); return figure; }
  if (url.origin === location.origin && url.pathname === '/api/images') {
    void gatewayImage(url.pathname + url.search).then((result) => {
      release = result.release;
      image.src = result.url;
    }, failed);
  } else if (/^https?:$/.test(url.protocol) || rasterData.test(source)) image.src = source;
  else failed();
  return figure;
}

export function renderImage(source, alt = '图片', previous = null) {
  const existing = previous && [...previous.querySelectorAll('.message-image')]
    .find((figure) => imageSources.get(figure) === source && !figure.dataset.failed);
  if (existing) {
    existing.querySelector('img').alt = alt;
    return existing;
  }
  const image = document.createElement('img');
  image.alt = alt;
  return mountImage(image, source);
}

export function renderImages(body, sources = {}, previous = null) {
  for (const image of body.querySelectorAll('img')) {
    const original = image.dataset.localSrc;
    const source = original === undefined ? image.dataset.imageSrc ?? image.getAttribute('src') : sources[original];
    // 先替换再挂载，确保异步加载回调能找到对话滚动容器。
    const marker = document.createTextNode('');
    image.replaceWith(marker);
    const existing = previous && [...previous.querySelectorAll('.message-image')]
      .find((figure) => imageSources.get(figure) === source && !figure.dataset.failed);
    if (existing) {
      existing.querySelector('img').alt = image.alt;
      marker.replaceWith(existing);
    } else marker.replaceWith(mountImage(image, source));
  }
}

export function imagesForItem(item) {
  const parts = item.type === 'userMessage' ? item.content : item.type === 'mcpToolCall' ? item.result?.content :
    item.type === 'dynamicToolCall' ? item.contentItems : [item];
  return (Array.isArray(parts) ? parts : []).flatMap((part) => {
    if (!['image', 'input_image', 'imageView', 'ImageView', 'localImage', 'local_image'].includes(part.type)) return [];
    const source = part.imageUrl || (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url) || part.url ||
      (part.data && part.mimeType ? 'data:' + part.mimeType + ';base64,' + part.data : null);
    return source ? [source] : [];
  });
}
