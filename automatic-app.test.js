const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inline=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name){const m=new RegExp('  (?:async )?function '+name+'\\(').exec(inline);assert.ok(m,name);const rest=inline.slice(m.index),end=rest.slice(1).search(/\n  (?:async )?function /);return end<0?rest:rest.slice(0,end+1);}
function fixture(extra={}){
 const rows={workRows:[['fixture']],actionRows:[]};
 const c={storageError:false,autoSyncEnabled:true,backupRestoreSyncGuard:false,autoSyncBlocked:false,syncReview:null,syncBusy:false,syncAuthBusy:false,autoAuthBusy:false,writeBusy:false,autoSyncTickBusy:false,
  document:{hidden:false},autoRetryAfter:0,syncConfig:{sheetId:'fixture-sheet-id-20261107'},autoWriteToken:true,googleToken:'synthetic',googleTokenWritable:true,autoTokenExpiresAt:Date.now()+60000,
  cloudWorkerUrl:'',cloudSession:'',writeBaseline:{version:1,work:{},actions:{}},txt:s=>String(s||'').trim(),updateAutoSyncNotice:()=>{},recordSyncCheck:()=>{},recordSyncCheckFailure:()=>{},autoPending:()=>0,
  autoCommit:async()=>{},syncStatusMessage:()=>{},GoalKeepBoth:{load:async()=>rows},GoalWriteback:{baselineFromRows:()=>({version:1,work:{},actions:{}}),preview:()=>[{values:[{status:'両方で変更（競合）'}]}]},...extra};
 vm.createContext(c);return c;
}
test('automatic tick handles remote changes and conflicts without a manual review gate',async()=>{
 let calls=0;const c=fixture({data:{},autoCommit:async rows=>{calls++;assert.ok(rows.workRows);}});vm.runInContext(source('autoSyncTick'),c);
 await c.autoSyncTick();assert.equal(calls,1);assert.equal(c.autoSyncBlocked,false);assert.equal(c.autoSyncTickBusy,false);
 c.writeBaseline=null;await c.autoSyncTick();assert.equal(calls,2,'initial no-baseline sync also runs keep-both');
});
test('automatic tick pauses for optional manual review, restore guard, local failure and other busy work',async()=>{
 for(const state of [{syncReview:{}},{backupRestoreSyncGuard:true},{storageError:true},{autoSyncBlocked:true},{syncBusy:true},{document:{hidden:true}}]){
  let reads=0;const c=fixture({...state,GoalKeepBoth:{load:async()=>reads++}});vm.runInContext(source('autoSyncTick'),c);await c.autoSyncTick();assert.equal(reads,0);
 }
});
test('remote-read failure is an error and does not claim a conflict or a completed sync',async()=>{
 const messages=[];let invalidated=0;const c=fixture({GoalKeepBoth:{load:async()=>{throw Error('Google Sheets API 503');}},syncStatusMessage:m=>messages.push(m),recordSyncCheckFailure:()=>invalidated++});vm.runInContext(source('autoSyncTick'),c);await c.autoSyncTick();assert.equal(c.autoSyncBlocked,true);assert.equal(invalidated,1);assert.match(messages.at(-1),/API 503/);assert.doesNotMatch(messages.at(-1),/完了|競合があります/);
});
test('enabling or retrying automatic sync needs no field selection but still requires a durable local save',()=>{
 let connects=0,saves=0;const removed=[];const c=fixture({backupRestoreSyncGuard:true,localStorage:{removeItem:k=>removed.push(k)},BACKUP_RESTORE_SYNC_GUARD_KEY:'guard',AUTO_ENABLE_AFTER_REVIEW_KEY:'pending',save:()=>{saves++;return false;},tryAutoConnect:()=>connects++});vm.runInContext(source('beginAutoSyncReview'),c);c.beginAutoSyncReview();assert.equal(connects,0);assert.equal(removed.length,0);assert.equal(c.backupRestoreSyncGuard,true);
 c.save=()=>true;c.syncReview={};c.beginAutoSyncReview();assert.equal(connects,1);assert.deepEqual(removed,['guard','pending']);assert.equal(c.backupRestoreSyncGuard,false);assert.equal(c.syncReview,null);
});
test('a valid auto token is reused for retry without a new OAuth prompt',()=>{
 let ticks=0;const writes=[];const c=fixture({AUTO_SYNC_KEY:'auto',localStorage:{setItem:(...args)=>writes.push(args)},autoSyncEnabled:false,autoSyncBlocked:true,autoSyncTick:()=>ticks++});vm.runInContext(source('tryAutoConnect'),c);c.tryAutoConnect(true);assert.equal(ticks,1);assert.equal(c.autoSyncEnabled,true);assert.equal(c.autoSyncBlocked,false);assert.deepEqual(writes,[['auto','1']]);
});
function commitFixture(){
 const calls=[],messages=[],current={entries:{today:{valuableAction:'local input'}}};
 const c=fixture({data:current,save:()=>{calls.push('save');return true;},protectOriginalLocalData:()=>calls.push('original'),startSyncSend:()=>calls.push('start'),finishSyncSend:(_scope,n)=>calls.push('sent:'+n),failSyncSend:()=>calls.push('failed'),saveWriteBaseline:()=>{calls.push('baseline');return true;},saveSyncConfig:()=>{},render:()=>{},backgroundRenderSafe:()=>true,scheduleAutoSave:()=>{},syncStatusMessage:m=>messages.push(m),
  GoalKeepBoth:{commit:async()=>{calls.push('remote');return {workRows:[],actionRows:[],count:1,archiveCount:2,archiveVerifiedCount:2};},reconcile:()=>({entries:{today:{valuableAction:'merged result'}}})}});
 vm.runInContext(source('autoCommit'),c);return {c,calls,messages,current};
}
test('local input and original backup are saved before any archive/remote operation',async()=>{
 const {c,calls}=commitFixture();await c.autoCommit({});assert.deepEqual(calls,['save','original','start','remote','sent:3','save','baseline']);assert.equal(c.autoSyncBlocked,false);assert.equal(c.data.entries.today.valuableAction,'merged result');
});
test('local save failure after a confirmed remote result retains current inputs and stops before baseline',async()=>{
 const {c,calls,messages,current}=commitFixture();let n=0;c.save=()=>++n===1;await c.autoCommit({});assert.equal(c.data,current);assert.equal(c.autoSyncBlocked,true);assert.ok(calls.includes('sent:3'));assert.ok(!calls.includes('baseline'));assert.match(messages.at(-1),/端末に保存できません/);assert.doesNotMatch(messages.at(-1),/^自動連係が完了/);
});
test('failure to save local input prevents even an archive write',async()=>{
 const {c,calls,messages}=commitFixture();c.save=()=>false;await c.autoCommit({});assert.ok(!calls.includes('remote'));assert.match(messages.at(-1),/端末保存を確認できない/);assert.equal(c.autoSyncBlocked,true);
});
test('stop reason is retained even when its status element is not mounted',()=>{
 const c={document:{getElementById:()=>null},syncStatusText:'',updateAutoSyncNotice:()=>{}};vm.createContext(c);vm.runInContext(source('syncStatusMessage'),c);c.syncStatusMessage('API 503: synthetic failure');assert.equal(c.syncStatusText,'API 503: synthetic failure');assert.match(source('renderSync'),/syncStatusText\?esc\(syncStatusText\)/);
});

