# voice-chess

声で指す Lichess。ブラウザだけで動く静的サイト（GitHub Pages 想定）。Lichess の CPU（AI）と対局する。姉妹: `..\lichess-cli\`（ターミナル版・パズル）。

## 現在の状況（2026-10-27）
- **CPU 対局まで実装済み**: ログイン（OAuth PKCE）→ 強さ・色・持ち時間を選んで対局開始 → 盤面表示・音声/クリック/文字入力で指す → 相手の手を読み上げ → 投了/中止。進行中の対局があればログイン時に再開。
- **確認済み**: 指し手の解釈（`tests\voice.test.mjs` 14 件通過）と、モック API（`/?mock=1`）での画面・対局フロー（白/黒、確認・取り消し、クリック、投了）を Chrome で確認。
- **未確認**: 実際の Lichess でのログイン・対局、実マイク（Web Speech API）での認識精度、GitHub Pages への公開。
  - `POST /api/challenge/ai` に必要なスコープは `challenge:write` と想定して `board:play` と合わせて要求している（**未確認**。拒否されたらここを疑う）。
- 人間との対局（シーク・チャレンジ）は未実装。
- 成りは画面クリックだとクイーン固定（音声は「イー エイト ナイト」で指定可）。

## 使い方
- ローカル: `node scripts/serve.mjs` → http://localhost:8000/ （Lichess へ実際にログインして動く。`localhost` ならマイクも使える）
- モック: http://localhost:8000/?mock=1 （ログイン不要・ランダムに指す相手。画面と音声の流れの確認用）
- テスト: `npm test`（= `node --test tests/voice.test.mjs`）
- マイク: Chrome / Edge。音声はブラウザ提供元のクラウドで認識される（完全ローカルではない）。マイクなしでも下の入力欄で同じ解釈を試せる。

## 構成
| ファイル | 役割 |
|---|---|
| `index.html` / `style.css` | 画面 |
| `js\app.js` | 画面制御・対局の同期・音声の流れ（確認・曖昧さの聞き返し） |
| `js\voice.js` | 認識文字列 → 指し手/コマンド。合法手との照合（LLM 不使用）。DOM 非依存 |
| `js\lichess.js` | OAuth PKCE、Board API、NDJSON ストリーム |
| `vendor\chess.js` | chess.js 1.4.0（BSD-2、ESM 版を同梱。CDN 不使用） |
| `tests\` | 解釈のテスト、API モック |
| `scripts\serve.mjs` | 開発用サーバー（`?mock=1` で import map によりモックへ差し替え） |

## 解釈の仕組み（`voice.js`）
1. 正規化（全角→半角・カタカナ→ひらがな・空白除去）→ 辞書の最長一致でトークン化（ファイル/数字/駒/取る/はい/いいえ/投了）。
2. 合法手から行き先・駒・出発ファイルで絞る。駒名なしはポーン優先、無ければ駒を問わず探す。
3. 1 手に絞れなければ聞き返し（「b」「b1」だけの返答で絞り込み）。
4. 0 手のときだけ、b/c/d/e/g・a/f/h の聞き間違いを置換して**ちょうど 1 手**になれば「もしかして」で提案（必ず確認）。
5. 認識の複数候補（最大 5）を順に試す。雑談の「はい」で確定しないよう、辞書に載る文字が 35% 未満の発話のコマンドは無効。
- 確認は既定で ON（Lichess は指した手を取り消せないため）。投了は常に確認。

## GitHub Pages に載せるとき
- リポジトリ直下をそのまま公開（`index.html` が入口、ビルド不要）。`https` なのでマイクも使える。
- OAuth のリダイレクト先は `location.origin + location.pathname`（例 `https://<user>.github.io/<repo>/`）。Lichess は PKCE の client_id/redirect を事前登録不要。
- トークンは `sessionStorage` のみ（タブを閉じると消える）。設定（確認・読み上げ・強さなど）だけ `localStorage`。
