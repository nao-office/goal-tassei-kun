const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
const inline=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const MAX_BYTES=20_000_000;
const KEY='fixture-records',GUARD='fixture-restore-guard',AUTO='fixture-auto',AUTO_REVIEW='fixture-auto-review';
const GOAL_BASE='fixture-goal-base:',WRITE_BASE='fixture-work-base:',APPROVED='fixture-approved:',SHEET='fixture-sheet';
const helpers=inline.slice(inline.indexOf('  const BACKUP_MAX_BYTES='),inline.indexOf("  document.addEventListener('click',ev=>{",inline.indexOf('  const BACKUP_MAX_BYTES=')));
const restore=inline.slice(inline.indexOf('  function restoreBackupFile('),inline.indexOf("  document.addEventListener('change',ev=>{",inline.indexOf('  function restoreBackupFile(')));
function source(name){
 const start=inline.indexOf('  function '+name+'(');assert.ok(start>=0,name);
 const rest=inline.slice(start),end=rest.slice(1).search(/\n  (?:async )?function /);
 return end<0?rest:rest.slice(0,end+1);
}
const simple=()=>({version:1,goal:{title:'架空ゴール',scene:'',identity:'',why:''},entries:{'2026-11-07':{valuableAction:'架空の行動'}}});
const fileFor=(value,extra={})=>{const text=typeof value==='string'?value:JSON.stringify(value);return {text,size:Buffer.byteLength(text,'utf8'),...extra};};
function fixture(extra={}){
 const messages=[],prompts=[],readers=[],downloads=[],revoked=[],changes=[],navigations=[],timers=[];
 const original=simple(),storage=new Map([[KEY,JSON.stringify(original)],[AUTO,'1'],[AUTO_REVIEW,'1'],[GOAL_BASE+SHEET,'old-goals'],[WRITE_BASE+SHEET,'old-work'],[APPROVED+SHEET,'1']]);
 const c={Blob,console,KEY,BACKUP_RESTORE_SYNC_GUARD_KEY:GUARD,AUTO_SYNC_KEY:AUTO,AUTO_ENABLE_AFTER_REVIEW_KEY:AUTO_REVIEW,GOAL_BASELINE_KEY:GOAL_BASE,WRITE_BASELINE_KEY:WRITE_BASE,SAFE_SYNC_APPROVED_KEY:APPROVED,
  data:original,fieldNames:['fit','normal','futureAction','valuableAction','minimumAction','withoutAction','achievement','growth','tomorrow','lessonReflection','lessonNextStep'],
  syncConfig:{sheetId:SHEET},syncBusy:false,syncAuthBusy:false,writeBusy:false,autoAuthBusy:false,autoSyncTickBusy:false,
  backupRestoreSyncGuard:false,autoSyncEnabled:true,autoWriteToken:true,googleToken:'synthetic-token',googleTokenWritable:true,autoSaveTimer:123,enableAutoAfterReview:true,
  writeBaseline:{old:'work'},goalSyncBaseline:{old:'goals'},safeSyncApproved:true,syncReview:{old:'preview'},syncReviewChoices:{old:'device'},goalReviewChoices:{old:'device'},storageError:false,localSaveEvidence:'loaded',
  localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{changes.push(['set',k]);storage.set(k,v);},removeItem:k=>{changes.push(['remove',k]);storage.delete(k);}},
  showToast:m=>messages.push(m),syncStatusMessage:m=>messages.push(m),updateAutoSyncNotice:()=>{},confirm:m=>{prompts.push(m);return true;},go:to=>navigations.push(to),jstToday:()=> '2026-11-07',
  setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout:()=>{},URL:{createObjectURL:blob=>{downloads.push({blob});return 'blob:fixture';},revokeObjectURL:url=>revoked.push(url)},
  document:{querySelectorAll:()=>[],body:{appendChild:()=>{}},createElement:()=>({click(){downloads.at(-1).name=this.download;downloads.at(-1).clicked=true;},remove(){}})},
  ...extra};
 c.FileReader=extra.FileReader||class{constructor(){readers.push(this);}readAsText(file,encoding){this.file=file;this.encoding=encoding;if(file.throwRead)throw Error('read');if(!file.defer)this.finish();}finish(){this.result=this.file.text;this.onload();}};
 c.window={};vm.createContext(c);vm.runInContext(fs.readFileSync('goal-progress.js','utf8'),c);c.GoalProgress=c.window.GoalProgress;
 vm.runInContext(inline.match(/  const DEFAULT_LESSONS=.*?;\n/)[0],c);
 vm.runInContext(inline.match(/  const initial=\(\)=>.*?;\n/)[0],c);
 for(const name of ['cleanString','cleanGoalSnapshot','normalize','save'])vm.runInContext(source(name),c);
 vm.runInContext(helpers+'\n'+restore,c);
 return Object.assign(c,{messages,prompts,readers,downloads,revoked,changes,navigations,timers,storage,original});
}
function unchanged(c,before=JSON.stringify(c.original)){
 assert.equal(JSON.stringify(c.data),before);assert.equal(c.storage.get(KEY),JSON.stringify(c.original));
 assert.equal(c.navigations.length,0);assert.ok(!c.messages.some(m=>m.startsWith('バックアップを読み込みました')));
}
function nonDestructive(c){unchanged(c);assert.equal(c.changes.length,0);assert.equal(c.backupRestoreSyncGuard,false);assert.equal(c.autoSyncEnabled,true);}

