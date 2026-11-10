// Synthetic local data and CSV uploads only. All external traffic is blocked.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const root = __dirname;
const KEY = 'mirai-goal-companion-v1';
const html = fs.readFileSync(root + '/index.html', 'utf8');
const defaults = JSON.parse(html.match(/const DEFAULT_LESSONS=(.*?);\n/)[1]);
const headers = ['ID','講義','テーマ','学びの要点','今日の問い','今日の実践例','出典','出典URL'];
const fixture = count => ({version:1, goal:{title:'架空の既存ゴール'}, entries:{'2026-11-10':{lessonNotes:{preserved:{reflection:'既存の講義メモ'}}}},
  lessons:[...structuredClone(defaults), ...Array.from({length:count-defaults.length}, (_,i) => ({id:'fixture-'+i, title:'保持する学び '+i}))]});
const file = (rows, name='fixture-lessons.csv') => ({name, mimeType:'text/csv', buffer:Buffer.from([headers,...rows].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n'))});
const fresh = id => [id, 'Day9', '追加する架空の学び', '要点\n続き', '問い', '実践', '出典', 'https://example.test/lesson'];
const server = http.createServer((req,res) => {
  const path = (req.url==='/'?'/index.html':req.url).split('?')[0];
  try {res.setHeader('Content-Type', path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(root+path));}
  catch {res.writeHead(404);res.end();}
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});
  try {
    for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
      const context = await browser.newContext({viewport});
      await context.route('**/*', route => route.request().url().startsWith(origin)?route.continue():route.abort());
      const page = await context.newPage(), errors=[];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      const stored = () => page.evaluate(key => localStorage.getItem(key), KEY);
      const openSync = async () => {
        await page.locator('[data-nav="sync"]').click();
        const advanced = page.locator('#syncAdvanced');
        if(await advanced.count() && !await advanced.evaluate(el => el.open)) await advanced.locator('summary').first().click();
      };
      const seed = async count => {
        await page.evaluate(({key,value}) => localStorage.setItem(key,JSON.stringify(value)), {key:KEY,value:fixture(count)});
        await page.reload(); await page.locator('[data-nav="morning"]').click();
        await page.locator('#fit').fill('CSV検証用の架空の入力');
        await openSync();
      };
      const upload = async rows => page.locator('#lessonCsvFile').setInputFiles(file(rows));
      const notice = async text => {
        await page.waitForFunction(text => document.querySelector('#toast').textContent.includes(text),text);
        assert.doesNotMatch(await page.locator('#toast').innerText(), /新しい学びをCSVから追加しました/);
      };
      const catalog = page.locator('section').filter({has:page.locator('[data-action="sync-lessons-csv"]')});
      await seed(800); const atLimit = await stored();
      await upload([fresh('over-limit')]); await notice('最大800件');
      assert.equal(await stored(), atLimit); assert.match(await catalog.innerText(), /800件登録済み/);
      await upload([fresh('over-limit')]); await notice('最大800件'); assert.equal(await stored(), atLimit);

      await seed(799); const before = await stored();
      await upload([fresh('new-1'),fresh('new-2')]); await notice('今回は追加していません');
      assert.equal(await stored(), before); assert.match(await catalog.innerText(), /799件登録済み/);
      await page.evaluate(() => {
        window.originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key,value) {if(key==='mirai-goal-companion-v1')throw Error('synthetic quota'); return window.originalSetItem.call(this,key,value);};
      });
      for(let i=0;i<2;i++) {
        await upload([fresh('new-1')]); await notice('端末に保存できなかった');
        assert.equal(await stored(), before); assert.match(await catalog.innerText(), /799件登録済み/);
      }
      await page.locator('[data-nav="evening"]').click();
      assert.equal(await page.locator('[data-lesson-id="new-1"]').count(),0);
      await openSync();
      await page.evaluate(() => Storage.prototype.setItem = window.originalSetItem);
      await upload([fresh('new-1')]);
      await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('1件の新しい学びをCSVから追加しました'));
      const saved = JSON.parse(await stored());
      assert.equal(saved.lessons.length,800); assert.equal(saved.lessons.at(-1).id,'new-1');
      assert.deepEqual(saved.lessons.slice(0,799),JSON.parse(before).lessons);
      assert.deepEqual(saved.entries['2026-11-10'],JSON.parse(before).entries['2026-11-10']);
      await page.reload(); await page.locator('[data-nav="evening"]').click();
      assert.equal(await page.locator('[data-lesson-id="new-1"]').count(),1);
      await openSync(); const after = await stored();
      await upload([fresh('new-1')]); await notice('新しく追加できる学びはありません');
      assert.equal(await stored(), after); assert.match(await catalog.innerText(), /800件登録済み/);
      const many = Array.from({length:1500},()=>fresh(defaults[0].id)); many.push(fresh('last-row'));
      await upload(many); await notice('最大1,500行'); assert.equal(await stored(), after);
      for(const event of ['onerror','onabort']) {
        await page.evaluate(event => {window.originalFileReader=FileReader; window.FileReader=class {readAsText(){this[event]();}};},event);
        await upload([fresh('failed-read')]); await notice(event==='onerror'?'読み取れませんでした':'読み取りを中止しました');
        assert.equal(await stored(),after);
        await page.evaluate(() => window.FileReader=window.originalFileReader);
      }
      assert.deepEqual(errors,[]);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
      fs.mkdirSync(root+'/test-results',{recursive:true});
      await page.screenshot({path:root+'/test-results/lesson-csv-'+viewport.width+'.png',fullPage:true});
      await context.close();
    }
    console.log('PASS: lesson CSV limits, failed persistence, retries, duplicates, reload and read failures at desktop/mobile widths. Synthetic data only; no real Google or iPhone testing.');
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exit(1);});
