const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await check()) return; await pause(20); }
  throw new Error('等待工具详情更新超时');
}

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/conversation.css"></head><body><main id="messages"></main></body></html>');
    } else if (['/js/activity.js', '/js/file-diff.js', '/js/images.js'].includes(pathname)) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(fs.readFileSync(path.join(root, 'public', pathname)));
    } else if (['/css/base.css', '/css/conversation.css'].includes(pathname)) {
      response.setHeader('Content-Type', 'text/css');
      response.end(fs.readFileSync(path.join(root, 'public', pathname)));
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  let exitCode = 0;
  try {
    await window.loadURL('http://127.0.0.1:' + server.address().port);
    const initial = await evaluate(String.raw`(async()=>{
      const {renderActivity}=await import('/js/activity.js');
      const fixture=window.__activity={reads:0,renderActivity};
      const binary='A'.repeat(2000000);
      const circular={name:'引用对象'};circular.self=circular;
      fixture.items=[
        {id:'dynamic',type:'dynamicToolCall',namespace:'functions',tool:'exec',arguments:{code:'检查输出'},status:'completed',get contentItems(){fixture.reads++;return [{type:'image',mimeType:'image/png',data:binary},{type:'text',text:'可读工具结果'}]}},
        {id:'mcp',type:'mcpToolCall',server:'test',tool:'many_results',arguments:{},get result(){fixture.reads++;return {text:'长'.repeat(500000),other:circular}},status:'completed'},
        {id:'command',type:'commandExecution',command:'node large-output.mjs',aggregatedOutput:'输出'.repeat(200000),status:'completed',startedAtMs:505000,completedAtMs:507000},
        {id:'files',type:'fileChange',startedAtMs:0,completedAtMs:512000,changes:[
          {path:'src/example.js',kind:{type:'update'},diff:['--- a/example.js','+++ b/example.js','@@ -8,3 +12,4 @@ example',
            ' const x = 1;','--- x;','+++ x;','+<tag>保留字面内容</tag>','  return x;','\\ No newline at end of file',
            '@@ -110 +114 @@','-before','+after'].join('\r\n')},
          {path:'src/other.js',kind:{type:'update'},diff:'+d'},
        ]},
        {id:'reasoning',type:'reasoning',summary:[{text:'检查边界条件'}]},
        {id:'other',type:'customToolResult',values:Array.from({length:10000},(_,i)=>i)},
      ];
      document.getElementById('messages').append(renderActivity(fixture.items,'turn',0,new Set()));
      return {reads:fixture.reads,lists:document.querySelectorAll('.activity-list').length,details:document.querySelectorAll('.activity-entry').length,text:document.querySelector('.activity-group>summary').textContent};
    })()`);
    assert.equal(initial.reads, 0, '折叠分组不得访问工具输出');
    assert.equal(initial.lists, 0, '折叠分组不创建工具详情列表');
    assert.equal(initial.details, 0);
    assert.match(initial.text, /调用了 2 个工具/);
    await evaluate("document.querySelector('.activity-group').open=true");
    await waitFor(() => evaluate("document.querySelectorAll('.activity-entry').length===7"));
    assert.equal(await evaluate('__activity.reads'), 0, '只展开分组时仍不得序列化工具输出');
    assert.equal(await evaluate("document.querySelectorAll('pre').length"), 0);
    assert.equal(await evaluate("document.querySelector('.activity-entry .activity-title').textContent"), 'functions · exec');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-detail-key="turn:item:files:0"] .file-change-counts > span')]
      .map(node => node.textContent)`), ['+3', '-2']);
    assert.equal(await evaluate("document.querySelectorAll('.file-diff').length"), 0, '展开分组只统计行数，按需渲染差异');
    await evaluate("document.querySelector('[data-detail-key=\"turn:item:files:0\"] > summary').click()");
    await waitFor(() => evaluate("!!document.querySelector('.file-diff')"));
    const patch = await evaluate(`(() => {
      const view = document.querySelector('.file-diff');
      return { path: view.querySelector('.file-diff-path').textContent, injected: !!view.querySelector('tag'),
        rows: [...view.querySelectorAll('tbody tr')].map(row => [row.dataset.kind,
          [...row.querySelectorAll('.file-diff-number')].map(node => node.textContent), row.querySelector('code').textContent]) };
    })()`);
    assert.equal(patch.path, 'src/example.js');
    assert.equal(patch.injected, false, '差异中的 HTML 按字面显示');
    assert.deepEqual(patch.rows, [
      ['note', [], '--- a/example.js'],
      ['note', [], '+++ b/example.js'],
      ['hunk', [], '@@ -8,3 +12,4 @@ example'],
      ['context', ['8', '12'], 'const x = 1;'],
      ['removed', ['9', ''], '-- x;'],
      ['added', ['', '13'], '++ x;'],
      ['added', ['', '14'], '<tag>保留字面内容</tag>'],
      ['context', ['10', '15'], ' return x;'],
      ['note', [], '\\ No newline at end of file'],
      ['hunk', [], '@@ -110 +114 @@'],
      ['removed', ['110', ''], 'before'],
      ['added', ['', '114'], 'after'],
    ], '逐块定位旧行和新行，文件头与换行提示不计入增删');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.activity-entry:is([data-kind="command"], [data-kind="file"])')]
      .map(row => [row.querySelector('.activity-kind').textContent, row.querySelector('time').dateTime])`), [
      ['命令', new Date(505000).toISOString()],
      ['文件', new Date(512000).toISOString()],
      ['文件', new Date(512000).toISOString()],
    ], '命令显示开始时间，同一编辑操作中的文件各自显示该操作的时间');
    assert.equal(await evaluate("document.querySelector('.activity-entry[data-kind=tool] .item-time').textContent"), '未记录');
    await evaluate("document.querySelector('[data-detail-key=\"turn:item:dynamic\"]').open=true");
    await waitFor(() => evaluate("document.querySelectorAll('pre').length===1"));
    const dynamic = await evaluate("document.querySelector('pre').textContent");
    assert.match(dynamic, /图片或音频数据已省略/);
    assert.match(dynamic, /可读工具结果/);
    assert.equal(dynamic.includes('A'.repeat(1000)), false, '图片 base64 不应放进 DOM');
    assert.equal(await evaluate('__activity.reads'), 1);
    await evaluate("document.querySelector('[data-detail-key=\"turn:item:mcp\"]').open=true;document.querySelector('[data-detail-key=\"turn:item:command\"]').open=true;document.querySelector('[data-detail-key=\"turn:item:other\"]').open=true");
    await waitFor(() => evaluate("document.querySelectorAll('pre').length===4"));
    const bounded = await evaluate("[...document.querySelectorAll('pre')].map(e=>e.textContent)");
    for (const text of bounded) assert.ok(text.length <= 100080, '工具详情文本应限制大小');
    assert.match(bounded[1], /输出过长，已截断/);
    assert.match(bounded[2], /输出过长，已截断/);
    assert.match(bounded[3], /其余内容已省略/);
    assert.equal(await evaluate('__activity.reads'), 2);
    const restored = await evaluate(`(()=>{
      const root=document.getElementById('messages');
      const open=new Set([...root.querySelectorAll('details[open][data-detail-key]')].map(e=>e.dataset.detailKey));
      const previous=root.querySelector('.activity-group');
      const diff=previous.querySelector('.file-diff');
      root.replaceChildren(__activity.renderActivity(__activity.items,'turn',0,open,previous));
      return {group:root.querySelector('.activity-group').open,dynamic:root.querySelector('[data-detail-key="turn:item:dynamic"]').open,
        pre:root.querySelectorAll('pre').length,diffRetained:diff===root.querySelector('.file-diff')};
    })()`);
    assert.deepEqual(restored, { group: true, dynamic: true, pre: 4, diffRetained: true }, '重绘应保留展开状态和已打开的差异');
    await evaluate("document.querySelector('.activity-group').open=false");
    await pause(30);
    const collapsed = await evaluate(`(()=>{
      const root=document.getElementById('messages');
      const keys=()=>new Set([...root.querySelectorAll('details[open][data-detail-key]')].map(e=>e.dataset.detailKey));
      root.replaceChildren(__activity.renderActivity(__activity.items,'turn',0,keys()));
      root.replaceChildren(__activity.renderActivity(__activity.items,'turn',0,keys()));
      const reads=__activity.reads;root.querySelector('.activity-group').open=true;return reads;
    })()`);
    await waitFor(() => evaluate("!!document.querySelector('[data-detail-key=\"turn:item:dynamic\"]')"));
    assert.equal(await evaluate("document.querySelector('[data-detail-key=\"turn:item:dynamic\"]').open"), true, '分组关闭后重绘仍应记住子详情展开状态');
    assert.equal(await evaluate('__activity.reads'), collapsed + 2, '恢复展开项时仅加载对应输出');
    const cycles = await evaluate(`(()=>{
      const item={id:'cycle',type:'custom'};item.self=item;
      const group=__activity.renderActivity([item],'cycle',0,new Set(['cycle:activity:0','cycle:item:cycle']));
      return group.querySelector('pre').textContent;
    })()`);
    assert.match(cycles, /重复引用已省略/);

    const wholeFiles = await evaluate(String.raw`(() => {
      const { renderActivity } = __activity;
      const changes = [
        { path: 'new.patch', kind: { type: 'add' }, diff: '@@ -3 +3 @@\r\n+kept\r\n\r\n' },
        { path: 'deleted.js', kind: { type: 'delete' }, diff: '-kept\n' },
        { path: 'empty.js', kind: { type: 'add' }, diff: '' },
      ];
      const open = new Set(['whole:activity:0', ...changes.map((_, index) => 'whole:item:files:' + index)]);
      const group = renderActivity([{ type: 'fileChange', id: 'files', changes }], 'whole', 0, open);
      return [...group.querySelectorAll('.activity-entry')].map(entry => ({
        title: entry.querySelector('.file-change-name').textContent,
        counts: [...entry.querySelectorAll('.file-change-counts > span')].map(node => node.textContent),
        rows: [...entry.querySelectorAll('tbody tr')].map(row => [row.dataset.kind,
          row.cells[0].textContent, row.cells[1].textContent, row.querySelector('code').textContent]),
        empty: !!entry.querySelector('.file-diff-notice'),
      }));
    })()`);
    assert.deepEqual(wholeFiles, [
      { title: '创建了 new.patch', counts: ['+3', '-0'],
        rows: [['added', '', '1', '@@ -3 +3 @@'], ['added', '', '2', '+kept'], ['added', '', '3', '']], empty: false },
      { title: '删除了 deleted.js', counts: ['+0', '-1'], rows: [['removed', '1', '', '-kept']], empty: false },
      { title: '创建了 empty.js', counts: [], rows: [], empty: true },
    ], '新建和删除记录使用原始文件内容，保留行首符号与空行');

    const large = await evaluate(String.raw`(() => {
      const root = document.getElementById('messages');
      const open = new Set(['large:activity:0', 'large:item:files:0']);
      const change = { path: 'large.js', kind: { type: 'update' },
        diff: '@@ -0,0 +1,20000 @@\n' + '+new line\n'.repeat(20000) };
      const render = (previous) => __activity.renderActivity([{ type: 'fileChange', id: 'files', changes: [change] }], 'large', 0, open, previous);
      const previous = render();
      root.replaceChildren(previous);
      const scroll = previous.querySelector('.file-diff-scroll');
      scroll.scrollTop = 180;
      const top = scroll.scrollTop;
      root.replaceChildren(render(previous));
      __activity.largeDiff = { scroll, top, render, change };
      return { rows: scroll.querySelectorAll('tbody tr').length, top,
        partial: root.querySelector('.file-diff-notice').textContent,
        countPartial: root.querySelector('.file-change-counts').textContent.includes('部分') };
    })()`);
    assert.ok(large.top > 0, '长差异应可以独立滚动');
    assert.equal(large.rows, 800);
    assert.match(large.partial, /显示部分内容/);
    assert.equal(large.countPartial, true);
    await waitFor(() => evaluate("__activity.largeDiff.scroll.isConnected && __activity.largeDiff.scroll.scrollTop === __activity.largeDiff.top"));
    assert.equal(await evaluate(String.raw`(() => {
      const { change, render } = __activity.largeDiff;
      const root = document.getElementById('messages');
      change.diff = '@@ -0,0 +1 @@\n+最新差异';
      root.replaceChildren(render(root.querySelector('.activity-group')));
      return root.querySelector('tr[data-kind="added"] code').textContent;
    })()`), '最新差异', '同一条目收到新差异后重新渲染');
    console.log('工具活动界面验证通过：差异行号与增删样式、新建删除、截断及阅读位置、两层延迟加载、图片省略和展开状态恢复');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { window.destroy(); await new Promise((resolve) => server.close(resolve)); app.exit(exitCode); }
}).catch((error) => { console.error(error); app.exit(1); });
