const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
globalThis.window=globalThis;
require('./sheets-writeback.js');
require('./keep-both-sync.js');
const W=GoalWriteback,K=GoalKeepBoth;
const DATE='2026-11-01',ID='synthetic-test-sheet-00000001';
const copy=value=>JSON.parse(JSON.stringify(value));
const row=(headers,values={})=>headers.map((_,index)=>String(values[index]??''));
const rows=(work={},actions=[])=>({workRows:[W.workHeaders,...Object.entries(work).map(([id,values])=>row(W.workHeaders,{0:id,...values}))],actionRows:[W.actionHeaders,...actions.map(values=>row(W.actionHeaders,values))]});
const data=(work={},actions=[],extra={})=>({entries:work,progress:{actions,sheetActions:[]},...extra});
const baseline=value=>W.baselineFromRows(value.workRows,value.actionRows);

function server(initial,options={}){
  const state={...copy(initial),archiveRows:copy(options.archiveRows||[]),tabExists:options.tabExists??Boolean(options.archiveRows),events:[]};
  const response=value=>Response.json(copy(value));
  state.fetch=async(url,request={})=>{
    const method=request.method||'GET',decoded=decodeURIComponent(String(url)),body=request.body?JSON.parse(request.body):null;
    let type;
    if(method==='GET'&&!decoded.includes('/values/'))type='metadata';
    else if(decoded.endsWith(':batchUpdate')&&!decoded.includes('/values:'))type='create';
    else if(decoded.includes('/values:batchUpdate'))type='mainUpdate';
    else if(decoded.includes(K.tabName))type=method==='GET'?'archiveRead':method==='PUT'?'archiveHeader':'archiveAppend';
    else type=method==='GET'?'mainRead':'mainAppend';
    const event={type,method,url:decoded,body};state.events.push(event);
    const before=await options.before?.(event,state);
    if(before)return before;
    let output={};
    if(type==='metadata')output={sheets:[
      {properties:{sheetId:1,title:'ワーク記録',gridProperties:{rowCount:options.workGridRows||1002,columnCount:24}}},
      {properties:{sheetId:2,title:'アクション一覧',gridProperties:{rowCount:options.actionGridRows||1200,columnCount:18}}},
      ...(state.tabExists?[{properties:{sheetId:12,title:K.tabName,gridProperties:{rowCount:1000,columnCount:10}}}]:[])
    ]};
    else if(type==='create'){
      assert.equal(body.requests[0].addSheet.properties.title,K.tabName);state.tabExists=true;
    }else if(type==='archiveRead'){
      assert.equal(state.tabExists,true);output={values:state.archiveRows};
    }else if(type==='archiveHeader')state.archiveRows=copy(body.values);
    else if(type==='archiveAppend')state.archiveRows.push(...copy(body.values));
    else if(type==='mainRead')output={values:decoded.includes('ワーク記録')?state.workRows:state.actionRows};
    else if(type==='mainAppend'){
      const target=decoded.includes('ワーク記録')?state.workRows:state.actionRows;
      target.push(...copy(body.values));
    }else if(type==='mainUpdate'){
      for(const patch of body.data){
        const match=patch.range.match(/^'([^']+)'!([A-Z])(\d+)$/);assert.ok(match);
        const target=match[1]==='ワーク記録'?state.workRows:state.actionRows;
        target[Number(match[3])-1][match[2].charCodeAt(0)-65]=patch.values[0][0];
      }
    }else throw Error('Unexpected mocked request '+decoded);
    const after=await options.after?.(event,state);
    return after||response(output);
  };
  return state;
}
async function using(state,fn){
  const original=globalThis.fetch;globalThis.fetch=state.fetch;
  try{return await fn();}finally{globalThis.fetch=original;}
}
const commit=(value,base,expectedRows)=>K.commit({sheetId:ID,token:'synthetic-token',data:value,baseline:base,expectedRows});

test('three-way plan merges independent fields and resolves true conflicts to Sheets',()=>{
  const base=rows({[DATE]:{1:'original',2:'old normal',3:'old future'}});
  const remote=rows({[DATE]:{1:'remote conflict',2:'old normal',3:'remote future'}});
  const local=data({[DATE]:{fit:'local conflict',normal:'local normal',futureAction:'old future',linkedActionId:'private link',lessonNotes:{lesson:{reflection:'device note'}}}});
  const before=copy(local),planned=K.plan(local,baseline(base),remote);
  assert.equal(planned.data.entries[DATE].fit,'remote conflict');
  assert.equal(planned.data.entries[DATE].normal,'local normal');
  assert.equal(planned.data.entries[DATE].futureAction,'remote future');
  assert.equal(planned.summary.conflictRecords,1);
  assert.equal(planned.archives.length,2);
  assert.equal(planned.archives[0].payload.values.fit,'local conflict');
  assert.equal(planned.archives[1].payload.values.fit,'remote conflict');
  assert.equal(planned.data.entries[DATE].linkedActionId,'private link');
  assert.deepEqual(local,before);
  assert.equal(JSON.stringify(planned.archives).includes('private link'),false);
  assert.equal(JSON.stringify(planned.archives).includes('device note'),false);
});