test('a compact app backup exports all ordinary UI collections and restores them without loss',async()=>{
 const c=fixture();c.data=c.normalize(simple());
 c.data.goals=[{id:'goal-1',theme:'架空テーマ',period:'1年',qualitative:'架空ゴール'}];
 c.data.goalChecks=[{id:'goal-1',at:'2026-11-07',memo:'確認'}];
 c.data.goalIdeas=[{id:'idea-1',content:'架空の種',question:'次の一歩？'}];
 c.data.goalHistory=[{id:'goal-1',at:'2026-11-07',beforeSnapshot:{qualitative:'前'},afterSnapshot:{qualitative:'後'}}];
 c.data.entries['2026-11-07'].lessonNotes={'DAY0-BE':{reflection:'気づき',nextStep:'一歩',reviewed:true}};
 for(const key of ['actions','reviews','sheetActions','actionIdeas','weekPlans'])c.data.progress[key]=[{id:key+'-1',title:key==='reviews'||key==='weekPlans'?undefined:'架空行動'}];
 // UI-generated histories retain both snapshots and optional fields.
 c.data.progress.actionHistory=[{at:'2026-11-07',id:'a-1',reason:'作成',before:null,after:{id:'a-1',title:'架空行動'}}];
 c.data.progress.reviewHistory=[{at:'2026-11-07',id:'r-1',reason:'確認',before:null,after:{id:'r-1',week:'2026-11-02'}}];
 c.data.progress.sheetHistory=[{at:'2026-11-07',id:'s-1',reason:'確認',before:null,after:{id:'s-1'},kind:'Google Sheets'}];
 const before=JSON.parse(JSON.stringify(c.data));assert.equal(c.exportData(),true);assert.equal(c.prompts.length,0);
 assert.match(c.downloads[0].name,/mirai-goal-backup-/);const json=await c.downloads[0].blob.text();assert.ok(!json.includes('\n  '));
 c.restoreBackupFile(fileFor(json));assert.ok(c.backupPreservesSource(before,c.data));assert.ok(c.backupPreservesSource(c.data,c.normalize(c.data)));
 assert.equal(c.storage.get(KEY),JSON.stringify(c.data));assert.equal(c.backupRestoreSyncGuard,true);assert.equal(c.storage.get(GUARD),'1');assert.equal(c.storage.get(AUTO),'0');
 assert.equal(c.autoSyncEnabled,false);assert.equal(c.autoWriteToken,false);assert.equal(c.googleToken,'');assert.equal(c.enableAutoAfterReview,false);assert.equal(c.storage.has(AUTO_REVIEW),false);
 assert.equal(c.writeBaseline,null);assert.equal(c.goalSyncBaseline,null);assert.equal(c.safeSyncApproved,false);assert.equal(c.syncReview,null);assert.equal(c.storage.has(WRITE_BASE+SHEET),false);assert.equal(c.storage.has(APPROVED+SHEET),false);
 assert.deepEqual(c.navigations,['home']);c.timers.forEach(fn=>fn());assert.deepEqual(c.revoked,['blob:fixture']);
});

test('legacy minimal v1, UTF-8 BOM, added defaults, and JSON-string goal snapshots remain compatible',()=>{
 const c=fixture(),record=simple();record.goalHistory=[{id:'legacy',beforeSnapshot:'{"qualitative":"前"}',afterSnapshot:'{"qualitative":"後"}'}];
 c.restoreBackupFile(fileFor('\uFEFF'+JSON.stringify(record,null,2)));
 assert.equal(c.data.goalHistory[0].beforeSnapshot.qualitative,'前');assert.ok(c.data.lessons.length);assert.ok(c.data.progress);assert.equal(c.navigations.length,1);
});

