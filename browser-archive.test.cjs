// Synthetic data only; all non-local traffic is blocked.
const {chromium,webkit,devices}=require('playwright'),fs=require('fs'),http=require('http'),vm=require('vm'),assert=require('assert/strict'),crypto=require('crypto');
const c={window:{}};vm.createContext(c);
for(const f of ['sheets-writeback.js','keep-both-sync.js'])vm.runInContext(fs.readFileSync(f,'utf8'),c);
const W=c.window.GoalWriteback,K=c.window.GoalKeepBoth,KEY='mirai-goal-companion-v1';
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function version(kind,id,values){
 const payload={schemaVersion:1,kind,id,values:Object.fromEntries(Object.values(kind==='work'?W.workFields:W.actionFields).map(k=>[k,values[k]||'']))};
 const json=JSON.stringify(payload),hash=crypto.createHash('sha256').update(json).digest('hex');
 return ['sha256:'+hash,'1',kind,id,'device','1','1',hash,json,'2026-11-08T00:00:00Z'];
}
const rows=[K.headers,version('work','2026-11-07',{valuableAction:'保管済み行動',lessonReflection:'別講義の感想'}),version('action','old',{id:'old',title:'保管済みアクション',status:'完了'})];
const partial=version('work','2026-11-06',{fit:'未完'});partial[6]='2';rows.push(partial);
const bundle={schemaVersion:1,sheetId:'fixture-sheet-20261108-synthetic',fetchedAt:'2026-11-08T00:00:00Z',tabExists:true,rows};
const fixture={version:1,goal:{},entries:{[today]:{valuableAction:'現在の行動',valuableDone:true,lessonId:'today-lesson'}},progress:{actions:[{id:'old',title:'元のアクション'}]},syncArchiveBackups:[bundle]};
const server=http.createServer((req,res)=>{try{const p=req.url.split('?')[0];let body=fs.readFileSync(__dirname+(p==='/'?'/index.html':p),'utf8');
 if(p==='/'||p==='/index.html')body=body.replace('\n})();\n</script>',"\nwindow.archiveQA={token:()=>{googleToken='fixture-token';syncConfig.sheetId='fixture-sheet-20261108-synthetic';},data:()=>data};\n})();\n</script>");
 res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404);res.end();}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 try{
 for(const mobile of [false,true]){
  const type=mobile?(process.env.MOBILE_BROWSER==='chromium'?chromium:webkit):chromium;
  const browser=await type.launch({headless:true});
  try{
   const context=await browser.newContext(mobile?devices['iPhone 13']:{viewport:{width:1365,height:900}});
   let googleReads=0,failed=false;const errors=[];
   await context.route('**/*',route=>{
    const url=route.request().url();
    if(url.startsWith(origin))return route.continue();
    if(url.startsWith('https://sheets.googleapis.com/')){
     assert.equal(route.request().method(),'GET');googleReads++;
     if(failed)return route.fulfill({status:503,body:'{}'});
     return route.fulfill({contentType:'application/json',body:JSON.stringify(url.includes('/values/')?{values:rows}:{sheets:[{properties:{title:'同期の別記録',gridProperties:{rowCount:1000}}}]})});
    }
    return route.abort();
   });
   await context.addInitScript(({KEY,fixture})=>{if(!localStorage.getItem(KEY))localStorage.setItem(KEY,JSON.stringify(fixture));},{KEY,fixture});
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin);await page.locator('[data-action="go-sync"]').first().click();
   await page.locator('[data-action="open-restored-archive"]').click();
   // Partial records are not offered for editing.
   await page.waitForFunction(()=>document.querySelectorAll('[data-action="copy-sync-archive"]').length===2);
   assert.equal(googleReads,0);assert.ok((await page.locator('#app').innerText()).includes('未完の記録 1件'));
   await page.locator('details.ui-item summary').first().click();
   const before=await page.evaluate(KEY=>localStorage.getItem(KEY),KEY);
   await page.locator('[data-action="copy-sync-archive"]').first().click();
   assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),before);
   assert.equal(await page.locator('[data-archive-field="valuableAction"]').inputValue(),'保管済み行動');
   assert.equal(await page.locator('[data-archive-field="lessonReflection"]').count(),0);
   fs.mkdirSync(__dirname+'/test-results',{recursive:true});
   await page.locator('#archive-edit-valuableAction').scrollIntoViewIfNeeded();
   await page.screenshot({path:__dirname+'/test-results/archive-editor-'+(mobile?'mobile':'desktop')+'.png'});
   await page.locator('[data-archive-field="valuableAction"]').fill('編集した行動');
   // Storage failure preserves draft and originals, retry succeeds without duplicates.
   await page.evaluate(()=>{window.realSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mirai-goal-companion-v1')throw Error('quota');return window.realSet.call(this,k,v);};});
   await page.locator('[data-action="save-archive-draft"]').click();
   assert.equal(await page.locator('[data-archive-field="valuableAction"]').inputValue(),'編集した行動');
   assert.equal(await page.evaluate(KEY=>localStorage.getItem(KEY),KEY),before);
   await page.evaluate(()=>Storage.prototype.setItem=window.realSet);
   await page.locator('[data-action="save-archive-draft"]').click();
   const saved=await page.evaluate(KEY=>JSON.parse(localStorage.getItem(KEY)),KEY);
   assert.equal(saved.entries[today].valuableAction,'現在の行動\n編集した行動');assert.equal(saved.entries[today].valuableDone,true);
   assert.equal(JSON.stringify(saved.syncArchiveBackups),JSON.stringify([bundle]));
   await page.locator('details.ui-item summary').nth(1).click();
   await page.locator('[data-action="copy-sync-archive"]').nth(1).click();
   await page.locator('[data-action="save-archive-draft"]').click();
   const actions=await page.evaluate(()=>window.archiveQA.data().progress.actions);
   assert.equal(actions.length,2);assert.equal(actions[0].title,'元のアクション');assert.equal(actions[1].status,'未着手');
   await page.evaluate(()=>window.archiveQA.token());
   const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="export-sync-archive"]').click();
   const download=await downloadPromise,path=await download.path(),backup=JSON.parse(fs.readFileSync(path,'utf8'));
   assert.equal(backup.syncArchiveBackups.length,2);assert.equal(JSON.stringify(backup.syncArchiveBackups[1].rows),JSON.stringify(rows));
   let downloads=0;page.on('download',()=>downloads++);failed=true;
   await page.locator('[data-action="export-sync-archive"]').click();await page.waitForFunction(()=>document.querySelector('#syncStatus').textContent.includes('作成できません'));
   assert.equal(downloads,0);assert.equal(errors.length,0,errors.join('\n'));
   console.log((mobile?'mobile '+type.name():'desktop Chromium')+': archive roundtrip viewer, partial protection, append, action clone, quota retry, fresh GET backup and network failure passed');
  }finally{await browser.close();}
 }
 }finally{server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
