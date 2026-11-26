import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createImages } from '../src/images.mjs';
import { createApi } from '../src/api.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codexdeck-images-'));
const file = path.join(directory, '中文 图片.png');
const body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const images = createImages();
const response = () => ({
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(value) { this.body = value; },
});
const read = async (source, service = images) => {
  const result = response();
  await service.serve(result, new URL(source, 'http://example.test'));
  return result;
};

try {
  await fs.writeFile(file, body);
  const original = { turns: [{ items: [
    { type: 'imageView', path: pathToFileURL(file).href },
    { type: 'agentMessage', text: `![截图](<${file.replaceAll('\\', '/')}>)` },
    { type: 'userMessage', content: [{ type: 'localImage', path: file }, { type: 'text', text: '![附件](<中文 图片.png>)' }] },
  ] }] };
  const prepared = images.prepare(original, directory);
  assert.equal(original.turns[0].items[0].imageUrl, undefined, '装饰图片不能改写 Desktop 原始数据');
  const [view, message, user] = prepared.turns[0].items;
  assert.ok(view.imageUrl.startsWith('/api/images?'));
  assert.equal(Object.keys(message.imageSources).length, 1);
  assert.ok(Object.values(message.imageSources)[0].startsWith('/api/images?'));
  assert.equal(user.content[0].imageUrl, view.imageUrl);
  assert.ok(Object.values(user.imageSources)[0].startsWith('/api/images?'));
  assert.equal(images.needsCwd(original), true);
  assert.equal(images.needsCwd({ type: 'imageView', path: file }), false);
  const absolute = process.platform === 'win32' ? '/' + file.replaceAll('\\', '/') : file;
  assert.ok(images.prepare({ type: 'agentMessage', text: `![截图](<${absolute}>)` }).imageSources);
  assert.ok(images.prepare({ type: 'agentMessage', text: `![截图](${pathToFileURL(file)})` }).imageSources);
  assert.equal(images.prepare({ type: 'agentMessage', text: '`![示例](fake.png)`\n\n```md\n![示例](fake.png)\n```' }, directory).imageSources, undefined);
  for (const source of ['https://example.com/image.png', '//server/share/image.png', '\\\\server\\share\\image.png', 'file://server/share/image.png', 'javascript:example.png', 'notes.txt']) {
    assert.equal(images.prepare({ type: 'imageView', path: source }, directory).imageUrl, undefined);
  }
  const served = await read(view.imageUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers['Content-Type'], 'image/png');
  assert.equal(served.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(served.body, body);
  const changed = new URL(view.imageUrl, 'http://example.test');
  changed.searchParams.set('path', path.join(directory, 'other.png'));
  await assert.rejects(read(changed.href), (error) => error.status === 403);
  await assert.rejects(read(view.imageUrl, createImages()), (error) => error.status === 403);
  await assert.rejects(read('/api/images?path=' + encodeURIComponent(file)), (error) => error.status === 403);
  const invalid = path.join(directory, 'invalid.png');
  await fs.writeFile(invalid, '<script>不是图片</script>');
  await assert.rejects(read(images.prepare({ type: 'imageView', path: invalid }).imageUrl), (error) => error.status === 415);
  const missing = path.join(directory, 'missing.png');
  await assert.rejects(read(images.prepare({ type: 'imageView', path: missing }).imageUrl), (error) => error.status === 404);
  const large = path.join(directory, 'large.png');
  await fs.writeFile(large, '');
  await fs.truncate(large, 33 * 1024 * 1024);
  await assert.rejects(read(images.prepare({ type: 'imageView', path: large }).imageUrl), (error) => error.status === 413);

  const threadId = '00000000-0000-4000-8000-000000000001';
  const turnId = '00000000-0000-4000-8000-000000000002';
  const calls = [];
  const handleApi = createApi({ workspace: directory, token: 'test-image-token', approvalRelay: { count: 0 }, bridge: {
    async request(method) {
      calls.push(method);
      if (method === 'thread/read') return { thread: { id: threadId, cwd: directory } };
      if (method === 'thread/turns/list') return { data: [{ id: turnId, items: [
        { type: 'agentMessage', text: '![截图](<中文 图片.png>)' },
      ] }] };
      if (method === 'thread/items/list') return { data: [{ type: 'imageView', path: file }] };
      throw new Error('未预期请求：' + method);
    },
  } });
  const apiRead = async (pathname, authorized = true) => {
    const result = response();
    await handleApi({ method: 'GET', headers: authorized ? { authorization: 'Bearer test-image-token' } : {} },
      result, new URL(pathname, 'http://example.test'));
    return result;
  };
  const page = JSON.parse((await apiRead(`/api/threads/${threadId}/turns?itemsView=summary`)).body);
  assert.ok(page.turns[0].items[0].imageSources);
  assert.equal(calls.filter((method) => method === 'thread/read').length, 1, '相对图片才补读会话工作目录');
  await apiRead(`/api/threads/${threadId}/turns?itemsView=summary`);
  assert.equal(calls.filter((method) => method === 'thread/read').length, 1, '同会话目录应复用，避免拖慢轮询');
  const itemPage = JSON.parse((await apiRead(`/api/threads/${threadId}/turns/${turnId}/items`)).body);
  assert.ok(itemPage.items[0].imageUrl);
  const signed = Object.values(page.turns[0].items[0].imageSources)[0];
  assert.deepEqual((await apiRead(signed)).body, body);
  await assert.rejects(apiRead(signed, false), (error) => error.status === 401, '签名 URL 仍必须经过网关鉴权');
  console.log('本地图片路径、相对目录、签名鉴权、图片类型与大小限制校验通过');
} finally { await fs.rm(directory, { recursive: true, force: true }); }
