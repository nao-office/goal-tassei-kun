import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import worker from './index.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const ORIGIN = 'https://nao-office.github.io';
const WORKER = 'https://goal-auth.example.workers.dev';
function fixture(email='owner@example.com') {
  const store = new Map();
  const kv = {
    get: async key => store.get(key) ?? null,
    put: async (key,value) => {store.set(key,value);},
    delete: async key => {store.delete(key);}
  };
  const env = {
    AUTH_KV: kv, GOOGLE_CLIENT_ID: 'example.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'fake-for-test-only',
    AUTH_ENCRYPTION_KEY: Buffer.alloc(32,7).toString('base64'),
    ALLOWED_EMAIL: 'owner@example.com',
    APP_ORIGIN: ORIGIN, APP_RETURN_URL: ORIGIN + '/goal-tassei-kun/'
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url,options={}) => {
    if (String(url).includes('/token')) {
      const grant = new URLSearchParams(options.body).get('grant_type');
      if (grant === 'authorization_code') return Response.json({
        access_token: 'initial-token', refresh_token: 'private-refresh-token', expires_in: 3600
      });
      if (grant === 'refresh_token') return Response.json({
        access_token: 'renewed-token', expires_in: 3600
      });
    }
    if (String(url).includes('/userinfo')) return Response.json({email, email_verified: true});
    throw Error('Unexpected upstream URL: ' + url);
  };
  return {env,store,cleanup:()=>{globalThis.fetch=originalFetch;}};
}
test('first login, single-use ticket, silent refresh and logout', async () => {
  const f=fixture();
  try {
    const start=await worker.fetch(new Request(WORKER+'/auth/start'),f.env);
    assert.equal(start.status,302);
    const auth=new URL(start.headers.get('Location'));
    assert.equal(auth.searchParams.get('access_type'),'offline');
    assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
    const state=auth.searchParams.get('state');
    const callback=await worker.fetch(new Request(WORKER+'/auth/callback?code=example&state='+state),f.env);
    assert.equal(callback.status,302);
    const app=new URL(callback.headers.get('Location'));
    assert.equal(app.origin,ORIGIN);
    const ticket=new URLSearchParams(app.hash.slice(1)).get('goal_auth_ticket');
    assert.ok(ticket);
    const finish=()=>worker.fetch(new Request(WORKER+'/auth/finish',{
      method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},
      body:JSON.stringify({ticket})
    }),f.env);
    const first=await finish();
    assert.equal(first.status,200);
    const {session}=await first.json();
    assert.match(session,/^[A-Za-z0-9_-]{43}$/);
    assert.equal((await finish()).status,409);
    const token=await worker.fetch(new Request(WORKER+'/auth/token',{
      headers:{Origin:ORIGIN,Authorization:'Bearer '+session}
    }),f.env);
    assert.equal(token.status,200);
    const body=await token.json();
    assert.equal(body.access_token,'renewed-token');
    assert.equal(JSON.stringify(body).includes('private-refresh-token'),false);
    assert.equal([...f.store.values()].some(x=>String(x).includes('private-refresh-token')),false);
    const logout=await worker.fetch(new Request(WORKER+'/auth/logout',{
      method:'POST',headers:{Origin:ORIGIN,Authorization:'Bearer '+session}
    }),f.env);
    assert.equal(logout.status,200);
    const expired=await worker.fetch(new Request(WORKER+'/auth/token',{
      headers:{Origin:ORIGIN,Authorization:'Bearer '+session}
    }),f.env);
    assert.equal(expired.status,401);
  } finally {f.cleanup();}
});
test('rejects unauthorized origin and account',async()=>{
  const f=fixture('someone-else@example.com');
  try {
    const denied=await worker.fetch(new Request(WORKER+'/auth/token',{headers:{Origin:'https://evil.example'}}),f.env);
    assert.equal(denied.status,403);
    const start=await worker.fetch(new Request(WORKER+'/auth/start'),f.env);
    const state=new URL(start.headers.get('Location')).searchParams.get('state');
    const callback=await worker.fetch(new Request(WORKER+'/auth/callback?code=example&state='+state),f.env);
    const app=new URL(callback.headers.get('Location'));
    assert.equal(new URLSearchParams(app.hash.slice(1)).has('goal_auth_error'),true);
    assert.equal([...f.store.keys()].some(k=>k.startsWith('session:')),false);
  } finally {f.cleanup();}
});
