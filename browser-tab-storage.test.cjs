// Shared-origin tabs with synthetic data. Never contacts live Google services.
const {chromium,webkit}=require('playwright'),fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const KEY='mirai-goal-companion-v1',root=__dirname;
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const fixture={version:1,goal:{title:'既存の未来'},entries:{[today]:{fit:'既存の理由',normal:'既存の当たり前'}},goals:[{id:'g1',theme:'検証',period:'1年',qualitative:'既存のゴール',why:'既存の理由',status:'進行中'}],progress:{actions:[{id:'a1',title:'既存の行動',minimum:'既存の最低ライン',status:'未着手'}]}};
const server=http.createServer((req,res)=>{try{
 const path=(req.url==='/'?'/index.html':req.url).split('?')[0];let body=fs.readFileSync(root+path,'utf8');
 if(path==='/index.html')body=body.replace('\n})();\n</script>',`\nwindow.tabQA={state:()=>tabGuard.state(),data:()=>data,drafts:tabDrafts,save,guard:()=>tabGuard,resume:resumeTabEditing,importReviewedSheetsData,importGoalManagementData,applyReviewedSync,saveGoalManagementChanges,autoCommit,autoSyncTick,setBusy:v=>writeBusy=v,archive:v=>archiveDraft=v,exportRescue:exportTabRescue,primeSession:()=>{cloudWorkerUrl='https://old.example.test';cloudSession='old-session';googleToken='old-token';googleTokenWritable=true;autoWriteToken=true;autoTokenExpiresAt=Date.now()+3600000;},session:()=>({cloudWorkerUrl,cloudSession,googleToken,googleTokenWritable,autoWriteToken})};\n})();\n</script>`);
 res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);
}catch{res.writeHead(404);res.end();}});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const type=process.env.TAB_BROWSER==='webkit'?webkit:chromium;
 const browser=await type.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH&&type===chromium?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
 try{for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true}),errors=[];
 await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const a=await context.newPage();a.on('pageerror',e=>errors.push(e.message));await a.goto(origin);
 await a.evaluate(({key,value})=>localStorage.setItem(key,JSON.stringify(value)),{key:KEY,value:fixture});await a.reload();await a.waitForFunction(()=>tabQA.state().owned);
 const b=await context.newPage();b.on('pageerror',e=>errors.push(e.message));await b.goto(origin);await b.waitForFunction(()=>!tabQA.state().waiting);
 const stored=()=>a.evaluate(key=>JSON.parse(localStorage.getItem(key)),KEY);
 const data=p=>p.evaluate(()=>JSON.parse(JSON.stringify(tabQA.data())));
 const takeover=async p=>{await p.locator('[data-action="resume-tab-edit"]').click();await p.waitForFunction(()=>tabQA.state().owned&&!tabQA.state().stale&&!tabQA.state().waiting&&!tabQA.state().suspended);};
 for(const p of [a,b])await p.locator('[data-nav="morning"]').click();
 // Rapid overlapping edits: the follower cannot write even before event delivery.
 await Promise.all([a.locator('#fit').fill('Aの理由'),b.locator('#normal').fill('Bの当たり前')]);
 assert.equal((await stored()).entries[today].fit,'Aの理由');assert.equal((await stored()).entries[today].normal,'既存の当たり前');assert.equal(await b.locator('#normal').inputValue(),'Bの当たり前');
 assert.match(await b.locator('#autoSyncNotice').innerText(),/保存・同期を保留/);assert.match(await b.locator('[data-local-save-hint]').innerText(),/保存は保留中/);
 fs.mkdirSync(root+'/test-results',{recursive:true});await b.screenshot({path:root+'/test-results/tab-paused-'+width+'.png',fullPage:true});
 await takeover(b);assert.equal((await stored()).entries[today].fit,'Aの理由');assert.equal((await stored()).entries[today].normal,'Bの当たり前');
 // Stale direct sync entry points return before reading or writing external data.
 assert.equal(await a.evaluate(async()=>{for(const name of ['importReviewedSheetsData','importGoalManagementData','applyReviewedSync','saveGoalManagementChanges','autoCommit','autoSyncTick'])await tabQA[name]();return true;}),true);
 // Conflicting values survive in durable rescue while selected tab retains its input.
 await b.locator('#fit').fill('Bが同じ項目を変更');await a.locator('#fit').fill('Aの編集中の内容');await takeover(a);
 assert.equal((await stored()).entries[today].fit,'Aの編集中の内容');
 const rescues=await a.evaluate(()=>tabQA.guard().rescues());assert.ok(rescues.some(r=>r.otherTab.entries[today].fit==='Bが同じ項目を変更'&&r.thisTab.entries[today].fit==='Aの編集中の内容'));
 // Dirty goal form remains usable; untouched fields pick up the other tab's edit.
 for(const p of [a,b]){await p.locator('[data-nav="goal"]').click();await p.locator('[data-goal-form][data-goal-id="g1"]').evaluate(form=>{for(let n=form.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;});}
 const goal=p=>p.locator('[data-goal-form][data-goal-id="g1"]');
 await goal(b).locator('[name="qualitative"]').fill('Bの未保存ゴール');
 await goal(a).locator('[name="why"]').fill('Aが更新した理由');await goal(a).locator('[data-action="save-goal"]').click();
 assert.equal(await goal(b).locator('[name="qualitative"]').inputValue(),'Bの未保存ゴール');
 await takeover(b);assert.equal(await goal(b).locator('[name="qualitative"]').inputValue(),'Bの未保存ゴール');assert.equal(await goal(b).locator('[name="why"]').inputValue(),'Aが更新した理由');
 await goal(b).locator('[data-action="save-goal"]').click();assert.equal((await stored()).goals[0].qualitative,'Bの未保存ゴール');assert.equal((await stored()).goals[0].why,'Aが更新した理由');
 // Unsaved action survives another handover, including its reason and untouched fields.
 await a.locator('[data-nav="progress"]').click();await a.locator('[data-progress-action="edit"][data-id="a1"]').first().evaluate(el=>{for(let n=el.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;});await a.locator('[data-progress-action="edit"][data-id="a1"]').first().click();
 await a.locator('#pg-action-form [name="note"]').fill('未保存の進捗メモ');await a.locator('#pg-action-form [name="reason"]').fill('変更理由を保持');
 await takeover(a);assert.equal(await a.locator('#pg-action-form [name="note"]').inputValue(),'未保存の進捗メモ');assert.equal(await a.locator('#pg-action-form [name="reason"]').inputValue(),'変更理由を保持');
 await a.locator('[data-progress-action="save-action"]').click();assert.equal((await stored()).progress.actions[0].note,'未保存の進捗メモ');
 // Weekly-review drafts survive as editable form inputs, not only recovery JSON.
 await b.locator('[data-nav="progress"]').click();await b.locator('[data-progress-action="mode"][data-mode="review"]').click();
 await b.locator('#pg-review-form [name="facts"]').fill('Bの未保存の週次レビュー');await b.locator('#pg-review-form [name="learning"]').fill('週の学びも残す');
 await a.evaluate(()=>{tabQA.data().entries[Object.keys(tabQA.data().entries)[0]].growth='Aの新しい振り返り';tabQA.save();});
 await takeover(b);assert.equal(await b.locator('#pg-review-form [name="facts"]').inputValue(),'Bの未保存の週次レビュー');assert.equal(await b.locator('#pg-review-form [name="learning"]').inputValue(),'週の学びも残す');
 await b.locator('[data-progress-action="save-review"]').click();assert.equal((await stored()).progress.reviews[0].facts,'Bの未保存の週次レビュー');await takeover(a);
 // A deleted edited record has an on-screen draft, not only a JSON artifact.
 await b.locator('[data-nav="goal"]').click();await goal(b).evaluate(form=>{for(let n=form.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS')n.open=true;});await goal(b).locator('[name="memo"]').fill('削除されても残すメモ');
 await a.evaluate(()=>{tabQA.data().goals=[];tabQA.save();});await takeover(b);
 assert.equal(await goal(b).locator('[name="memo"]').inputValue(),'削除されても残すメモ');assert.equal(await goal(b).locator('[name="qualitative"]').inputValue(),'Bの未保存ゴール');
 await goal(b).locator('[data-action="save-goal"]').click();assert.equal((await stored()).goals[0].memo,'削除されても残すメモ');
 // Busy network work must retain its lock through pagehide and defer a takeover.
 await b.evaluate(()=>{tabQA.setBusy(true);dispatchEvent(new Event('pagehide'));});assert.equal((await b.evaluate(()=>tabQA.state())).owned,true);
 await a.locator('[data-action="resume-tab-edit"]').click();await a.waitForFunction(()=>tabQA.state().waiting);assert.equal((await b.evaluate(()=>tabQA.state())).owned,true);
 await b.evaluate(()=>tabQA.setBusy(false));await a.waitForFunction(()=>tabQA.state().owned&&!tabQA.state().stale&&!tabQA.state().suspended);
 // Failure to preserve a rescue never changes canonical records or loses text.
 await b.locator('[data-nav="morning"]').click();await b.locator('#normal').fill('容量不足でも残す入力');const before=await stored();
 await b.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes(':tab-rescue:'))throw Error('synthetic rescue quota');return originalSetItem.call(this,k,v);};});
 await b.locator('[data-action="resume-tab-edit"]').click();await b.waitForFunction(()=>document.querySelector('#toast').textContent.includes('synthetic rescue quota'));
 assert.deepEqual(await stored(),before);assert.equal(await b.locator('#normal').inputValue(),'容量不足でも残す入力');
 await b.evaluate(()=>Storage.prototype.setItem=originalSetItem);await takeover(b);assert.equal((await stored()).entries[today].normal,'容量不足でも残す入力');
 // Recovery download includes the unsaved archive editor, full records and prior conflicts.
 await b.evaluate(()=>tabQA.archive({kind:'work',originalId:'synthetic',values:{fit:'別記録の未保存コピー'}}));
 const downloaded=b.waitForEvent('download');await b.evaluate(()=>tabQA.exportRescue());const file=await downloaded;
 const recovery=JSON.parse(fs.readFileSync(await file.path(),'utf8'));assert.equal(recovery.archiveDraft.values.fit,'別記録の未保存コピー');assert.ok(recovery.rescues.length);
 // Auth settings changed in the owner must replace the follower's stale session.
 await a.evaluate(()=>tabQA.primeSession());await b.evaluate(()=>{localStorage.setItem('mirai-goal-cloud-auth-worker-v1','https://new.example.test');localStorage.setItem('mirai-goal-cloud-auth-session-v1','new-session');});
 // Closing the writer releases the lock; a surviving stale tab can resume safely.
 await b.close();await takeover(a);assert.deepEqual(await a.evaluate(()=>tabQA.session()),{cloudWorkerUrl:'https://new.example.test',cloudSession:'new-session',googleToken:'',googleTokenWritable:false,autoWriteToken:false});await a.reload();await a.waitForFunction(()=>tabQA.state().owned);assert.equal((await data(a)).entries[today].normal,'容量不足でも残す入力');
 assert.deepEqual(errors,[]);assert.ok(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 fs.mkdirSync(root+'/test-results',{recursive:true});await a.screenshot({path:root+'/test-results/tab-storage-'+width+'.png',fullPage:true});await context.close();
 }
 console.log('PASS: shared-origin rapid edits, stale write/sync blocking, explicit takeover, same-field recovery, dirty/orphan goal and action forms, weekly-review drafts, busy-pagehide, quota retry, rescue export, writer close/reload at desktop/mobile widths. Synthetic services only.');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exit(1);});
