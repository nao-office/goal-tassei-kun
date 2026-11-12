// Synthetic records only. All external services are blocked.
const {chromium,webkit}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http');
const root=__dirname,KEY='mirai-goal-companion-v1';
const server=http.createServer((req,res)=>{try{const p=(req.url==='/'?'/index.html':req.url).split('?')[0];res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(root+p));}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,type=process.env.NAV_BROWSER==='webkit'?webkit:chromium;
 const browser=await type.launch({headless:true,...(type===chromium&&process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 try{for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());await page.goto(origin);
  const nav=tab=>page.locator('[data-nav="'+tab+'"]'),mode=tab=>page.locator('[data-progress-action="mode"][data-mode="'+tab+'"]');
  const stored=()=>page.evaluate(k=>JSON.parse(localStorage.getItem(k)),KEY);
  const reveal=async s=>{const el=page.locator(s);await el.evaluate(e=>{for(let n=e;n;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;});return el;};
  const choose=async(accept,action,count=1)=>{const messages=[];const listener=async d=>{messages.push(d.message());await (accept?d.accept():d.dismiss());};page.on('dialog',listener);try{await action();}finally{page.off('dialog',listener);}assert.equal(messages.length,count);for(const m of messages)assert.match(m,/保存していない入力/);};
  const clean=action=>choose(false,action,0),notice=t=>page.waitForFunction(s=>document.querySelector('#toast').textContent.includes(s),t);
  const fail=()=>page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mirai-goal-companion-v1')throw Error('synthetic quota');return originalSetItem.call(this,k,v);};});
  const recover=()=>page.evaluate(()=>Storage.prototype.setItem=originalSetItem);
  const seed=async progress=>{await page.evaluate(({key,progress})=>localStorage.setItem(key,JSON.stringify({version:1,goal:{title:'架空のゴール'},entries:{},goals:[{id:'g1',theme:'検証',period:'1年',qualitative:'保存済みゴール',status:'進行中'}],progress})),{key:KEY,progress});await page.reload();await page.waitForFunction(async()=>(await navigator.locks.query()).held.some(l=>l.name.endsWith(':single-writer')));};
  const action={id:'a1',title:'保存済み行動',minimum:'小さな一歩',status:'未着手',horizon:'1か月',due:'2027-01-15',plannedWeek:''};
  await seed({actions:[action]});await nav('progress').click();await mode('review').click();
  const review=page.locator('#pg-review-form'),week=await page.locator('#pg-week').inputValue();
  await review.locator('[name="facts"]').fill('書きかけの事実');await review.locator('[name="learning"]').fill('書きかけの学び');
  // Navigation protection also applies to drafts restored by a tab takeover.
  const peer=await context.newPage();await peer.goto(origin);await peer.locator('[data-action="resume-tab-edit"]').click();await peer.waitForFunction(()=>document.querySelector('#toast').textContent.includes('このタブで続けられます'));
  await page.locator('[data-action="resume-tab-edit"]').click();await notice('このタブで続けられます');await peer.close();
  assert.equal(await review.locator('[name="facts"]').inputValue(),'書きかけの事実');assert.equal(await review.locator('[name="learning"]').inputValue(),'書きかけの学び');const before=JSON.stringify(await stored());
  await choose(false,()=>page.locator('#pg-week').fill(week==='2026-11-02'?'2026-11-09':'2026-11-02'));assert.equal(await page.locator('#pg-week').inputValue(),week);
  await choose(false,()=>review.locator('[name="reviewGoalId"]').selectOption('g1'));assert.equal(await review.locator('[name="reviewGoalId"]').inputValue(),'');
  for(let n=0;n<2;n++){await choose(false,()=>mode('actions').click());await choose(false,()=>nav('home').click());}
  assert.equal(await review.locator('[name="facts"]').inputValue(),'書きかけの事実');assert.equal(await review.locator('[name="learning"]').inputValue(),'書きかけの学び');assert.equal(JSON.stringify(await stored()),before);
  const unload=()=>page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;});assert.equal(await unload(),true);
  await fail();await review.locator('[data-progress-action="save-review"]').click();await notice('端末に保存できません');await choose(false,()=>mode('actions').click());assert.equal(JSON.stringify(await stored()),before);
  await recover();await clean(()=>review.locator('[data-progress-action="save-review"]').click());await notice('週次レビューを保存');assert.equal((await stored()).progress.reviewHistory.length,1);
  await clean(()=>review.locator('[name="reviewGoalId"]').selectOption('g1'));assert.equal(await review.locator('[name="facts"]').inputValue(),'');
  await review.locator('[name="facts"]').fill('ゴール別の別レビュー');await review.locator('[data-progress-action="save-review"]').click();
  await clean(()=>review.locator('[name="reviewGoalId"]').selectOption(''));assert.equal(await review.locator('[name="facts"]').inputValue(),'書きかけの事実');
  await review.locator('[name="facts"]').fill('破棄する変更');await choose(true,()=>mode('actions').click());await clean(()=>mode('review').click());assert.equal(await review.locator('[name="facts"]').inputValue(),'書きかけの事実');
  await clean(()=>mode('actions').click());let title=await reveal('#pg-action-form [name="title"]');await title.fill('新規の書きかけ');
  const edit=await reveal('[data-disclosure-key="action:a1"] [data-progress-action="edit"]');
  await choose(false,()=>edit.click());await choose(false,()=>mode('plan').click());
  await choose(false,()=>page.locator('[data-disclosure-key="action:a1"] [data-progress-action="today"]').click());await choose(false,()=>page.locator('[data-disclosure-key="action:a1"] [data-progress-action="toggle"]').click());
  assert.equal(await title.inputValue(),'新規の書きかけ');assert.equal((await stored()).progress.actions.length,1);assert.deepEqual((await stored()).entries,{});
  await choose(true,()=>edit.click());title=page.locator('#pg-action-form [name="title"]');assert.equal(await title.inputValue(),'保存済み行動');
  await title.fill('行動の変更を保持');await choose(false,()=>page.locator('[data-progress-action="cancel-edit"]').click());
  await fail();await page.locator('[data-progress-action="save-action"]').click();await notice('端末に保存できません');await choose(false,()=>nav('goal').click());assert.equal(await title.inputValue(),'行動の変更を保持');
  await recover();await clean(()=>page.locator('[data-progress-action="save-action"]').click());await notice('アクションを保存したよ');assert.equal((await stored()).progress.actionHistory.length,1);
  await clean(()=>nav('goal').click());const goalField=await reveal('[data-goal-form][data-goal-id="g1"] [name="qualitative"]');await goalField.fill('ゴールの書きかけ');
  await choose(false,()=>page.locator('[data-goal-filter="3年"]').click());await choose(false,()=>nav('progress').click());assert.equal(await goalField.inputValue(),'ゴールの書きかけ');
  await choose(true,()=>nav('progress').click());assert.equal(await unload(),false);
  for(const source of ['actions','sheetActions']){
   await seed({[source]:[{...action,origin:source==='sheetActions'?'Google Sheets':'端末内'}],actionHistory:[]});await nav('progress').click();await mode('plan').click();
   const button=await reveal('[data-progress-action="plan-this-week"][data-id="a1"]'),original=JSON.stringify(await stored());await fail();
   for(let n=0;n<2;n++){await button.click();await notice('計画と履歴は変更していません');assert.equal(JSON.stringify(await stored()),original);assert.ok(!(await page.locator('.form-panel').first().innerText()).includes(action.title));}
   await recover();await button.click();await notice('今週の計画に追加したよ');assert.equal((await stored()).progress.actionHistory.length,1);assert.equal((await stored()).progress.actions[0].horizon,'今週');
   await page.reload();await nav('progress').click();await mode('plan').click();assert.equal((await stored()).progress.actionHistory.length,1);assert.ok((await page.locator('.form-panel').first().innerText()).includes(action.title));
  }
  assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));fs.mkdirSync(root+'/test-results',{recursive:true});await page.screenshot({path:root+'/test-results/progress-navigation-'+type.name()+'-'+width+'.png',fullPage:true});
  console.log(type.name()+' '+width+': draft cancel/approve, week/goal isolation, failed save/retry, shortcuts and plan rollback passed. Synthetic data only.');await context.close();
 }}finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exit(1);});
