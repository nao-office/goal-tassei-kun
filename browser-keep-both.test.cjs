// Automatic, keep-both integration QA. All Google/OAuth traffic is intercepted.
// Separate Chromium and iPhone-profile WebKit stores share only this synthetic Sheets service.
// MOBILE_BROWSER=chromium is a local fallback, not Safari or real-device coverage.
const {chromium, webkit, devices} = require('playwright');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const root = __dirname;
const KEY = 'mirai-goal-companion-v1';
const SHEET = 'fixture-automatic-keep-both-20261107';
const ARCHIVE = '同期の別記録';
const ACTION = 'fixture-shared-action';
const today = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
const modules = {window:{}};
vm.createContext(modules);
for (const name of ['sheets-writeback.js', 'goal-management-sync.js']) {
  vm.runInContext(fs.readFileSync(root + '/' + name, 'utf8'), modules);
}
const W = modules.window.GoalWriteback;
const G = modules.window.GoalManagementSync;
const baseEntry = {valuableAction:'共有済みの行動', minimumAction:'共有済みの最低ライン'};
const baseAction = Object.fromEntries(Object.values(W.actionFields).map(key => [key, '']));
Object.assign(baseAction, {id:ACTION, title:'共有済みのアクション', priority:'通常', status:'未着手'});
const workRow = Array(24).fill('');
workRow[0] = today;
for (const [index, key] of Object.entries(W.workFields)) {
  workRow[index] = [7, 8, 12, 22].includes(+index) ? 'FALSE' : baseEntry[key] || '';
}
// Unmapped cells must never be changed by automatic work sync.
workRow[13] = 'Sheetsだけのゴール';
workRow[14] = 'Sheetsだけの未来の景色';
workRow[17] = 'fixture-remote-timestamp';
const actionRow = Object.entries(W.actionFields).map(([, key]) => baseAction[key]);
const sheets = new Map([
  ['ワーク記録', [structuredClone(W.workHeaders), workRow]],
  ['アクション一覧', [structuredClone(W.actionHeaders), actionRow]],
  ['ゴール一覧', [structuredClone(G.goalHeaders)]],
  ['ゴール履歴', [structuredClone(G.historySyncHeaders)]],
  ['ゴール確認履歴', [structuredClone(G.checkHeaders)]],
  ['ゴールの種', [structuredClone(G.ideaHeaders)]]
]);
const baseline = W.baselineFromRows(sheets.get('ワーク記録'), sheets.get('アクション一覧'));
const requests = [], checks = [], errors = [], mockErrors = [], dialogs = [], browsers = [];
let failArchiveWrite = false, failMainWrite = false, failReadDevice = '';
let holdMainDevice = '', heldMain = null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = name => sheets.get(name);
const work = () => rows('ワーク記録')[1];
const archive = () => rows(ARCHIVE) || [];
const mutations = () => requests.filter(request => request.main && request.applied);
const appliedArchive = () => requests.filter(request => request.archive && request.applied);
const check = description => { checks.push(description); console.log('PASS ' + description); };