test('a realistic Japanese backup over the old 2MB limit round-trips, including legacy pretty JSON',async()=>{
 const record=simple();record.entries={};
 for(let i=0;i<200;i++){const date=new Date(Date.UTC(2025,0,1+i)).toISOString().slice(0,10);record.entries[date]={valuableAction:'あ'.repeat(4000)};}
 for(const pretty of [false,true]){
  const c=fixture();c.data=c.normalize(record);assert.equal(c.exportData(),true);assert.equal(c.prompts.length,0);
  const exported=await c.downloads[0].blob.text();const file=fileFor(pretty?JSON.stringify(JSON.parse(exported),null,2):exported);
  assert.ok(file.size>2_000_000&&file.size<MAX_BYTES);c.restoreBackupFile(file);assert.equal(Object.keys(c.data.entries).length,200);assert.equal(c.data.entries['2025-01-01'].valuableAction,'あ'.repeat(4000));assert.equal(c.navigations.length,1);
 }
});

test('the shared limit is exactly 20,000,000 UTF-8 bytes, with inclusive boundary and multibyte counting',()=>{
 const c=fixture();assert.equal(vm.runInContext('BACKUP_MAX_BYTES',c),MAX_BYTES);
 const record={...simple(),exportedAt:''},base=JSON.stringify(record);record.exportedAt='x'.repeat(MAX_BYTES-Buffer.byteLength(base));
 const exact=fileFor(record);assert.equal(exact.size,MAX_BYTES);c.restoreBackupFile(exact);assert.equal(c.navigations.length,1);
 for(const file of [{size:MAX_BYTES+1,text:'not read'},fileFor({...simple(),exportedAt:'あ'.repeat(7_000_000)})]){
  const denied=fixture();denied.restoreBackupFile(file);nonDestructive(denied);assert.equal(denied.readers.length,0);assert.match(denied.messages.at(-1),/20MB/);
 }
 const misreported=fixture();misreported.restoreBackupFile({...exact,text:exact.text+' ',size:1});nonDestructive(misreported);assert.match(misreported.messages.at(-1),/20MB/);
});

test('normal export includes its metadata within the same byte boundary enforced by restore',async()=>{
 const c=fixture();c.data=c.normalize(simple());c.data.goalIdeas=Array.from({length:2500},(_,i)=>({id:'seed-'+i,content:'x'.repeat(4000),memo:'x'.repeat(4000)}));
 const bytes=()=>Buffer.byteLength(JSON.stringify({...c.data,exportedAt:'2026-11-07T00:00:00.000Z'}));
 while(bytes()>MAX_BYTES)c.data.goalIdeas.pop();
 // Last record fills the remaining bytes using supported fields, not ignored metadata.
 c.data.goalIdeas.push({id:'boundary',content:'',memo:''});
 let remaining=MAX_BYTES-bytes();assert.ok(remaining>=0&&remaining<=8000);
 const last=c.data.goalIdeas.at(-1);last.content='x'.repeat(Math.min(remaining,4000));last.memo='x'.repeat(Math.max(0,remaining-4000));
 assert.equal(bytes(),MAX_BYTES);assert.equal(c.exportData(),true);assert.equal(c.prompts.length,0);assert.equal(c.downloads[0].blob.size,MAX_BYTES);
 const json=await c.downloads[0].blob.text();const dest=fixture();dest.restoreBackupFile(fileFor(json));assert.equal(dest.navigations.length,1);assert.equal(dest.data.goalIdeas.length,c.data.goalIdeas.length);
 const sparse=JSON.parse(json);delete sparse.lessons;sparse.goal.title+='x';const sparseFile=fileFor(sparse);assert.ok(sparseFile.size<MAX_BYTES);
 const enlarged=fixture();enlarged.restoreBackupFile(sparseFile);nonDestructive(enlarged);assert.equal(enlarged.prompts.length,0);assert.match(enlarged.messages.at(-1),/復元後の書き出し.*20MB/);
 enlarged.data=sparse;assert.equal(enlarged.exportData(),true);assert.match(enlarged.downloads[0].name,/recovery-only/);assert.match(enlarged.prompts[0],/20MB/);
 c.data.goal.title+='x';assert.equal(bytes(),MAX_BYTES+1);assert.equal(c.exportData(),true);assert.match(c.prompts[0],/20MB/);assert.match(c.downloads[1].name,/recovery-only/);
});

