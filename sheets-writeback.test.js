const test=require('node:test');
const assert=require('node:assert/strict');

globalThis.window=globalThis;
require('./sheets-writeback.js');
const sync=globalThis.GoalWriteback;

test('read-only review scope is separate from scopes that can write',()=>{
  assert.equal(sync.readOnlyScope,'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.equal(sync.writeScope,'https://www.googleapis.com/auth/spreadsheets');
  assert.notEqual(sync.readOnlyScope,sync.writeScope);
});

test('clearing existing device values from null, undefined, or blank Sheets values requires explicit confirmation',()=>{
  const fields=[null,undefined,'','   '].map((remoteValue,index)=>({
    kind:'work',id:'2026-10-27',index:index+1,label:'大切な記録'+(index+1),
    localValue:'端末に残す値'+(index+1),remoteValue
  }));
  const choices=Object.fromEntries(fields.map(field=>[
    [field.kind,field.id,field.index].join('\u0001'),'sheets'
  ]));
  const changes=sync.destructiveChanges(fields,choices);
  assert.equal(changes.length,4);
  let prompt='';
  assert.equal(sync.confirmDestructiveChanges(changes,message=>{prompt=message;return true;}),true);
  assert.match(prompt,/端末に残す値1/);
  assert.match(prompt,/Google Sheetsの記録：未設定/);
  assert.match(prompt,/Google Sheetsの記録：空欄/);
  assert.match(prompt,/Google Sheetsの記録：空欄（空白文字のみ）/);
  assert.match(prompt,/消去される場所と値：端末/);
});

test('canceling deletion confirmation leaves device data and baseline untouched and performs no Sheets write',()=>{
  const fields=[{kind:'work',id:'2026-10-27',index:1,label:'理由',localValue:'端末の理由',remoteValue:null}];
  const choices={['work\u00012026-10-27\u00011']:'sheets'};
  const data={entries:{'2026-10-27':{fit:'端末の理由'}},progress:{actions:[]}};
  const baseline={version:1,work:{'2026-10-27':['2026-10-27','以前の理由']},actions:{}};
  const beforeData=JSON.stringify(data),beforeBaseline=JSON.stringify(baseline);
  let writes=0;
  const confirmed=sync.confirmDestructiveChanges(sync.destructiveChanges(fields,choices),()=>false);
  if(confirmed)writes++;
  assert.equal(confirmed,false);
  assert.equal(writes,0);
  assert.equal(JSON.stringify(data),beforeData);
  assert.equal(JSON.stringify(baseline),beforeBaseline);
});

test('automatic sync remains stopped immediately after backup restore even when previously approved',()=>{
  assert.equal(sync.canAutoSync({enabled:true,approved:true,baseline:{version:1},restoreGuard:true,blocked:false}),false);
  assert.equal(sync.canAutoSync({enabled:true,approved:true,baseline:{version:1},restoreGuard:false,blocked:false}),true);
});

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

test('a Sheets-only action remains an import candidate, not a deletion risk, with an existing baseline',()=>{
  const actionRows=[sync.actionHeaders,row(sync.actionHeaders,{0:'a-1',3:'Sheets action'})];
  const workRows=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'Sheets work'})];
  const baseline=sync.baselineFromRows(workRows,actionRows);
  const groups=sync.preview({entries:{},progress:{actions:[]}},baseline,workRows,actionRows);
  for(const kind of ['work','action']){
    const fields=groups.filter(group=>group.kind===kind).flatMap(group=>group.values);
    assert.ok(fields.length>0);
    assert.ok(fields.every(field=>field.status==='Sheetsだけに存在'));
    assert.ok(fields.every(field=>field.status!=='削除・空欄化の可能性'));
  }
});

test('review counts distinguish changed records, equal records, and changed fields',()=>{
  const groups=[
    {values:[{},{}]},
    {values:[{}]},
    {values:[]}
  ];
  assert.deepEqual(sync.reviewCounts(groups),{
    comparedRecords:3,changedRecords:2,equalRecords:1,changedFields:3
  });
});

