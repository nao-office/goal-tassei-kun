// Isolated browser QA: synthetic localStorage and intercepted Google API calls only.
const {chromium}=require('playwright'),fs=require('fs'),http=require('http'),vm=require('vm'),assert=require('assert/strict');
const root=__dirname;
const artifacts=root+'/test-results';fs.mkdirSync(artifacts,{recursive:true});
const ctx={window:{}};vm.createContext(ctx);for(const p of ['sheets-writeback.js','goal-management-sync.js'])vm.runInContext(fs.readFileSync(root+'/'+p,'utf8'),ctx);
const W=ctx.window.GoalWriteback,G=ctx.window.GoalManagementSync;
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const yesterday=new Date(new Date(today+'T12:00:00+09:00').getTime()-86400000).toISOString().slice(0,10);
const current={fit:'理由の例',normal:'当たり前の例',futureAction:'未来の行動の例',valuableAction:'今日の既存行動',minimumAction:'最低ラインは保持',withoutAction:'未来の例'};
const fixture={version:1,goal:{title:'架空のゴール',scene:'',identity:'',why:''},goals:[],goalHistory:[],goalChecks:[],goalIdeas:[{id:'fixture-seed',question:'なぜ大切？',content:'架空の材料',state:'要確認',theme:'仕事'}],progress:{},entries:{[today]:current,[yesterday]:{tomorrow:'前夜の架空の一歩'}}};
const sheetId='fixture-spreadsheet-123456';
const requests=[];
const server=http.createServer((req,res)=>{const p=(req.url==='/'?'/index.html':req.url).split('?')[0];try{const text=fs.readFileSync(root+p);res.setHeader('Content-Type',p.endsWith('.js')?'application/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(text);}catch{res.writeHead(404);res.end();}});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
let remoteRows=[structuredClone(W.workHeaders)],delayWrite=false,releaseWrite,signalWriteStarted;
const writeStarted=new Promise(resolve=>signalWriteStarted=resolve);
const row=Array(24).fill('');row[0]=today;for(const [i,k] of Object.entries(W.workFields))row[i]=[7,8,12,22].includes(+i)?'FALSE':(current[k]||'');row[4]='Sheetsの旧行動';remoteRows.push(row);
const other=Array(24).fill('');other[0]=yesterday;other[11]='前夜の架空の一歩';for(const i of [7,8,12,22])other[i]='FALSE';remoteRows.push(other);
const initialRows=structuredClone(remoteRows);
const baseline=W.baselineFromRows(initialRows,[W.actionHeaders]);
await context.addInitScript(({fixture,sheetId,baseline})=>{
 if(!localStorage.getItem('qa-initialized')){localStorage.setItem('mirai-goal-companion-v1',JSON.stringify(fixture));localStorage.setItem('mirai-goal-sheet-sync-config-v1',JSON.stringify({sheetId,lastSync:'2026-01-01',lastMethod:'CSV'}));localStorage.setItem('mirai-goal-sheet-write-baseline-v1:'+sheetId,JSON.stringify(baseline));localStorage.setItem('qa-initialized','1');}
 window.google={accounts:{oauth2:{initTokenClient:({callback})=>({requestAccessToken:()=>callback({access_token:'fake-test-token',expires_in:3600})})}}};
},{fixture,sheetId,baseline});
await context.route('**/*',async route=>{
 const req=route.request(),url=req.url();if(url.startsWith(origin))return route.continue();
 if(!url.startsWith('https://sheets.googleapis.com/'))return route.abort();
 requests.push({method:req.method(),url});const path=decodeURIComponent(url);
 if(req.method()==='POST'){
  if(delayWrite)await new Promise(r=>{releaseWrite=r;signalWriteStarted();});
  const body=req.postDataJSON();for(const patch of body.data||[]){const m=patch.range.match(/'ワーク記録'!([A-Z])(\d+)/);if(m){remoteRows[+m[2]-1][m[1].charCodeAt(0)-65]=patch.values[0][0];}}
  return route.fulfill({json:{totalUpdatedCells:1}});
 }
 let values=path.includes("'ワーク記録'")?remoteRows:path.includes("'アクション一覧'")?[W.actionHeaders]:path.includes("'ゴール一覧'")?[G.goalHeaders]:path.includes("'ゴール履歴'")?[G.historySyncHeaders]:path.includes("'ゴール確認履歴'")?[G.checkHeaders]:path.includes("'ゴールの種'")?[G.ideaHeaders]:[];
 return route.fulfill({json:{values}});
});
const page=await context.newPage();let errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.locator('[data-nav="morning"]').click();
const panelText=await page.locator('#app').innerText();assert.ok(panelText.indexOf('前夜の架空の一歩')<panelText.indexOf('1. 自分'));assert.ok(panelText.indexOf('4. 今日')<panelText.indexOf('今日のゴール深掘り（任意）'));
page.once('dialog',d=>d.dismiss());await page.locator('[data-action="use-previous-action"]').click();assert.equal(await page.locator('#valuableAction').inputValue(),'今日の既存行動');
page.once('dialog',d=>d.accept());await page.locator('[data-action="use-previous-action"]').click();assert.equal(await page.locator('#valuableAction').inputValue(),'前夜の架空の一歩');assert.equal(await page.locator('#minimumAction').inputValue(),'最低ラインは保持');
await page.locator('#autoSyncNotice summary').click();await page.locator('#fit').fill('保存テスト');assert.ok(await page.locator('#autoSyncNotice details').evaluate(el=>el.open));assert.match(await page.locator('#autoSyncNotice').innerText(),/端末保存：保存済み/);
await context.setOffline(true);await page.waitForTimeout(100);assert.match(await page.locator('#autoSyncNotice').innerText(),/オフライン/);await context.setOffline(false);
await page.screenshot({path:artifacts+'/morning-desktop.png',fullPage:true});
await page.locator('[data-nav="sync"]').click();if(!await page.locator('#syncAdvanced').evaluate(el=>el.open))await page.locator('#syncAdvanced > summary').click();assert.match(await page.locator('#app').innerText(),/ゴールの種（手動同期・CSV追加）/);
await page.locator('[data-action="google-sync"]').click();await page.waitForFunction(()=>document.querySelector('.sync-review-panel'));assert.equal(requests.filter(x=>x.method==='POST').length,0);assert.doesNotMatch(await page.locator('#syncEvidence').innerText(),/送信完了を確認/);
for(const field of await page.locator('[data-sync-choice][value="device"]').all())await field.check();
delayWrite=true;await page.locator('[data-action="apply-sync-review"]').click();await page.waitForFunction(()=>document.querySelector('#autoSyncNotice').textContent.includes('送信中（完了未確認）'));
// UI status is set before fetch reaches the mock. Wait for the actual held POST.
await Promise.race([writeStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('Mock write request did not arrive')),10000))]);
const sheet=page.locator('#sheetId');await sheet.fill('other-spreadsheet-fixture');assert.equal(await sheet.inputValue(),sheetId);assert.ok(releaseWrite);releaseWrite();delayWrite=false;
await page.waitForFunction(()=>document.querySelector('#syncEvidence').textContent.includes('送信完了を確認'));
assert.ok(requests.some(x=>x.method==='POST'));assert.equal(remoteRows[1][4],'前夜の架空の一歩');
remoteRows[1][4]='別端末を模した架空の変更';await page.locator('[data-action="google-sync"]').click();await page.waitForFunction(()=>document.querySelector('#syncEvidence').textContent.includes('同期基準から変更あり'));
await page.locator('[data-action="cancel-sync-review"]').first().click();assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem('mirai-goal-companion-v1')).entries[key].valuableAction,today),'前夜の架空の一歩');
await page.screenshot({path:artifacts+'/sync-desktop.png',fullPage:true});
await page.reload();await page.locator('[data-nav="sync"]').click();if(!await page.locator('#syncAdvanced').evaluate(el=>el.open))await page.locator('#syncAdvanced > summary').click();assert.doesNotMatch(await page.locator('#syncEvidence').innerText(),/送信完了を確認/);assert.match(await page.locator('#syncEvidence').innerText(),/未確認/);
await page.locator('[data-nav="morning"]').click();await page.evaluate(()=>{window.qaOriginalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mirai-goal-companion-v1')throw new Error('qa quota');return window.qaOriginalSet.call(this,k,v);};});
await page.locator('#fit').fill('保存できない例');assert.match(await page.locator('#autoSyncNotice').innerText(),/端末保存：失敗または未確認/);
const storedBeforeFailure=await page.evaluate(()=>localStorage.getItem('mirai-goal-companion-v1'));
await page.locator('[data-action="confirm-morning"]').click();assert.equal(await page.locator('#fit').inputValue(),'保存できない例');assert.match(await page.locator('#toast').innerText(),/保存できません/);assert.equal(await page.locator('[data-nav="morning"]').getAttribute('aria-current'),'page');
await page.locator('[data-nav="evening"]').click();await page.locator('#growth').fill('失敗時も残す夜の気づき');await page.locator('[data-action="finish-review"]').click();assert.equal(await page.locator('#growth').inputValue(),'失敗時も残す夜の気づき');assert.equal(await page.locator('[data-nav="evening"]').getAttribute('aria-current'),'page');assert.match(await page.locator('#toast').innerText(),/保存できません/);
await page.locator('#lessonReflection').fill('失敗時も残す学び');await page.locator('[data-action="finish-lesson"]').click();assert.equal(await page.locator('#lessonReflection').inputValue(),'失敗時も残す学び');assert.match(await page.locator('#toast').innerText(),/保存できません/);assert.equal(await page.evaluate(()=>localStorage.getItem('mirai-goal-companion-v1')),storedBeforeFailure);
await page.evaluate(()=>Storage.prototype.setItem=window.qaOriginalSet);await page.locator('[data-action="retry-local-save"]').click();assert.equal(await page.locator('#lessonReflection').inputValue(),'失敗時も残す学び');assert.match(await page.locator('#autoSyncNotice').innerText(),/端末保存：保存済み/);await page.locator('[data-action="finish-lesson"]').click();await page.locator('[data-action="finish-review"]').click();assert.equal(await page.locator('[data-nav="history"]').getAttribute('aria-current'),'page');
await page.locator('[data-nav="morning"]').click();await page.locator('[data-action="confirm-morning"]').click();assert.equal(await page.locator('[data-nav="home"]').getAttribute('aria-current'),'page');await page.locator('[data-nav="morning"]').click();
await page.setViewportSize({width:390,height:844});await page.screenshot({path:artifacts+'/morning-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
await page.locator('[data-nav="sync"]').click();if(!await page.locator('#syncAdvanced').evaluate(el=>el.open))await page.locator('#syncAdvanced > summary').click();await page.screenshot({path:artifacts+'/sync-mobile.png',fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
// Browser download/import remains isolated to synthetic fixture data.
const beforeBackup=await page.evaluate(()=>localStorage.getItem('mirai-goal-companion-v1'));
const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').click();const download=await downloadPromise;
assert.match(download.suggestedFilename(),/mirai-goal-backup-/);const exported=JSON.parse(fs.readFileSync(await download.path(),'utf8'));assert.equal(exported.entries[today].fit,'保存できない例');assert.equal(exported.recoveryOnly,undefined);
const candidate=structuredClone(exported);candidate.entries[today].fit='復元候補の架空の入力';const upload={name:'fixture-backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(candidate))};
page.once('dialog',d=>d.dismiss());await page.locator('#importFile').setInputFiles(upload);await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>localStorage.getItem('mirai-goal-companion-v1')),beforeBackup);
await page.evaluate(()=>{window.qaOriginalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='mirai-goal-companion-v1')throw new Error('qa restore quota');return window.qaOriginalSet.call(this,k,v);};});
page.once('dialog',d=>d.accept());await page.locator('#importFile').setInputFiles(upload);await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('バックアップを保存できませんでした'));assert.equal(await page.evaluate(()=>localStorage.getItem('mirai-goal-companion-v1')),beforeBackup);
await page.evaluate(()=>Storage.prototype.setItem=window.qaOriginalSet);page.once('dialog',d=>d.accept());await page.locator('#importFile').setInputFiles(upload);await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('バックアップを読み込みました'));
assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem('mirai-goal-companion-v1')).entries[key].fit,today),candidate.entries[today].fit);assert.equal(await page.evaluate(()=>localStorage.getItem('mirai-goal-auto-sync-enabled-v1')),'0');
// A valid >2MB Japanese backup must restore and export without truncation.
const large=structuredClone(candidate);for(let i=0;i<180;i++){const d=new Date(Date.UTC(2024,0,1+i)).toISOString().slice(0,10);large.entries[d]={fit:'あ'.repeat(3990)};}
const largeBytes=Buffer.from(JSON.stringify(large));assert.ok(largeBytes.length>2_000_000);const requestsBeforeLarge=requests.length;
page.once('dialog',d=>d.accept());await page.locator('#importFile').setInputFiles({name:'fixture-large.json',mimeType:'application/json',buffer:largeBytes});await page.waitForFunction(()=>JSON.parse(localStorage.getItem('mirai-goal-companion-v1')).entries['2024-01-01']?.fit?.length===3990);
await page.locator('[data-nav="sync"]').click();if(!await page.locator('#syncAdvanced').evaluate(el=>el.open))await page.locator('#syncAdvanced > summary').click();const largeDownloadPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').click();const largeDownload=await largeDownloadPromise;assert.match(largeDownload.suggestedFilename(),/mirai-goal-backup-/);const roundtrip=JSON.parse(fs.readFileSync(await largeDownload.path(),'utf8'));assert.equal(roundtrip.entries['2024-01-01'].fit,'あ'.repeat(3990));assert.equal(requests.length,requestsBeforeLarge);
assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:40,requests:requests.length,posts:requests.filter(x=>x.method==='POST').length,screenshots:['morning-desktop','sync-desktop','morning-mobile','sync-mobile'],realGoogleRequests:0},null,2));
await browser.close();server.close();
})().catch(e=>{console.error(e);server.close();process.exit(1)});
