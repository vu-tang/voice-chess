// Lichess との通信。OAuth は PKCE（クライアントシークレット不要）なので、静的ページだけで完結する。
// トークンは sessionStorage のみ（タブを閉じると消える）。コードや URL には埋め込まない。

const BASE = 'https://lichess.org';
const CLIENT_ID = 'voice-chess-ghpages'; // Lichess は PKCE の client_id を自由な文字列として扱う
const SCOPES = 'board:play challenge:write';
const TOKEN_KEY = 'voice-chess.token';
const PKCE_KEY = 'voice-chess.pkce';

const redirectUri = () => location.origin + location.pathname;

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const randomString = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

const store = {
  get: (k) => {
    try {
      return sessionStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      sessionStorage.setItem(k, v);
    } catch {
      /* 保存できなくても動作はする（再読込でログインし直し） */
    }
  },
  del: (k) => {
    try {
      sessionStorage.removeItem(k);
    } catch {
      /* 同上 */
    }
  },
};

export const hasToken = () => !!store.get(TOKEN_KEY);
export const logout = () => store.del(TOKEN_KEY);

export async function login() {
  const verifier = randomString(48);
  const state = randomString(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set(PKCE_KEY, JSON.stringify({ verifier, state }));
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  location.assign(`${BASE}/oauth?${q}`);
}

// 認可後に戻ってきたとき、URL の ?code=... をトークンに交換する。処理したら true
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  const saved = JSON.parse(store.get(PKCE_KEY) || 'null');
  store.del(PKCE_KEY);
  history.replaceState(null, '', location.pathname); // code をアドレスバー・履歴に残さない
  if (q.has('error')) throw new Error(`認可がキャンセルされました（${q.get('error')}）`);
  if (!saved || saved.state !== q.get('state')) throw new Error('認可の状態が一致しません。もう一度ログインしてください');
  const res = await fetch(`${BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.get('code'),
      code_verifier: saved.verifier,
      redirect_uri: redirectUri(),
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`トークンを取得できませんでした（HTTP ${res.status}）`);
  const json = await res.json();
  store.set(TOKEN_KEY, json.access_token);
  return true;
}

const authHeaders = () => ({ Authorization: `Bearer ${store.get(TOKEN_KEY)}` });

async function request(path, { method = 'GET', form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...authHeaders(), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  if (res.status === 401) {
    logout();
    throw new Error('ログインの有効期限が切れました。もう一度ログインしてください');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j.error ? `: ${typeof j.error === 'string' ? j.error : JSON.stringify(j.error)}` : '';
    } catch {
      /* 本文が JSON でなければ無視 */
    }
    throw new Error(`Lichess API エラー（HTTP ${res.status}）${detail}`);
  }
  return res.json();
}

export const getAccount = () => request('/api/account');
export const getPlaying = async () => (await request('/api/account/playing')).nowPlaying ?? [];

// クロックを省略すると無制限。limit/increment は秒
export function challengeAI({ level, color, limit, increment }) {
  const form = { level: String(level), color };
  if (limit > 0) {
    form['clock.limit'] = String(limit);
    form['clock.increment'] = String(increment ?? 0);
  }
  return request('/api/challenge/ai', { method: 'POST', form });
}

export const sendMove = (gameId, uci) => request(`/api/board/game/${gameId}/move/${uci}`, { method: 'POST' });
export const resign = (gameId) => request(`/api/board/game/${gameId}/resign`, { method: 'POST' });
export const abort = (gameId) => request(`/api/board/game/${gameId}/abort`, { method: 'POST' });

// NDJSON のストリーム。1行ずつ JSON にして返す（空行は keep-alive）
export async function* streamGame(gameId, signal) {
  const res = await fetch(`${BASE}/api/board/game/stream/${gameId}`, {
    headers: { ...authHeaders(), Accept: 'application/x-ndjson' },
    signal,
  });
  if (!res.ok) throw new Error(`対局に接続できませんでした（HTTP ${res.status}）`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
}
