import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildUsage, readQuery, TranscriptSource } from './usage.mjs';

const port = Number(process.env.ANTIGRAVITY_DASHBOARD_PORT ?? process.env.PORT ?? 8768);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('端口必须为 1–65535。');
const host = '127.0.0.1';
const origin = `http://${host}:${port}`;
const brain = process.env.ANTIGRAVITY_BRAIN_DIR || join(homedir(), '.gemini', 'antigravity', 'brain');
const source = new TranscriptSource(brain);
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/dashboard.css', 'dashboard.css', 'text/css'],
  ['/dashboard.js', 'dashboard.js', 'text/javascript'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
].map(async ([url, file, type]) => [url, { type, content: await readFile(new URL(`./web/${file}`, import.meta.url)) }])));
const localIcon = await readFile(new URL('./web/antigravity.local.png', import.meta.url)).catch((error) => {
  if (error.code !== 'ENOENT') console.warn('无法读取本地 Antigravity 图标，将显示默认图标。');
  return null;
});
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
assets.set('/dashboard-icon', localIcon?.subarray(0, 8).equals(pngSignature)
  ? { type: 'image/png', content: localIcon }
  : assets.get('/favicon.svg'));

function send(res, status, content, type = 'application/json') {
  res.writeHead(status, { ...headers, 'Content-Type': `${type}; charset=utf-8` });
  res.end(type === 'application/json' ? JSON.stringify(content) : content);
}

const server = http.createServer(async (req, res) => {
  if (!([`${host}:${port}`, `localhost:${port}`].includes(req.headers.host))) {
    return send(res, 403, { error: '请使用本机地址访问面板。' });
  }
  if (req.method !== 'GET') return send(res, 405, { error: '仅支持 GET 请求。' });
  try {
    const url = new URL(req.url, origin);
    const asset = assets.get(url.pathname);
    if (asset) return send(res, 200, asset.content, asset.type);
    if (url.pathname === '/api/health') return send(res, 200, { app: 'antigravity-usage-dashboard' });
    if (url.pathname !== '/api/usage' && url.pathname !== '/api/session') return send(res, 404, { error: '页面不存在。' });

    let query;
    try { query = readQuery(url.searchParams); } catch (error) { return send(res, 400, { error: error.message }); }
    const id = url.pathname === '/api/session' ? url.searchParams.get('id') : undefined;
    if (url.pathname === '/api/session' && !id) return send(res, 400, { error: '缺少会话 ID。' });
    const data = buildUsage(await source.read(), query, id);
    return data ? send(res, 200, data) : send(res, 404, { error: '当前筛选范围内没有此会话。' });
  } catch (error) {
    console.error('读取用量失败', error.code || error.name);
    return send(res, 500, { error: '读取本地用量失败，请检查日志目录的读取权限。' });
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用。请设置 ANTIGRAVITY_DASHBOARD_PORT。` : error.message);
  process.exitCode = 1;
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`收到 ${signal}，正在关闭面板服务…`);
  server.close(() => process.exit(process.exitCode ?? 0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
process.on('uncaughtException', (error) => {
  console.error('未处理的异常：', error?.stack || error);
  process.exitCode = 1;
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝：', reason?.stack || reason);
  process.exitCode = 1;
  shutdown('unhandledRejection');
});

server.listen(port, host, () => console.log(`Antigravity Usage Dashboard · ${origin}/`));
