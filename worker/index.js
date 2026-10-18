/**
 * Goal Tassei Kun - Cloudflare Workers OAuth session broker.
 *
 * Refresh tokens stay encrypted in Workers KV. GitHub Pages stores only a
 * random, revocable app session; Google access tokens live in page memory.
 * Configure secrets and Google OAuth redirect URI before deployment.
 */
const SESSION_TTL = 90 * 24 * 60 * 60;
const STATE_TTL = 10 * 60;
const TICKET_TTL = 3 * 60;
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.appdata'
].join(' ');

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers}
  });
}
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64url(new Uint8Array(bytes));
}
function decodeKey(encoded) {
  const s = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(s.padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error('AUTH_ENCRYPTION_KEY must be 32 random bytes in base64');
  return bytes;
}
async function encryptionKey(env) {
  return crypto.subtle.importKey('raw', decodeKey(env.AUTH_ENCRYPTION_KEY), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(text, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await encryptionKey(env), new TextEncoder().encode(text));
  return base64url(iv) + '.' + base64url(new Uint8Array(encrypted));
}
async function unseal(value, env) {
  const [iv, payload] = String(value).split('.');
  if (!iv || !payload) throw new Error('Invalid encrypted session');
  const fromB64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromB64(iv)}, await encryptionKey(env), fromB64(payload));
  return new TextDecoder().decode(plain);
}
function config(env, origin) {
  if (!env.AUTH_KV || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.AUTH_ENCRYPTION_KEY || !env.ALLOWED_EMAIL || !env.APP_ORIGIN || !env.APP_RETURN_URL) {
    throw new Error('Worker configuration is incomplete');
  }
  const app = new URL(env.APP_RETURN_URL);
  if (app.protocol !== 'https:' || app.origin !== env.APP_ORIGIN || !env.APP_ORIGIN.startsWith('https://')) throw new Error('Invalid app URL');
  if (origin && origin !== env.APP_ORIGIN) throw new Error('Origin is not allowed');
}
function cors(env, request) {
  return request.headers.get('Origin') === env.APP_ORIGIN
    ? {'Access-Control-Allow-Origin': env.APP_ORIGIN, 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
       'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Vary': 'Origin'}
    : {};
}
function appRedirect(env, key, value) {
  const target = new URL(env.APP_RETURN_URL);
  target.hash = key + '=' + encodeURIComponent(value);
  return new Response(null, {status: 302, headers: {
    'Location': target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'
  }});
}
function oauthCallbackUrl(request) {
  return new URL('/auth/callback', request.url).toString();
}
async function exchangeToken(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(params)
  });
  const body = await response.json();
  if (!response.ok) throw new Error('Google OAuth token exchange failed: ' + (body.error || response.status));
  return body;
}
function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '');
  return match ? match[1] : '';
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get('Origin');
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') {
      if (origin !== env.APP_ORIGIN) return new Response(null, {status: 403});
      return new Response(null, {status: 204, headers});
    }
    try {
      config(env, ['/auth/finish', '/auth/token', '/auth/logout'].includes(path) ? origin : null);
      if (path === '/health' && request.method === 'GET') return json({ok: true});
      if (path === '/auth/start' && request.method === 'GET') {
        const state = randomId();
        const verifier = randomId();
        const challenge = await sha256(verifier);
        await env.AUTH_KV.put('oauth:' + await sha256(state), verifier, {expirationTtl: STATE_TTL});
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        for (const [k, v] of Object.entries({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: oauthCallbackUrl(request),
          response_type: 'code', scope: SCOPES, access_type: 'offline',
          prompt: 'consent select_account', state,
          code_challenge: challenge, code_challenge_method: 'S256'
        })) auth.searchParams.set(k, v);
        return Response.redirect(auth.toString(), 302);
      }
      if (path === '/auth/callback' && request.method === 'GET') {
        if (url.searchParams.has('error')) return appRedirect(env, 'goal_auth_error', 'Googleへの接続がキャンセルされました');
        const state = url.searchParams.get('state') || '';
        const code = url.searchParams.get('code') || '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code) return appRedirect(env, 'goal_auth_error', '認証情報が不足しています');
        const stateKey = 'oauth:' + await sha256(state);
        const verifier = await env.AUTH_KV.get(stateKey);
        if (!verifier) return appRedirect(env, 'goal_auth_error', '認証の期限が切れました。もう一度お試しください');
        await env.AUTH_KV.delete(stateKey);
        const token = await exchangeToken({
          code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: oauthCallbackUrl(request), code_verifier: verifier, grant_type: 'authorization_code'
        });
        if (!token.refresh_token || !token.access_token) throw new Error('Google did not issue an offline refresh token');
        const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: {Authorization: 'Bearer ' + token.access_token}
        });
        if (!profileRes.ok) throw new Error('Google account verification failed');
        const profile = await profileRes.json();
        if (!profile.email_verified || String(profile.email || '').toLowerCase() !== env.ALLOWED_EMAIL.trim().toLowerCase()) {
          return appRedirect(env, 'goal_auth_error', '許可されていないGoogleアカウントです');
        }
        const session = randomId();
        const sessionKey = 'session:' + await sha256(session);
        await env.AUTH_KV.put(sessionKey, JSON.stringify({
          email: profile.email, refresh: await seal(token.refresh_token, env)
        }), {expirationTtl: SESSION_TTL});
        const ticket = randomId();
        await env.AUTH_KV.put('ticket:' + await sha256(ticket), session, {expirationTtl: TICKET_TTL});
        return appRedirect(env, 'goal_auth_ticket', ticket);
      }
      if (path === '/auth/finish' && request.method === 'POST') {
        const input = await request.text();
        if (input.length > 2048) return json({error: 'Invalid request'}, 400, headers);
        let body; try {body = JSON.parse(input);} catch {return json({error: 'Invalid JSON'}, 400, headers);}
        const ticket = String(body.ticket || '');
        if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return json({error: 'Invalid ticket'}, 400, headers);
        const key = 'ticket:' + await sha256(ticket);
        const session = await env.AUTH_KV.get(key);
        if (!session) return json({error: 'Ticket not found or expired'}, 409, headers);
        await env.AUTH_KV.delete(key);
        return json({session, expires_in: SESSION_TTL}, 200, headers);
      }
      if ((path === '/auth/token' && request.method === 'GET') ||
          (path === '/auth/logout' && request.method === 'POST')) {
        const session = bearer(request);
        if (!session) return json({error: 'Login required'}, 401, headers);
        const key = 'session:' + await sha256(session);
        const raw = await env.AUTH_KV.get(key);
        if (!raw) return json({error: 'Session expired'}, 401, headers);
        if (path === '/auth/logout') {
          await env.AUTH_KV.delete(key);
          return json({ok: true}, 200, headers);
        }
        const saved = JSON.parse(raw);
        const refresh = await unseal(saved.refresh, env);
        let token;
        try {
          token = await exchangeToken({
            client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
            refresh_token: refresh, grant_type: 'refresh_token'
          });
        } catch (error) {
          if (/invalid_grant/.test(error.message)) {
            await env.AUTH_KV.delete(key);
            return json({error: 'Google authorization expired. Sign in again.'}, 401, headers);
          }
          throw error;
        }
        if (token.refresh_token && token.refresh_token !== refresh) {
          await env.AUTH_KV.put(key, JSON.stringify({...saved, refresh: await seal(token.refresh_token, env)}), {expirationTtl: SESSION_TTL});
        }
        return json({access_token: token.access_token, expires_in: Number(token.expires_in) || 3600}, 200, headers);
      }
      return json({error: 'Not found'}, 404, headers);
    } catch (error) {
      // Never return credentials or OAuth authorization codes in errors.
      const message = String(error.message || 'Unexpected error');
      if (path === '/auth/callback') return appRedirect(env, 'goal_auth_error', 'Google認証の設定または権限を確認してください');
      if (message === 'Origin is not allowed') return json({error: 'Origin not allowed'}, 403);
      return json({error: 'Authentication service unavailable. Check Worker settings.'}, 503, headers);
    }
  }
};
