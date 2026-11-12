// Exact browser module with synthetic records and controlled local persistence.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
  const context={window:{}};vm.createContext(context);vm.runInContext(fs.readFileSync('goal-progress.js','utf8'),context);
  const P=context.window.GoalProgress,data={goals:[],entries:{},progress:P.empty()};
  let stored=JSON.stringify(data),fails=false,saves=0;const toasts=[];
  const ctx={data,render(){},toast:s=>toasts.push(s),save(){saves++;if(fails)return false;stored=JSON.stringify(data);return true;}};
  return {P,data,ctx,toasts,fail:v=>fails=v,stored:()=>stored,saves:()=>saves,
    click:(action,extra={})=>P.capture(ctx,{target:{closest:()=>({dataset:{progressAction:action,...extra}})}})};
}
for(const source of ['actions','sheetActions'])for(const status of ['未着手','完了'])test('completion retry preserves '+source+' '+status+' and adds only the successful history',()=>{
  const f=fixture(),p=f.data.progress;
  p[source]=[{id:'a1',title:'架空の行動',status,completedAt:status==='完了'?'2026-11-01T00:00:00Z':'',origin:source==='sheetActions'?'Google Sheets':'端末内'}];
  p.actionHistory=[{id:'existing',reason:'既存履歴'}];f.ctx.save();
  const original=f.stored(),actions=p.actions,history=p.actionHistory,remote=p.sheetActions;
  f.fail(true);
  for(let i=0;i<2;i++){
    f.click('toggle',{id:'a1'});
    assert.equal(JSON.stringify(f.data),original);assert.equal(f.stored(),original);
    assert.equal(p.actions,actions);assert.equal(p.actionHistory,history);assert.equal(p.sheetActions,remote);
    assert.match(f.toasts.at(-1),/保存できません/);assert.doesNotMatch(f.toasts.at(-1),/進捗を更新したよ/);
  }
  f.fail(false);f.click('toggle',{id:'a1'});
  const result=JSON.parse(f.stored()).progress;
  assert.equal(result.actions.length,1);assert.equal(result.actions[0].status,status==='完了'?'未着手':'完了');
  assert.equal(result.actionHistory.length,2);assert.equal(result.actionHistory[1].before.status,status);
  assert.equal(result.actions[0].completedAt==='',status==='完了');
  if(source==='sheetActions')assert.equal(result.sheetActions[0].status,status);
  assert.match(f.toasts.at(-1),/進捗を更新したよ/);
});

const specs=[['週間計画','weekPlans',800],['アクションの種','actionIdeas',1400],['アクション一覧','sheetActions',1400],['アクション履歴','sheetHistory',1800]];
function row(P,name,id){const cells=Array(P.remoteHeaders[name].length).fill('');cells[0]=name==='アクション履歴'?'2026-11-12T00:00:00Z':id;if(name==='アクション履歴'){cells[2]=id;cells[5]='架空の行動';cells[20]='取込テスト';}else cells[name==='週間計画'?4:name==='アクション一覧'?3:4]='架空の記録';return cells;}
function initialRows(P,name,count){const f={progress:P.empty()};for(let i=0;i<count;i++){
  const r=row(P,name,'existing-'+i),prop=specs.find(s=>s[0]===name)[1];
  if(name==='アクション履歴')f.progress[prop].push({at:r[0],id:r[2],reason:r[20],after:{id:r[2],title:r[5]}});
  else f.progress[prop].push({id:r[0]});
}return f.progress;}
for(const [name,prop,limit] of specs)test(name+' rejects aggregate overflow before saving and preserves exact-limit import after reload',()=>{
  const f=fixture();f.data.progress=initialRows(f.P,name,limit-1);const before=JSON.stringify(f.data),saved=f.saves();
  const rows=[f.P.remoteHeaders[name],row(f.P,name,'new-1'),row(f.P,name,'new-2')];
  assert.throws(()=>f.P.importSheet(name,rows,f.data,f.ctx.save),/上限|最大/);
  assert.equal(JSON.stringify(f.data),before);assert.equal(f.saves(),saved);
  assert.equal(f.P.importSheet(name,rows.slice(0,2),f.data,f.ctx.save),1);
  const after=JSON.parse(f.stored());assert.equal(after.progress[prop].length,limit);
  const normalized=f.P.normalize(after.progress);assert.equal(normalized[prop].length,limit);
  assert.ok(normalized[prop].some(x=>x.id==='new-1'));
  const exact=f.stored(),saves=f.saves();
  assert.equal(f.P.importSheet(name,rows.slice(0,2),f.data,f.ctx.save),0);
  assert.equal(f.stored(),exact);assert.equal(f.saves(),saves);
});
for(const [name,prop] of specs)test(name+' save failure restores old data and retry appends once',()=>{
  const f=fixture();f.data.progress=initialRows(f.P,name,1);f.ctx.save();
  const before=f.stored(),list=f.data.progress[prop],rows=[f.P.remoteHeaders[name],row(f.P,name,'new')];f.fail(true);
  for(let i=0;i<2;i++){
    assert.throws(()=>f.P.importSheet(name,rows,f.data,f.ctx.save),/保存/);
    assert.equal(JSON.stringify(f.data),before);assert.equal(f.data.progress[prop],list);assert.equal(f.stored(),before);
  }
  f.fail(false);assert.equal(f.P.importSheet(name,rows,f.data,f.ctx.save),1);assert.equal(JSON.parse(f.stored()).progress[prop].length,2);
});
test('CSV rejects too many input rows rather than silently accepting only the beginning',()=>{
  const f=fixture(),name='週間計画',rows=[f.P.remoteHeaders[name],...Array.from({length:1401},()=>row(f.P,name,'same'))],before=JSON.stringify(f.data);
  assert.throws(()=>f.P.importSheet(name,rows,f.data,f.ctx.save),/1,400|1400/);assert.equal(JSON.stringify(f.data),before);assert.equal(f.saves(),0);
});
test('CSV rejects long IDs and fields that would be cut on reload, without partial writes',()=>{
  for(const [name] of specs)for(const field of ['id','goal','body']){
    const f=fixture(),r=row(f.P,name,'new');
    const index=field==='id'?(name==='アクション履歴'?2:0):field==='goal'?({'アクション履歴':3,'週間計画':2,'アクション一覧':1,'アクションの種':3}[name]):(name==='アクション履歴'?5:name==='週間計画'?4:name==='アクション一覧'?3:4);
    r[index]='あ'.repeat(field==='body'?4001:181);const before=JSON.stringify(f.data);
    assert.throws(()=>f.P.importSheet(name,[f.P.remoteHeaders[name],row(f.P,name,'valid'),r],f.data,f.ctx.save),/文字/);
    assert.equal(JSON.stringify(f.data),before);assert.equal(f.saves(),0);
  }
});
test('CSV counts only newly accepted records, including duplicates in the same file',()=>{
  const f=fixture(),name='週間計画',r=row(f.P,name,'new');
  assert.equal(f.P.importSheet(name,[f.P.remoteHeaders[name],r,r],f.data,f.ctx.save),1);
  assert.equal(f.data.progress.weekPlans.length,1);
});
test('weekly view distinguishes synchronized action fields from device-only plans and notes',()=>{
  const f=fixture();f.click('mode',{mode:'plan'});const result=f.P.render(f.ctx);
  assert.match(result,/対応項目.*自動連係/);assert.match(result,/週間計画.*端末専用/);
  assert.doesNotMatch(result,/Google Sheetsへは書き戻されません/);
});
