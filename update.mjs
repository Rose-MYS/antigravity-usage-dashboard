#!/usr/bin/env node
// 升级到 GitHub 上的最新版本：npm run update
// 只做快进式更新（git pull --ff-only）；本地改过文件时停止，不会覆盖你的修改。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  git('--version');
} catch {
  fail('没有找到 git。请先安装 Git，或到 GitHub 下载最新版本：https://github.com/Rose-MYS/antigravity-usage-dashboard/releases');
}
try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  fail('当前目录不是用 git clone 下载的仓库，无法自动更新。请到 GitHub 下载最新版本：https://github.com/Rose-MYS/antigravity-usage-dashboard/releases');
}

const changed = git('status', '--porcelain', '--untracked-files=no');
if (changed) {
  fail(`以下文件有本地修改，为避免覆盖已停止更新：\n${changed}\n\n可以先备份并还原这些文件（git stash），再运行 npm run update。`);
}

const before = version();
const head = git('rev-parse', 'HEAD');
console.log(`当前版本 v${before}，正在检查更新…`);
try {
  git('fetch', '--tags', '--quiet');
  git('pull', '--ff-only', '--quiet');
} catch (error) {
  fail(`更新失败：${String(error.stderr || error.message).trim()}`);
}

if (git('rev-parse', 'HEAD') === head) {
  console.log('已经是最新版本。');
  process.exit(0);
}
const after = version();
console.log(after === before ? `已更新到最新代码（v${after}）。` : `已从 v${before} 更新到 v${after}。`);

// 装了后台服务就顺便重启，让新版本立即生效。
let restarted = false;
try {
  const status = execFileSync(process.execPath, [join(root, 'service.mjs'), 'status'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (/后台服务\s*已安装/.test(status)) {
    execFileSync(process.execPath, [join(root, 'service.mjs'), 'restart'], { cwd: root, stdio: 'inherit', windowsHide: true });
    restarted = true;
  }
} catch (error) {
  if (/后台服务\s*已安装/.test(String(error.stdout ?? ''))) {
    try {
      execFileSync(process.execPath, [join(root, 'service.mjs'), 'restart'], { cwd: root, stdio: 'inherit', windowsHide: true });
      restarted = true;
    } catch { /* 重启失败时下面会提示手动重启。 */ }
  }
}
if (!restarted) console.log('如果面板正在运行，请重新执行 npm start（或 npm run service:restart）让新版本生效。');
