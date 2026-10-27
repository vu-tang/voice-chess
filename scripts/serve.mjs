// 開発用の静的サーバー: node scripts/serve.mjs [port]
// http://localhost:8000/?mock=1 で Lichess API をモック（tests/mock-lichess.js）に差し替えて動かせる。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const IMPORT_MAP = '<script type="importmap">{"imports":{"/js/lichess.js":"/tests/mock-lichess.js"}}</script>';

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      let body = await readFile(file);
      if (rel === '/index.html' && url.searchParams.has('mock')) {
        body = Buffer.from(body.toString('utf8').replace('<script type="module"', IMPORT_MAP + '\n  <script type="module"'));
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(port, () => console.log(`http://localhost:${port}/  （モック: /?mock=1）`));
