// Two independent browser stores with one stateful, entirely mocked Sheets service.
// WebKit with an iPhone viewport is simulation, not a real iPhone/Safari/OAuth test.
const {chromium,webkit,devices}=require('playwright');
const fs=require('node:fs'),http=require('node:http'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=__dirname,KEY='mirai-goal-companion-v1',sheetId='fixture-two-devices-20261107';
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const modules={window:{}};vm.createContext(modules);for(const p of ['sheets-writeback.js','goal-management-sync.js'])vm.runInContext(fs.readFileSync(root+'/'+p,'utf8'),modules);
const W=modules.window.GoalWriteback,G=modules.window.GoalManagementSync;
const values={valuableAction:'共有済みの行動',minimumAction:'共有済みの最低ライン'};
const row=Array(24).fill('');row[0]=today;for(const [index,key] of Object.entries(W.workFields))row[index]=[7,8,12,22].includes(+index)?'FALSE':values[key]||'';
let workRows=[structuredClone(W.workHeaders),row],failNextWrite=false;
const baseline=W.baselineFromRows(workRows,[W.actionHeaders]),requests=[],checks=[],errors=[],browsers=[];
const server=http.createServer((req,res)=>{const p=(req.url==='/'?'/index.html':req.url).split('?')[0];try{res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(root+p));}catch{res.writeHead(404);res.end();}});
async function stored(page){return page.evaluate(k=>localStorage.getItem(k),KEY);}
async function value(page,key){return JSON.parse(await stored(page)).entries[today][key];}
async function edit(page,key,text){await page.locator('[data-nav="'+(['achievement','growth','tomorrow'].includes(key)?'evening':'morning')+'"]').click();await page.locator('#'+key).fill(text);assert.equal(await value(page,key),text);}
async function compare(page){await page.locator('[data-nav="sync"]').click();const before=await stored(page),postCount=requests.filter(x=>x.method==='POST').length;await page.locator('[data-action="google-sync"]').click();await page.locator('.sync-review-panel').first().waitFor();assert.equal(await stored(page),before);assert.equal(requests.filter(x=>x.method==='POST').length,postCount);}
async function choose(page,choice){const fields=page.locator('[data-sync-choice][value="'+choice+'"]');const count=await fields.count();assert.ok(count>0,'Expected an explicit difference');for(let i=0;i<count;i++)await fields.nth(i).check();}
async function apply(page){await page.locator('[data-action="apply-sync-review"]').click();await page.waitForFunction(()=>!document.querySelector('[data-action="apply-sync-review"]')||document.querySelector('#syncStatus')?.textContent.includes('同期を停止しました'));}
async function makeDevice(name,browser,options,origin){
 const context=await browser.newContext(options);const fixture={version:1,goal:{title:'',scene:'',identity:'',why:''},goals:[],goalHistory:[],goalChecks:[],goalIdeas:[],lessons:[],entries:{[today]:values},progress:{reviews:[{id:'local-'+name,week:'2026-11-02',facts:name+'だけの週次メモ'}]}};
 await context.addInitScript(({KEY,fixture,sheetId,baseline})=>{
  if(!localStorage.getItem('fixture-init')){localStorage.setItem(KEY,JSON.stringify(fixture));localStorage.setItem('mirai-goal-sheet-sync-config-v1',JSON.stringify({sheetId}));localStorage.setItem('mirai-goal-sheet-write-baseline-v1:'+sheetId,JSON.stringify(baseline));localStorage.setItem('fixture-init','1');}
  window.google={accounts:{oauth2:{initTokenClient:({callback})=>({requestAccessToken:()=>callback({access_token:'synthetic-token',expires_in:3600})})}}};
 },{KEY,fixture,sheetId,baseline});
 await context.route('**/*',async route=>{
  const req=route.request(),url=req.url();if(url.startsWith(origin+'/'))return route.continue();
  if(!url.startsWith('https://sheets.googleapis.com/'))return route.abort();
  requests.push({device:name,method:req.method()});const path=decodeURIComponent(url);
  if(req.method()==='POST'){
   if(failNextWrite){failNextWrite=false;return route.fulfill({status:500,json:{error:{message:'synthetic failed write'}}});}
   let count=0;for(const patch of req.postDataJSON().data||[]){const m=patch.range.match(/^'ワーク記録'!([A-X])(\d+)$/);assert.ok(m,'Only expected work-cell writes allowed: '+patch.range);const r=+m[2]-1,c=m[1].charCodeAt(0)-65;assert.ok(workRows[r]);workRows[r][c]=patch.values[0][0];count++;}
   return route.fulfill({json:{totalUpdatedCells:count}});
  }
  const rows=path.includes("'ワーク記録'")?workRows:path.includes("'アクション一覧'")?[W.actionHeaders]:path.includes("'ゴール一覧'")?[G.goalHeaders]:path.includes("'ゴール履歴'")?[G.historySyncHeaders]:path.includes("'ゴール確認履歴'")?[G.checkHeaders]:path.includes("'ゴールの種'")?[G.ideaHeaders]:null;
  assert.ok(rows,'Unexpected mocked API request '+path);return route.fulfill({json:{values:rows}});
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(name+': '+e.message));page.on('dialog',dialog=>dialog.dismiss());await page.goto(origin);return {page,context};
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const pcBrowser=await chromium.launch({headless:true});browsers.push(pcBrowser);const mobileEngine=process.env.MOBILE_BROWSER==='chromium'?chromium:webkit;const phoneBrowser=await mobileEngine.launch({headless:true});browsers.push(phoneBrowser);
 const pc=await makeDevice('PC',pcBrowser,{viewport:{width:1440,height:1000}},origin),phone=await makeDevice('mobile',phoneBrowser,devices['iPhone 13'],origin);const A=pc.page,B=phone.page;
 await edit(A,'valuableAction','PCで変更した行動');assert.equal(await value(B,'valuableAction'),'共有済みの行動');checks.push('isolated stores');
 await compare(A);await choose(A,'device');await apply(A);assert.equal(workRows[1][4],'PCで変更した行動');assert.equal(await value(B,'valuableAction'),'共有済みの行動');checks.push('PC send does not auto-import on mobile');
 await compare(B);assert.match(await B.locator('#syncEvidence').innerText(),/同期基準から変更あり/);await choose(B,'sheets');const beforeReadOnlyPosts=requests.filter(x=>x.method==='POST').length;await apply(B);assert.equal(await value(B,'valuableAction'),'PCで変更した行動');assert.equal(requests.filter(x=>x.method==='POST').length,beforeReadOnlyPosts);checks.push('mobile explicit remote choice without write');
 await edit(B,'minimumAction','モバイルで変更した最低ライン');await compare(B);await choose(B,'device');await apply(B);assert.equal(workRows[1][5],'モバイルで変更した最低ライン');await compare(A);await choose(A,'sheets');await apply(A);assert.equal(await value(A,'minimumAction'),'モバイルで変更した最低ライン');checks.push('reverse mobile to PC');
 for(const [page,name] of [[A,'PC'],[B,'mobile']]){const data=JSON.parse(await stored(page));assert.equal(data.progress.reviews.length,1);assert.equal(data.progress.reviews[0].facts,name+'だけの週次メモ');}checks.push('device-only reviews preserved');
 await edit(A,'fit','PC側の競合入力');await edit(B,'fit','モバイル側の競合入力');await compare(B);await choose(B,'device');await apply(B);await compare(A);assert.match(await A.locator('.sync-review-panel').first().innerText(),/競合/);const postsBeforeDefer=requests.filter(x=>x.method==='POST').length;await choose(A,'defer');await A.locator('[data-action="apply-sync-review"]').click();assert.match(await A.locator('#syncStatus').innerText(),/未選択/);assert.equal(requests.filter(x=>x.method==='POST').length,postsBeforeDefer);assert.equal(await value(A,'fit'),'PC側の競合入力');checks.push('conflicts defer without losing either value');
 await A.locator('[data-action="cancel-sync-review"]').first().click();assert.equal(await value(A,'fit'),'PC側の競合入力');await compare(A);await choose(A,'sheets');await apply(A);assert.equal(await value(A,'fit'),'モバイル側の競合入力');checks.push('cancel and explicit conflict resolution');
 await edit(A,'growth','送信失敗後も残す内容');await compare(A);await choose(A,'device');failNextWrite=true;await apply(A);assert.match(await A.locator('#syncStatus').innerText(),/同期を停止しました/);assert.equal(workRows[1][10],'');assert.equal(await value(A,'growth'),'送信失敗後も残す内容');assert.match(await A.locator('#syncEvidence').innerText(),/未完了・結果未確認/);checks.push('failed write retains local content');
 await compare(A);await choose(A,'device');await apply(A);assert.equal(workRows[1][10],'送信失敗後も残す内容');checks.push('failed write retry');
 await compare(B);const beforeConflict=await stored(B);await choose(B,'sheets');workRows[1][10]='比較後に変わったSheets側の値';const postsBeforeStale=requests.filter(x=>x.method==='POST').length;await apply(B);assert.match(await B.locator('#syncStatus').innerText(),/同期を停止しました/);assert.equal(await stored(B),beforeConflict);assert.equal(requests.filter(x=>x.method==='POST').length,postsBeforeStale);checks.push('stale remote review stops before write');
 await B.reload();await B.locator('[data-nav="sync"]').click();assert.match(await B.locator('#syncEvidence').innerText(),/未確認/);assert.doesNotMatch(await B.locator('#syncEvidence').innerText(),/送信完了を確認/);checks.push('reload clears send evidence');
 assert.deepEqual(errors,[]);fs.mkdirSync(root+'/test-results',{recursive:true});await A.screenshot({path:root+'/test-results/device-sync-PC.png',fullPage:true});await B.screenshot({path:root+'/test-results/device-sync-mobile-webkit.png',fullPage:true});
 console.log(JSON.stringify({passed:true,browsers:['desktop Chromium','iPhone 13 viewport on '+(process.env.MOBILE_BROWSER==='chromium'?'Chromium':'Linux WebKit')+' (not real iPhone)'],checks,requests:requests.length,posts:requests.filter(x=>x.method==='POST').length,realGoogleRequests:0},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await Promise.all(browsers.map(browser=>browser.close()));server.close();});
