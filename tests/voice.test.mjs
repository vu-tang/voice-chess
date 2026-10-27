// 実行: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../vendor/chess.js';
import { interpret, normalize, tokenize, speakMove } from '../js/voice.js';

const legalOf = (fen) => new Chess(fen).moves({ verbose: true });
const START = legalOf();
const ucis = (r) => r.moves.map((m) => m.from + m.to + (m.promotion ?? ''));

test('正規化: 全角・カタカナ・空白', () => {
  assert.equal(normalize('Ｅ ４'), 'e4');
  assert.equal(normalize('ナイト エフ スリー'), 'ないとえふすりー');
});

test('トークン化: 最長一致（えいと=8、えいち=h）', () => {
  assert.deepEqual(tokenize('えいと').map((t) => t.v), ['8']);
  assert.deepEqual(tokenize('えいち').map((t) => t.v), ['h']);
  assert.deepEqual(tokenize('しーよん').map((t) => t.v), ['c', '4']);
});

test('ポーンの手（表記ゆれ）', () => {
  for (const s of ['e4', 'E4', 'ｅ４', 'イーフォー', 'いーよん', 'ポーン イー ヨン', 'e 4']) {
    const r = interpret(s, START);
    assert.equal(r.kind, 'move', s);
    assert.deepEqual(ucis(r), ['e2e4'], s);
  }
});

test('駒の手', () => {
  assert.deepEqual(ucis(interpret('ナイト エフスリー', START)), ['g1f3']);
  assert.deepEqual(ucis(interpret('knight f3', START)), ['g1f3']);
});

test('from-to で指定', () => {
  assert.deepEqual(ucis(interpret('e2 e4', START)), ['e2e4']);
  assert.deepEqual(ucis(interpret('ジーワン エフスリー', START)), ['g1f3']);
});

test('駒名なしはポーン優先。ポーンで行けない行き先は駒を問わず探す', () => {
  assert.deepEqual(ucis(interpret('エフスリー', START)), ['f2f3']); // ポーン優先（Nf3 でもある）
  assert.deepEqual(ucis(interpret('c3', START)), ['c2c3']); // b1 のナイトも行けるがポーン優先
  // ポーンがいない局面で「e2」→ ナイトの g1e2 を返す
  assert.deepEqual(ucis(interpret('イーツー', legalOf('4k3/8/8/8/8/8/8/K5N1 w - - 0 1'))), ['g1e2']);
});

test('曖昧な手は複数候補を返し、絞り込みで1手になる', () => {
  const fen = '4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1';
  const legal = legalOf(fen);
  const r = interpret('ナイト d2', legal);
  assert.equal(r.kind, 'move');
  assert.deepEqual(ucis(r).sort(), ['b1d2', 'f3d2']);
  assert.deepEqual(ucis(interpret('b', r.moves, { choose: true })), ['b1d2']);
  assert.deepEqual(ucis(interpret('f3', r.moves, { choose: true })), ['f3d2']);
  assert.deepEqual(ucis(interpret('b ナイト d2', legal)), ['b1d2']);
});

test('キャスリング', () => {
  const legal = legalOf('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.deepEqual(ucis(interpret('キャスリング', legal)), ['e1g1']);
  assert.deepEqual(ucis(interpret('ショート キャスリング', legal)), ['e1g1']);
  assert.deepEqual(ucis(interpret('ロング キャスリング', legal)), ['e1c1']);
  assert.deepEqual(ucis(interpret('o-o-o', legal)), ['e1c1']);
  assert.equal(interpret('キャスリング', START).kind, 'none');
});

test('プロモーション（既定はクイーン）', () => {
  const legal = legalOf('8/4P3/8/8/8/8/8/k6K w - - 0 1');
  assert.deepEqual(ucis(interpret('e8', legal)), ['e7e8q']);
  assert.deepEqual(ucis(interpret('e8 ナイト', legal)), ['e7e8n']);
  assert.deepEqual(ucis(interpret('ポーン e8 ルーク', legal)), ['e7e8r']);
});

test('取る（x）とファイル指定', () => {
  const legal = legalOf('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  assert.deepEqual(ucis(interpret('e x d5', legal)), ['e4d5']);
  assert.deepEqual(ucis(interpret('イー とる ディー ゴ', legal)), ['e4d5']);
});

test('同じ響きのファイルの推測（1手に絞れるときだけ）', () => {
  const legal = legalOf('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
  const r = interpret('d3', legal); // d3 は不可。e3 だけが近い候補
  assert.equal(r.kind, 'move');
  assert.equal(r.guessed, true);
  assert.deepEqual(ucis(r), ['e2e3']);
  assert.equal(interpret('h5', legal).kind, 'none');
});

test('はい / いいえ / 投了', () => {
  assert.equal(interpret('はい', START).kind, 'yes');
  assert.equal(interpret('OK', START).kind, 'yes');
  assert.equal(interpret('いいえ', START).kind, 'no');
  assert.equal(interpret('やり直し', START).kind, 'no');
  assert.equal(interpret('投了', START).kind, 'resign');
  assert.equal(interpret('リザイン', START).kind, 'resign');
  assert.equal(interpret('はい、お願いします', START).kind, 'yes');
  assert.equal(interpret('投了します', START).kind, 'resign');
});

test('無関係な発話は none', () => {
  assert.equal(interpret('今日はいい天気ですね', START).kind, 'none');
  assert.equal(interpret('', START).kind, 'none');
});

test('読み上げ', () => {
  const m = (san, fen) => new Chess(fen).moves({ verbose: true }).find((x) => x.san === san);
  assert.equal(speakMove(m('Nf3')), 'ナイト、エフサン');
  assert.equal(speakMove(m('O-O', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')), 'ショートキャスリング');
  assert.equal(speakMove(m('exd5', '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1')), 'ポーン、ディーゴ、取る');
});
