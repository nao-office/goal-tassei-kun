const test=require('node:test');
const assert=require('node:assert/strict');

globalThis.window=globalThis;
require('./goal-management-sync.js');
const sync=globalThis.GoalManagementSync;

function row(headers,values={}){
  const result=Array(headers.length).fill('');
  for(const [index,value] of Object.entries(values))result[Number(index)]=value;
  return result;
}

function remoteRows({goals=[],history=[],checks=[],ideas=[],historyHeaders=sync.historySyncHeaders}={}){
  return {
    goals:[sync.goalHeaders,...goals],
    history:[historyHeaders,...history],
    checks:[sync.checkHeaders,...checks],
    ideas:[sync.ideaHeaders,...ideas]
  };
}

test('new device imports all remote goal data while preserving unrelated local records',()=>{
  const rows=remoteRows({
    goals:[row(sync.goalHeaders,{0:'g-1',1:'健康',2:'1年',3:'毎週運動する',7:'海辺を走る',8:'継続する'})],
    history:[row(sync.historySyncHeaders,{0:'2026-10-01T10:00:00+09:00',1:'g-1',2:'作成',
      3:'健康',4:'1年',5:'毎週運動する',16:'event-1',17:'{}',18:'{\"theme\":\"健康\"}'})],
    checks:[row(sync.checkHeaders,{0:'2026-10-02',1:'g-1',2:'健康',4:'変更なし',5:'今のまま'})],
    ideas:[row(sync.ideaHeaders,{0:'idea-1',2:'学び',5:'候補内容',6:'要確認'})]
  });
  const localGoal={id:'g-local',theme:'端末だけ',period:'3か月',qualitative:'端末の目標'};
  const localIdea={id:'idea-local',content:'端末の種'};
  const data={goal:{title:'旧VISION',scene:'旧景色',identity:'旧BE',why:'旧理由'},
    goals:[localGoal],goalHistory:[],goalChecks:[],goalIdeas:[localIdea],
    entries:{'2026-10-01':{fit:'端末のワーク'}},progress:{actions:[{id:'a-local'}]}};
  const before=JSON.stringify(data);
  const groups=sync.preview(data,null,rows);
  const staged=sync.applyRemote(data,rows,{},groups);
  assert.equal(JSON.stringify(data),before);
  assert.ok(staged.goals.some(goal=>goal.id==='g-1'));
  assert.ok(staged.goals.some(goal=>goal.id==='g-local'));
  assert.equal(staged.goal.title,'旧VISION');
  assert.equal(staged.goalHistory.length,1);
  assert.equal(staged.goalHistory[0].eventId,'event-1');
  assert.equal(staged.goalChecks.length,1);
  assert.ok(staged.goalIdeas.some(idea=>idea.id==='idea-1'));
  assert.ok(staged.goalIdeas.some(idea=>idea.id==='idea-local'));
  assert.deepEqual(staged.entries,data.entries);
  assert.deepEqual(staged.progress,data.progress);
});

test('same goal ID with different content is a conflict and local data remains unchanged by default',()=>{
  const rows=remoteRows({goals:[row(sync.goalHeaders,{0:'g-1',1:'Sheetsテーマ',2:'1年',3:'Sheets内容'})]});
  const data={goal:{},goals:[{id:'g-1',theme:'端末テーマ',period:'1年',qualitative:'端末内容'}],
    goalHistory:[],goalChecks:[],goalIdeas:[]};
  const groups=sync.preview(data,null,rows);
  assert.equal(groups.goals.find(group=>group.id==='g-1').status,'競合');
  assert.deepEqual(sync.applyRemote(data,rows,{},groups).goals,data.goals);
  const withHistory={...data,goalHistory:[{at:'2026-10-03',id:'g-1',action:'端末の変更'}]};
  assert.equal(sync.writePlan(withHistory,rows,groups,{}).history.length,0);
  assert.equal(sync.writePlan(withHistory,rows,groups,{['goal\u0001g-1']:'device'}).history.length,1);
  const resolved=sync.applyRemote(data,rows,{['goal\u0001g-1']:'sheets'},groups);
  assert.equal(resolved.goals[0].theme,'Sheetsテーマ');
});

