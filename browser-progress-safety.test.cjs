// Synthetic browser data only. External traffic is blocked, including Google.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),vm=require('node:vm');
const root=__dirname,KEY='mirai-goal-companion-v1',moduleContext={window:{}};
vm.createContext(moduleContext);vm.runInContext(fs.readFileSync(root+'/goal-progress.js','utf8'),moduleContext);
const headers=moduleContext.window.GoalProgress.remoteHeaders['週間計画'];
const csv=rows=>({name:'synthetic-plans.csv',mimeType:'text/csv',buffer:Buffer.from([headers,...rows].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n'))});
const planRow=id=>{const row=Array(headers.length).fill('');row[0]=id;row[1]='2026-11-09';row[4]='架空の計画';return row;};
const server=http.createServer((req,res)=>{try{
  const path=(req.url==='/'?'/index.html':req.url).split('?')[0];
  res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(root+path));
}catch{res.writeHead(404);res.end();}});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  try{for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
    await page.goto(origin);
    const stored=()=>page.evaluate(key=>localStorage.getItem(key),KEY);
    const seed=async progress=>{
      await page.evaluate(({key,progress})=>localStorage.setItem(key,JSON.stringify({version:1,goal:{title:'架空のゴール'},entries:{},progress})),{key:KEY,progress});
      await page.reload();
      await page.waitForFunction(async()=> (await navigator.locks.query()).held.some(lock=>lock.name.endsWith(':single-writer')));
    };
    const failStorage=()=>page.evaluate(()=>{
      window.originalSetItem=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key==='mirai-goal-companion-v1')throw Error('synthetic quota');return window.originalSetItem.call(this,key,value);};
    });
    const restoreStorage=()=>page.evaluate(()=>Storage.prototype.setItem=window.originalSetItem);
    const notice=async text=>page.waitForFunction(text=>document.querySelector('#toast').textContent.includes(text),text);
    const openAction=async()=>{
      await page.locator('[data-nav="progress"]').click();
      await page.locator('[data-progress-action="mode"][data-mode="actions"]').click();
      const card=page.locator('[data-disclosure-key="action:a1"]');
      await card.evaluate(el=>{for(let node=el;node;node=node.parentElement)if(node.tagName==='DETAILS')node.open=true;});
      return card;
    };
    // Both local and Sheets-derived actions retain their old state after a failed
    // complete/reopen. Clicking the same button after recovery applies it once.
    for(const source of ['actions','sheetActions'])for(const status of ['未着手','完了']){
      await seed({[source]:[{id:'a1',title:'保存確認用の行動',minimum:'小さな一歩',status,completedAt:status==='完了'?'2026-11-01T00:00:00Z':'',origin:source==='sheetActions'?'Google Sheets':'端末内'}],actionHistory:[]});
      const card=await openAction(),before=await stored(),label=status==='完了'?'未着手に戻す':'完了にする';
      await failStorage();
      for(let attempt=0;attempt<2;attempt++){
        await card.getByRole('button',{name:label,exact:true}).click();await notice('状態と履歴は変更していません');
        assert.equal(await stored(),before);assert.equal(await card.getByRole('button',{name:label,exact:true}).count(),1);
      }
      await restoreStorage();await card.getByRole('button',{name:label,exact:true}).click();await notice('進捗を更新したよ');
      const result=JSON.parse(await stored()).progress;assert.equal(result.actionHistory.length,1);
      assert.equal(result.actions[0].status,status==='完了'?'未着手':'完了');assert.equal(result.actionHistory[0].before.status,status);
      await page.reload();const reloaded=await openAction();
      assert.equal(await reloaded.getByRole('button',{name:status==='完了'?'完了にする':'未着手に戻す',exact:true}).count(),1);
    }
    const openCsv=async()=>{
      await page.locator('[data-nav="sync"]').click();
      await page.locator('#syncAdvanced').evaluate(el=>el.open=true);
      // Set the same selected CSV type as the visible button without a dialog.
      const chooser=page.waitForEvent('filechooser');
      await page.locator('[data-action="sync-action-csv"][data-sheet="週間計画"]').click();await chooser;
    };
    const plans=count=>({weekPlans:Array.from({length:count},(_,i)=>({id:'plan-'+i,week:'2026-11-09',focus:'既存の架空計画'}))});
    const upload=async rows=>{await page.locator('#toast').evaluate(el=>el.textContent='');await page.locator('#actionSyncCsvFile').setInputFiles(csv(rows));};
    await seed(plans(800));await openCsv();const atLimit=await stored();
    for(let attempt=0;attempt<2;attempt++){await upload([planRow('new')]);await notice('最大800件');assert.equal(await stored(),atLimit);}
    await seed(plans(799));await openCsv();const before=await stored();
    await upload([planRow('new'),planRow('other')]);await notice('最大800件');assert.equal(await stored(),before);
    await failStorage();
    for(let attempt=0;attempt<2;attempt++){await upload([planRow('new')]);await notice('今回は追加していません');assert.equal(await stored(),before);}
    await restoreStorage();await upload([planRow('new')]);await notice('新しい記録を1件追加しました');
    const saved=JSON.parse(await stored());assert.equal(saved.progress.weekPlans.length,800);assert.equal(saved.progress.weekPlans.at(-1).id,'new');
    await page.reload();await openCsv();const reloaded=JSON.parse(await stored());
    assert.equal(reloaded.progress.weekPlans.length,800);assert.equal(reloaded.progress.weekPlans.at(-1).id,'new');
    const stable=await stored();await upload([planRow('new')]);await notice('新しく追加できる記録はありません');assert.equal(await stored(),stable);
    await upload(Array.from({length:1401},()=>planRow('new')));await notice('最大1,400行');assert.equal(await stored(),stable);
    for(const event of ['onerror','onabort']){
      await page.evaluate(event=>{window.originalFileReader=FileReader;window.FileReader=class{readAsText(){this[event]();}};},event);
      await upload([planRow('read-failure')]);await notice(event==='onerror'?'読み取れませんでした':'読み取りを中止しました');assert.equal(await stored(),stable);
      await page.evaluate(()=>window.FileReader=window.originalFileReader);
    }
    await seed(plans(0));await page.locator('[data-nav="progress"]').click();
    await page.locator('[data-progress-action="mode"][data-mode="plan"]').click();
    const text=await page.locator('#app').innerText();assert.match(text,/対応項目.*自動連係/);assert.match(text,/週間計画は自動連係されません/);assert.doesNotMatch(text,/Google Sheetsへは書き戻されません/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
    fs.mkdirSync(root+'/test-results',{recursive:true});await page.screenshot({path:root+'/test-results/progress-safety-'+width+'.png',fullPage:true});
    console.log('Progress safety verified at width '+width+': completion/reopen failure and retry, CSV cap/failure/duplicate/reload, synchronization copy.');
    await context.close();
  }}finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
