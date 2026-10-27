// js/lichess.js と同じ公開インターフェースのモック（開発・動作確認用。/?mock=1 で差し替わる）。
// 相手は合法手からランダムに指す。クロックは固定値。
import { Chess } from '../vendor/chess.js';

const queue = [];
let wake = null;
let game = null;

const push = (ev) => {
  queue.push(ev);
  wake?.();
};
const state = () => ({
  type: 'gameState',
  moves: game.uci.join(' '),
  wtime: 600000,
  btime: 600000,
  status: game.status,
  winner: game.winner,
});

function afterMove() {
  const c = game.chess;
  if (c.isCheckmate()) {
    game.status = 'mate';
    game.winner = c.turn() === 'w' ? 'black' : 'white';
  } else if (c.isStalemate()) {
    game.status = 'stalemate';
  } else if (c.isDraw()) {
    game.status = 'draw';
  }
  push(state());
}

function play(m) {
  game.chess.move(m);
  game.uci.push(m.from + m.to + (m.promotion ?? ''));
  afterMove();
}

function aiMove() {
  if (game.status !== 'started') return;
  setTimeout(() => {
    if (game.status !== 'started') return;
    const moves = game.chess.moves({ verbose: true });
    play(moves[Math.floor(Math.random() * moves.length)]);
  }, 500);
}

export const hasToken = () => true;
export const logout = () => {};
export const login = async () => {};
export const handleRedirect = async () => false;
export const getAccount = async () => ({ id: 'tester', username: 'Tester' });
export const getPlaying = async () => [];

export async function challengeAI({ color }) {
  const mine = color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color;
  game = { id: 'MOCK0001', mine, chess: new Chess(), uci: [], status: 'started', winner: null };
  queue.length = 0;
  return { id: game.id };
}

export async function sendMove(_id, uci) {
  const m = game.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  game.uci.push(uci);
  afterMove();
  if (m) aiMove();
}

export async function resign() {
  game.status = 'resign';
  game.winner = game.mine === 'white' ? 'black' : 'white';
  push(state());
}
export const abort = async () => {
  game.status = 'aborted';
  push(state());
};

export async function* streamGame(_id, signal) {
  const ai = { aiLevel: 3, id: undefined };
  const me = { id: 'tester', name: 'Tester' };
  yield {
    type: 'gameFull',
    id: game.id,
    white: game.mine === 'white' ? me : ai,
    black: game.mine === 'black' ? me : ai,
    initialFen: 'startpos',
    state: state(),
  };
  if (game.mine === 'black' && game.uci.length === 0) aiMove();
  while (!signal.aborted) {
    if (!queue.length) await new Promise((r) => { wake = r; setTimeout(r, 300); });
    while (queue.length) yield queue.shift();
  }
}