test('a different value for the same goal ID is always an explicit conflict',()=>{
  const baselineRows=remoteRows({goals:[row(sync.goalHeaders,{0:'g-1',1:'前回',2:'1年',3:'共通'})]});
  const baseline=sync.baselineFromRows(baselineRows);
  const remoteChanged=remoteRows({goals:[row(sync.goalHeaders,{0:'g-1',1:'Sheets変更',2:'1年',3:'共通'})]});
  const local={goal:{},goals:[{id:'g-1',theme:'前回',period:'1年',qualitative:'共通'}],
    goalHistory:[],goalChecks:[],goalIdeas:[]};
  assert.equal(sync.preview(local,baseline,remoteChanged).goals[0].status,'競合');
  local.goals[0].qualitative='端末変更';
  assert.equal(sync.preview(local,baseline,remoteChanged).goals[0].status,'競合');
});

test('importing null, undefined, and blank Sheets values reports every local value that would be cleared',()=>{
  const rows=remoteRows({goals:[row(sync.goalHeaders,{0:'g-1',1:'Sheetsテーマ',2:'1年',3:'Sheets内容',7:null,8:undefined,9:''})]});
  const data={goal:{},goals:[{id:'g-1',theme:'端末テーマ',period:'1年',qualitative:'端末内容',
    scene:'端末だけの景色',be:'端末だけの在り方',why:'端末だけの理由'}],
    goalHistory:[],goalChecks:[],goalIdeas:[]};
  const groups=sync.preview(data,null,rows);
  const cleared=sync.clearedLocalValues(groups,{['goal\u0001g-1']:'sheets'});
  assert.ok(cleared.some(item=>item.label==='ゴールの理由'&&item.localValue==='端末だけの理由'));
  assert.ok(cleared.some(item=>item.label==='未来の景色'&&item.localValue==='端末だけの景色'));
  assert.ok(cleared.some(item=>item.label==='在り方（BE）'&&item.localValue==='端末だけの在り方'));
  assert.equal(sync.applyRemote(data,rows,{['goal\u0001g-1']:'sheets'},groups).goals[0].why,'');
  assert.equal(data.goals[0].why,'端末だけの理由');
});

test('legacy VISION and BE values use a reserved row in the existing goal tab',()=>{
  const legacy={title:'旧MY GOAL',scene:'未来の景色',identity:'在り方',why:'理由'};
  const encoded=sync.legacyRow(legacy);
  assert.equal(encoded[0],sync.legacyGoalId);
  assert.equal(encoded[3],legacy.title);
  assert.equal(encoded[7],legacy.scene);
  assert.equal(encoded[8],legacy.identity);
  assert.equal(encoded[9],legacy.why);
  const rows=remoteRows({goals:[encoded]});
  const staged=sync.applyRemote({goal:{},goals:[],goalHistory:[],goalChecks:[],goalIdeas:[]},rows,{});
  assert.deepEqual(staged.goal,legacy);
});

test('goal history and review entries merge append-only without duplicating matching events',()=>{
  const history=row(sync.historySyncHeaders,{0:'2026-10-01',1:'g-1',2:'変更',13:'理由',16:'event-1',
    17:'{\"theme\":\"前\"}',18:'{\"theme\":\"後\"}'});
  const check=row(sync.checkHeaders,{0:'2026-10-02',1:'g-1',4:'変更なし',5:'確認'});
  const rows=remoteRows({history:[history],checks:[check]});
  const repeated=sync.historyFromRow(history);
  const localCheck={at:'2026-10-02',id:'g-1',result:'変更なし',note:'確認'};
  const data={goal:{},goals:[],goalHistory:[repeated],goalChecks:[localCheck],goalIdeas:[]};
  const preview=sync.preview(data,null,rows);
  assert.equal(preview.history.toImport.length,0);
  assert.equal(preview.history.toUpload.length,0);
  assert.equal(preview.checks.toImport.length,0);
  assert.equal(preview.checks.toUpload.length,0);
});

test('writes are blocked if the history tab has not been extended with approved snapshot columns',()=>{
  const rows=remoteRows({historyHeaders:sync.historyHeaders});
  const history=[{at:'2026-10-01',id:'g-1',action:'変更',eventId:'event-1'}];
  assert.throws(()=>sync.writePlan({goal:{},goals:[],goalHistory:history,goalChecks:[],goalIdeas:[]},
    rows,{goals:[],ideas:[],history:{},checks:{}},{}),/Q:S列/);
});

