const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const inline=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name){
 const match=new RegExp('  (?:async )?function '+name+'\\(').exec(inline);
 assert.ok(match,name);
 const rest=inline.slice(match.index),end=rest.slice(1).search(/\n  (?:async )?function /);
 return end<0?rest:rest.slice(0,end+1);
}
const sheetId='fixture-spreadsheet-123456';
function fixture(extra={}){
 const notice={innerHTML:'',querySelector:()=>({open:true})},panel={innerHTML:''};
 const c={syncConfig:{sheetId,lastSync:'2026-11-03T00:00:00Z',lastMethod:'CSV'},syncDisplayEvidence:{sheetId:'',work:{},goals:{}},localSaveEvidence:'',storageError:false,syncStatusText:'',
  writeBaseline:null,autoSyncEnabled:false,autoSyncBlocked:false,autoWriteToken:false,autoTokenExpiresAt:0,googleToken:'',autoAuthBusy:false,syncAuthBusy:false,writeBusy:false,syncBusy:false,autoSyncTickBusy:false,
  navigator:{onLine:true},document:{getElementById:id=>id==='autoSyncNotice'?notice:id==='syncEvidence'?panel:null,querySelectorAll:()=>[]},autoPending:()=>0,
  showToast:()=>{},button:(label,action)=>`<button data-action="${action}">${label}</button>`,...extra};
 vm.createContext(c);
 for(const name of ['txt','esc','syncDisplayForSheet','recordSyncCheck','recordSyncCheckFailure','startSyncSend','finishSyncSend','failSyncSend','syncEvidenceTime','syncEvidenceLines','updateAutoSyncNotice'])vm.runInContext(source(name),c);
 c.notice=notice;c.panel=panel;return c;
}
test('no timestamps, CSV/imports, connection or empty pending count imply Sheets sent',()=>{
 const c=fixture({writeBaseline:{},autoPending:()=>0,autoWriteToken:true,googleToken:'test',autoTokenExpiresAt:Date.now()+60000});
 const lines=c.syncEvidenceLines().join('\n');
 assert.match(lines,/まだ保存していません/);assert.match(lines,/今回の起動中は送信完了の確認なし/);assert.doesNotMatch(lines,/送信完了を確認/);assert.match(lines,/現在のSheetsとの一致を保証するものではありません/);
 c.localSaveEvidence='loaded';assert.match(c.syncEvidenceLines()[0],/保存されていた記録を読み込み/);
});
test('local save evidence follows actual persistence success and failure, separately from Sheets',()=>{
 let stored='';const c=fixture({KEY:'fixture',data:{entries:{fixture:{valuableAction:'test'}}},localStorage:{setItem:(k,v)=>stored=v}});
 vm.runInContext(source('save'),c);assert.equal(c.save(),true);assert.equal(stored,JSON.stringify(c.data));assert.match(c.notice.innerHTML,/端末保存：保存済み/);assert.doesNotMatch(c.notice.innerHTML,/送信完了を確認/);
 c.localStorage.setItem=()=>{throw Error('quota');};c.data.entries.fixture.valuableAction='unsaved';assert.equal(c.save(),false);assert.match(c.notice.innerHTML,/端末保存：失敗または未確認/);assert.doesNotMatch(c.notice.innerHTML,/端末保存：保存済み/);assert.equal(JSON.parse(stored).entries.fixture.valuableAction,'test');
 c.localStorage.setItem=(k,v)=>stored=v;assert.equal(c.save(),true);assert.match(c.notice.innerHTML,/端末保存：保存済み/);
});
test('remote checks distinguish no baseline, matching baseline and changed Sheets, with scope and time',()=>{
 const c=fixture(),base={version:1,work:{},actions:{}};
 c.recordSyncCheck('work',base,null,sheetId);assert.match(c.syncEvidenceLines()[2],/同期基準がなく変更の有無は未判定/);
 c.recordSyncCheck('work',base,base,sheetId);assert.match(c.syncEvidenceLines()[2],/ワーク・アクション：同期基準からの変更なし/);assert.match(c.syncEvidenceLines()[2],/ゴール管理：未確認/);assert.match(c.syncEvidenceLines()[2],/時点/);
 c.recordSyncCheck('goals',{goals:['changed']},{goals:[]},sheetId);assert.match(c.syncEvidenceLines()[2],/ゴール管理：同期基準から変更あり（更新元は判定できません）/);
 c.recordSyncCheckFailure('goals',sheetId);assert.match(c.syncEvidenceLines()[2],/直近の確認に失敗。現在の状態は未確認/);
 assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
});
test('send evidence records only a successful nonzero send and never promotes a failed partial attempt',()=>{
 const c=fixture();c.startSyncSend('work',sheetId);assert.match(c.syncEvidenceLines()[1],/送信中（完了未確認）/);
 c.finishSyncSend('work',0,sheetId);assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
 c.startSyncSend('work',sheetId);c.finishSyncSend('work',2,sheetId);assert.match(c.syncEvidenceLines()[1],/ワーク・アクション：送信完了を確認/);assert.match(c.syncEvidenceLines()[1],/ゴール管理：今回の起動中は送信完了の確認なし/);
 c.failSyncSend('work',sheetId);assert.match(c.syncEvidenceLines()[1],/送信完了を確認/,'later local failure preserves confirmed remote result');
 c.startSyncSend('work',sheetId);c.failSyncSend('work',sheetId);assert.match(c.syncEvidenceLines()[1],/直近の送信処理は未完了・結果未確認/);assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
});
test('changing spreadsheet clears evidence and ignores delayed results from the original destination',()=>{
 const c=fixture();c.startSyncSend('work',sheetId);c.recordSyncCheck('work',{}, {},sheetId);
 c.syncConfig.sheetId='another-fixture-sheet-123';c.finishSyncSend('work',3,sheetId);c.recordSyncCheck('goals',{}, {},sheetId);c.failSyncSend('work',sheetId);c.recordSyncCheckFailure('goals',sheetId);
 assert.doesNotMatch(c.syncEvidenceLines().join(' '),/送信完了を確認|時点|直近の確認に失敗|結果未確認/);
 assert.equal(c.syncDisplayEvidence.sheetId,c.syncConfig.sheetId);
 c.syncConfig.sheetId=sheetId;assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
});
test('all automatic, offline, authentication and failure notices retain four evidence categories',()=>{
 const c=fixture();
 for(const props of [{},{navigator:{onLine:false}},{autoSyncEnabled:true,navigator:{onLine:true},cloudWorkerUrl:'',cloudSession:''},{autoSyncBlocked:true},{storageError:true}]){
  Object.assign(c,props);c.updateAutoSyncNotice();
  for(const label of ['端末保存','Sheets送信','Sheets側の確認','端末専用'])assert.ok(c.notice.innerHTML.includes(label),label);
  assert.match(c.notice.innerHTML,/sync-evidence-details" open/);assert.match(c.panel.innerHTML,/ゴール・ゴールの種は手動同期/);assert.match(c.panel.innerHTML,/Sheetsの更新を取り込みます/);
 }
});
function automaticFixture(resultOrError){
 const c=fixture({data:{entries:{test:{valuableAction:'before'}}},syncBusy:false,syncAuthBusy:false,autoWriteToken:true,googleToken:'test',writeBaseline:{version:1,work:{},actions:{}},
  save:()=>true,saveWriteBaseline:()=>true,saveSyncConfig:()=>{},protectOriginalLocalData:()=>{},backgroundRenderSafe:()=>true,render:()=>{},scheduleAutoSave:()=>{},syncStatusMessage:()=>{},autoRetryAfter:0,
  GoalKeepBoth:{commit:async()=>{if(resultOrError instanceof Error)throw resultOrError;return resultOrError;},reconcile:current=>current},
  GoalWriteback:{commit:async()=>{if(resultOrError instanceof Error)throw resultOrError;return resultOrError;},baselineFromRows:()=>({version:1,work:{},actions:{}})}});
 vm.runInContext(source('autoCommit'),c);return c;
}
test('automatic write integration marks verified send but a newer local edit remains pending',async()=>{
 const c=automaticFixture({count:1,workRows:[],actionRows:[]});c.autoPending=()=>1;
 await c.autoCommit({});assert.match(c.syncEvidenceLines()[1],/送信完了を確認/);assert.match(c.syncEvidenceLines()[1],/同期基準と異なる端末の変更/);assert.equal(c.autoSyncBlocked,false);
});
test('automatic write integration fails closed for partial, verification and HTTP errors',async()=>{
 for(const error of ['部分書き込み後に再取得失敗','保存結果の再確認に失敗','Google Sheets API 401']){
  const c=automaticFixture(Error(error));await c.autoCommit({});assert.equal(c.autoSyncBlocked,true);assert.match(c.syncEvidenceLines()[1],/未完了・結果未確認/);assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
 }
});
test('successful remote send plus baseline-storage failure stays distinct from failed local bookkeeping',async()=>{
 const c=automaticFixture({count:1,workRows:[],actionRows:[]});c.saveWriteBaseline=()=>false;await c.autoCommit({});
 assert.equal(c.autoSyncBlocked,true);assert.match(c.syncEvidenceLines()[1],/送信完了を確認/);assert.doesNotMatch(c.syncEvidenceLines()[1],/直近の送信処理は未完了/);
});
test('read-only review integration records both comparisons without modifying data or writing Sheets',async()=>{
 const rows={workRows:[],actionRows:[]},goalRows={goals:[],history:[],checks:[],ideas:[]};
 const c=fixture({googleToken:'test',syncAuthBusy:false,data:{entries:{fixture:{valuableAction:'keep'}}},goalSyncBaseline:null,
  GoalWriteback:{load:async()=>rows,preview:()=>[],baselineFromRows:()=>({version:1,work:{},actions:{}})},
  GoalManagementSync:{load:async()=>goalRows,preview:()=>({goals:[],ideas:[]}),baselineFromRows:x=>({version:1,...x})},render:()=>{},syncStatusMessage:()=>{}});
 vm.runInContext(source('fetchSheetRows'),c);const before=JSON.stringify(c.data);await c.fetchSheetRows();assert.equal(JSON.stringify(c.data),before);assert.equal(c.syncBusy,false);assert.ok(c.syncDisplayEvidence.work.checkedAt);assert.ok(c.syncDisplayEvidence.goals.checkedAt);assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
 c.GoalWriteback.load=async()=>{throw Error('offline');};await c.fetchSheetRows();assert.match(c.syncEvidenceLines()[2],/直近の確認に失敗/);
});
test('UI describes real manual goal seed sync and current buttons without obsolete instructions',()=>{
 assert.match(html,/⑤ ゴールの種（手動同期・CSV追加）/);assert.match(html,/ゴールの種は「差分を確認（読み取りのみ）」で比較/);
 assert.doesNotMatch(html,/ゴールの種は安全同期の対象外|Googleに接続して同期|Google Sheetsに保存して同期/);
 assert.match(html,/この差分欄で同期する範囲/);assert.match(html,/別の「ゴール管理」の差分欄で手動同期/);
});
test('send-in-progress replaces previous success before a deferred request completes',async()=>{
 const c=automaticFixture({count:1,workRows:[],actionRows:[]});c.autoTokenExpiresAt=Date.now()+60000;
 c.startSyncSend('work',sheetId);c.finishSyncSend('work',1,sheetId);c.updateAutoSyncNotice();assert.match(c.notice.innerHTML,/送信完了を確認/);
 let resolve;c.GoalKeepBoth.commit=()=>new Promise(r=>resolve=r);const pending=c.autoCommit({});assert.match(c.notice.innerHTML,/送信中（完了未確認）/);assert.doesNotMatch(c.notice.innerHTML,/送信完了を確認/);
 resolve({count:1,workRows:[],actionRows:[]});await pending;assert.match(c.notice.innerHTML,/送信完了を確認/);
});
test('import recheck failures invalidate previous read evidence for either scope',async()=>{
 for(const [name,scope] of [['importReviewedSheetsData','work'],['importGoalManagementData','goals']]){
  const data={entries:{fixture:{valuableAction:'keep'}}};
  const c=fixture({data,syncAuthBusy:false,googleToken:'test',syncReview:{sheetId,localSnapshot:JSON.stringify(data),goalRows:{},rows:{workRows:[],actionRows:[]}},
   GoalWriteback:{load:async()=>{throw Error('offline');}},GoalManagementSync:{load:async()=>{throw Error('offline');}},syncStatusMessage:()=>{}});
  c.recordSyncCheck(scope,{}, {},sheetId);vm.runInContext(source(name),c);await c[name]();assert.match(c.syncEvidenceLines()[2],/直近の確認に失敗/);assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);assert.equal(c.data.entries.fixture.valuableAction,'keep');
 }
});
test('destination fields cannot change during a pending sync or auth operation',()=>{
 for(const busy of ['syncBusy','syncAuthBusy','autoAuthBusy','writeBusy','autoSyncTickBusy']){
  let handler;const c=fixture({[busy]:true,cloudWorkerUrl:'https://fixture.invalid',document:{addEventListener:(event,fn)=>handler=fn},showToast:()=>{}});
  vm.runInContext(inline.split('\n').find(line=>line.startsWith("  document.addEventListener('input',")),c);
  for(const [key,oldValue] of [['sheetId',sheetId],['workerUrl','https://fixture.invalid']]){
   const target={dataset:{config:key},value:'changed',matches:x=>x==='[data-config]'};handler({target});assert.equal(target.value,oldValue);assert.equal(c.syncConfig.sheetId,sheetId);
  }
 }
});
test('import row validation failure cannot retain earlier successful check evidence',async()=>{
 const data={entries:{fixture:{valuableAction:'keep'}}};
 const c=fixture({data,syncAuthBusy:false,googleToken:'test',syncReview:{sheetId,localSnapshot:JSON.stringify(data),rows:{workRows:[],actionRows:[]}},
  GoalWriteback:{load:async()=>({workRows:[],actionRows:[]}),baselineFromRows:()=>{throw Error('duplicate IDs');}},syncStatusMessage:()=>{}});
 c.recordSyncCheck('work',{}, {},sheetId);vm.runInContext(source('importReviewedSheetsData'),c);await c.importReviewedSheetsData();assert.match(c.syncEvidenceLines()[2],/直近の確認に失敗/);assert.equal(c.data.entries.fixture.valuableAction,'keep');
});
test('local failure after a successful import read does not mislabel the remote read as failed',async()=>{
 const data={entries:{fixture:{valuableAction:'keep'}}};
 const rows={workRows:[],actionRows:[]};
 const c=fixture({data,syncAuthBusy:false,googleToken:'test',syncReview:{sheetId,localSnapshot:JSON.stringify(data),rows},
  GoalWriteback:{load:async()=>rows,baselineFromRows:()=>({version:1,work:{},actions:{}}),importInitial:()=>({data:{entries:{}},summary:{recordsImported:1}})},syncStatusMessage:()=>{},localStorage:{setItem:()=>{},removeItem:()=>{}},saveSafeSyncApproval:()=>true,save:()=>false});
 vm.runInContext(source('importReviewedSheetsData'),c);await c.importReviewedSheetsData();assert.ok(c.syncDisplayEvidence.work.checkedAt);assert.equal(c.syncDisplayEvidence.work.checkFailed,false);assert.equal(c.data.entries.fixture.valuableAction,'keep');assert.doesNotMatch(c.syncEvidenceLines()[1],/送信完了を確認/);
});
