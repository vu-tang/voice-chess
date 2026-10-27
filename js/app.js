// 画面と対局の制御。音声の解釈は voice.js、Lichess との通信は lichess.js。
import { Chess } from '../vendor/chess.js';
import * as li from './lichess.js';
import { interpret, speakMove, squareKana } from './voice.js';

const $ = (id) => document.getElementById(id);
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const TEXT_VS = '︎'; // ♟ が絵文字で表示されないように
const FILES = 'abcdefgh';

const END_TEXT = {
  mate: 'チェックメイト',
  resign: '投了',
  stalemate: 'ステイルメイト',
  timeout: '時間切れ',
  outoftime: '時間切れ',
  draw: '引き分け',
  aborted: '対局は中止されました',
  noStart: '対局は開始されませんでした',
  cheat: '不正により終了',
  variantEnd: '対局終了',
  unknownFinish: '対局終了',
};

const S = {
  me: null,
  gameId: null,
  color: 'white', // 自分の色
  initialFen: null,
  chess: new Chess(),
  count: -1, // 受信済みの手数（-1=未受信。再接続時の相手の手だけ読み上げるため）
  status: 'none', // none | started | 終了系
  winner: null,
  clock: null, // {w, b, at}
  oppLabel: '相手',
  selected: null,
  pending: null, // {type:'confirm', move} | {type:'choose', moves} | {type:'resign'}
  abortCtl: null,
  sending: false,
  speaking: false,
  muteUntil: 0,
  rec: null,
  wantListen: false,
};

// ---------- 設定（この端末のブラウザにだけ保存） ----------
const SETTINGS_KEY = 'voice-chess.settings';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if ('confirm' in s) $('optConfirm').checked = s.confirm;
    if ('speak' in s) $('optSpeak').checked = s.speak;
    for (const [k, id] of [['level', 'optLevel'], ['color', 'optColor'], ['clock', 'optClock']]) {
      if (s[k] && [...$(id).options].some((o) => o.value === s[k])) $(id).value = s[k];
    }
  } catch {
    /* 読めなければ既定値 */
  }
}
function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        confirm: $('optConfirm').checked,
        speak: $('optSpeak').checked,
        level: $('optLevel').value,
        color: $('optColor').value,
        clock: $('optClock').value,
      }),
    );
  } catch {
    /* 保存できなくても動作はする */
  }
}

// ---------- 通知・フィードバック ----------
function notice(msg, info = false) {
  const el = $('notice');
  el.textContent = msg || '';
  el.hidden = !msg;
  el.classList.toggle('info', info);
}