async function until(predicate, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (mockErrors.length) throw mockErrors[0];
    if (await predicate()) return;
    await pause(40);
  }
  throw Error('Timed out: ' + description);
}
function column(text) {
  return [...text].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
}
function parseRange(range) {
  const match = range.match(/^'([^']+)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
  assert.ok(match, 'Unexpected fixture range: ' + range);
  return {name:match[1], col:column(match[2]), row:Number(match[3] || 1) - 1};
}
function applyValues(range, values, append) {
  const target = parseRange(range);
  assert.ok(sheets.has(target.name), 'Writing a missing tab: ' + target.name);
  assert.ok(['ワーク記録', 'アクション一覧', ARCHIVE].includes(target.name), 'Forbidden fixture write: ' + range);
  const sheet = rows(target.name), start = append ? sheet.length : target.row;
  values.forEach((valuesRow, rowIndex) => {
    sheet[start + rowIndex] ||= [];
    valuesRow.forEach((value, colIndex) => { sheet[start + rowIndex][target.col + colIndex] = value; });
  });
  return values.reduce((total, row) => total + row.length, 0);
}
function archiveVersions() {
  const grouped = new Map();
  for (const row of archive().slice(1)) {
    assert.match(String(row[0]), /^sha256:[a-f0-9]{64}$/);
    assert.equal(String(row[1]), '1');
    assert.ok(['work', 'action'].includes(row[2]));
    assert.ok(['device', 'sheets'].includes(row[4]));
    if (!grouped.has(row[0])) grouped.set(row[0], []);
    grouped.get(row[0]).push(row);
  }
  return [...grouped.values()].map(chunks => {
    // Sheets append has no atomic deduplication across independent devices.
    // Concurrent identical appends are one logical version; disagreeing bytes
    // with the same content ID must never be accepted as a complete archive.
    const uniqueChunks = new Map();
    for (const chunk of chunks) {
      const prior = uniqueChunks.get(Number(chunk[5]));
      if (prior) assert.deepEqual(chunk.slice(5, 9), prior.slice(5, 9), 'Repeated archive chunks must have identical content');
      uniqueChunks.set(Number(chunk[5]), chunk);
    }
    const ordered = [...uniqueChunks.values()].sort((a, b) => Number(a[5]) - Number(b[5]));
    assert.equal(ordered.length, Number(chunks[0][6]), 'Archive must contain every chunk');
    ordered.forEach((chunk, index) => assert.equal(Number(chunk[5]), index + 1));
    const json = ordered.map(chunk => chunk[8]).join('');
    assert.equal(crypto.createHash('sha256').update(json).digest('hex'), chunks[0][7], 'Archive payload hash');
    return {archiveId:chunks[0][0], side:chunks[0][4], ...JSON.parse(json)};
  });
}
function assertArchived(key, deviceValue, sheetsValue) {
  const versions = archiveVersions().filter(item => item.kind === 'work' && item.id === today);
  // Content IDs are independent of source: an earlier identical version may have
  // been archived by the other device and is reused rather than appended twice.
  assert.ok(versions.some(item => item.values?.[key] === deviceValue), 'Device version missing: ' + key);
  assert.ok(versions.some(item => item.values?.[key] === sheetsValue), 'Sheets version missing: ' + key);
}
function localOnly(data) {
  const entry = data.entries[today];
  const action = data.progress.actions.find(item => item.id === ACTION);
  return {
    goal:data.goal, goals:data.goals, goalIdeas:data.goalIdeas, lessons:data.lessons,
    reviews:data.progress.reviews, reviewHistory:data.progress.reviewHistory,
    weekPlans:data.progress.weekPlans, actionIdeas:data.progress.actionIdeas,
    actionHistory:data.progress.actionHistory, sheetHistory:data.progress.sheetHistory,
    linkedActionId:entry.linkedActionId, goalSnapshot:entry.goalSnapshot,
    otherLesson:entry.lessonNotes?.['fixture-other-lesson'],
    actionFacts:action?.facts, actionGap:action?.gap, plannedWeek:action?.plannedWeek, origin:action?.origin
  };
}
async function data(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY); }
async function value(page, key) { return (await data(page)).entries[today]?.[key]; }
async function navigate(page, tab) { await page.locator('[data-nav="' + tab + '"]').click(); }
async function reveal(page, selector) {
  const target = page.locator(selector);
  for (const details of await page.locator('details').filter({has:target}).all()) {
    if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
  }
  return target;
}
async function edit(page, key, text) {
  await navigate(page, ['achievement', 'growth', 'tomorrow'].includes(key) ? 'evening' : 'morning');
  await page.locator('#' + key).fill(text);
  assert.equal(await value(page, key), text, 'Inputs must save locally before syncing');
}
async function idle(page) {
  await until(async () => {
    const notice = await page.locator('#autoSyncNotice').innerText();
    return !/送信処理中|接続を確認中|差分を確認中|同期中|自動保存しています|両方の記録を保存中/.test(notice);
  }, 'automatic sync leaves the busy state');
  await pause(80);
}
async function enable(page) {
  await navigate(page, 'sync');
  await page.locator('[data-action="toggle-auto-sync"]').click();
  await until(async () => (await page.evaluate(() => localStorage.getItem('mirai-goal-auto-sync-enabled-v1'))) === '1', 'automatic sync enabled without choices');
  assert.equal(await page.locator('[data-sync-choice]:checked').count(), 0);
}
async function disable(page) {
  await idle(page);
  await navigate(page, 'sync');
  await page.locator('[data-action="toggle-auto-sync"]').click();
  await until(async () => (await page.evaluate(() => localStorage.getItem('mirai-goal-auto-sync-enabled-v1'))) === '0', 'automatic sync disabled');
}
async function poll(page) {
  // Use the same browser lifecycle event as returning to an open tab.
  // No application globals or hidden commit functions are invoked by the test.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function stopped(page) {
  await until(async () => /停止|保留|失敗|通信.*確認でき/.test(await page.locator('#autoSyncNotice').innerText()), 'failure explained in persistent notice');
  await navigate(page, 'sync');
  await until(async () => /停止|保留|失敗|エラー/.test(await page.locator('#syncStatus').innerText()), 'specific sync failure reason');
  return page.locator('#syncStatus').innerText();
}
async function preserveDraft(page, fields, remoteText, savedPart) {
  const beforeSaved = savedPart(await data(page));
  const beforeMainWrites = mutations().length;
  const currentTab = await page.locator('[data-nav][aria-current="page"]').getAttribute('data-nav');
  work()[3] = remoteText;
  const expectedRows = structuredClone([rows('ワーク記録'), rows('アクション一覧')]);
  await poll(page);
  await until(async () => await value(page, 'futureAction') === remoteText, 'background import while form draft is focused');
  await idle(page);
  for (const [selector, expected] of Object.entries(fields)) assert.equal(await page.locator(selector).inputValue(), expected);
  await page.locator(Object.keys(fields).at(-1)).blur();
  await pause(400); // The app's deferred render runs 200 ms after focusout.
  for (const [selector, expected] of Object.entries(fields)) assert.equal(await page.locator(selector).inputValue(), expected, 'Blur must not discard an unsaved form');
  assert.equal(await page.locator('[data-nav][aria-current="page"]').getAttribute('data-nav'), currentTab);
  assert.deepEqual(savedPart(await data(page)), beforeSaved, 'Background import must not implicitly save the draft');
  assert.deepEqual([rows('ワーク記録'), rows('アクション一覧')], expectedRows, 'Unsaved draft must not alter active Sheets data');
  assert.equal(mutations().length, beforeMainWrites);
}

