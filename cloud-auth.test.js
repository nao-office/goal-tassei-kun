const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

globalThis.window=globalThis;
require('./cloud-auth.js');
const auth=globalThis.GoalCloudAuth;
const keys={
  sessionKey:'cloud-session',
  autoSyncKey:'auto-sync',
  autoEnableAfterReviewKey:'auto-enable-after-review'
};

function storageFixture(){
  const values=new Map([
    ['cloud-session','expired-session'],
    ['auto-sync','1'],
    ['auto-enable-after-review','1'],
    ['app-data','saved-device-records'],
    ['sync-config',JSON.stringify({sheetId:'private-sheet-id'})],
    ['sheets-data','existing-sheet-records']
  ]);
  return {
    values,
    getItem:key=>values.get(key)??null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key)
  };
}

test('401 gives a clear re-login instruction without exposing response secrets',()=>{
  const message=auth.errorMessage(401);
  assert.match(message,/Googleに再ログイン/);
  assert.match(message,/端末とSheetsの記録は変更していません/);
  assert.doesNotMatch(message,/access_token|refresh_token|Bearer|secret/i);
});

test('Google connection screen includes the re-login action and explicit read-only next step',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.match(html,/Googleに再ログイン/);
  assert.match(html,/まず差分を確認できます/);
  assert.match(html,/relogin-google/);
});

test('clearing an expired session disables auto sync and preserves records and sheet settings',()=>{
  const storage=storageFixture();
  const before={
    data:storage.getItem('app-data'),
    config:storage.getItem('sync-config'),
    sheets:storage.getItem('sheets-data')
  };
  auth.clearSession(storage,keys);
  assert.equal(storage.getItem('cloud-session'),null);
  assert.equal(storage.getItem('auto-sync'),'0');
  assert.equal(storage.getItem('auto-enable-after-review'),null);
  assert.deepEqual({
    data:storage.getItem('app-data'),
    config:storage.getItem('sync-config'),
    sheets:storage.getItem('sheets-data')
  },before);
});

test('successful re-login stores only the new session and keeps sync off without changing records',()=>{
  const storage=storageFixture();
  const before={
    data:storage.getItem('app-data'),
    config:storage.getItem('sync-config'),
    sheets:storage.getItem('sheets-data')
  };
  auth.saveSession(storage,keys,'new-session');
  assert.equal(storage.getItem('cloud-session'),'new-session');
  assert.equal(storage.getItem('auto-sync'),'0');
  assert.equal(storage.getItem('auto-enable-after-review'),null);
  assert.deepEqual({
    data:storage.getItem('app-data'),
    config:storage.getItem('sync-config'),
    sheets:storage.getItem('sheets-data')
  },before);
});

test('after re-login the review callback runs using a mock read request only',async()=>{
  const storage=storageFixture();
  const before={
    data:storage.getItem('app-data'),
    config:storage.getItem('sync-config'),
    sheets:storage.getItem('sheets-data')
  };
  auth.saveSession(storage,keys,'new-session');
  const requests=[];
  let reviewToken='';
  const token=await auth.requestAccessToken(async(url,options)=>{
    requests.push({url,method:options.method||'GET'});
    assert.ok(options.headers.Authorization);
    return Response.json({access_token:'mock-access-token',expires_in:3600});
  },'https://worker.example','new-session');
  reviewToken=token;
  assert.equal(token,'mock-access-token');
  assert.equal(reviewToken,'mock-access-token');
  assert.deepEqual(requests,[{url:'https://worker.example/auth/token',method:'GET'}]);
  assert.equal(storage.getItem('auto-sync'),'0');
  assert.deepEqual({
    data:storage.getItem('app-data'),
    config:storage.getItem('sync-config'),
    sheets:storage.getItem('sheets-data')
  },before);
});

test('an expired session request returns a safe 401 error for the relogin flow',async()=>{
  await assert.rejects(
    auth.requestAccessToken(async()=>new Response(JSON.stringify({error:'private-token-details'}),{status:401}),
      'https://worker.example','expired-session'),
    error=>{
      assert.equal(error.status,401);
      assert.match(error.message,/Googleに再ログイン/);
      assert.doesNotMatch(error.message,/private-token-details|access_token|refresh_token/i);
      return true;
    }
  );
});