test('safe outgoing edits and incoming replacements preserve original synchronized snapshots',()=>{
  const original=rows({[DATE]:{1:'before'}}),base=baseline(original);
  const outgoing=K.plan(data({[DATE]:{fit:'local edit'}}),base,original);
  assert.equal(outgoing.summary.conflictRecords,0);
  assert.equal(outgoing.archives.length,2);
  const incoming=K.plan(data({[DATE]:{fit:'before'}}),base,rows({[DATE]:{1:'remote edit'}}));
  assert.equal(incoming.data.entries[DATE].fit,'remote edit');
  assert.equal(incoming.archives.length,2);
});

test('clearing archives both copies, and deleted remote rows retain local contents',()=>{
  const original=rows({[DATE]:{1:'before',7:'TRUE'}}),base=baseline(original);
  const cleared=K.plan(data({[DATE]:{fit:'',minimumDone:false}}),base,original);
  assert.equal(cleared.data.entries[DATE].fit,'');
  assert.equal(cleared.summary.clearingRecords,1);
  assert.equal(cleared.archives.length,2);
  const deleted=K.plan(data({[DATE]:{fit:'before',minimumDone:true}}),base,rows());
  assert.equal(deleted.data.entries[DATE].fit,'before');
  assert.equal(deleted.summary.deletedRowsKept,1);
  assert.equal(deleted.archives[1].payload.values,null);
});

test('new remote records import automatically, missing local records do not delete them',()=>{
  const remote=rows({[DATE]:{1:'remote only',7:'TRUE'}},[{0:'remote-action',3:'Read a test chapter'}]);
  const planned=K.plan(data(),baseline(remote),remote);
  assert.equal(planned.data.entries[DATE].fit,'remote only');
  assert.equal(planned.data.entries[DATE].minimumDone,true);
  assert.equal(planned.data.progress.actions[0].title,'Read a test chapter');
  assert.equal(planned.archives.length,0);
});

test('legacy actions participate with primary local actions taking precedence',()=>{
  const local=data({},[{id:'a',title:'local primary',fact:'device fact'}]);
  local.progress.sheetActions=[{id:'a',title:'legacy old',gap:'legacy extra'},{id:'b',title:'legacy only',gap:'device gap'}];
  const planned=K.plan(local,null,rows());
  assert.equal(planned.candidate.progress.actions.find(action=>action.id==='a').title,'local primary');
  assert.equal(planned.candidate.progress.actions.find(action=>action.id==='b').title,'legacy only');
  assert.equal(planned.data.progress.actions.length,1);
  assert.equal(planned.data.progress.sheetActions[0].gap,'legacy extra');
  assert.equal(JSON.stringify(planned.archives).includes('device fact'),false);
  assert.equal(JSON.stringify(planned.archives).includes('device gap'),false);
});

test('empty default daily rows neither append nor archive, and matching rows are no-ops',async()=>{
  const initial=rows(),state=server(initial);
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'',minimumDone:false,valuableDone:false,reviewed:false,lessonNotes:{}}}),baseline(initial));
    assert.equal(result.count,0);assert.equal(result.archiveCount,0);
    assert.equal(state.workRows.length,1);
    assert.ok(state.events.every(event=>['mainRead','metadata'].includes(event.type)));
  });
  const matched=rows({[DATE]:{1:'same'}});
  assert.equal(K.plan(data({[DATE]:{fit:'same'}}),baseline(matched),matched).archives.length,0);
});

