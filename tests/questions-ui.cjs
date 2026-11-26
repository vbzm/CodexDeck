const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const root = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await check()) return; await pause(30); }
  throw new Error('等待提问界面更新超时');
}

app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/composer.css"><link rel="stylesheet" href="/css/questions.css"><style>body{padding:20px}.question-section{max-height:90vh;max-width:820px;margin:0 auto}#notice,#authPanel{display:none}</style></head><body><div id="notice"></div><div id="authPanel" hidden><input id="tokenInput"></div><section id="questionSection" class="question-section" hidden aria-label="待回答的问题"></section><script>window.markdownit=()=>({renderer:{rules:{}}});</script></body></html>`);
      return;
    }
    const file = path.join(root, 'public', pathname);
    if (!file.startsWith(path.join(root, 'public') + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({ show: false, width: 1100, height: 850,
    webPreferences: { offscreen: true, backgroundThrottling: false, partition: 'questions-ui-' + process.pid } });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  let exitCode = 0;
  const errors = [];
  window.webContents.on('console-message', (event) => {
    if (/Uncaught|Failed to fetch dynamically imported/.test(event.message)) errors.push(event.message);
  });
  try {
    await window.loadURL('http://127.0.0.1:' + server.address().port);
    await evaluate(`(async () => {
      const {state}=await import('/js/core.js');
      const questions=await import('/js/questions.js');
      const id='00000000-0000-4000-8000-000000000001';
      const other='00000000-0000-4000-8000-000000000002';
      const first={key:'blocking',kind:'blocking',threadId:id,turnId:'turn',questions:[
        {id:'direction',header:'选择方案',question:'你想先实现哪个方案？',isOther:true,options:[{label:'先做推荐方案 (Recommended)',description:'保留现有风格，并支持手机界面。'},{label:'<img src=x onerror=alert(1)>',description:'这是纯文本选项'}]},
        {id:'__proto__',question:'还有什么补充要求？',options:[],isOther:true},
      ]};
      window.__questionFixture={id,other,requests:[first],posts:[],fail:false,defer:false,release:null,delayGet:false,releaseGet:null};
      const fixture=window.__questionFixture;
      const realFetch=window.fetch;
      const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
      window.fetch=async(input,options={})=>{
        const url=new URL(input,location.href);
        if(!url.pathname.includes('/questions'))return realFetch(input,options);
        if(options.method==='POST'){
          const body=JSON.parse(options.body);fixture.posts.push(body);
          if(fixture.fail)return json({error:'模拟连接中断'},503);
          const finish=()=>{
            if(body.key==='blocking')fixture.requests=[];
            else fixture.requests=fixture.requests.map(r=>r.key!==body.key?r:{...r,questions:r.questions.filter(q=>!body.skipped.includes(q.id)).map(q=>({...q,answer:body.answers[q.id]??q.answer}))}).filter(r=>r.questions.length);
            return json({answered:true});
          };
          if(fixture.defer)return new Promise(resolve=>{fixture.release=()=>resolve(finish())});
          return finish();
        }
        const body={requests:url.pathname.includes(other)?[]:structuredClone(fixture.requests)};
        if(fixture.delayGet){fixture.delayGet=false;return new Promise(resolve=>{fixture.releaseGet=()=>resolve(json(body))})}
        return json(body);
      };
      state.selectedId=id;state.selectedThread={id,status:{type:'active'}};state.turns=new Map();
      window.__questionModules={state,questions};
      await questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), false);
    assert.equal(await evaluate("document.querySelectorAll('.question-recommended').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('.question-options img').length"), 0, '选项内容只能作为文本显示');
    assert.equal(await evaluate("document.querySelector('.question-next').disabled"), true, '未选择时不能提交默认答案');
    await evaluate("document.querySelector('.question-option').click();document.querySelector('.question-next').click()");
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '2 / 2');
    await evaluate("document.querySelector('.question-answer-input').value='中文补充要求';document.querySelector('.question-answer-input').dispatchEvent(new Event('input'));document.querySelector('.question-previous').click()");
    assert.equal(await evaluate("document.querySelector('.question-option').getAttribute('aria-checked')"), 'true');
    await evaluate("document.querySelector('.question-next').click();document.querySelector('.question-answer-input').focus();window.__focusedQuestionInput=document.activeElement");
    await evaluate("__questionModules.questions.loadQuestions()");
    assert.equal(await evaluate("document.activeElement===window.__focusedQuestionInput"), true, '轮询不应重建正在编辑的表单或抢焦点');
    assert.equal(await evaluate("document.querySelector('.question-answer-input').value"), '中文补充要求');
    await evaluate("__questionFixture.defer=true;document.querySelector('.question-next').click();document.querySelector('.question-next').click()");
    await waitFor(() => evaluate('!!__questionFixture.release'));
    assert.equal(await evaluate("document.querySelector('.question-next').textContent"), '正在发送…');
    assert.equal(await evaluate("document.querySelector('.question-answer-input').disabled"), true);
    assert.equal(await evaluate('__questionFixture.posts.length'), 1, '提交时不能重复发送');
    await evaluate('__questionFixture.defer=false;__questionFixture.release()');
    await waitFor(() => evaluate("document.getElementById('questionSection').hidden"));
    assert.deepEqual(await evaluate('__questionFixture.posts[0].answers'), { direction: '先做推荐方案 (Recommended)', ['__proto__']: '中文补充要求' });

    await evaluate(`(async()=>{
      const fixture=__questionFixture;
      fixture.requests=[{key:'async',kind:'async',threadId:fixture.id,turnId:'turn',questions:[{id:'question',question:'工作还在继续，你想先做哪一步？',options:[{label:'先检查网关',description:'这是一段说明'}],isOther:true}]}];
      await __questionModules.questions.loadQuestions();
      const input=document.querySelector('.question-answer-input');input.value='填写自己的回答';input.dispatchEvent(new Event('input'));
      fixture.fail=true;document.querySelector('.question-next').click();
    })()`);
    await waitFor(() => evaluate("document.querySelector('.question-error').textContent.includes('模拟连接中断')"));
    assert.equal(await evaluate("document.querySelector('.question-answer-input').value"), '填写自己的回答');
    assert.equal(await evaluate("document.querySelector('.question-next').disabled"), false);
    await evaluate("__questionFixture.releaseGet=null;__questionFixture.delayGet=true;__questionFixture.fail=false;document.querySelector('.question-next').click()");
    await waitFor(() => evaluate('!!__questionFixture.releaseGet'));
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), true, '回答成功后立即隐藏，不等待下一次读取');
    assert.equal(await evaluate("document.querySelectorAll('.question-card').length"), 0, '不保留已回答卡片或摘要');
    await evaluate("__questionFixture.releaseGet();__questionModules.questions.loadQuestions()");
    await evaluate(`(async()=>{
      delete __questionFixture.requests[0].questions[0].answer;await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), true, '旧快照遗漏答案也不能恢复已提交的问题');
    await evaluate(`(async()=>{
      __questionFixture.requests[0].questions.push({id:'new-one',question:'新问题一',options:[]});await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.querySelector('.question-text').textContent"), '新问题一');
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '1 / 1');
    assert.equal(await evaluate("document.querySelector('.question-previous').hidden"), true);
    await evaluate(`(async()=>{
      const input=document.querySelector('.question-answer-input');input.value='新问题一的草稿';input.dispatchEvent(new Event('input'));input.focus();window.__focusedQuestionInput=input;
      __questionFixture.requests[0].questions.push({id:'new-two',question:'新问题二',options:[]});await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.activeElement===window.__focusedQuestionInput"), true, '新增问题不打断待答题的编辑');
    assert.equal(await evaluate("document.querySelector('.question-answer-input').value"), '新问题一的草稿');
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '1 / 2');
    assert.equal(await evaluate("document.querySelector('.question-previous').hidden"), false, '题数增加时更新导航');
    await evaluate("document.querySelector('.question-next').click()");
    assert.equal(await evaluate("document.querySelector('.question-text').textContent"), '新问题二');
    await evaluate("document.querySelector('.question-previous').click()");
    assert.equal(await evaluate("document.querySelector('.question-text').textContent"), '新问题一', '上一题只在待答题间切换');
    await evaluate("document.querySelector('.question-next').click();const input=document.querySelector('.question-answer-input');input.value='新问题二的答案';input.dispatchEvent(new Event('input'));document.querySelector('.question-next').click()");
    await waitFor(() => evaluate("document.getElementById('questionSection').hidden"));
    assert.deepEqual(await evaluate('__questionFixture.posts.at(-1).answers'), { 'new-one': '新问题一的草稿', 'new-two': '新问题二的答案' }, '新增问题的提交不包含旧题');

    await evaluate(`(async()=>{
      const fixture=__questionFixture;
      fixture.requests=[{key:'skip',kind:'async',threadId:fixture.id,turnId:'turn',questions:[{id:'one',question:'第一个问题',options:[]},{id:'two',question:'第二个问题',options:[]}]}];
      await __questionModules.questions.loadQuestions();document.querySelector('.question-skip').click();
      const input=document.querySelector('.question-answer-input');input.value='只回答第二题';input.dispatchEvent(new Event('input'));document.querySelector('.question-next').click();
    })()`);
    await waitFor(() => evaluate("__questionFixture.posts.at(-1)?.key==='skip' && document.getElementById('questionSection').hidden"));
    assert.deepEqual(await evaluate('__questionFixture.posts.at(-1).skipped'), ['one']);
    assert.deepEqual(await evaluate('__questionFixture.posts.at(-1).answers'), { two: '只回答第二题' });
    await evaluate(`(async()=>{
      __questionFixture.requests[0].questions.unshift({id:'one',question:'第一个问题',options:[]});
      __questionFixture.requests[0].questions.push({id:'three',question:'第三个问题',options:[]});await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.querySelector('.question-text').textContent"), '第三个问题', '旧的已答题和跳过题不随新题出现');
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '1 / 1');
    await evaluate("document.querySelector('.question-skip').click()");
    await waitFor(() => evaluate("document.getElementById('questionSection').hidden"));
    assert.deepEqual(await evaluate('__questionFixture.posts.at(-1).answers'), {});
    assert.deepEqual(await evaluate('__questionFixture.posts.at(-1).skipped'), ['three']);

    await evaluate(`(async()=>{
      const {state,questions}=__questionModules;
      __questionFixture.requests=[{key:'draft',kind:'async',threadId:__questionFixture.id,turnId:'turn',questions:[{id:'q',question:'切换会话后保留未发送的回答',options:[]}]}];
      await questions.loadQuestions();const input=document.querySelector('.question-answer-input');input.value='留在原对话的草稿';input.dispatchEvent(new Event('input'));
      state.selectedId=__questionFixture.other;state.turns=new Map();questions.renderQuestions();await questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), true, '切换对话不能残留旧问题');
    await evaluate(`(async()=>{
      const {state,questions}=__questionModules;state.selectedId=__questionFixture.id;state.turns=new Map();await questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.querySelector('.question-answer-input').value"), '留在原对话的草稿');
    await evaluate(`(async()=>{
      __questionFixture.delayGet=true;window.__oldQuestionLoad=__questionModules.questions.loadQuestions();
    })()`);
    await waitFor(() => evaluate('!!__questionFixture.releaseGet'));
    await evaluate(`(async()=>{
      const {state,questions}=__questionModules;state.selectedId=__questionFixture.other;state.turns=new Map();questions.renderQuestions();
      state.selectedId=__questionFixture.id;state.turns=new Map();__questionFixture.requests=[];await questions.loadQuestions();__questionFixture.releaseGet();await window.__oldQuestionLoad;
    })()`);
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), true, 'A→B→A 的旧请求不能恢复失效问题');

    await evaluate(`(async()=>{
      const fixture=__questionFixture;
      fixture.requests=[{key:'force',kind:'async',threadId:fixture.id,turnId:'turn',questions:[{id:'q',question:'旧问题',options:[]}]}];
      fixture.delayGet=true;window.__oldForcedLoad=__questionModules.questions.loadQuestions();
    })()`);
    await waitFor(() => evaluate('!!__questionFixture.releaseGet'));
    await evaluate(`(async()=>{
      __questionFixture.requests=[];await __questionModules.questions.loadQuestions({force:true});__questionFixture.releaseGet();await window.__oldForcedLoad;
    })()`);
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), true, '强制刷新后的旧问题响应不能覆盖最新结果');

    await evaluate(`(async()=>{
      const fixture=__questionFixture;
      fixture.requests=[{key:'remote',kind:'async',threadId:fixture.id,turnId:'turn',questions:[{id:'q',question:'等待其它端回答',options:[]}]}];
      await __questionModules.questions.loadQuestions();fixture.requests[0].questions[0].answer='Desktop 已回答';await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.getElementById('questionSection').hidden"), true, '其它端回答完毕后也不保留卡片');
    await evaluate(`(async()=>{
      delete __questionFixture.requests[0].questions[0].answer;
      __questionFixture.requests[0].questions.push({id:'new',question:'同一请求追加的问题',options:[]});await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.querySelector('.question-text').textContent"), '同一请求追加的问题');
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '1 / 1');
    assert.equal(await evaluate("document.querySelector('.question-previous').hidden"), true, '不能导航到其它端已答的旧题');

    await evaluate(`(async()=>{
      const fixture=__questionFixture;
      fixture.requests=[{key:'partial',kind:'async',threadId:fixture.id,turnId:'turn',questions:[{id:'one',question:'仍在填写的问题',options:[]},{id:'two',question:'其它端即将回答的问题',options:[]}]}];
      await __questionModules.questions.loadQuestions();const input=document.querySelector('.question-answer-input');input.value='保留输入';input.dispatchEvent(new Event('input'));input.focus();window.__focusedQuestionInput=input;
      fixture.requests[0].questions[1].answer='Desktop 已回答';await __questionModules.questions.loadQuestions();
    })()`);
    assert.equal(await evaluate("document.activeElement===window.__focusedQuestionInput"), true, '部分题目被其它端回答时保留当前草稿和焦点');
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '1 / 1');
    assert.equal(await evaluate("document.querySelector('.question-previous').hidden"), true, '待答数量减少时更新导航');
    await evaluate(`(async()=>{
      __questionFixture.defer=true;document.querySelector('.question-next').click();
    })()`);
    await waitFor(() => evaluate("document.querySelector('.question-next').textContent==='正在发送…'"));
    await evaluate(`(async()=>{
      __questionFixture.requests[0].questions.push({id:'three',question:'发送期间追加的问题',options:[]});await __questionModules.questions.loadQuestions();
      __questionFixture.defer=false;__questionFixture.release();
    })()`);
    await waitFor(() => evaluate("document.querySelector('.question-text')?.textContent==='发送期间追加的问题' && document.querySelector('.question-card').getAttribute('aria-busy')==='false'"));
    assert.equal(await evaluate("document.querySelector('.question-progress').textContent"), '1 / 1', '只完成本次发送的题目，保留发送期间新增的问题');
    assert.equal(await evaluate("document.querySelector('.question-answer-input').value"), '');
    assert.deepEqual(await evaluate('__questionFixture.posts.at(-1).answers'), { one: '保留输入' });

    await evaluate(`(async()=>{
      const fixture=__questionFixture;fixture.requests=[{key:'mobile',kind:'async',threadId:fixture.id,turnId:'turn',questions:[{id:'q',header:'窄屏答题界面',question:'这是一道用于检查手机布局的长问题：请选择你的推荐方案，也可以输入自己的回答。',options:[{label:'保留现有风格并支持手机操作 (Recommended)',description:'较长的选项说明应自然换行，在深色与浅色主题中保持可读。'},{label:'填写自己的要求'}],isOther:true}]}];await __questionModules.questions.loadQuestions();
    })()`);
    const screenshots = path.join(root, 'work', 'questions-qa');
    fs.mkdirSync(screenshots, { recursive: true });
    window.webContents.invalidate();
    await pause(150);
    fs.writeFileSync(path.join(screenshots, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
    for (const width of [375, 320]) {
      window.setContentSize(width, 812);
      await pause(100);
      const layout = await evaluate(`(()=>({overflow:document.documentElement.scrollWidth>innerWidth,rects:[...document.querySelectorAll('.question-card,.question-option,.question-answer-input,.question-actions button')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right}})}))()`);
      assert.equal(layout.overflow, false, '手机页面不应横向溢出');
      for (const rect of layout.rects) assert.ok(rect.left >= 0 && rect.right <= width, '手机答题控件不能超出屏幕');
      if (width === 375) {
        fs.writeFileSync(path.join(screenshots, 'mobile-light.png'), (await window.webContents.capturePage()).toPNG());
        await evaluate("document.documentElement.dataset.theme='dark'");
        fs.writeFileSync(path.join(screenshots, 'mobile-dark.png'), (await window.webContents.capturePage()).toPNG());
      }
    }
    assert.deepEqual(errors, []);
    console.log('提问界面验证通过：选项与自填、多题草稿、保留焦点、防重复、失败重试、已答即隐藏、新题不带旧题、跳过、切换隔离与 320/375px 布局');
  } catch (error) { console.error(error); exitCode = 1; }
  finally { window.destroy(); await new Promise((resolve) => server.close(resolve)); app.exit(exitCode); }
}).catch((error) => { console.error(error); app.exit(1); });