test('oversized current data remains downloadable intact only after explicit recovery-only warning',async()=>{
 const c=fixture();c.data.goalIdeas=Array.from({length:1800},(_,i)=>({id:'seed-'+i,content:'あ'.repeat(4000)}));const before=JSON.stringify(c.data);
 assert.equal(c.exportData(),true);assert.match(c.prompts[0],/20MB.*上限/);assert.match(c.prompts[0],/通常のバックアップとしては復元できません/);
 assert.match(c.downloads[0].name,/recovery-only/);const raw=JSON.parse(await c.downloads[0].blob.text());assert.equal(raw.recoveryOnly,true);assert.equal(raw.goalIdeas.length,1800);assert.equal(raw.goalIdeas[1799].content,'あ'.repeat(4000));assert.equal(JSON.stringify(c.data),before);assert.equal(c.changes.length,0);
 const restored=fixture();restored.restoreBackupFile(fileFor(raw));nonDestructive(restored);
});

test('canceling recovery export has no side effects',()=>{
 const c=fixture({confirm:()=>false});c.data.goal.title='x'.repeat(4001);const before=JSON.stringify(c.data);
 assert.equal(c.exportData(),false);assert.equal(c.downloads.length,0);assert.equal(JSON.stringify(c.data),before);assert.equal(c.changes.length,0);
});

test('text and collection truncation, unknown fields, invalid records and changed history are rejected rather than silently normalized',()=>{
 const cases=[
  x=>x.goal.title='あ'.repeat(4001),x=>x.goal.extra='must not drop',x=>x.entries['2026-11-07'].unknown='must not drop',
  x=>x.goals=Array.from({length:3001},(_,i)=>({id:'g-'+i})),x=>x.goals=[null],x=>x.goalIdeas=[{id:'i',memo:42}],
  x=>x.lessons=Array.from({length:801},(_,i)=>({id:'lesson-'+i})),x=>x.lessons=[{id:'lesson',url:'http://example.test'}],
  x=>x.entries.badDate={valuableAction:'must not drop'},x=>x.entries['2026-11-07'].lessonNotes=Object.fromEntries(Array.from({length:201},(_,i)=>['l'+i,{reflection:'note'}])),
  x=>x.progress={actions:[{title:'missing id'}]},x=>x.progress={actions:Array.from({length:1001},(_,i)=>({id:'a'+i}))},
  x=>x.progress={reviews:Array.from({length:521},(_,i)=>({id:'r'+i}))},x=>x.progress={actionHistory:Array.from({length:2501},(_,i)=>({id:'a'+i}))},
  x=>x.progress={sheetHistory:[{id:'s-1',kind:'Original kind must survive'}]},x=>x.progress={actionHistory:[{id:'a',reason:'x'.repeat(1001)}]},
  x=>x.goalHistory=[{id:'g',beforeSnapshot:'not JSON'}],x=>x.goalHistory=[{id:'g',beforeSnapshot:null,unexpected:'keep'}],
  x=>x.entries=JSON.parse('{"__proto__":{"valuableAction":"keep"}}'),x=>x.recoveryOnly=true
 ];
 for(const alter of cases){const c=fixture(),record=simple();alter(record);c.restoreBackupFile(fileFor(record));nonDestructive(c);assert.equal(c.prompts.length,0,alter.toString());assert.match(c.messages.at(-1),/全内容を保って復元できません/,alter.toString());}
});

test('normalization loss also triggers intact recovery export, not a falsely restorable backup',async()=>{
 const c=fixture();c.data.goal.title='長'.repeat(4001);assert.equal(c.exportData(),true);assert.match(c.downloads[0].name,/recovery-only/);
 const raw=JSON.parse(await c.downloads[0].blob.text());assert.equal(raw.goal.title.length,4001);assert.equal(raw.recoveryOnly,true);
 const dest=fixture();dest.restoreBackupFile(fileFor(raw));nonDestructive(dest);assert.match(dest.messages.at(-1),/全内容を保って復元できません/);
});

test('malformed JSON and unsupported root versions or shapes never mutate data or sync state',()=>{
 for(const raw of ['bad JSON','null','[]','{"version":2,"goal":{},"entries":{}}','{"version":1,"goal":null,"entries":{}}','{"version":1,"goal":{},"entries":[]}',JSON.stringify({...simple(),entries:{'2026-11-07':null}})]){
  const c=fixture();c.restoreBackupFile(fileFor(raw));nonDestructive(c);assert.equal(c.prompts.length,0);
 }
});