function speak(text) {
  if (!$('optSpeak').checked || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = 1.05;
  const done = () => {
    S.speaking = false;
    S.muteUntil = performance.now() + 600; // 読み上げの余韻をマイクが拾わないように
  };
  u.onend = done;
  u.onerror = done;
  S.speaking = true;
  speechSynthesis.speak(u);
}

// 画面の一言と読み上げ
function say(text, { talk = true } = {}) {
  $('feedback').textContent = text;
  if (talk) speak(text);
}

// ---------- 盤の描画 ----------
const active = () => S.status === 'started' || S.status === 'created';
const myTurn = () => active() && S.chess.turn() === S.color[0];

function kingSquare(color) {
  for (const row of S.chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

function renderBoard() {
  const flip = S.color === 'black';
  const rows = flip ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const cols = flip ? [...FILES].reverse() : [...FILES];
  const last = S.chess.history({ verbose: true }).at(-1);
  const checkSq = S.chess.inCheck() ? kingSquare(S.chess.turn()) : null;
  const dests = new Map();
  if (S.selected && myTurn()) {
    for (const m of S.chess.moves({ square: S.selected, verbose: true })) dests.set(m.to, !!m.captured);
  }
  const pend = S.pending?.type === 'confirm' ? S.pending.move : null;

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    for (const f of cols) {
      const sq = f + r;
      const el = document.createElement('div');
      const dark = (FILES.indexOf(f) + r) % 2 === 0;
      el.className = 'sq ' + (dark ? 'd' : 'l');
      el.dataset.sq = sq;
      if (last && (last.from === sq || last.to === sq)) el.classList.add('last');
      if (pend && (pend.from === sq || pend.to === sq)) el.classList.add('pend');
      if (checkSq === sq) el.classList.add('check');
      if (S.selected === sq) el.classList.add('sel');
      if (dests.has(sq)) el.classList.add('dest', ...(dests.get(sq) ? ['cap'] : []));
      const piece = S.chess.get(sq);
      if (piece) {
        const p = document.createElement('span');
        p.className = `pc ${piece.color}`;
        p.textContent = GLYPH[piece.type] + TEXT_VS;
        el.append(p);
      }
      if (f === cols[0]) el.append(coord('r', r));
      if (r === rows[rows.length - 1]) el.append(coord('f', f));
      frag.append(el);
    }
  }
  $('board').replaceChildren(frag);
}

function coord(kind, text) {
  const s = document.createElement('span');
  s.className = `coord ${kind}`;
  s.textContent = text;
  return s;
}

function renderMoves() {
  const sans = S.chess.history();
  const items = [];
  for (let i = 0; i < sans.length; i += 2) {
    const item = document.createElement('li');
    item.value = i / 2 + 1;
    item.textContent = sans[i] + (sans[i + 1] ? '  ' + sans[i + 1] : '');
    items.push(item);
  }
  $('moves').replaceChildren(...items);
  $('moves').scrollTop = $('moves').scrollHeight;
}

function resultText() {
  const t = END_TEXT[S.status] ?? '対局終了';
  if (S.status === 'aborted' || S.status === 'noStart') return t;
  if (!S.winner) return t;
  return `${t}。${S.winner === S.color ? 'あなたの勝ちです' : 'あなたの負けです'}`;
}

function renderStatus() {
  let text;
  if (S.status === 'none') text = '対局していません';
  else if (active()) text = (myTurn() ? 'あなたの番です' : '相手の番です') + (S.chess.inCheck() ? '（チェック）' : '');
  else text = resultText();
  $('status').textContent = text;
  $('resignBtn').hidden = !active();
  $('newGame').hidden = active();
  $('oppName').textContent = S.oppLabel;
  $('myName').textContent = S.me ? S.me.username : 'あなた';

  const p = S.pending;
  $('pendingBox').hidden = !p || p.type === 'choose';
  if (p?.type === 'confirm') $('pendingText').textContent = `${p.move.san}（${speakMove(p.move)}）でよいですか？`;
  if (p?.type === 'resign') $('pendingText').textContent = '投了しますか？';
}

function render() {
  renderBoard();
  renderMoves();
  renderStatus();
  renderClocks();
}

// ---------- 時計 ----------
const fmt = (ms) => {
  if (ms == null) return '';
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

function renderClocks() {
  const c = S.clock;
  const mine = S.color[0];
  const opp = mine === 'w' ? 'b' : 'w';
  const running = active() && S.chess.history().length >= 2 ? S.chess.turn() : null; // 双方が1手指すまで進まない
  const left = (side) => {
    if (!c || c[side] == null) return null;
    return c[side] - (running === side ? performance.now() - c.at : 0);
  };
  const set = (id, side) => {
    const el = $(id);
    const v = left(side);
    el.textContent = c && c[side] != null ? fmt(v) : '';
    el.classList.toggle('run', running === side);
  };
  set('myClock', mine);
  set('oppClock', opp);
}
setInterval(renderClocks, 250);

// ---------- 対局の同期 ----------
function applyState(state) {
  const c = S.initialFen && S.initialFen !== 'startpos' ? new Chess(S.initialFen) : new Chess();
  const moves = state.moves ? state.moves.split(' ') : [];
  try {
    for (const u of moves) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  } catch (e) {
    notice(`指し手の反映に失敗しました: ${e.message}`);
    return;
  }
  S.chess = c;
  S.status = state.status;
  S.winner = state.winner ?? null;
  S.clock = { w: state.wtime ?? null, b: state.btime ?? null, at: performance.now() };

  const prev = S.count;
  S.count = moves.length;
  const last = c.history({ verbose: true }).at(-1);
  if (last && prev >= 0 && S.count > prev) {
    S.selected = null;
    S.pending = null;
    if (last.color !== S.color[0]) {
      say(`相手は ${speakMove(last)}`);
      notice(`相手の手: ${last.san}`, true);
    }
  }
  if (!active()) {
    S.pending = null;
    const t = resultText();
    say(t);
    notice(t, true);
  }
  render();
}

async function runStream(gameId, ctl) {
  while (!ctl.signal.aborted) {
    try {
      for await (const ev of li.streamGame(gameId, ctl.signal)) {
        if (ev.type === 'gameFull') {
          S.color = ev.white?.id === S.me.id ? 'white' : 'black';
          S.initialFen = ev.initialFen;
          const opp = S.color === 'white' ? ev.black : ev.white;
          S.oppLabel = opp?.aiLevel ? `Lichess AI レベル${opp.aiLevel}` : (opp?.name ?? '相手');
          applyState(ev.state);
        } else if (ev.type === 'gameState') {
          applyState(ev);
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
      notice(`対局との接続が切れました。再接続します…（${e.message}）`, true);
    }
    if (ctl.signal.aborted || !active()) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function openGame(gameId) {
  S.abortCtl?.abort();
  S.abortCtl = new AbortController();
  Object.assign(S, {
    gameId, count: -1, status: 'started', winner: null, selected: null, pending: null,
    chess: new Chess(), initialFen: null, clock: null,
  });
  notice('');
  render();
  runStream(gameId, S.abortCtl);
}

// ---------- 指す ----------
async function submit(m) {
  if (!myTurn() || S.sending) return;
  S.sending = true;
  S.pending = null;
  S.selected = null;
  render();
  try {
    await li.sendMove(S.gameId, m.from + m.to + (m.promotion ?? ''));
  } catch (e) {
    say('指せませんでした');
    notice(e.message);
  } finally {
    S.sending = false;
  }
}

async function doResign() {
  S.pending = null;
  render();
  try {
    await (S.chess.history().length < 2 ? li.abort(S.gameId) : li.resign(S.gameId));
  } catch (e) {
    notice(e.message);
  }
}

$('board').addEventListener('click', (e) => {
  const el = e.target.closest('.sq');
  if (!el || !myTurn()) return;
  const sq = el.dataset.sq;
  if (S.selected) {
    const mv = S.chess.moves({ square: S.selected, verbose: true }).filter((m) => m.to === sq);
    if (mv.length) {
      submit(mv.find((m) => m.promotion === 'q') ?? mv[0]); // 成りはクイーン固定（画面操作）
      return;
    }
  }
  const p = S.chess.get(sq);
  S.selected = p && p.color === S.color[0] ? sq : null;
  render();
});

// ---------- 音声・テキストコマンド ----------
function proposeMoves(moves, guessed) {
  if (moves.length === 1) {
    const m = moves[0];
    if ($('optConfirm').checked || guessed) {
      S.pending = { type: 'confirm', move: m };
      say(`${guessed ? 'もしかして、' : ''}${speakMove(m)}。よろしいですか`);
      render();
    } else {
      say(speakMove(m), { talk: false });
      submit(m);
    }
    return;
  }
  // 同じ行き先に複数の駒が行ける
  S.pending = { type: 'choose', moves };
  const froms = [...new Set(moves.map((m) => m.from))];
  say(`${froms.map(squareKana).join('、')}の、どれですか？`);
  $('feedback').textContent = `どれですか？ ${froms.join(' / ')}（出発のマスかファイルを言ってください）`;
  render();
}

function answerYesNo(yes) {
  const p = S.pending;
  if (!p || p.type === 'choose') {
    say('確認するものはありません', { talk: false });
    return;
  }
  S.pending = null;
  if (!yes) {
    say('取り消しました');
    render();
    return;
  }
  if (p.type === 'confirm') submit(p.move);
  else if (p.type === 'resign') doResign();
}

function handleUtterance(alts) {
  const legal = myTurn() ? S.chess.moves({ verbose: true }) : [];
  let res = null;
  for (const a of alts) {
    let r;
    if (S.pending?.type === 'choose') {
      r = interpret(a, S.pending.moves, { choose: true });
      if (r.kind === 'none') r = interpret(a, legal);
    } else {
      r = interpret(a, legal);
    }
    if (r.kind !== 'none') {
      res = r;
      break;
    }
    res ??= r;
  }
  $('heard').textContent = `聞き取り: ${alts[0]}`;

  if (!active() && res.kind !== 'none') {
    say('対局中ではありません', { talk: false });
    return;
  }
  switch (res.kind) {
    case 'move':
      proposeMoves(res.moves, res.guessed);
      break;
    case 'yes':
      answerYesNo(true);
      break;
    case 'no':
      answerYesNo(false);
      break;
    case 'resign':
      S.pending = { type: 'resign' };
      say('投了しますか？「はい」で確定します');
      render();
      break;
    default:
      say(active() && !myTurn() ? 'いまは相手の番です' : (res.reason ?? '聞き取れませんでした'), { talk: false });
  }
}

// ---------- マイク（Web Speech API） ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function setMic(on) {
  S.wantListen = on;
  const b = $('micBtn');
  b.classList.toggle('on', on);
  b.textContent = on ? '🎤 聞いています（クリックで停止）' : '🎤 マイクをオン';
}

function startMic() {
  if (!SR) {
    notice('このブラウザは音声認識に対応していません。Chrome か Edge を使うか、下の入力欄に文字で入力してください。');
    return;
  }
  const rec = new SR();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 5;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r.isFinal) {
        $('heard').textContent = `聞き取り中… ${r[0].transcript}`;
        continue;
      }
      if (S.speaking || performance.now() < S.muteUntil) continue; // 自分の読み上げは無視
      const alts = Array.from({ length: r.length }, (_, k) => r[k].transcript).filter(Boolean);
      if (alts.length) handleUtterance(alts);
    }
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setMic(false);
      notice('マイクの使用が許可されていません。アドレスバーの鍵アイコンから許可してください。');
    } else if (e.error === 'network') {
      notice('音声認識サービスに接続できません（ネットワークを確認してください）。');
    }
  };
  rec.onend = () => {
    if (S.wantListen) setTimeout(() => { try { rec.start(); } catch { /* 起動済み */ } }, 300);
  };
  S.rec = rec;
  setMic(true);
  try {
    rec.start();
  } catch {
    /* 起動済み */
  }
}

function stopMic() {
  setMic(false);
  try {
    S.rec?.stop();
  } catch {
    /* 停止済み */
  }
}

// ---------- 操作 ----------
$('micBtn').addEventListener('click', () => (S.wantListen ? stopMic() : startMic()));
$('yesBtn').addEventListener('click', () => answerYesNo(true));
$('noBtn').addEventListener('click', () => answerYesNo(false));
$('resignBtn').addEventListener('click', () => {
  S.pending = { type: 'resign' };
  render();
});
$('cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('cmdInput').value.trim();
  $('cmdInput').value = '';
  if (v) handleUtterance([v]);
});
for (const id of ['optConfirm', 'optSpeak', 'optLevel', 'optColor', 'optClock']) $(id).addEventListener('change', saveSettings);

$('newGameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const [limit, increment] = $('optClock').value.split('+').map(Number);
  const btn = e.currentTarget.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const g = await li.challengeAI({ level: $('optLevel').value, color: $('optColor').value, limit, increment });
    openGame(g.id ?? g.game?.id);
  } catch (err) {
    notice(err.message);
  } finally {
    btn.disabled = false;
  }
});

$('loginBtn').addEventListener('click', () => li.login());
$('logoutBtn').addEventListener('click', () => {
  li.logout();
  S.abortCtl?.abort();
  location.reload();
});

// ---------- 起動 ----------
async function init() {
  loadSettings();
  try {
    await li.handleRedirect();
  } catch (e) {
    notice(e.message);
  }
  if (!li.hasToken()) {
    $('welcome').hidden = false;
    $('loginBtn').hidden = false;
    return;
  }
  try {
    S.me = await li.getAccount();
  } catch (e) {
    notice(e.message);
    $('welcome').hidden = false;
    $('loginBtn').hidden = false;
    return;
  }
  $('account').textContent = S.me.username;
  $('logoutBtn').hidden = false;
  $('app').hidden = false;
  render();

  try {
    const playing = await li.getPlaying();
    if (playing.length) {
      notice('進行中の対局を再開しました', true);
      openGame(playing[0].gameId);
    }
  } catch (e) {
    notice(e.message);
  }
}

init();