test('continued remote churn backs off automatically without a manual review or false success',async()=>{
 const {c,messages}=commitFixture();c.GoalKeepBoth.commit=async()=>{const e=Error('changed again');e.code='REMOTE_CHANGED';throw e;};await c.autoCommit({});assert.equal(c.autoSyncBlocked,false);assert.ok(c.autoRetryAfter>Date.now());assert.match(messages.at(-1),/自動で連係を再試行/);assert.doesNotMatch(messages.at(-1),/完了|確認して/);
});
test('dirty action, review and goal editor controls prevent background render after blur',()=>{
 let controls=[];const c={document:{querySelectorAll:selector=>{assert.match(selector,/#pg-action-form/);assert.match(selector,/#pg-review-form/);assert.match(selector,/data-goal-form/);return controls;}},editingControlFocused:()=>false};vm.createContext(c);vm.runInContext(source('unsavedFormEdits')+source('backgroundRenderSafe'),c);
 assert.equal(c.backgroundRenderSafe(),true);
 for(const control of [{tagName:'INPUT',value:'draft',defaultValue:''},{tagName:'TEXTAREA',value:'draft',defaultValue:'old'},{tagName:'SELECT',value:'b',options:[{value:'a',defaultSelected:true},{value:'b',defaultSelected:false}]},{tagName:'INPUT',type:'checkbox',checked:true,defaultChecked:false}]){controls=[control];assert.equal(c.backgroundRenderSafe(),false);}
 controls=[{tagName:'SELECT',value:'a',options:[{value:'a',defaultSelected:false},{value:'b',defaultSelected:false}]}];assert.equal(c.backgroundRenderSafe(),true,'pristine implicit first option is not a dirty draft');
 assert.match(inline,/if\(backgroundRenderSafe\(\)\)\{autoRenderDeferred=false;render\(\{preserveDisclosures:true\}\);\}/);
});

test('main automatic retry button does not switch sync off when its token has expired',()=>{
 const handler=inline.slice(inline.indexOf("if(action==='toggle-auto-sync')"),inline.indexOf("if(action==='reconnect-auto-sync')"));assert.match(handler,/if\(autoSyncEnabled&&autoWriteToken&&!autoSyncBlocked\)/);assert.match(handler,/beginAutoSyncReview\(\)/);
});
test('duplicate source IDs stop with an accurate repair warning rather than promising retry will fix it',async()=>{
 const {c,messages}=commitFixture();c.GoalKeepBoth.commit=async()=>{throw Error('シートに同じID／日付の行が複数あります：2026-11-01');};await c.autoCommit({});assert.equal(c.autoSyncBlocked,true);assert.match(messages.at(-1),/再試行だけでは解消しません/);assert.match(messages.at(-1),/記録は削除していません/);
});

test('background refresh preserves open and closed disclosures by stable record ID, not changing titles/counts',()=>{
 function tree(rows){
  const app={querySelectorAll:()=>folds},folds=[];
  for(const row of rows){
   const parent=row.parent==null?app:folds[row.parent];
   folds.push({tagName:'DETAILS',parentElement:parent,open:row.open,
    getAttribute:name=>name==='data-disclosure-key'?(row.key||null):null,
    querySelector:()=>({cloneNode:()=>({textContent:row.label,querySelectorAll:()=>[]})})});
  }
  return {app,folds};
 }
 const c={Map};vm.createContext(c);vm.runInContext(source('disclosureStates')+source('restoreDisclosures'),c);
 const old=tree([{label:'未着手',open:true},{parent:0,key:'action:a',label:'old title',open:true},{parent:0,key:'action:b',label:'same title',open:false}]);
 const saved=c.disclosureStates(old.app);
 const next=tree([{label:'未着手',open:false},{parent:0,key:'action:b',label:'same title',open:true},{parent:0,key:'action:new',label:'new item',open:false},{parent:0,key:'action:a',label:'new title',open:false}]);
 c.restoreDisclosures(next.app,saved);
 assert.deepEqual(next.folds.map(f=>f.open),[true,false,false,true]);
 assert.deepEqual(old.folds.map(f=>f.open),[true,true,false],'capturing state is read-only');
 c.restoreDisclosures(next.app,null);
 assert.deepEqual(next.folds.map(f=>f.open),[true,false,false,true]);
});
test('only background refresh opts into disclosure preservation; ordinary navigation uses default rendering',()=>{
 assert.match(source('autoCommit'),/render\(\{preserveDisclosures:true\}\)/);
 assert.match(source('render'),/options\.preserveDisclosures\?disclosureStates\(app\):null/);
 assert.match(source('render'),/restoreDisclosures\(app,disclosures\)/);
 assert.match(source('go'),/tab=to;render\(\)/);
 assert.match(fs.readFileSync('goal-progress.js','utf8'),/data-disclosure-key="action:/);
});