const server = http.createServer((request, response) => {
  const path = new URL(request.url, 'http://fixture.local').pathname;
  if (path.includes('..')) { response.writeHead(400); response.end(); return; }
  try {
    response.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(root + (path === '/' ? '/index.html' : path)));
  } catch { response.writeHead(404); response.end(); }
});
async function makeDevice(name, browser, options, origin, useBaseline) {
  const context = await browser.newContext(options);
  const fixture = {
    version:1, goal:{title:name + 'だけのゴール', scene:'', identity:'', why:''}, goals:[], goalHistory:[], goalChecks:[], goalIdeas:[],
    lessons:[{id:'fixture-other-lesson', title:name + 'だけの講義', theme:'仕事', takeaway:'端末専用'}],
    entries:{[today]:{...baseEntry, linkedActionId:ACTION, goalSnapshot:name + 'のゴール記録', lessonNotes:{'fixture-other-lesson':{reflection:name + 'の複数講義メモ', nextStep:'端末に残す', reviewed:true}}}},
    progress:{
      actions:[{...baseAction, facts:name + 'だけの事実', gap:name + 'だけのGAP', plannedWeek:'2026-11-02', origin:name + '専用'}],
      reviews:[{id:'review-' + name, week:'2026-11-02', facts:name + 'だけの週次メモ'}],
      weekPlans:[{id:'plan-' + name, week:'2026-11-02', focus:name + 'だけの週間計画'}],
      actionIdeas:[{id:'idea-' + name, title:name + 'だけの候補'}],
      actionHistory:[{at:'2026-11-01', id:ACTION, reason:name + 'だけの変更履歴', after:{...baseAction}}]
    }
  };
  await context.addInitScript(({KEY, SHEET, fixture, baseline, useBaseline}) => {
    if (!localStorage.getItem('keep-both-fixture-initialized')) {
      localStorage.setItem(KEY, JSON.stringify(fixture));
      localStorage.setItem('mirai-goal-sheet-sync-config-v1', JSON.stringify({sheetId:SHEET}));
      if (useBaseline) localStorage.setItem('mirai-goal-sheet-write-baseline-v1:' + SHEET, JSON.stringify(baseline));
      // Deliberately no legacy safe-sync approval: automatic keep-both must not ask for field choices.
      localStorage.setItem('keep-both-fixture-initialized', '1');
    }
    window.google = {accounts:{oauth2:{initTokenClient:({callback}) => ({requestAccessToken:() => callback({access_token:'synthetic-keep-both-token', expires_in:3600})})}}};
  }, {KEY, SHEET, fixture, baseline, useBaseline});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    // This is the only path that handles Google endpoints. Never continue Google requests.
    if (url.origin !== 'https://sheets.googleapis.com') return route.abort();
    const record = {device:name, method:request.method(), path:decodeURIComponent(url.pathname), applied:false, main:false, archive:false};
    requests.push(record);
    try {
      assert.ok(record.path.startsWith('/v4/spreadsheets/' + SHEET), 'Only the synthetic spreadsheet is allowed');
      assert.equal(request.headers().authorization, 'Bearer synthetic-keep-both-token');
      if (record.method === 'GET' && failReadDevice === name) {
        failReadDevice = '';
        record.failed = 'network';
        return route.abort('failed');
      }
      const valuesMarker = '/values/';
      if (record.method === 'GET' && !record.path.includes(valuesMarker)) {
        return route.fulfill({json:{sheets:[...sheets.keys()].map((title, sheetId) => ({properties:{sheetId, title, gridProperties:{rowCount:title === 'ワーク記録' ? 1002 : title === 'アクション一覧' ? 1200 : 1000, columnCount:title === 'ワーク記録' ? 24 : title === 'アクション一覧' ? 18 : title === ARCHIVE ? 10 : 26}}}))}});
      }
      if (record.method === 'GET') {
        const range = record.path.split(valuesMarker)[1];
        const {name:tab} = parseRange(range);
        assert.ok(sheets.has(tab), 'Unexpected fixture tab read: ' + tab);
        return route.fulfill({json:{values:structuredClone(rows(tab))}});
      }
      const body = request.postDataJSON();
      if (record.path.endsWith(':batchUpdate') && !record.path.endsWith('/values:batchUpdate')) {
        for (const command of body.requests || []) {
          assert.equal(command.addSheet?.properties?.title, ARCHIVE, 'Only the new archive tab may be created');
          assert.ok(!sheets.has(ARCHIVE), 'Archive tab already exists');
          sheets.set(ARCHIVE, []);
        }
        record.archive = true; record.applied = true;
        return route.fulfill({json:{replies:[{addSheet:{properties:{title:ARCHIVE, sheetId:99}}}]}});
      }
      const patches = record.path.endsWith('/values:batchUpdate') ? body.data : [{range:record.path.split(valuesMarker)[1].replace(/:append$/, ''), values:body.values}];
      const targets = patches.map(patch => parseRange(patch.range).name);
      record.archive = targets.includes(ARCHIVE);
      record.main = targets.some(tab => tab !== ARCHIVE);
      assert.ok(!(record.archive && record.main), 'Archive verification must precede main writes, not share a batch');
      if (record.archive && failArchiveWrite) {
        failArchiveWrite = false; record.failed = 'archive';
        return route.fulfill({status:503, json:{error:{message:'fixture archive-write failure'}}});
      }
      if (record.main && failMainWrite) {
        failMainWrite = false; record.failed = 'main';
        return route.fulfill({status:503, json:{error:{message:'fixture main-write failure after archive'}}});
      }
      if (record.main && holdMainDevice === name) {
        holdMainDevice = '';
        await new Promise(resolve => { heldMain = {record, release:resolve}; });
      }
      let count = 0;
      for (const patch of patches) count += applyValues(patch.range, patch.values, record.path.endsWith(':append'));
      record.applied = true;
      return route.fulfill({json:{totalUpdatedCells:count, updatedCells:count, updates:{updatedCells:count}}});
    } catch (error) {
      mockErrors.push(error);
      return route.fulfill({status:500, json:{error:{message:'fixture assertion failed: ' + error.message}}});
    }
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(name + ': ' + error.message));
  page.on('dialog', dialog => { dialogs.push(name + ': ' + dialog.message()); dialog.dismiss(); });
  await page.goto(origin);
  // Persist ordinary normalized local data before taking the preservation snapshot.
  await edit(page, 'valuableAction', baseEntry.valuableAction);
  return {page, context, preserved:localOnly(await data(page))};
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const pcBrowser = await chromium.launch({headless:true}); browsers.push(pcBrowser);
  const mobileName = process.env.MOBILE_BROWSER === 'chromium' ? 'Chromium fallback (NOT WebKit/Safari)' : 'Linux WebKit';
  console.log('Mobile engine: ' + mobileName + '; iPhone 13 profile is simulation, not a real iPhone.');
  const mobileBrowser = await (process.env.MOBILE_BROWSER === 'chromium' ? chromium : webkit).launch({headless:true}); browsers.push(mobileBrowser);
  const pc = await makeDevice('PC', pcBrowser, {viewport:{width:1440, height:1000}}, origin, true);
  const phone = await makeDevice('mobile', mobileBrowser, devices['iPhone 13'], origin, false);
  const A = pc.page, B = phone.page;

  work()[2] = '別端末から届いた当たり前';
  await enable(A);
  await until(async () => await value(A, 'normal') === work()[2], 'PC automatically imports remote-only update');
  assert.equal(await value(B, 'normal') || '', '');
  await enable(B);
  await until(async () => await value(B, 'normal') === work()[2], 'mobile first connection imports without a baseline or manual choices');
  await idle(A); await idle(B);
  assertArchived('normal', '', '別端末から届いた当たり前');
  check('independent stores; automatic remote import and no-baseline first connection without choices');

  await edit(A, 'valuableAction', 'PCが自動送信した行動');
  await until(() => work()[4] === 'PCが自動送信した行動', 'PC input automatically saved');
  await idle(A); await poll(B);
  await until(async () => await value(B, 'valuableAction') === work()[4], 'mobile automatically imports PC change');
  await edit(B, 'minimumAction', 'モバイルが自動送信した最低ライン');
  await until(() => work()[5] === 'モバイルが自動送信した最低ライン', 'mobile input automatically saved');
  await idle(B); await poll(A);
  await until(async () => await value(A, 'minimumAction') === work()[5], 'PC automatically imports mobile change');
  rows('アクション一覧')[1][3] = '別端末から届いたアクション';
  await idle(A); await poll(A); await poll(B);
  await until(async () => [await data(A), await data(B)].every(item => item.progress.actions.find(action => action.id === ACTION)?.title === rows('アクション一覧')[1][3]), 'remote action is imported on both devices');
  check('automatic PC-to-mobile, mobile-to-PC and remote action updates');

  await disable(A);
  await edit(A, 'fit', 'PCに残す競合した理由');
  await edit(B, 'fit', 'モバイルに残す競合した理由');
  await until(() => work()[1] === 'モバイルに残す競合した理由', 'mobile version reaches Sheets first');
  await idle(B); await enable(A);
  await until(async () => await value(A, 'fit') === 'モバイルに残す競合した理由', 'conflict automatically keeps the current Sheets version active');
  await idle(A);
  assertArchived('fit', 'PCに残す競合した理由', 'モバイルに残す競合した理由');
  assert.equal(await value(B, 'fit'), 'モバイルに残す競合した理由');
  assert.equal(await A.locator('[data-sync-choice]').count(), 0);
  assert.equal(await B.locator('[data-sync-choice]').count(), 0);
  check('true two-device conflict preserves verifiable device and Sheets versions without manual choices');

  const beforeArchiveRead = {local:await data(A), main:mutations().length, archive:structuredClone(archive())};
  if(!await A.locator('#syncAdvanced').evaluate(el=>el.open))await A.locator('#syncAdvanced > summary').click();
  await A.locator('[data-action="read-sync-archive"]').click();
  await until(async () => /別記録を読み取りました/.test(await A.locator('#syncStatus').innerText()), 'saved versions are accessible in the archive viewer');
  const archivePanel = A.locator('section.form-panel').filter({has:A.locator('[data-action="read-sync-archive"]')});
  assert.equal(await archivePanel.locator('details').count(), archiveVersions().length, 'The archive viewer deduplicates logical versions');
  for (const summary of await archivePanel.locator('details > summary').all()) await summary.click();
  const archiveText = await archivePanel.innerText();
  assert.match(archiveText, /PCに残す競合した理由/);
  assert.match(archiveText, /モバイルに残す競合した理由/);
  assert.deepEqual(await data(A), beforeArchiveRead.local);
  assert.equal(mutations().length, beforeArchiveRead.main);
  assert.deepEqual(archive(), beforeArchiveRead.archive);
  check('both archived versions can be read in the app without changing either store');

  const stableArchive = structuredClone(archive()), stableMutations = mutations().length;
  for (let repeat = 0; repeat < 3; repeat++) { await poll(A); await poll(B); await pause(200); }
  await idle(A); await idle(B);
  assert.deepEqual(archive(), stableArchive);
  assert.equal(mutations().length, stableMutations);
  check('repeat polls neither duplicate the archive nor loop writes');

  await disable(A);
  await edit(A, 'fit', '別記録失敗時も端末に残る理由');
  await edit(A, 'growth', '別記録が保存できるまで送らない成長');
  work()[1] = '別記録失敗時もSheetsに残る理由';
  const beforeFailure = structuredClone(sheets.get('ワーク記録'));
  const mainBeforeFailure = mutations().length;
  failArchiveWrite = true;
  await enable(A);
  const archiveFailure = await stopped(A);
  assert.match(archiveFailure, /fixture archive-write failure/);
  assert.deepEqual(sheets.get('ワーク記録'), beforeFailure);
  assert.equal(mutations().length, mainBeforeFailure);
  assert.equal(await value(A, 'fit'), '別記録失敗時も端末に残る理由');
  assert.equal(await value(A, 'growth'), '別記録が保存できるまで送らない成長');
  await navigate(A, 'morning'); await navigate(A, 'sync');
  assert.equal(await A.locator('#syncStatus').innerText(), archiveFailure, 'Navigation must retain the specific stop reason');
  check('archive-write failure refuses main writes, retains both inputs, and keeps reason across navigation');
  await enable(A);
  await until(() => work()[10] === '別記録が保存できるまで送らない成長', 'retry after archive failure');
  await until(async () => await value(A, 'fit') === '別記録失敗時もSheetsに残る理由', 'retry imports active Sheets conflict version');
  await idle(A);
  assertArchived('fit', '別記録失敗時も端末に残る理由', '別記録失敗時もSheetsに残る理由');

  await disable(A);
  await edit(A, 'normal', '再送しても一度だけ残す端末の値');
  await edit(A, 'tomorrow', '主記録の再送で届く明日の一歩');
  work()[2] = '再送しても一度だけ残すSheetsの値';
  failMainWrite = true;
  await enable(A);
  const mainFailure = await stopped(A);
  assert.match(mainFailure, /fixture main-write failure/);
  assertArchived('normal', '再送しても一度だけ残す端末の値', '再送しても一度だけ残すSheetsの値');
  const archivedBeforeRetry = structuredClone(archive());
  assert.equal(work()[11], '');
  await enable(A);
  await until(() => work()[11] === '主記録の再送で届く明日の一歩', 'main-write retry succeeds after archive verification');
  await until(async () => await value(A, 'normal') === '再送しても一度だけ残すSheetsの値', 'retry imports the remote conflict value');
  await idle(A);
  assert.deepEqual(archive().slice(0, archivedBeforeRetry.length), archivedBeforeRetry, 'Existing archive rows remain unchanged');
  const oldChunks = new Set(archivedBeforeRetry.slice(1).map(row => row[0] + ':' + row[5]));
  const additions = archive().slice(archivedBeforeRetry.length).map(row => row[0] + ':' + row[5]);
  assert.ok(additions.every(key => !oldChunks.has(key)), 'Retry must reuse already-saved versions, not append duplicates');
  assert.equal(new Set(additions).size, additions.length, 'New final merged snapshots are archived once');
  const afterSuccessfulRetry = structuredClone(archive());
  await poll(A); await idle(A);
  assert.deepEqual(archive(), afterSuccessfulRetry, 'A repeated successful retry creates no additional versions');
  check('retry after archive success/main-write failure is idempotent');

  const beforeNetwork = structuredClone(sheets.get('ワーク記録'));
  const beforeNetworkLocal = await data(A);
  failReadDevice = 'PC';
  await poll(A);
  const networkFailure = await stopped(A);
  assert.deepEqual(sheets.get('ワーク記録'), beforeNetwork);
  assert.deepEqual(await data(A), beforeNetworkLocal);
  await navigate(A, 'evening'); await navigate(A, 'sync');
  assert.equal(await A.locator('#syncStatus').innerText(), networkFailure);
  await enable(A); await idle(A);
  check('network failure is non-destructive, visible, and recoverable');

  holdMainDevice = 'PC';
  await edit(A, 'achievement', '送信中の古い入力');
  await until(() => heldMain !== null, 'mock holds the automatic write in flight');
  await edit(A, 'achievement', '送信中に加えた新しい入力');
  assert.equal(await A.locator('#achievement').inputValue(), '送信中に加えた新しい入力');
  heldMain.release();
  await until(() => work()[9] === '送信中の古い入力', 'first in-flight snapshot is written');
  assert.equal(await value(A, 'achievement'), '送信中に加えた新しい入力');
  await until(() => work()[9] === '送信中に加えた新しい入力', 'newer input remains pending and is automatically sent next');
  await idle(A);
  assert.equal(await value(A, 'achievement'), '送信中に加えた新しい入力');
  assertArchived('achievement', '送信中の古い入力', '送信中に加えた新しい入力');
  check('newer in-flight input is preserved and automatically sent in the next save');

  // Bring mobile up to date, then verify the untouched device-only areas on both stores.
  await poll(B);
  await until(async () => await value(B, 'achievement') === '送信中に加えた新しい入力', 'mobile final import');
  await idle(B);
  for (const device of [pc, phone]) assert.deepEqual(localOnly(await data(device.page)), device.preserved);
  assert.equal(work()[13], 'Sheetsだけのゴール');
  assert.equal(work()[14], 'Sheetsだけの未来の景色');
  assert.equal(work()[17], 'fixture-remote-timestamp');
  assert.deepEqual(errors, []);
  assert.deepEqual(mockErrors, []);
  assert.deepEqual(dialogs, [], 'Automatic keep-both must not require confirm dialogs');
  assert.ok(appliedArchive().length > 0);
  check('device-only reviews/plans/lessons/action details and unmapped Sheets columns stay untouched');

  fs.mkdirSync(root + '/test-results', {recursive:true});
  // Form drafts have their own Save buttons. Automatic imports must neither
  // persist drafts nor rebuild the form and erase them, including after blur.
  await navigate(A, 'progress');
  const editAction = await reveal(A, '[data-progress-action="edit"][data-id="' + ACTION + '"]');
  // Force a background import after the card has been expanded. Its changing
  // title must not close the card or hide the Edit button before the click.
  rows('アクション一覧')[1][3] = '展開中に届いた新しいアクション名';
  await poll(A); await idle(A);
  await until(async () => (await data(A)).progress.actions.find(item=>item.id===ACTION).title === rows('アクション一覧')[1][3], 'background action title import');
  assert.equal(await editAction.isVisible(), true, 'background refresh keeps expanded action editable');
  await editAction.click();
  const actionDraft = '自動取り込みとフォーカス解除を越えて残すアクション';
  await A.locator('#pg-action-form [name="title"]').fill(actionDraft);
  const savedActionBefore = (await data(A)).progress.actions.find(item => item.id === ACTION).title;
  assert.notEqual(savedActionBefore, actionDraft);
  await preserveDraft(A, {'#pg-action-form [name="title"]':actionDraft}, 'アクション編集中に届いた更新', item => ({actions:item.progress.actions, history:item.progress.actionHistory}));
  await A.screenshot({path:root + '/test-results/automatic-draft-action-PC.png', fullPage:true});
  const actionHistoryBefore = (await data(A)).progress.actionHistory.length;
  await A.locator('[data-progress-action="save-action"]').click();
  assert.equal((await data(A)).progress.actions.find(item => item.id === ACTION).title, actionDraft);
  assert.equal((await data(A)).progress.actionHistory.length, actionHistoryBefore + 1);
  await until(() => rows('アクション一覧')[1][3] === actionDraft, 'explicit action Save schedules automatic upload');
  await idle(A);
  check('action draft survives automatic import and blur; only explicit Save persists and uploads it');

  await poll(B);
  await until(async () => (await data(B)).progress.actions.find(item => item.id === ACTION)?.title === actionDraft, 'mobile imports the explicitly saved action');
  await idle(B);
  await navigate(B, 'progress');
  await B.locator('[data-progress-action="mode"][data-mode="review"]').click();
  const reviewField = await reveal(B, '#pg-review-form [name="facts"]');
  const reviewDraft = '自動取り込みとフォーカス解除を越えて残す週次レビュー';
  await reviewField.fill(reviewDraft);
  const reviewHistoryBefore = (await data(B)).progress.reviewHistory.length;
  await preserveDraft(B, {'#pg-review-form [name="facts"]':reviewDraft}, '週次レビュー編集中に届いた更新', item => ({reviews:item.progress.reviews, history:item.progress.reviewHistory}));
  await B.screenshot({path:root + '/test-results/automatic-draft-review-mobile-' + (process.env.MOBILE_BROWSER === 'chromium' ? 'chromium-fallback' : 'webkit') + '.png', fullPage:true});
  const beforeReviewSaveRows = structuredClone([rows('ワーク記録'), rows('アクション一覧')]);
  await B.locator('[data-progress-action="save-review"]').click();
  assert.ok((await data(B)).progress.reviews.some(item => item.facts === reviewDraft));
  assert.equal((await data(B)).progress.reviewHistory.length, reviewHistoryBefore + 1);
  await poll(B); await idle(B);
  assert.deepEqual([rows('ワーク記録'), rows('アクション一覧')], beforeReviewSaveRows, 'Weekly review remains device-only after explicit Save');
  check('mobile weekly-review draft survives import and blur; explicit Save remains local-only');

  await navigate(A, 'goal');
  const goalForm = '[data-goal-form][data-goal-id=""]';
  const themeField = await reveal(A, goalForm + ' [name="theme"]');
  const goalDraft = '自動取り込みとフォーカス解除を越えて残すゴール';
  await themeField.fill('仕事');
  await A.locator(goalForm + ' [name="period"]').selectOption('3か月');
  await A.locator(goalForm + ' [name="qualitative"]').fill(goalDraft);
  const beforeGoalSave = await data(A);
  const remoteGoalsBefore = structuredClone(rows('ゴール一覧'));
  await preserveDraft(A, {[goalForm + ' [name="theme"]']:'仕事', [goalForm + ' [name="period"]']:'3か月', [goalForm + ' [name="qualitative"]']:goalDraft}, 'ゴール編集中に届いた更新', item => ({goals:item.goals, history:item.goalHistory, checks:item.goalChecks}));
  assert.deepEqual(rows('ゴール一覧'), remoteGoalsBefore);
  await A.screenshot({path:root + '/test-results/automatic-draft-goal-PC.png', fullPage:true});
  await A.locator(goalForm + ' [data-action="save-goal"]').click();
  const afterGoalSave = await data(A);
  assert.equal(afterGoalSave.goals.length, beforeGoalSave.goals.length + 1);
  assert.ok(afterGoalSave.goals.some(item => item.qualitative === goalDraft && item.theme === '仕事' && item.period === '3か月'));
  assert.equal(afterGoalSave.goalHistory.length, beforeGoalSave.goalHistory.length + 1);
  await poll(A); await idle(A);
  assert.deepEqual(rows('ゴール一覧'), remoteGoalsBefore, 'Explicit goal Save does not bypass manual goal sync');
  check('goal text/select drafts survive import and blur; explicit Save records goal/history without automatic goal upload');

  assert.deepEqual(errors, []);
  assert.deepEqual(mockErrors, []);
  assert.deepEqual(dialogs, []);
  await navigate(A, 'sync'); await navigate(B, 'sync');
  await A.screenshot({path:root + '/test-results/automatic-keep-both-PC.png', fullPage:true});
  await B.screenshot({path:root + '/test-results/automatic-keep-both-mobile-' + (process.env.MOBILE_BROWSER === 'chromium' ? 'chromium-fallback' : 'webkit') + '.png', fullPage:true});
  assert.ok(await B.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile layout must fit its viewport');
  const archiveRows = archive().length - 1;
  const uniqueChunks = new Set(archive().slice(1).map(row => row[0] + ':' + row[5])).size;
  console.log(JSON.stringify({passed:true, browsers:['desktop Chromium', 'iPhone 13 profile on ' + mobileName + ' (not real iPhone)'], checks, requests:requests.length, mainMutations:mutations().length, archiveRows, logicalArchiveVersions:archiveVersions().length, duplicatePhysicalRowsFromConcurrentAppends:archiveRows - uniqueChunks, realGoogleRequests:0}, null, 2));
})().catch(error => {
  console.error(error);
  console.error(JSON.stringify({completedChecks:checks, recentRequests:requests.slice(-12), mockErrors:mockErrors.map(item => item.message)}, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  if (heldMain) heldMain.release();
  await Promise.all(browsers.map(browser => browser.close()));
  server.close();
});