test('restore confirmation cancellation preserves data, storage and all sync state',()=>{
 const c=fixture({confirm:()=>false});c.restoreBackupFile(fileFor(simple()));nonDestructive(c);assert.equal(c.googleToken,'synthetic-token');assert.equal(c.autoSaveTimer,123);
});

test('read errors, aborts, missing files and synchronous FileReader failures are safe',()=>{
 for(const event of ['onerror','onabort']){const c=fixture();c.restoreBackupFile(fileFor(simple(),{defer:true}));c.readers[0][event]();nonDestructive(c);assert.match(c.messages.at(-1),/現在の記録は変更していません/);}
 const thrown=fixture();thrown.restoreBackupFile(fileFor(simple(),{throwRead:true}));nonDestructive(thrown);
 const unavailable=fixture({FileReader:class{constructor(){throw Error('unavailable');}}});unavailable.restoreBackupFile(fileFor(simple()));nonDestructive(unavailable);
 for(const file of [undefined,{size:NaN},{size:-1}]){const c=fixture();c.restoreBackupFile(file);nonDestructive(c);}
});

test('only the latest selected file can restore, and even a later rejected selection supersedes older reads',()=>{
 for(const newest of [fileFor({...simple(),goal:{title:'latest'}}),{size:MAX_BYTES+1}]){
  const c=fixture();c.restoreBackupFile(fileFor({...simple(),goal:{title:'stale'}},{defer:true}));c.restoreBackupFile(newest);const messages=c.messages.length;c.readers[0].finish();c.readers[0].onerror();c.readers[0].onabort();assert.equal(c.messages.length,messages);assert.notEqual(c.data.goal.title,'stale');
  if(newest.size<=MAX_BYTES){assert.equal(c.data.goal.title,'latest');assert.equal(c.prompts.length,1);}else nonDestructive(c);
 }
});

test('sync busy states and sync starting during confirmation block replacement',()=>{
 for(const flag of ['syncBusy','syncAuthBusy','writeBusy','autoAuthBusy','autoSyncTickBusy']){
  const c=fixture({[flag]:true});c.restoreBackupFile(fileFor(simple()));nonDestructive(c);assert.equal(c.prompts.length,0);
  const during=fixture();during.confirm=()=>{during[flag]=true;return true;};during.restoreBackupFile(fileFor(simple()));nonDestructive(during);
 }
});

test('quota failures at every safety-write stage leave existing records intact and never report restore success',()=>{
 for(const failKey of [GUARD,AUTO,AUTO_REVIEW,GOAL_BASE+SHEET,KEY]){
  const c=fixture();for(const method of ['setItem','removeItem']){const fn=c.localStorage[method];c.localStorage[method]=(key,...args)=>{if(key===failKey)throw Error('QuotaExceededError');return fn(key,...args);};}
  c.restoreBackupFile(fileFor({...simple(),goal:{title:'replacement'}}));unchanged(c);
  if(failKey===GUARD){assert.equal(c.backupRestoreSyncGuard,false);assert.equal(c.autoSyncEnabled,true);}else{assert.equal(c.backupRestoreSyncGuard,true);assert.equal(c.storage.get(GUARD),'1');assert.equal(c.autoSyncEnabled,false);assert.equal(c.autoSaveTimer,null);}
  assert.match(c.messages.at(-1),/復元しませんでした|保存できませんでした/);
 }
});

test('cleanup failure after a successful restore keeps the durable guard and reports a warning',()=>{
 const c=fixture(),remove=c.localStorage.removeItem;c.localStorage.removeItem=key=>{if(key===WRITE_BASE+SHEET)throw Error('denied');remove(key);};
 c.restoreBackupFile(fileFor({...simple(),goal:{title:'restored'}}));assert.equal(c.data.goal.title,'restored');assert.equal(JSON.parse(c.storage.get(KEY)).goal.title,'restored');assert.equal(c.storage.get(GUARD),'1');assert.equal(c.autoSyncEnabled,false);assert.ok(c.messages.some(m=>/古い同期基準を削除できません/.test(m)));
});

test('failed export serialization or download does not claim success and releases created object URLs',()=>{
 const circular=fixture();circular.data.circular=circular.data;assert.equal(circular.exportData(),false);assert.equal(circular.downloads.length,0);assert.match(circular.messages.at(-1),/開始できません/);
 const c=fixture();c.document.createElement=()=>({click(){throw Error('blocked download');},remove(){}});assert.equal(c.exportData(),false);assert.match(c.messages.at(-1),/開始できません/);c.timers.forEach(fn=>fn());assert.deepEqual(c.revoked,['blob:fixture']);assert.equal(c.changes.length,0);
});
