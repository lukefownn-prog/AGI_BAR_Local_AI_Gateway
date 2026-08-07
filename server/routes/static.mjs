/**
 * 靜態檔案（web/）。刻意限制在 web/ 目錄內，避免路徑穿越。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.resolve(paths.web, '.' + rel);
  if (!target.startsWith(paths.web + path.sep) && target !== paths.web) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(body);
  return true;
}