test('reconcile preserves newer edits, device-only fields, legacy records and input immutability',()=>{
  const snapshot=data({[DATE]:{fit:'old',normal:'old normal',lessonId:'lesson',lessonReflection:'old reflection',lessonNotes:{lesson:{reflection:'private nested'}},linkedActionId:'local-link'}},[{id:'a',title:'old action',note:'old note',fact:'private fact'}]);
  snapshot.progress.sheetActions=[{id:'legacy',title:'old legacy',gap:'private gap'}];
  snapshot.progress.reviews=[{id:'review',note:'private review'}];
  const current=copy(snapshot);current.entries[DATE].fit='newer typing';current.entries[DATE].lessonNotes.lesson.reflection='newer nested';
  current.progress.actions[0].title='newer action';
  current.entries['2026-11-02']={fit:'new local day',deviceField:'keep'};
  const remote=rows({[DATE]:{1:'remote fit',2:'remote normal',18:'lesson',20:'remote reflection'}},[{0:'a',3:'remote action',11:'remote note'},{0:'legacy',3:'remote legacy'},{0:'new',3:'new remote'}]);
  const before=copy(current),result=K.reconcile(current,snapshot,remote);
  assert.equal(result.entries[DATE].fit,'newer typing');
  assert.equal(result.entries[DATE].normal,'remote normal');
  assert.equal(result.entries[DATE].lessonReflection,'remote reflection');
  assert.equal(result.entries[DATE].lessonNotes.lesson.reflection,'newer nested');
  assert.equal(result.entries[DATE].linkedActionId,'local-link');
  assert.deepEqual(result.entries['2026-11-02'],current.entries['2026-11-02']);
  assert.equal(result.progress.actions[0].title,'newer action');
  assert.equal(result.progress.actions[0].note,'remote note');
  assert.equal(result.progress.actions[0].fact,'private fact');
  assert.equal(result.progress.sheetActions[0].title,'remote legacy');
  assert.equal(result.progress.sheetActions[0].gap,'private gap');
  assert.deepEqual(result.progress.reviews,snapshot.progress.reviews);
  assert.equal(result.progress.actions.find(item=>item.id==='new').title,'new remote');
  assert.deepEqual(current,before);
});

test('reconcile does not resurrect a record removed during the request or erase newly created fields',()=>{
  const snapshot=data({[DATE]:{fit:'old'}},[{id:'removed',title:'old'}]);
  const current=data({'2026-11-02':{fit:'new local',minimumDone:false}});
  const result=K.reconcile(current,snapshot,rows({[DATE]:{1:'remote'},'2026-11-02':{1:'remote new',7:'TRUE'}},[{0:'removed',3:'remote removed'}]));
  assert.equal(result.entries[DATE],undefined);
  assert.equal(result.entries['2026-11-02'].fit,'new local');
  assert.equal(result.entries['2026-11-02'].minimumDone,false);
  assert.equal(result.progress.actions.length,0);
});

test('commit creates the separate tab on demand, verifies both versions, and never duplicates a daily row',async()=>{
  const original=rows({[DATE]:{1:'base',2:'base normal'}}),live=rows({[DATE]:{1:'remote',2:'base normal'}}),state=server(live);
  const local=data({[DATE]:{fit:'local',normal:'local normal',goalSnapshot:'private goal',lessonNotes:{x:{reflection:'private note'}}}});
  await using(state,async()=>{
    const result=await commit(local,baseline(original),live);
    assert.equal(result.archiveCount,2);assert.equal(result.archiveVerifiedCount,2);
    assert.equal(result.count,1);
    assert.equal(state.workRows.length,2);
    assert.equal(state.workRows[1][1],'remote');assert.equal(state.workRows[1][2],'local normal');
    const archive=await K.loadArchive(ID,'synthetic-token');
    assert.equal(archive.versions.length,2);assert.equal(archive.partialVersions.length,0);
    assert.deepEqual(new Set(archive.versions.map(version=>version.values.fit)),new Set(['local','remote']));
    assert.equal(JSON.stringify(state.archiveRows).includes('private goal'),false);
    assert.equal(JSON.stringify(state.archiveRows).includes('private note'),false);
    const appendAt=state.events.findIndex(event=>event.type==='archiveAppend');
    const verifiedAt=state.events.findIndex((event,index)=>index>appendAt&&event.type==='archiveRead');
    assert.ok(state.events.findIndex(event=>event.type==='mainUpdate')>verifiedAt);
    for(const version of archive.versions){
      assert.equal(version.versionId,'sha256:'+createHash('sha256').update(JSON.stringify(version.payload)).digest('hex'));
    }
  });
});

