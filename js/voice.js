// 音声認識の文字列 → 指し手 / コマンドへの解釈。DOM に依存しない（Node でもテストできる）。
// 方針: LLM は使わず、「合法手リストとの照合」で確定する。聞き間違いは合法手で絞り込む。

const hira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 全角→半角(NFKC)、小文字、カタカナ→ひらがな、空白・句読点の除去
export function normalize(text) {
  return hira(String(text).normalize('NFKC').toLowerCase()).replace(/[\s、。,.!?！？「」『』]/g, '');
}

// 辞書は正規化後（ひらがな・小文字）の表記で持つ
const FILES = {
  a: ['a', 'えー', 'えい'],
  b: ['b', 'びー', 'びい'],
  c: ['c', 'しー', 'しい'],
  d: ['d', 'でぃー', 'でぃ', 'でー', 'でい'],
  e: ['e', 'いー'],
  f: ['f', 'えふ', 'えっふ'],
  g: ['g', 'じー', 'じい', 'ぎー'],
  h: ['h', 'えいち', 'えっち', 'えち'],
};
const RANKS = {
  1: ['1', 'いち', 'わん', '一'],
  2: ['2', 'に', 'つー', '二'],
  3: ['3', 'さん', 'すりー', '三'],
  4: ['4', 'よん', 'し', 'ふぉー', '四'],
  5: ['5', 'ご', 'ふぁいぶ', '五'],
  6: ['6', 'ろく', 'しっくす', '六'],
  7: ['7', 'なな', 'しち', 'せぶん', '七'],
  8: ['8', 'はち', 'えいと', '八'],
};
const PIECES = {
  p: ['ぽーん', 'ぽん', 'ぽおん', '歩', 'pawn'],
  n: ['ないと', '騎士', 'knight', 'night'],
  b: ['びしょっぷ', 'びしょぷ', 'bishop'],
  r: ['るーく', 'るく', 'rook'],
  q: ['くいーん', 'くいん', '女王', 'queen'],
  k: ['きんぐ', '王様', 'king'],
};
const CAPTURE = ['x', '×', 'とる', 'とって', '取る', '取って', 'たべる', 'てーく', 'ていく', 'takes'];
const YES = ['はい', 'いえす', 'yes', 'おっけー', 'おーけー', 'ok', 'おけ', 'かくてい', 'おねがい', 'お願い', 'そう', 'うん'];
const NO = ['いいえ', 'いえ', 'のー', 'no', 'ちがう', '違う', 'きゃんせる', 'cancel', 'やりなおし', 'やり直し', 'とりけし', '取り消し', 'だめ'];
const RESIGN = ['とうりょう', '投了', 'りざいん', 'resign', 'まいりました', '参りました'];

const DICT = [];
for (const [v, list] of Object.entries(FILES)) list.forEach((s) => DICT.push([s, 'file', v]));
for (const [v, list] of Object.entries(RANKS)) list.forEach((s) => DICT.push([s, 'rank', v]));
for (const [v, list] of Object.entries(PIECES)) list.forEach((s) => DICT.push([s, 'piece', v]));
CAPTURE.forEach((s) => DICT.push([s, 'x', '']));
YES.forEach((s) => DICT.push([s, 'yes', '']));
NO.forEach((s) => DICT.push([s, 'no', '']));
RESIGN.forEach((s) => DICT.push([s, 'resign', '']));
DICT.sort((a, b) => b[0].length - a[0].length); // 最長一致

// 正規化済みの文字列をトークン列にする。辞書にない文字は読み飛ばす
export function tokenize(norm) {
  const toks = [];
  for (let i = 0; i < norm.length; ) {
    const hit = DICT.find(([s]) => norm.startsWith(s, i));
    if (hit) {
      toks.push({ t: hit[1], v: hit[2], n: hit[0].length });
      i += hit[0].length;
    } else {
      i += 1;
    }
  }
  return toks;
}

const LONG_CASTLE = /[o0]-[o0]-[o0]|おーおーおー|ろんぐ|くいーんさいど/;
const SHORT_CASTLE = /[o0]-[o0]|おーおー|きゃすりんぐ|しょーと|きんぐさいど/;

// 聞き間違いやすいファイルの組（b/c/d/e/g、a/f/h）。合法手が1つに絞れるときだけ推測に使う
const CONFUSABLE = ['bcdeg', 'afh'];

const pieceFilter = (m, piece) => m.piece === piece;

function matchTo(legal, to, o) {
  return legal.filter((m) => {
    if (m.to !== to) return false;
    if (o.piece && !pieceFilter(m, o.piece)) return false;
    if (o.files.some((f) => m.from[0] !== f)) return false;
    if (o.ranks.some((r) => m.from[1] !== r)) return false;
    if (m.promotion && m.promotion !== o.promo) return false;
    return true;
  });
}

