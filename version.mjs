// 检查 GitHub 上是否有新版本。只在页面请求时联网，结果缓存 12 小时；访问失败时静默跳过。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';

export const REPO = 'Rose-MYS/antigravity-usage-dashboard';
export const CURRENT = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const CACHE_MS = 12 * 3600 * 1000;
const RETRY_MS = 30 * 60 * 1000;

function parse(version) {
  const match = String(version ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

export function newer(candidate, current = CURRENT) {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// 很多用户通过系统代理访问 GitHub，而 Node 的 fetch 不会自动走系统代理，这里自己找代理并建立 HTTPS 隧道。
function systemProxy() {
  const fromEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .map((key) => process.env[key]).find((value) => value && (!value.includes('://') || /^https?:\/\//i.test(value)));
  if (fromEnv) return fromEnv.includes('://') ? fromEnv : `http://${fromEnv}`;
  try {
    if (process.platform === 'win32') {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
      const read = (name) => execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        .match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`))?.[1].trim();
      if (Number(read('ProxyEnable')) !== 1) return null;
      const server = read('ProxyServer') ?? '';
      const entries = Object.fromEntries(server.split(';').map((part) => part.includes('=') ? part.split('=') : ['all', part]));
      const target = entries.https || entries.http || entries.all;
      return target ? (target.includes('://') ? target : `http://${target}`) : null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const value = (name) => out.match(new RegExp(`${name}\\s*:\\s*(\\S+)`))?.[1];
      if (value('HTTPSEnable') === '1') return `http://${value('HTTPSProxy')}:${value('HTTPSPort')}`;
      if (value('HTTPEnable') === '1') return `http://${value('HTTPProxy')}:${value('HTTPPort')}`;
    }
  } catch { /* 读不到系统代理时直连。 */ }
  return null;
}

function viaProxy(url, proxy, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const via = new URL(proxy);
    const timer = setTimeout(() => reject(new Error('timeout')), 8000);
    const done = (fn) => (value) => { clearTimeout(timer); fn(value); };
    const tunnel = httpRequest({ host: via.hostname, port: via.port || 80, method: 'CONNECT', path: `${target.hostname}:443`, headers: { Host: `${target.hostname}:443` } });
    tunnel.on('error', done(reject));
    tunnel.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return done(reject)(new Error(`proxy ${res.statusCode}`));
      const req = httpsRequest(url, { headers, agent: false, createConnection: () => tlsConnect({ socket, servername: target.hostname }) }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', done(() => resolve({ status: response.statusCode, body })));
      });
      req.on('error', done(reject));
      req.end();
    });
    tunnel.end();
  });
}

async function direct(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  return { status: response.status, body: await response.text() };
}

async function github(path) {
  const url = `https://api.github.com/repos/${REPO}${path}`;
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'antigravity-usage-dashboard' };
  // 先直连（较新的 Node 遇到 HTTPS_PROXY 等环境变量时会自动走代理），失败后再通过系统代理建立隧道。
  let response;
  try {
    response = await direct(url, headers);
  } catch (error) {
    const proxy = systemProxy();
    if (!proxy) throw error;
    response = await viaProxy(url, proxy, headers);
  }
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`GitHub ${response.status}`);
  return JSON.parse(response.body);
}

async function latestRelease() {
  const release = await github('/releases/latest');
  if (release?.tag_name) {
    return { version: release.tag_name.replace(/^v/, ''), url: release.html_url, notes: String(release.body ?? '').slice(0, 2000), publishedAt: release.published_at };
  }
  // 还没有正式 Release 时，退而看版本标签。
  const tags = (await github('/tags?per_page=100')) ?? [];
  const best = tags.map((tag) => tag.name).filter(parse).sort((a, b) => (newer(a, b) ? -1 : newer(b, a) ? 1 : 0))[0];
  return best ? { version: best.replace(/^v/, ''), url: `https://github.com/${REPO}/releases/tag/${best}`, notes: '', publishedAt: null } : null;
}

export function createUpdateChecker({ enabled = true } = {}) {
  let cache = null;
  let checkedAt = 0;
  let failedAt = 0;
  let pending;

  async function refresh() {
    try {
      cache = await latestRelease();
      checkedAt = Date.now();
    } catch {
      failedAt = Date.now();
    }
  }

  return async function status() {
    const base = { current: CURRENT, repo: `https://github.com/${REPO}`, enabled };
    if (!enabled) return base;
    const stale = Date.now() - checkedAt > CACHE_MS && Date.now() - failedAt > RETRY_MS;
    if (stale) {
      pending ??= refresh().finally(() => { pending = undefined; });
      await pending;
    }
    return {
      ...base,
      checkedAt: checkedAt || null,
      latest: cache?.version ?? null,
      url: cache?.url ?? null,
      notes: cache?.notes ?? '',
      publishedAt: cache?.publishedAt ?? null,
      updateAvailable: Boolean(cache && newer(cache.version)),
    };
  };
}