test('retry deduplicates deterministic archive versions and no-op saves do not touch archive',async()=>{
  const original=rows({[DATE]:{1:'base'}}),live=rows({[DATE]:{1:'remote'}}),state=server(live),local=data({[DATE]:{fit:'local'}});
  await using(state,async()=>{
    const first=await commit(local,baseline(original));
    const physical=state.archiveRows.length;
    const second=await commit(local,baseline(original));
    assert.equal(second.archiveCount,0);assert.equal(second.archiveVerifiedCount,2);
    assert.equal(state.archiveRows.length,physical);
    const reconciled=K.reconcile(local,local,first),start=state.events.length;
    const third=await commit(reconciled,baseline(first));
    assert.equal(third.archiveCount,0);assert.equal(third.count,0);
    assert.ok(state.events.slice(start).every(event=>['mainRead','metadata'].includes(event.type)));
  });
});

test('a deleted remote row is recreated once, with both local and absence snapshots preserved',async()=>{
  const base=baseline(rows({[DATE]:{1:'preserve me'}})),state=server(rows()),local=data({[DATE]:{fit:'preserve me'}});
  await using(state,async()=>{
    const first=await commit(local,base);assert.equal(first.archiveCount,2);
    assert.equal(state.workRows.length,2);assert.equal(state.workRows[1][1],'preserve me');
    const archive=await K.loadArchive(ID,'synthetic-token');assert.ok(archive.versions.some(version=>version.values===null));
    await commit(local,base);assert.equal(state.workRows.length,2);
  });
});

test('stale expected rows are advisory and automatic sync plans from current rows',async()=>{
  const previous=rows({[DATE]:{1:'before'}}),state=server(rows({[DATE]:{1:'changed'}}));
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'local'}}),baseline(previous),previous);
    assert.equal(result.workRows[1][1],'changed');
    assert.equal(result.summary.refreshedRows,true);
    const archive=await K.loadArchive(ID,'synthetic-token');
    assert.deepEqual(new Set(archive.versions.map(version=>version.values.fit)),new Set(['local','changed']));
  });
});

test('archive failure never changes active rows and retry fills only missing versions',async()=>{
  let failed=false;
  const initial=rows({[DATE]:{1:'remote'}}),state=server(initial,{before(event,state){
    if(event.type==='archiveAppend'&&!failed){failed=true;state.archiveRows.push(copy(event.body.values[0]));return Response.json({error:{message:'synthetic interruption'}},{status:503});}
  }});
  await using(state,async()=>{
    const local=data({[DATE]:{fit:'local',normal:'new local'}});
    await assert.rejects(commit(local,null),/未完了/);
    assert.deepEqual(state.workRows,initial.workRows);
    assert.equal(state.events.filter(event=>event.type==='mainUpdate').length,0);
    const already=state.archiveRows[1][0];
    const retry=await commit(local,null);assert.equal(retry.archiveVerifiedCount,2);
    assert.equal(state.archiveRows.filter(row=>row[0]===already).length,1);
    assert.equal(state.workRows[1][2],'new local');
  });
});

test('unknown-outcome archive append is reread, verified, and not blindly repeated',async()=>{
  let interrupted=false;
  const state=server(rows({[DATE]:{1:'remote'}}),{after(event){if(event.type==='archiveAppend'&&!interrupted){interrupted=true;throw Error('synthetic lost response');}}});
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'local',normal:'new normal'}}),null);
    assert.equal(result.archiveCount,2);assert.equal(state.workRows[1][2],'new normal');
    assert.equal(state.events.filter(event=>event.type==='archiveAppend').length,1);
  });
});

test('lost main append response is verified without appending the date again',async()=>{
  let interrupted=false;
  const state=server(rows(),{after(event){if(event.type==='mainAppend'&&!interrupted){interrupted=true;throw Error('synthetic lost main response');}}});
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'new record'}}),null);
    assert.equal(result.count,1);assert.equal(state.workRows.length,2);
    assert.equal(state.events.filter(event=>event.type==='mainAppend').length,1);
  });
});

test('identical simultaneous duplicate chunks are deduplicated but conflicting same-ID chunks fail safely',async()=>{
  const state=server(rows({[DATE]:{1:'remote'}}),{after(event,state){if(event.type==='archiveAppend')state.archiveRows.push(...copy(event.body.values));}});
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'local',normal:'new'}}),null);
    assert.equal(result.archiveCount,2);
    const archive=await K.loadArchive(ID,'synthetic-token');assert.equal(archive.versions.length,2);
    const altered=copy(state.archiveRows[1]);altered[8]+='x';state.archiveRows.push(altered);
    const writes=state.events.filter(event=>event.type==='mainUpdate').length;
    await assert.rejects(commit(data({[DATE]:{fit:'different',normal:'newer'}}),null),/内容が一致/);
    assert.equal(state.events.filter(event=>event.type==='mainUpdate').length,writes);
  });
});