// text: 認識結果の文字列 / legal: chess.js の moves({verbose:true}) / opts.choose: 曖昧な候補の絞り込みモード
// 戻り値: {kind:'move', moves, guessed?} | {kind:'yes'|'no'|'resign'} | {kind:'none', reason}
export function interpret(text, legal, opts = {}) {
  const norm = normalize(text);

  const isLong = LONG_CASTLE.test(norm);
  if (isLong || SHORT_CASTLE.test(norm)) {
    const flag = isLong ? 'q' : 'k';
    const moves = legal.filter((m) => m.flags.includes(flag));
    return moves.length ? { kind: 'move', moves } : { kind: 'none', reason: 'いまはキャスリングできません' };
  }

  const toks = tokenize(norm);
  const squares = [];
  const loneF = [];
  const loneR = [];
  const pieces = [];
  let cmd = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'file' && toks[i + 1]?.t === 'rank') {
      squares.push({ sq: t.v + toks[i + 1].v, i });
      i++;
    } else if (t.t === 'file') loneF.push({ v: t.v, i });
    else if (t.t === 'rank') loneR.push({ v: t.v, i });
    else if (t.t === 'piece') pieces.push({ v: t.v, i });
    else if (t.t === 'yes' || t.t === 'no' || t.t === 'resign') cmd ??= t.t;
  }

  // 雑談の中の「はい」などで確定・投了しないよう、辞書に載る文字が一定割合ない発話のコマンドは無効
  const covered = toks.reduce((n, t) => n + t.n, 0);
  if (cmd && covered / norm.length < 0.35) cmd = null;

  if (cmd === 'resign') return { kind: 'resign' };

  // 曖昧だった候補の絞り込み（「b」「b1」「1」など）
  if (opts.choose) {
    let pool = legal;
    for (const s of squares) pool = pool.filter((m) => m.from === s.sq || m.to === s.sq);
    for (const f of loneF) pool = pool.filter((m) => m.from[0] === f.v);
    for (const r of loneR) pool = pool.filter((m) => m.from[1] === r.v);
    if (pool.length > 0 && pool.length < legal.length) return { kind: 'move', moves: pool };
  }

  if (squares.length === 0) {
    return cmd ? { kind: cmd } : { kind: 'none', reason: '指し手が聞き取れませんでした' };
  }

  // from と to の両方を言った場合（「e2 e4」）
  if (squares.length >= 2) {
    const from = squares[squares.length - 2].sq;
    const to = squares[squares.length - 1].sq;
    const moves = legal.filter((m) => m.from === from && m.to === to);
    if (moves.length === 0) return { kind: 'none', reason: `${from} から ${to} へは指せません` };
    const q = moves.filter((m) => !m.promotion || m.promotion === 'q');
    return { kind: 'move', moves: q.length ? q : moves };
  }

  const { sq: to, i: toIdx } = squares[0];
  const before = pieces.filter((p) => p.i < toIdx);
  const after = pieces.filter((p) => p.i > toIdx);
  const explicit = before.length > 0;
  // 駒名を言わなければポーン。「e8 クイーン」のように行き先の後ろの駒名は成り先
  const piece = before[0]?.v ?? 'p';
  const promo = after.at(-1)?.v ?? 'q';
  // 絞り込みのヒント（「g ナイト f3」の g）は行き先より前のものだけ使う
  const base = {
    files: loneF.filter((x) => x.i < toIdx).map((x) => x.v),
    ranks: loneR.filter((x) => x.i < toIdx).map((x) => x.v),
    promo,
  };

  let moves = matchTo(legal, to, { ...base, piece });
  if (moves.length === 0 && !explicit) {
    // 駒名の聞き落としを想定して、駒を問わず探す
    moves = matchTo(legal, to, { ...base, piece: null });
  }
  if (moves.length > 0) return { kind: 'move', moves };

  // 同じ響きのファイルに置き換えて、ちょうど1手に絞れるなら推測として返す
  const group = CONFUSABLE.find((g) => g.includes(to[0]));
  if (group) {
    const alts = [];
    for (const f of group) {
      if (f === to[0]) continue;
      const alt = f + to[1];
      let found = matchTo(legal, alt, { ...base, piece });
      if (found.length === 0 && !explicit) found = matchTo(legal, alt, { ...base, piece: null });
      alts.push(...found);
    }
    if (alts.length === 1) return { kind: 'move', moves: alts, guessed: true };
  }
  return { kind: 'none', reason: `${to} へ動かせる駒がありません` };
}

// ---- 読み上げ・表示用 ----
export const PIECE_KANA = { p: 'ポーン', n: 'ナイト', b: 'ビショップ', r: 'ルーク', q: 'クイーン', k: 'キング' };
export const FILE_KANA = { a: 'エー', b: 'ビー', c: 'シー', d: 'ディー', e: 'イー', f: 'エフ', g: 'ジー', h: 'エイチ' };
export const RANK_KANA = { 1: 'イチ', 2: 'ニ', 3: 'サン', 4: 'ヨン', 5: 'ゴ', 6: 'ロク', 7: 'ナナ', 8: 'ハチ' };

export const squareKana = (sq) => FILE_KANA[sq[0]] + RANK_KANA[sq[1]];

// chess.js の verbose な指し手を日本語の読みにする
export function speakMove(m) {
  const tail = m.san.endsWith('#') ? '、チェックメイト' : m.san.endsWith('+') ? '、チェック' : '';
  if (m.flags.includes('k')) return 'ショートキャスリング' + tail;
  if (m.flags.includes('q')) return 'ロングキャスリング' + tail;
  let s = `${PIECE_KANA[m.piece]}、${squareKana(m.to)}`;
  if (m.captured) s += '、取る';
  if (m.promotion) s += `、プロモーション、${PIECE_KANA[m.promotion]}`;
  return s + tail;
}
