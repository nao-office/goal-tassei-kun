// Synthetic stores + intercepted Google/Worker traffic only. No real account or data.
const {chromium,webkit,devices}=require('playwright');
const fs=require('node:fs'),http=require('node:http'),vm=require('node:vm'),assert=require('node:assert/strict');
const KEY='mirai-goal-companion-v1',SHEET='fixture-simple-sync-20261110',WORKER='https://sync-auth.example';
const mods={window:{}};vm.createContext(mods);for(const file of ['sheets-writeback.js','goal-management-sync.js'])vm.runInContext(fs.readFileSync(__dirname+'/'+file,'utf8'),mods);
const W=mods.window.GoalWriteback,G=mods.window.GoalManagementSync;
const fixture={version:1,goal:{},goals:[{id:'local-goal',period:'1年',theme:'仕事',qualitative:'端末のゴール',status:'進行中'}],goalIdeas:[],goalHistory:[],goalChecks:[],entries:{},progress:{reviews:[{id:'private-review',facts:'端末専用メモ'}]}};
const baseline=W.baselineFromRows([W.workHeaders],[W.actionHeaders]);
const server=http.createServer((req,res)=>{try{const path=req.url.split('?')[0];let body=fs.readFileSync(__dirname+(path==='/'?'/index.html':path),'utf8');
 if(path==='/'||path==='/index.html')body=body.replace('\n})();\n</script>',`\nwindow.syncQA={state:()=>({review:syncReview,enabled:autoSyncEnabled,busy:syncBusy||syncAuthBusy||writeBusy||autoSyncTickBusy,data,tab}),tick:autoSyncTick,token:()=>{googleToken='fixture-token';googleTokenWritable=true;autoWriteToken=true;autoTokenExpiresAt=Date.now()+3600000;},enable:()=>{autoSyncEnabled=true;},disable:()=>{autoSyncEnabled=false;clearTimeout(autoSaveTimer);},editGoal:()=>{data.goals.find(g=>g.id==='local-goal').qualitative='端末で更新したゴール';save();}};\n})();\n</script>`);
 res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});
const idle=page=>page.waitForFunction(()=>!window.syncQA.state().busy);
const state=page=>page.evaluate(()=>window.syncQA.state());
async function openDetails(page){if(!await page.locator('#syncAdvanced').evaluate(el=>el.open))await page.locator('#syncAdvanced > summary').click();}
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 try{for(const mobile of [false,true]){
  const engine=mobile&&process.env.MOBILE_BROWSER!=='chromium'?webkit:chromium,browser=await engine.launch({headless:true});
  try{
   const context=await browser.newContext(mobile?devices['iPhone 13']:{viewport:{width:1365,height:1000}}),errors=[],requests=[];
   const remoteGoal=G.goalRow({id:'remote-goal',theme:'家族',period:'1年',qualitative:'Sheetsのゴール',status:'進行中'});
   const sheets=new Map([['ワーク記録',[W.workHeaders]],['アクション一覧',[W.actionHeaders]],['ゴール一覧',[G.goalHeaders,remoteGoal]],['ゴール履歴',[G.historySyncHeaders,G.historyRow({id:'remote-goal',at:'2026-11-10',action:'作成',eventId:'remote-event',qualitative:'Sheetsのゴール'})]],['ゴール確認履歴',[G.checkHeaders,['2026-11-10','remote-goal','家族','1年','継続','確認メモ']]],['ゴールの種',[G.ideaHeaders,['seed-1','2026-11-10','家族','1年','未来の景色','家族との時間','要確認']]]]);
   let held=null,holdNext=false,signalHeld;
   await context.addInitScript(({KEY,SHEET,WORKER,fixture,baseline})=>{
    if(!localStorage.getItem('fixture-init')){localStorage.setItem(KEY,JSON.stringify(fixture));localStorage.setItem('mirai-goal-sheet-sync-config-v1',JSON.stringify({sheetId:SHEET}));localStorage.setItem('mirai-goal-sheet-write-baseline-v1:'+SHEET,JSON.stringify(baseline));localStorage.setItem('mirai-goal-cloud-auth-worker-v1',WORKER);localStorage.setItem('fixture-init','1');}
   },{KEY,SHEET,WORKER,fixture,baseline});
   await context.route('**/*',async route=>{
    const req=route.request(),url=req.url();if(url.startsWith(origin+'/'))return route.continue();
    if(url.startsWith(WORKER)){requests.push({url,method:req.method()});assert.ok(url.endsWith('/auth/finish'));return route.fulfill({json:{session:'s'.repeat(43)}});}
    if(!url.startsWith('https://sheets.googleapis.com/'))return route.abort();
    const path=decodeURIComponent(url);requests.push({url:path,method:req.method()});
    if(req.method()==='GET'&&holdNext){holdNext=false;await new Promise(resolve=>{held=resolve;signalHeld();});}
    if(req.method()==='GET'){
     if(!path.includes('/values/'))return route.fulfill({json:{sheets:[...sheets.keys()].map((title,sheetId)=>({properties:{title,sheetId,gridProperties:{rowCount:title==='アクション一覧'?1200:1000,columnCount:26}}}))}});
     const name=path.match(/\/values\/'([^']+)'!/)?.[1];assert.ok(sheets.has(name),path);return route.fulfill({json:{values:sheets.get(name)}});
    }
    assert.equal(req.method(),'POST');const body=req.postDataJSON();
    if(path.includes('/values:batchUpdate'))for(const patch of body.data){const match=patch.range.match(/^'([^']+)'!A(\d+):/);assert.ok(match);assert.ok(['ゴール一覧','ゴールの種'].includes(match[1]));sheets.get(match[1])[Number(match[2])-1]=patch.values[0];}
    else {const name=path.match(/\/values\/'([^']+)'!/)?.[1];assert.ok(['ゴール一覧','ゴールの種','ゴール履歴','ゴール確認履歴'].includes(name));sheets.get(name).push(...body.values);}
    return route.fulfill({json:{totalUpdatedCells:1}});
   });
   const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.dismiss());
   await page.goto(origin+'/#goal_auth_ticket=fixture-ticket');await page.waitForFunction(()=>localStorage.getItem('mirai-goal-cloud-auth-session-v1'));
   await idle(page);assert.equal((await state(page)).review,null);assert.equal((await state(page)).enabled,false);assert.equal(requests.length,1,'login must not read Sheets');assert.equal(await page.evaluate(()=>location.hash),'');
   await page.locator('[data-nav="sync"]').click();
   assert.equal(await page.locator('#syncAdvanced').evaluate(el=>el.open),false);assert.equal(await page.locator('[data-action="google-sync"]').isVisible(),false);assert.equal(await page.locator('[data-action="save-writeback"]').count(),0);assert.equal(await page.locator('[data-action="goal-sync"]').isVisible(),true);
   fs.mkdirSync(__dirname+'/test-results',{recursive:true});await page.waitForFunction(()=>!document.getElementById('toast').classList.contains('show'));await page.screenshot({path:__dirname+'/test-results/sync-simple-'+(mobile?'mobile':'desktop')+'.png',fullPage:true});
   await page.locator('#app section.form-panel').nth(1).scrollIntoViewIfNeeded();await page.screenshot({path:__dirname+'/test-results/sync-simple-controls-'+(mobile?'mobile':'desktop')+'.png'});
   await page.evaluate(()=>window.syncQA.token());
   let before=requests.length;await page.locator('[data-action="goal-sync"]').click();await page.waitForFunction(()=>window.syncQA.state().review?.scope==='goals');
   assert.equal(requests.length-before,4);assert.ok(requests.slice(before).every(r=>r.method==='GET'&&/ゴール/.test(r.url)));
   assert.equal(await page.locator('[data-sync-choice]').count(),0);assert.equal((await state(page)).data.goals.length,1,'preview is read-only');
   await page.locator('[data-action="import-goal-sync-review"]').click();await idle(page);
   let current=(await state(page)).data;assert.equal(current.goals.length,2);assert.equal(current.goals.find(g=>g.id==='local-goal').qualitative,'端末のゴール');assert.equal(current.goalIdeas.length,1);assert.equal(current.goalHistory.length,1);assert.equal(current.goalChecks.length,1);assert.equal(current.progress.reviews[0].facts,'端末専用メモ');assert.ok(requests.slice(1).every(r=>r.method==='GET'));
   // Goal uploads stay usable and only write their selected destination.
   await page.evaluate(()=>window.syncQA.editGoal());await page.locator('[data-action="goal-sync"]').click();await page.waitForFunction(()=>window.syncQA.state().review?.scope==='goals');
   await page.locator('[data-goal-sync-choice][value="device"]').first().check();await page.locator('[data-action="apply-goal-sync-review"]').click();await idle(page);
   assert.equal(sheets.get('ゴール一覧').find(r=>r[0]==='local-goal')[3],'端末で更新したゴール');assert.match(await page.locator('#syncStatus').innerText(),/手動同期が完了/);
   // Open review pauses only while visible, and Close/navigation resumes polling.
   await page.evaluate(()=>window.syncQA.enable());await page.locator('[data-action="goal-sync"]').click();await idle(page);
   before=requests.length;await page.evaluate(()=>window.syncQA.tick());assert.equal(requests.length,before);assert.match(await page.locator('#autoSyncNotice').innerText(),/一時待機/);
   await page.locator('[data-action="cancel-sync-review"]').click();await idle(page);assert.ok(requests.length>before);assert.equal((await state(page)).review,null);
   await page.locator('[data-action="goal-sync"]').click();await idle(page);before=requests.length;await page.locator('[data-nav="morning"]').click();await idle(page);assert.equal((await state(page)).review,null);assert.ok(requests.length>before);
   await page.locator('[data-nav="sync"]').click();await openDetails(page);await page.locator('[data-action="google-sync"]').click();await idle(page);assert.equal((await state(page)).review.scope,'recovery');
   before=requests.length;await page.locator('#syncAdvanced > summary').click();await page.waitForFunction(()=>window.syncQA.state().review===null);await idle(page);assert.equal((await state(page)).review,null);assert.ok(requests.length>before);
   // Closing recovery tools cannot cancel an unrelated pending goal read.
   await openDetails(page);
   const goalReached=new Promise(resolve=>signalHeld=resolve);holdNext=true;await page.locator('[data-action="goal-sync"]').click();await goalReached;
   await page.locator('#syncAdvanced > summary').click();held();await idle(page);
   assert.equal((await state(page)).review?.scope,'goals');await page.locator('[data-action="cancel-sync-review"]').click();await idle(page);
   // An interrupted read cannot install a review on the new page or wipe a draft.
   await page.evaluate(()=>window.syncQA.disable());
   const reached=new Promise(resolve=>signalHeld=resolve);holdNext=true;await page.locator('[data-action="goal-sync"]').click();await reached;
   await page.locator('[data-nav="morning"]').click();await page.locator('#fit').fill('読み取り待ちの間に入力');held();await idle(page);
   assert.equal((await state(page)).review,null);assert.equal(await page.locator('#fit').inputValue(),'読み取り待ちの間に入力');
   assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   console.log((mobile?'mobile '+engine.name():'desktop Chromium')+': login-only, goal-only read/import/upload, hidden recovery, close/navigation resume and interrupted read passed');
   await context.close();
  }finally{await browser.close();}
 }}finally{server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