test('large snapshots split below the cell limit, retain surrogate pairs and pass complete SHA verification',async()=>{
  const long='架空😀'.repeat(900),state=server(rows({[DATE]:{1:'remote'}}));
  const record=Object.fromEntries(Object.entries(W.workFields).map(([index,key])=>[key,[7,8,12,22].includes(Number(index))?false:long]));
  await using(state,async()=>{
    await commit(data({[DATE]:record}),null);
    assert.ok(state.archiveRows.slice(1).every(row=>row[8].length<=30000));
    assert.ok(state.archiveRows.slice(1).every(row=>!/[\uD800-\uDBFF]$/.test(row[8])));
    const archive=await K.loadArchive(ID,'synthetic-token');
    assert.equal(archive.versions.find(version=>version.values?.fit===long).values.fit,long);
    assert.ok(state.archiveRows.slice(1).some(row=>Number(row[6])>1));
  });
});

test('partial multi-chunk snapshots are not reported saved and retry appends only missing chunks',async()=>{
  const long='synthetic text '.repeat(250);let fail=true;
  const record=Object.fromEntries(Object.entries(W.workFields).map(([index,key])=>[key,[7,8,12,22].includes(Number(index))?false:long]));
  const state=server(rows({[DATE]:{1:'remote'}}),{before(event,state){
    if(event.type==='archiveAppend'&&fail){fail=false;state.archiveRows.push(copy(event.body.values[0]));throw Error('synthetic partial append');}
  }});
  await using(state,async()=>{
    await assert.rejects(commit(data({[DATE]:record}),null),/未完了/);
    const archive=await K.loadArchive(ID,'synthetic-token');
    assert.equal(archive.versions.length,0);assert.equal(archive.partialVersions.length,1);
    const first=copy(state.archiveRows[1]);
    await commit(data({[DATE]:record}),null);
    assert.equal(state.archiveRows.filter(row=>row[0]===first[0]&&row[5]===first[5]).length,1);
    assert.equal((await K.loadArchive(ID,'synthetic-token')).versions.length,2);
  });
});

test('corrupt SHA and incompatible archive header block overwrites',async()=>{
  const state=server(rows({[DATE]:{1:'remote'}}));
  await using(state,async()=>{
    await commit(data({[DATE]:{fit:'local'}}),null);
    state.archiveRows[1][8]=state.archiveRows[1][8].replace('local','alter');
    await assert.rejects(commit(data({[DATE]:{fit:'local two',normal:'do not write'}}),null),/SHA-256/);
    assert.equal(state.workRows[1][2],'');
    state.archiveRows[0][0]='unexpected header';
    await assert.rejects(K.loadArchive(ID,'synthetic-token'),/列見出し/);
  });
});

test('oversized snapshots stop before creating a tab or writing active rows',async()=>{
  const state=server(rows({[DATE]:{1:'remote'}}));
  await using(state,async()=>{
    await assert.rejects(commit(data({[DATE]:{fit:'x'.repeat(K.limits.snapshotChars+1)}}),null),/容量|文字数/);
    assert.equal(state.tabExists,false);assert.ok(state.events.every(event=>event.method==='GET'));
  });
});

test('loadArchive is read-only and never creates a missing tab',async()=>{
  const state=server(rows());
  await using(state,async()=>{
    assert.deepEqual(await K.loadArchive(ID,'synthetic-token'),{versions:[],partialVersions:[],tabExists:false});
    assert.deepEqual(state.events.map(event=>event.type),['metadata']);
  });
});

test('a failed active write remains an error despite successfully preserved archives',async()=>{
  const state=server(rows({[DATE]:{1:'remote'}}),{before(event){if(event.type==='mainUpdate')return Response.json({error:{message:'synthetic permission denied'}},{status:403});}});
  await using(state,async()=>{
    await assert.rejects(commit(data({[DATE]:{fit:'local',normal:'not written'}}),null),/403/);
    assert.equal(state.workRows[1][2],'');
    assert.equal((await K.loadArchive(ID,'synthetic-token')).versions.length,2);
  });
});

test('one remote change after archive verification is reread, rearchived and retried safely',async()=>{
  let changed=false;
  const initial=rows({[DATE]:{1:'remote'}}),state=server(initial,{after(event,state){
    if(event.type==='archiveRead'&&state.archiveRows.length>1&&!changed){changed=true;state.workRows[1][1]='new remote change';}
  }});
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'local',normal:'local normal'}}),null);
    assert.equal(state.workRows[1][1],'new remote change');assert.equal(state.workRows[1][2],'local normal');
    assert.equal(state.events.filter(event=>event.type==='mainUpdate').length,1);
    assert.equal((await K.loadArchive(ID,'synthetic-token')).versions.length,3);
    assert.equal(result.archiveCount,3);
  });
});

