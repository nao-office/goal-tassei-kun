const test=require('node:test');
const assert=require('node:assert/strict');

globalThis.window=globalThis;
require('./sheets-writeback.js');
const sync=globalThis.GoalWriteback;

function row(headers,values={}){
  const result=Array(headers.length).fill('');
  for(const [index,value] of Object.entries(values))result[Number(index)]=value;
  return result;
}

test('preview distinguishes equal, device-only, Sheets-only, and conflicting values',()=>{
  const equalRows={
    workRows:[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'same'})],
    actionRows:[sync.actionHeaders]
  };
  const base=sync.baselineFromRows(equalRows.workRows,equalRows.actionRows);
  const data={entries:{'2026-10-27':{fit:'same'}},progress:{actions:[]}};
  const before=JSON.stringify(data),baselineBefore=JSON.stringify(base);
  const equal=sync.preview(data,base,equalRows.workRows,equalRows.actionRows);
  assert.equal(JSON.stringify(data),before);
  assert.equal(JSON.stringify(base),baselineBefore);
  assert.ok(equal.some(group=>group.status==='一致'));
  assert.equal(equal.flatMap(group=>group.values).length,0);

  const deviceOnly=sync.preview({entries:{'2026-10-27':{fit:'端末だけ'}},progress:{actions:[]}},null,[sync.workHeaders],[sync.actionHeaders]);
  assert.ok(deviceOnly.flatMap(group=>group.values).some(field=>field.status==='端末だけに存在'));

  const sheetsRows=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'Sheetsだけ'})];
  const sheetsOnly=sync.preview({entries:{},progress:{actions:[]}},null,sheetsRows,[sync.actionHeaders]);
  assert.ok(sheetsOnly.flatMap(group=>group.values).some(field=>field.status==='Sheetsだけに存在'));

  const previous=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'前回'})];
  const remote=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'Sheets変更'})];
  const conflict=sync.preview({entries:{'2026-10-27':{fit:'端末変更'}},progress:{actions:[]}},
    sync.baselineFromRows(previous,[sync.actionHeaders]),remote,[sync.actionHeaders]);
  assert.ok(conflict.flatMap(group=>group.values).some(field=>field.status==='両方で変更（競合）'));
});

test('local edits remain pending relative to the stored baseline',()=>{
  const previous=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'前回'})];
  const baseline=sync.baselineFromRows(previous,[sync.actionHeaders]);
  const changed={entries:{'2026-10-27':{fit:'端末変更'}},progress:{actions:[]}};
  assert.equal(sync.countPending(changed,baseline),1);
});

test('preview distinguishes blank cells from missing values and flags deletions',()=>{
  const previous=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'保存済み'})];
  const emptyRemote=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:''})];
  const groups=sync.preview({entries:{'2026-10-27':{fit:''}},progress:{actions:[]}},
    sync.baselineFromRows(previous,[sync.actionHeaders]),emptyRemote,[sync.actionHeaders]);
  const field=groups.flatMap(group=>group.values).find(item=>item.index===1);
  assert.equal(field.status,'削除・空欄化の可能性');
  assert.equal(field.localValue,'');
  assert.equal(field.remoteValue,'');

  const deleted=sync.preview({entries:{'2026-10-27':{fit:'保存済み'}},progress:{actions:[]}},
    sync.baselineFromRows(previous,[sync.actionHeaders]),[sync.workHeaders],[sync.actionHeaders]);
  assert.ok(deleted.flatMap(group=>group.values).some(item=>item.status==='削除・空欄化の可能性'));
});

test('choosing Sheets values only updates the provided staged data',()=>{
  const staged={entries:{'2026-10-27':{fit:'端末'}},progress:{actions:[]}};
  sync.applyRemoteField(staged,'work','2026-10-27',1,'Sheets');
  assert.equal(staged.entries['2026-10-27'].fit,'Sheets');
  const action={entries:{},progress:{actions:[]}};
  sync.applyRemoteField(action,'action','a-1',3,'Sheetsの行動');
  assert.equal(action.progress.actions[0].title,'Sheetsの行動');
});

test('commit stops before any write when Sheets changed after preview',async()=>{
  const originalFetch=globalThis.fetch;
  const observedWork=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'プレビュー時'})];
  const changedWork=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'確認後に変更'})];
  let writes=0;
  globalThis.fetch=async url=>{
    const target=decodeURIComponent(String(url));
    if(target.includes('values:batchUpdate')||target.includes(':append'))writes++;
    if(target.includes('ワーク記録'))return Response.json({values:changedWork});
    if(target.includes('アクション一覧'))return Response.json({values:[sync.actionHeaders]});
    throw new Error('Unexpected mocked URL: '+url);
  };
  try{
    await assert.rejects(sync.commit({
      sheetId:'a'.repeat(24),token:'mock-token',
      data:{entries:{'2026-10-27':{fit:'端末'}},progress:{actions:[]}},
      baseline:sync.baselineFromRows(observedWork,[sync.actionHeaders]),
      expectedRows:{workRows:observedWork,actionRows:[sync.actionHeaders]}
    }),/差分確認後にGoogle Sheetsの内容が変わりました/);
    assert.equal(writes,0);
  }finally{globalThis.fetch=originalFetch;}
});

test('commit reports a save failure and the already confirmed partial count',async()=>{
  const originalFetch=globalThis.fetch;
  const workRows=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'前回'})];
  const actionRows=[sync.actionHeaders];
  let writes=0;
  globalThis.fetch=async (url,options={})=>{
    const target=decodeURIComponent(String(url));
    if(options.method==='POST'){
      writes++;
      return Response.json({error:{message:'mock failure'}},{status:503});
    }
    if(target.includes('ワーク記録'))return Response.json({values:workRows});
    if(target.includes('アクション一覧'))return Response.json({values:actionRows});
    throw new Error('Unexpected mocked URL: '+url);
  };
  try{
    await assert.rejects(sync.commit({
      sheetId:'b'.repeat(24),token:'mock-token',
      data:{entries:{'2026-10-27':{fit:'今回'}},progress:{actions:[]}},
      baseline:sync.baselineFromRows(workRows,actionRows)
    }),/ワーク記録の更新中に失敗しました/);
    assert.equal(writes,1);
  }finally{globalThis.fetch=originalFetch;}
});