test('initial import adds Sheets records and preserves terminal-only data and matching local values',()=>{
  const workRows=[
    sync.workHeaders,
    row(sync.workHeaders,{0:'2026-10-27',1:'Sheets reason',2:'Sheets belief',7:'TRUE',18:'lesson-1',20:'Sheets lesson memo'}),
    row(sync.workHeaders,{0:'2026-10-28',1:'New day from Sheets',3:'New action'})
  ];
  const actionRows=[
    sync.actionHeaders,
    row(sync.actionHeaders,{0:'a-sheets',1:'g-1',3:'New action from Sheets'}),
    row(sync.actionHeaders,{0:'a-local',3:'Sheets title',10:'進行中'})
  ];
  const localAction={id:'a-local',title:'端末のタイトル',note:'端末だけのメモ'};
  const goal={id:'g-local',title:'端末だけのゴール'};
  const data={
    entries:{
      '2026-10-27':{fit:'端末の理由',normal:'',minimumDone:false,lessonId:'lesson-1',lessonNotes:{'lesson-1':{reflection:'端末の復習メモ',nextStep:'',reviewed:false}},goalSnapshot:'端末のゴール状態'},
      '2026-10-29':{fit:'端末だけの別日'}
    },
    goals:[goal],
    progress:{actions:[localAction],sheetActions:[],actionHistory:[{id:'history-1'}],reviews:[{id:'review-1'}]}
  };
  const before=JSON.stringify(data);
  const result=sync.importInitial(data,workRows,actionRows);
  assert.equal(JSON.stringify(data),before);
  assert.equal(result.summary.workRecordsAdded,1);
  assert.equal(result.summary.workRecordsUpdated,1);
  assert.equal(result.summary.actionRecordsAdded,1);
  assert.equal(result.summary.actionRecordsUpdated,1);
  assert.equal(result.summary.recordsImported,4);
  assert.equal(result.data.entries['2026-10-27'].fit,'端末の理由');
  assert.equal(result.data.entries['2026-10-27'].normal,'Sheets belief');
  assert.equal(result.data.entries['2026-10-27'].minimumDone,false);
  assert.equal(result.data.entries['2026-10-27'].lessonNotes['lesson-1'].reflection,'端末の復習メモ');
  assert.equal(result.data.entries['2026-10-27'].goalSnapshot,'端末のゴール状態');
  assert.equal(result.data.entries['2026-10-28'].fit,'New day from Sheets');
  assert.equal(result.data.entries['2026-10-29'].fit,'端末だけの別日');
  assert.deepEqual(result.data.goals[0],goal);
  assert.equal(result.data.progress.actions[0].title,'端末のタイトル');
  assert.equal(result.data.progress.actions[0].note,'端末だけのメモ');
  assert.equal(result.data.progress.sheetActions[0].title,'New action from Sheets');
  assert.deepEqual(result.data.progress.actionHistory[0],{id:'history-1'});
  assert.deepEqual(result.data.progress.reviews[0],{id:'review-1'});
  assert.ok(result.summary.localFieldsKept>=2);
});

test('initial import ignores empty Sheets cells and imports explicit false for a new work record',()=>{
  const workRows=[
    sync.workHeaders,
    row(sync.workHeaders,{0:'2026-10-27',1:'',7:'FALSE'}),
    row(sync.workHeaders,{0:'2026-10-28',1:'New record',7:'FALSE'})
  ];
  const result=sync.importInitial({entries:{},progress:{actions:[],sheetActions:[]}},workRows,[sync.actionHeaders]);
  assert.equal(result.data.entries['2026-10-27'].minimumDone,false);
  assert.equal(result.data.entries['2026-10-28'].fit,'New record');
  assert.equal(result.data.entries['2026-10-28'].minimumDone,false);
});

test('choosing Sheets values only updates the provided staged data',()=>{
  const staged={entries:{'2026-10-27':{fit:'端末'}},progress:{actions:[]}};
  sync.applyRemoteField(staged,'work','2026-10-27',1,'Sheets');
  assert.equal(staged.entries['2026-10-27'].fit,'Sheets');
  const action={entries:{},progress:{actions:[]}};
  sync.applyRemoteField(action,'action','a-1',3,'Sheetsの行動');
  assert.equal(action.progress.actions[0].title,'Sheetsの行動');
});

test('applying a reviewed work value retains other work, goals, actions, and history',()=>{
  const action={id:'a-1',title:'端末のアクション'};
  const history={id:'h-1',reason:'端末の履歴'};
  const goal={id:'g-1',title:'端末のゴール'};
  const goalHistory={id:'gh-1',title:'ゴール変更履歴'};
  const staged={entries:{'2026-10-27':{fit:'選択対象',achievement:'別のワーク記録'}},
    goals:[goal],goalHistory:[goalHistory],progress:{actions:[action],actionHistory:[history]}};
  sync.applyRemoteField(staged,'work','2026-10-27',1,'Sheetsから選んだ値');
  assert.equal(staged.entries['2026-10-27'].fit,'Sheetsから選んだ値');
  assert.equal(staged.entries['2026-10-27'].achievement,'別のワーク記録');
  assert.equal(staged.goals[0],goal);
  assert.equal(staged.goalHistory[0],goalHistory);
  assert.equal(staged.progress.actions[0],action);
  assert.equal(staged.progress.actionHistory[0],history);
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

test('commit stops without writing when both device and Sheets changed the same value',async()=>{
  const originalFetch=globalThis.fetch;
  const baselineWork=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'前回'})];
  const changedWork=[sync.workHeaders,row(sync.workHeaders,{0:'2026-10-27',1:'Sheets側の変更'})];
  let writes=0;
  globalThis.fetch=async (url,options={})=>{
    const target=decodeURIComponent(String(url));
    if(options.method==='POST'){writes++;return Response.json({updatedCells:1});}
    if(target.includes('ワーク記録'))return Response.json({values:changedWork});
    if(target.includes('アクション一覧'))return Response.json({values:[sync.actionHeaders]});
    throw Error('Unexpected mocked URL: '+url);
  };
  try{
    await assert.rejects(sync.commit({
      sheetId:'c'.repeat(24),token:'mock-token',
      data:{entries:{'2026-10-27':{fit:'端末側の変更'}},progress:{actions:[]}},
      baseline:sync.baselineFromRows(baselineWork,[sync.actionHeaders])
    }),/変更が重複しています/);
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