test('same-page concurrent commits serialize and do not append the same date twice',async()=>{
  const state=server(rows());
  await using(state,async()=>{
    const local=data({[DATE]:{fit:'same new record'}});
    await Promise.all([commit(local,null),commit(local,null)]);
    assert.equal(state.workRows.length,2);
    assert.equal(state.events.filter(event=>event.type==='mainAppend').length,1);
    assert.equal((await K.loadArchive(ID,'synthetic-token')).versions.length,2);
  });
});

test('remote text and action identifiers exceeding reload limits stop before any active write',async()=>{
  for(const initial of [rows({[DATE]:{1:'x'.repeat(4001)}}),rows({},[{0:'a'.repeat(181),3:'remote'}]),rows({},[{0:'a',1:'g'.repeat(181)}]),rows({},[{0:'a',3:'x'.repeat(4001)}])]){
    const state=server(initial);
    await using(state,async()=>{
      await assert.rejects(commit(data(),null),/文字数上限/);
      assert.ok(state.events.every(event=>event.method==='GET'));
      assert.equal(state.tabExists,false);
    });
  }
});

test('remote import exceeding action and work record capacity preserves every local record',()=>{
  const local=data({},Array.from({length:1000},(_,index)=>({id:'local-'+index,title:'synthetic action'})));
  assert.throws(()=>K.plan(local,null,rows({},[{0:'remote-extra',3:'remote'}])),/保存件数/);
  assert.equal(local.progress.actions.length,1000);
  const work=Object.fromEntries(Array.from({length:5000},(_,index)=>{
    const date=new Date(Date.UTC(2000,0,1+index)).toISOString().slice(0,10);return [date,{fit:'synthetic work'}];
  }));
  assert.throws(()=>K.plan(data(work),null,rows({[DATE]:{1:'new remote'}})),/5,000/);
  assert.equal(Object.keys(work).length,5000);
});

test('legacy action capacity stays separate from primary action capacity',()=>{
  const local=data({},Array.from({length:1000},(_,index)=>({id:'local-'+index,title:'local'})));
  local.progress.sheetActions=Array.from({length:1300},(_,index)=>({id:'legacy-'+index,title:'legacy'}));
  const planned=K.plan(local,null,rows());
  assert.equal(planned.data.progress.actions.length,1000);
  assert.equal(planned.data.progress.sheetActions.length,1300);
  assert.equal(planned.candidate.progress.actions.length,2300);
});

test('reconcile capacity check protects late-arriving local records from reload truncation',()=>{
  const snapshot=data({},Array.from({length:999},(_,index)=>({id:'local-'+index,title:'local'})));
  const current=copy(snapshot);current.progress.actions.push({id:'new-local',title:'typed while waiting'});
  const before=copy(current);
  assert.throws(()=>K.reconcile(current,snapshot,rows({},[{0:'remote-new',3:'new remote'}])),/保存件数/);
  assert.deepEqual(current,before);
});

test('invalid calendar dates stop import without changing the original Sheets',async()=>{
  for(const id of ['2026-99-99','2026-02-29','2026-04-31','not-a-date']){
    const initial=rows({[id]:{1:'synthetic record'}}),state=server(initial);
    await using(state,async()=>{
      await assert.rejects(commit(data(),null),/日付が不正/);
      assert.deepEqual(state.workRows,initial.workRows);
      assert.ok(state.events.every(event=>event.method==='GET'));
    });
  }
  assert.equal(K.plan(data(),null,rows({'2024-02-29':{1:'valid leap day'}})).data.entries['2024-02-29'].fit,'valid leap day');
});

test('archive total row and character limits fail safely before active writes',async()=>{
  const original=rows({[DATE]:{1:'remote'}}),state=server(original);
  await using(state,async()=>{
    await commit(data({[DATE]:{fit:'local'}}),null);
    const single=copy(state.archiveRows[1]);
    state.archiveRows=[K.headers,...Array.from({length:K.limits.rows},()=>copy(single))];
    await assert.rejects(commit(data({[DATE]:{fit:'changed local',normal:'not written'}}),null),/保存容量/);
    assert.equal(state.workRows[1][2],'');
    const longLocal=Object.fromEntries(Object.entries(W.workFields).map(([index,key])=>[key,[7,8,12,22].includes(Number(index))?false:'z'.repeat(3900)]));
    state.archiveRows=[];
    await commit(data({[DATE]:longLocal}),null);
    const chunk=copy(state.archiveRows.find(row=>row[8]?.length>29000));
    assert.ok(chunk);
    state.archiveRows=[K.headers,...Array.from({length:Math.ceil(K.limits.totalChars/chunk[8].length)+1},()=>copy(chunk))];
    await assert.rejects(commit(data({[DATE]:{fit:'another',normal:'not written'}}),null),/総容量/);
  });
});

