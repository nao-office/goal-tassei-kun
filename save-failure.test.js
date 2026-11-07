const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inline=fs.readFileSync('index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name){const m=new RegExp('  (?:async )?function '+name+'\\(').exec(inline);assert.ok(m,name);const rest=inline.slice(m.index),end=rest.slice(1).search(/\n  (?:async )?function /);return end<0?rest:rest.slice(0,end+1);}
function fixture(){
 const saved={valuableAction:'以前の行動',minimumAction:'以前の最低ライン',reviewed:false,lessonId:'old',lessonReviewed:false,lessonReflection:'以前の学び',lessonNextStep:'以前の実践',lessonNotes:{old:{reflection:'前のメモ',reviewed:false}}};
 const c={KEY:'fixture',activeDate:'2026-11-07',data:{entries:{'2026-11-07':structuredClone(saved),'2026-11-06':{tomorrow:'前夜の計画'}}},storageError:false,localSaveEvidence:'loaded',
  notices:0,toasts:[],destinations:[],renders:0,schedules:0,fail:true,stored:JSON.stringify({entries:{'2026-11-07':saved}}),
  GoalProgress:{capture:()=>false,change:()=>false},progressCtx:()=>({}),fieldNames:['valuableAction','minimumAction','achievement','growth','tomorrow','lessonReflection','lessonNextStep'],navigator:{},
  lessonFor:()=>({id:'lesson-1'}),confirm:()=>true,dayShift:()=> '2026-11-06'};
 c.localStorage={setItem:(_k,v)=>{if(c.fail)throw Error('fixture quota');c.stored=v;}};
 c.showToast=s=>c.toasts.push(s);c.updateAutoSyncNotice=()=>c.notices++;c.go=to=>c.destinations.push(to);c.render=()=>c.renders++;c.scheduleAutoSave=()=>c.schedules++;
 const handlers={};c.document={querySelectorAll:()=>[],addEventListener:(event,fn)=>handlers[event]=fn};vm.createContext(c);
 for(const name of ['save','txt','isPlanned','usePreviousAction'])vm.runInContext(source(name),c);
 c.entry=()=>c.data.entries[c.activeDate];
 for(const event of ['input','change','click'])vm.runInContext(inline.split('\n').find(line=>line.startsWith("  document.addEventListener('"+event+"',")&&line.endsWith('});')),c);
 c.click=action=>handlers.click({target:{closest:selector=>selector==='[data-action]'?{dataset:{action}}:null}});
 c.input=(field,value)=>handlers.input({target:{matches:s=>s==='[data-entry]',dataset:{entry:field},value}});
 c.check=(field,value)=>handlers.change({target:{matches:s=>s==='[data-check]',dataset:{check:field},checked:value}});
 return c;
}
for(const [action,field,value,destination,success] of [
 ['confirm-morning','valuableAction','変更した朝の行動','home','今日の一歩が決まりました'],
 ['finish-review','growth','変更した夜の気づき','history','今日の振り返りを記録しました'],
 ['finish-lesson','lessonReflection','変更した講義の気づき',null,'今日の学びを復習したね']
])test(action+' keeps inputs and page on repeated save failures; one successful retry completes',()=>{
 const c=fixture(),before=c.stored;c.input(field,value);const notes=JSON.stringify(c.entry().lessonNotes);
 for(let attempt=0;attempt<2;attempt++){
  c.click(action);assert.equal(c.stored,before);assert.equal(c.entry()[field],value);assert.equal(c.renders,0);assert.deepEqual(c.destinations,[]);assert.equal(c.schedules,0);assert.match(c.toasts.at(-1),/保存できません/);assert.doesNotMatch(c.toasts.at(-1),new RegExp(success));
  assert.equal(c.entry().reviewed,false);assert.equal(c.entry().lessonReviewed,false);assert.equal(JSON.stringify(c.entry().lessonNotes),notes);
 }
 c.fail=false;c.click(action);assert.equal(JSON.parse(c.stored).entries[c.activeDate][field],value);assert.equal(c.storageError,false);assert.equal(c.schedules,1);assert.match(c.toasts.at(-1),new RegExp(success));
 assert.deepEqual(c.destinations,destination?[destination]:[]);assert.equal(c.renders,action==='finish-lesson'?1:0);
 if(action==='finish-review')assert.equal(c.entry().reviewed,true);
 if(action==='finish-lesson'){assert.equal(c.entry().lessonReviewed,true);assert.equal(c.entry().lessonNotes['lesson-1'].reflection,value);}
});
test('existing completed flags remain completed after a failed edit without losing new text',()=>{
 const c=fixture();c.entry().reviewed=true;c.entry().lessonReviewed=true;c.input('growth','修正');c.click('finish-review');c.click('finish-lesson');assert.equal(c.entry().reviewed,true);assert.equal(c.entry().lessonReviewed,true);assert.equal(c.entry().growth,'修正');assert.deepEqual(c.destinations,[]);
});
test('retry local save retains page and does not claim completion or a Sheets send',()=>{
 const c=fixture();c.input('valuableAction','未保存の入力');c.click('retry-local-save');assert.match(c.toasts.at(-1),/保存できません/);c.fail=false;c.click('retry-local-save');assert.match(c.toasts.at(-1),/端末内の記録を再保存しました/);assert.doesNotMatch(c.toasts.at(-1),/Sheets|振り返りを記録|一歩が決まり/);assert.deepEqual(c.destinations,[]);assert.equal(c.renders,0);assert.equal(c.entry().reviewed,false);assert.equal(JSON.parse(c.stored).entries[c.activeDate].valuableAction,'未保存の入力');
});
test('checkbox storage failure does not report success or schedule a send',()=>{
 const c=fixture(),before=c.stored;c.check('minimumDone',true);assert.equal(c.entry().minimumDone,true);assert.equal(c.stored,before);assert.equal(c.schedules,0);assert.match(c.toasts.at(-1),/保存できません/);c.fail=false;c.click('retry-local-save');assert.equal(JSON.parse(c.stored).entries[c.activeDate].minimumDone,true);
});
test('failed previous-action replacement preserves current input and can retry',()=>{
 const c=fixture();c.click('use-previous-action');assert.equal(c.entry().valuableAction,'以前の行動');assert.equal(c.renders,0);assert.equal(c.schedules,0);c.fail=false;c.click('use-previous-action');assert.equal(c.entry().valuableAction,'前夜の計画');assert.equal(c.renders,1);
});
test('storage failure prevents scheduling, automatic tick and commit even with a previously valid sync session',async()=>{
 const c={storageError:true,updateAutoSyncNotice:()=>{},calls:0,GoalWriteback:{canAutoSync:()=>{throw Error('must not enter sync');}},autoSyncEnabled:true};
 vm.createContext(c);for(const n of ['scheduleAutoSave','autoSyncTick','autoCommit'])vm.runInContext(source(n),c);c.scheduleAutoSave();await c.autoSyncTick();await c.autoCommit();
});
test('save failure notice offers retry and JSON rescue without hiding evidence categories',()=>{
 assert.match(source('updateAutoSyncNotice'),/端末保存を再試行.*retry-local-save/);assert.match(source('updateAutoSyncNotice'),/JSONで退避.*export/);
});
function progressFixture(){
 const values={title:'架空の新規行動',minimum:'小さな一歩',reason:'保存理由',facts:'週の気づき'},form={querySelector:s=>({value:values[s.match(/name="([^"]+)"/)[1]]||''}),scrollIntoView:()=>{}};
 const c={window:{},document:{getElementById:()=>form}};vm.createContext(c);vm.runInContext(fs.readFileSync('goal-progress.js','utf8'),c);const P=c.window.GoalProgress;
 const ctx={data:{goals:[],entries:{},progress:P.empty()},saved:false,renders:0,toasts:[],go:()=>{}};ctx.save=()=>ctx.saved;ctx.render=()=>ctx.renders++;ctx.toast=s=>ctx.toasts.push(s);
 return {P,ctx,values,click:(action,extra={})=>P.capture(ctx,{target:{closest:()=>({dataset:{progressAction:action,...extra}})}})};
}
for(const action of ['save-action','save-review'])test(action+' leaves form and history unchanged on failure, and does not duplicate retry',()=>{
 const {ctx,values,click}=progressFixture();const before=JSON.stringify(ctx.data);click(action);click(action);assert.equal(JSON.stringify(ctx.data),before);assert.equal(ctx.renders,0);assert.match(ctx.toasts.at(-1),/入力を残しています/);assert.equal(values.reason,'保存理由');ctx.saved=true;click(action);assert.equal(ctx.renders,1);const p=ctx.data.progress;assert.equal((action==='save-action'?p.actions:p.reviews).length,1);assert.equal((action==='save-action'?p.actionHistory:p.reviewHistory).length,1);
});
test('failed action edit preserves its target and reason for retry without creating another action',()=>{
 const {ctx,values,click}=progressFixture();ctx.data.progress.actions.push({id:'a1',title:'既存',origin:'端末内'});click('edit',{id:'a1'});const renders=ctx.renders;click('save-action');assert.equal(ctx.renders,renders);assert.equal(ctx.data.progress.actions[0].title,'既存');ctx.saved=true;click('save-action');assert.equal(ctx.data.progress.actions.length,1);assert.equal(ctx.data.progress.actions[0].id,'a1');assert.equal(ctx.data.progress.actions[0].title,values.title);assert.equal(ctx.data.progress.actionHistory.length,1);
});