test('commit stops before writing when a goal tab changes after preview',async()=>{
  const originalFetch=globalThis.fetch;
  const expected=remoteRows();
  const changed=remoteRows({goals:[row(sync.goalHeaders,{0:'g-1',1:'別端末の変更',2:'1年'})]});
  let writes=0;
  globalThis.fetch=async (url,options={})=>{
    if(options.method==='POST'){writes++;return Response.json({});}
    const target=decodeURIComponent(String(url));
    if(target.includes('ゴール一覧'))return Response.json({values:changed.goals});
    if(target.includes('ゴール履歴'))return Response.json({values:expected.history});
    if(target.includes('ゴール確認履歴'))return Response.json({values:expected.checks});
    if(target.includes('ゴールの種'))return Response.json({values:expected.ideas});
    throw Error('Unexpected mocked URL: '+url);
  };
  try{
    await assert.rejects(sync.commit({sheetId:'s'.repeat(24),token:'mock-token',data:{goal:{},goals:[],
      goalHistory:[],goalChecks:[],goalIdeas:[]},rows:expected,groups:{goals:[],ideas:[],history:{},checks:{}},choices:{}}),
    /差分確認後にゴール関連タブが変更されました/);
    assert.equal(writes,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('a failed save reports the table and never deletes any row',async()=>{
  const originalFetch=globalThis.fetch;
  const rows=remoteRows();
  const localGoal={id:'g-local',theme:'端末',period:'1年',qualitative:'新規'};
  const data={goal:{},goals:[localGoal],goalHistory:[],goalChecks:[],goalIdeas:[]};
  const groups=sync.preview(data,null,rows);
  let writes=0;
  globalThis.fetch=async (url,options={})=>{
    if(options.method==='POST'){
      writes++;
      return Response.json({error:{message:'mock failure'}},{status:503});
    }
    const target=decodeURIComponent(String(url));
    if(target.includes('ゴール一覧'))return Response.json({values:rows.goals});
    if(target.includes('ゴール履歴'))return Response.json({values:rows.history});
    if(target.includes('ゴール確認履歴'))return Response.json({values:rows.checks});
    if(target.includes('ゴールの種'))return Response.json({values:rows.ideas});
    throw Error('Unexpected mocked URL: '+url);
  };
  try{
    await assert.rejects(sync.commit({sheetId:'s'.repeat(24),token:'mock-token',data,rows,groups,
      choices:{['goal\u0001g-local']:'device'}}),/ゴール一覧で停止しました/);
    assert.equal(writes,1);
  }finally{globalThis.fetch=originalFetch;}
});

test('writing a blank value over an existing Sheets value requires separate clear confirmation',async()=>{
  const originalFetch=globalThis.fetch;
  const sheetGoal={id:'g-1',theme:'健康',period:'1年',qualitative:'週に運動する',why:'Sheetsに保存された理由'};
  const rows=remoteRows({goals:[sync.goalRow(sheetGoal)]});
  const data={goal:{},goals:[{...sheetGoal,why:''}],goalHistory:[],goalChecks:[],goalIdeas:[]};
  const groups=sync.preview(data,null,rows);
  const choices={['goal\u0001g-1']:'device'};
  let writes=0;
  globalThis.fetch=async (url,options={})=>{
    if(options.method==='POST'){writes++;return Response.json({});}
    const target=decodeURIComponent(String(url));
    if(target.includes('ゴール一覧'))return Response.json({values:rows.goals});
    if(target.includes('ゴール履歴'))return Response.json({values:rows.history});
    if(target.includes('ゴール確認履歴'))return Response.json({values:rows.checks});
    if(target.includes('ゴールの種'))return Response.json({values:rows.ideas});
    throw Error('Unexpected mocked URL: '+url);
  };
  try{
    await assert.rejects(sync.commit({sheetId:'s'.repeat(24),token:'mock-token',data,rows,groups,choices}),
      /空欄にする確認が必要/);
    assert.equal(writes,0);
  }finally{globalThis.fetch=originalFetch;}
});