test('unexpected remote changes in final reread are preserved before local reconciliation',async()=>{
  let changed=false;
  const original=rows({[DATE]:{1:'base',2:'base normal'}}),state=server(original,{after(event,state){
    if(event.type==='mainUpdate'&&!changed){changed=true;state.workRows[1][1]='remote arrived during write';}
  }});
  await using(state,async()=>{
    const local=data({[DATE]:{fit:'base',normal:'local normal'}});
    const result=await commit(local,baseline(original));
    assert.equal(result.workRows[1][1],'remote arrived during write');
    const archive=await K.loadArchive(ID,'synthetic-token');
    assert.ok(archive.versions.some(version=>version.values?.fit==='remote arrived during write'));
    assert.ok(archive.versions.some(version=>version.values?.fit==='base'));
    const reconciled=K.reconcile(local,local,result);
    assert.equal(reconciled.entries[DATE].fit,'remote arrived during write');
  });
});

test('load rejects grids with unseen work/action tail rows before treating an ID as absent',async()=>{
  for(const options of [{workGridRows:5002},{actionGridRows:1201}]){
    const state=server(rows(),options);
    await using(state,async()=>{
      const local=data({[DATE]:{fit:'an ID could already exist beyond the read window'}},[{id:'existing-in-unseen-tail',title:'must not append'}]);
      await assert.rejects(K.load(ID,'synthetic-token'),/読み取り上限/);
      await assert.rejects(commit(local,null),/読み取り上限/);
      assert.ok(state.events.every(event=>event.type==='metadata'));
      assert.equal(state.tabExists,false);
      assert.equal(state.workRows.length,1);assert.equal(state.actionRows.length,1);
    });
  }
});

test('the largest fully covered grid is allowed and missing grid metadata fails safely',async()=>{
  const state=server(rows(),{workGridRows:5001,actionGridRows:1200});
  await using(state,async()=>assert.deepEqual(await K.load(ID,'synthetic-token'),rows()));
  const missing=server(rows(),{before(event){if(event.type==='metadata')return Response.json({sheets:[{properties:{title:'ワーク記録'}}]});}});
  await using(missing,async()=>{
    await assert.rejects(commit(data({[DATE]:{fit:'do not write'}}),null),/読み取り範囲/);
    assert.ok(missing.events.every(event=>event.method==='GET'));
  });
});

test('continued remote churn stops after two attempts with REMOTE_CHANGED for automatic backoff',async()=>{
  let changes=0;
  const state=server(rows({[DATE]:{1:'remote'}}),{after(event,state){
    if(event.type==='archiveRead'&&state.archiveRows.length>1)state.workRows[1][1]='remote change '+(++changes);
  }});
  await using(state,async()=>{
    let failure;
    try{await commit(data({[DATE]:{fit:'local',normal:'must remain pending'}}),null);}catch(error){failure=error;}
    assert.equal(failure?.code,'REMOTE_CHANGED');
    assert.ok(failure.archiveVerifiedCount>=2);
    assert.ok(failure.archiveCount>=2);
    assert.match(failure.message,/少し待って/);
    assert.equal(state.events.filter(event=>event.type==='mainUpdate').length,0);
    assert.equal(state.events.filter(event=>event.type==='archiveAppend').length,2);
    assert.equal(state.workRows[1][2],'');
  });
});

test('lost tab-creation and header-save responses are reread without duplicate creation or data loss',async()=>{
  const failed=new Set();
  const state=server(rows({[DATE]:{1:'remote'}}),{after(event){
    if(['create','archiveHeader'].includes(event.type)&&!failed.has(event.type)){
      failed.add(event.type);throw Error('synthetic lost setup response');
    }
  }});
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'local',normal:'safe new value'}}),null);
    assert.equal(result.archiveCount,2);
    assert.equal(state.events.filter(event=>event.type==='create').length,1);
    assert.equal(state.events.filter(event=>event.type==='archiveHeader').length,1);
    assert.equal(state.workRows[1][2],'safe new value');
  });
});

