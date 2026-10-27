const test=require('node:test');
const assert=require('node:assert/strict');

globalThis.window=globalThis;
require('./goal-progress.js');
const progress=globalThis.GoalProgress;

test('sheet imports add new IDs without replacing local action or review data',()=>{
  const localAction={id:'same',title:'端末で編集した内容',origin:'端末内'};
  const localOnly={id:'local-only',title:'端末専用のアクション'};
  const review={id:'review-1',week:'2026-10-26',facts:'端末専用レビュー'};
  const data={progress:Object.assign(progress.empty(),{
    actions:[localAction,localOnly],
    sheetActions:[{id:'cached',title:'以前の取込記録'}],
    reviews:[review],
    reviewHistory:[{id:'review-history',reason:'端末専用履歴'}]
  })};
  const headers=progress.remoteHeaders['アクション一覧'];
  const collision=Array(headers.length).fill('');
  collision[0]='same';collision[3]='Sheetsの別の内容';
  const addition=Array(headers.length).fill('');
  addition[0]='remote-new';addition[3]='Sheetsの新しいアクション';
  let saves=0;
  const imported=progress.importSheet('アクション一覧',[headers,collision,addition],data,()=>{saves++;return true;});

  assert.equal(imported,2);
  assert.equal(saves,1);
  assert.equal(data.progress.actions.find(item=>item.id==='same').title,'端末で編集した内容');
  assert.equal(data.progress.actions.find(item=>item.id==='local-only').title,'端末専用のアクション');
  assert.equal(data.progress.sheetActions.find(item=>item.id==='cached').title,'以前の取込記録');
  assert.equal(data.progress.sheetActions.find(item=>item.id==='same').title,'Sheetsの別の内容');
  assert.equal(progress.actionList(data).find(item=>item.id==='same').title,'端末で編集した内容');
  assert.equal(data.progress.sheetActions.find(item=>item.id==='remote-new').title,'Sheetsの新しいアクション');
  assert.equal(data.progress.reviews[0],review);
  assert.equal(data.progress.reviewHistory[0].id,'review-history');
});

test('action history import appends unseen history without dropping local history',()=>{
  const local={at:'2026-10-27T00:00:00Z',id:'a-1',reason:'local'};
  const data={progress:Object.assign(progress.empty(),{sheetHistory:[local]})};
  const headers=progress.remoteHeaders['アクション履歴'];
  const remote=Array(headers.length).fill('');
  remote[0]='2026-10-28T00:00:00Z';remote[2]='a-2';remote[20]='remote';
  progress.importSheet('アクション履歴',[headers,remote],data,()=>true);
  assert.equal(data.progress.sheetHistory.length,2);
  assert.ok(data.progress.sheetHistory.includes(local));
});