test('new appends cannot push active IDs beyond the complete read window',async()=>{
  const initial=rows({},Array.from({length:1199},(_,index)=>({0:'existing-'+index,3:'synthetic existing'})));
  const local=data({},[{id:'new-action',title:'keep local'}]);
  local.progress.sheetActions=initial.actionRows.slice(1).map(row=>({id:row[0],title:row[3]}));
  const state=server(initial);
  await using(state,async()=>{
    await assert.rejects(commit(local,baseline(initial)),/追加行.*読み取り上限/);
    assert.ok(state.events.every(event=>event.method==='GET'));
    assert.equal(state.actionRows.length,1200);
  });
});

test('even whitespace-only outgoing cells receive an archive before GoalWriteback sends them',async()=>{
  const state=server(rows());
  await using(state,async()=>{
    const result=await commit(data({[DATE]:{fit:'   '}}),null);
    assert.equal(result.archiveCount,2);
    assert.equal(state.workRows[1][1],'   ');
  });
});

test('a final archive failure honestly reports already-completed Sheets updates',async()=>{
  let mainWritten=false;
  const original=rows({[DATE]:{1:'base',2:'old normal'}}),state=server(original,{
    before(event){if(mainWritten&&event.type==='archiveAppend')return Response.json({error:{message:'synthetic final archive failure'}},{status:503});},
    after(event,state){if(event.type==='mainUpdate'){mainWritten=true;state.workRows[1][1]='late remote fit';}}
  });
  await using(state,async()=>{
    const local=data({[DATE]:{fit:'base',normal:'new normal'}}),before=copy(local);
    await assert.rejects(commit(local,baseline(original)),/Sheetsの更新は反映されましたが.*端末の記録はまだ置き換えていません/);
    assert.equal(state.workRows[1][2],'new normal');
    assert.deepEqual(local,before);
  });
});

test('independent pages racing to append the same new date preserve both versions and stop on duplicates without deleting rows',{timeout:5000},async()=>{
  let arrivals=0,release;
  const bothAtAppend=new Promise(resolve=>{release=resolve;});
  const state=server(rows(),{async before(event){
    if(event.type==='mainAppend'){
      if(++arrivals===2)release();
      await bothAtAppend;
    }
  }});
  const sourceW=readFileSync(require.resolve('./sheets-writeback.js'),'utf8');
  const sourceK=readFileSync(require.resolve('./keep-both-sync.js'),'utf8');
  function independentPage(){
    const context={crypto:globalThis.crypto,TextEncoder,fetch:state.fetch};
    context.window=context;vm.createContext(context);
    vm.runInContext(sourceW,context);vm.runInContext(sourceK,context);
    return context.GoalKeepBoth;
  }
  const pc=independentPage(),mobile=independentPage();
  const localPC=data({[DATE]:{fit:'synthetic PC outgoing'}}),localMobile=data({[DATE]:{fit:'synthetic mobile outgoing'}});
  const beforePC=copy(localPC),beforeMobile=copy(localMobile);
  await using(state,async()=>{
    const results=await Promise.allSettled([
      pc.commit({sheetId:ID,token:'synthetic-token',data:localPC,baseline:null}),
      mobile.commit({sheetId:ID,token:'synthetic-token',data:localMobile,baseline:null})
    ]);
    for(const result of results){
      assert.equal(result.status,'rejected');
      assert.equal(result.reason.message,'シートに同じID／日付の行が複数あります：'+DATE);
      assert.equal(result.reason.code,undefined); // A real safety stop, not a retryable stale read.
    }
    assert.equal(state.workRows.length,3);
    assert.deepEqual(new Set(state.workRows.slice(1).map(row=>row[1])),new Set(['synthetic PC outgoing','synthetic mobile outgoing']));
    assert.ok(state.workRows.slice(1).every(row=>row[0]===DATE));
    const archive=await K.loadArchive(ID,'synthetic-token');
    assert.deepEqual(new Set(archive.versions.filter(version=>version.values).map(version=>version.values.fit)),new Set(['synthetic PC outgoing','synthetic mobile outgoing']));
    assert.ok(archive.versions.some(version=>version.values===null));
    assert.equal(state.events.filter(event=>event.type==='mainAppend').length,2);
    assert.equal(state.events.filter(event=>event.type==='mainUpdate'||event.method==='DELETE'||event.url.includes(':clear')).length,0);
    assert.deepEqual(localPC,beforePC);assert.deepEqual(localMobile,beforeMobile);
  });
});
