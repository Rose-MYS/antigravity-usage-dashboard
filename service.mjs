#!/usr/bin/env node
// 后台常驻与开机自启：node service.mjs <install|uninstall|status|start|stop|restart|logs|run>
// install 可选参数：--autostart / --no-autostart（登录后自动启动）、--keepalive / --no-keepalive（异常退出后自动重启）、--yes（全部使用默认值）
// 只使用 Node.js 自带模块和系统自带的任务调度（Windows 计划任务、macOS launchd、Linux systemd --user）。
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const APP = 'antigravity-usage-dashboard';
const TASK = 'Antigravity Usage Dashboard';
const LABEL = 'com.github.rose-mys.antigravity-usage-dashboard';
const root = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const platform = process.platform;
const LOG_LIMIT = 1024 * 1024;
const RESTART_DELAYS = [1000, 2000, 5000, 10000, 30000];

function dataDir() {
  if (process.env.ANTIGRAVITY_DASHBOARD_HOME) return process.env.ANTIGRAVITY_DASHBOARD_HOME;
  if (platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), APP);
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP);
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), APP);
}

const dir = dataDir();
const files = {
  config: join(dir, 'config.json'),
  state: join(dir, 'state.json'),
  lock: join(dir, 'supervisor.lock'),
  log: join(dir, 'dashboard.log'),
  launcher: join(dir, 'launch.vbs'),
  taskXml: join(dir, 'task.xml'),
  plist: join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
  unit: join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user', `${APP}.service`),
};

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function config() {
  const saved = readJson(files.config, {});
  return {
    port: Number(process.env.ANTIGRAVITY_DASHBOARD_PORT ?? saved.port ?? 8768),
    brainDir: process.env.ANTIGRAVITY_BRAIN_DIR ?? saved.brainDir ?? '',
    autostart: saved.autostart ?? true,
    keepalive: saved.keepalive ?? true,
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function health(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', timeout, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).app === APP ? 'ours' : 'other'); } catch { resolve('other'); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', (error) => resolve(error.code === 'ECONNREFUSED' ? 'free' : 'other'));
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function tryRun(command, args) {
  try { return { ok: true, output: run(command, args) }; } catch (error) { return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }; }
}

// ---------- 日志（超过 1 MB 轮转，保留一份旧日志） ----------
function log(line) {
  mkdirSync(dir, { recursive: true });
  try {
    if (statSync(files.log).size > LOG_LIMIT) renameSync(files.log, `${files.log}.1`);
  } catch { /* 首次写入时日志还不存在。 */ }
  appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
}

function pipeLines(stream, prefix) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) if (line) log(`${prefix}${line}`);
  });
  stream.on('end', () => { if (rest) log(`${prefix}${rest}`); });
}

// ---------- 守护进程：拉起 server.mjs，退出后自动重启 ----------
function acquireLock() {
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(files.lock, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(readFileSync(files.lock, 'utf8'));
      if (alive(owner) && owner !== process.pid) return false;
      rmSync(files.lock, { force: true });
    }
  }
  return false;
}

async function supervise() {
  const { port, brainDir, keepalive } = config();
  if (!acquireLock()) {
    console.log('守护进程已在运行。');
    return;
  }
  const releaseLock = () => {
    if (Number(readFileSync(files.lock, 'utf8')) === process.pid) rmSync(files.lock, { force: true });
  };
  let child;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log('守护进程收到停止信号。');
    child?.kill();
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => {
    try { releaseLock(); } catch { /* 锁文件可能已被卸载命令删除。 */ }
    writeJson(files.state, { ...readJson(files.state, {}), supervisor: null, server: null, stoppedAt: Date.now() });
  });

  log(`守护进程启动（PID ${process.pid}，端口 ${port}，自动重启${keepalive ? '开' : '关'}）。`);
  let failures = 0;
  while (!stopping) {
    const owner = await health(port);
    if (owner !== 'free') {
      // 端口已被占用：可能是手动运行的 npm start，或其他程序。等待它释放后再接管。
      writeJson(files.state, { supervisor: process.pid, server: null, port, waiting: owner, updatedAt: Date.now() });
      await sleep(15000);
      continue;
    }
    const env = { ...process.env, ANTIGRAVITY_DASHBOARD_PORT: String(port) };
    if (brainDir) env.ANTIGRAVITY_BRAIN_DIR = brainDir;
    const startedAt = Date.now();
    child = spawn(node, [join(root, 'server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    writeJson(files.state, { supervisor: process.pid, server: child.pid, port, startedAt, updatedAt: Date.now() });
    pipeLines(child.stdout, '');
    pipeLines(child.stderr, '[stderr] ');
    const code = await new Promise((resolve) => {
      child.on('exit', (exitCode, signal) => resolve(signal ?? exitCode));
      child.on('error', (error) => { log(`无法启动面板服务：${error.message}`); resolve('error'); });
    });
    child = undefined;
    if (stopping) break;
    if (!keepalive) {
      log(`面板服务已退出（${code}）。未开启自动重启，守护进程退出。`);
      break;
    }
    if (Date.now() - startedAt > 60000) failures = 0;
    const delay = RESTART_DELAYS[Math.min(failures, RESTART_DELAYS.length - 1)];
    failures++;
    log(`面板服务已退出（${code}），${delay / 1000} 秒后重启。`);
    await sleep(delay);
  }
}

// ---------- 各平台的自启配置 ----------
function xml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function windowsUser() {
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${userInfo().username}` : userInfo().username;
}

function installWindows({ autostart, keepalive }) {
  // wscript 以隐藏窗口运行守护进程并等待它；守护进程一旦退出，任务结束，下一次 5 分钟巡检会重新拉起。
  const quote = (value) => `""${value}""`;
  writeFileSync(files.launcher, [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = "${root}"`,
    `WScript.Quit shell.Run("${quote(node)} ${quote(join(root, 'service.mjs'))} run", 0, True)`,
    '',
  ].join('\r\n'));
  const user = xml(windowsUser());
  const start = new Date(Date.now() + 60000).toISOString().slice(0, 19);
  // 登录触发器负责自启；5 分钟巡检只在同时开启自启和自动重启时添加，否则重启电脑后它也会把服务拉起来。
  const triggers = autostart ? `  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${user}</UserId></LogonTrigger>${keepalive ? `
    <TimeTrigger>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>${start}</StartBoundary><Enabled>true</Enabled>
    </TimeTrigger>` : ''}
  </Triggers>` : '  <Triggers/>';
  const task = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Antigravity Usage Dashboard 后台服务（http://127.0.0.1:${config().port}）</Description></RegistrationInfo>
${triggers}
  <Principals><Principal id="Author"><UserId>${user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>wscript.exe</Command><Arguments>//B //Nologo "${xml(files.launcher)}"</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec>
  </Actions>
</Task>
`;
  writeFileSync(files.taskXml, '\ufeff' + task, 'utf16le');
  run('schtasks.exe', ['/Create', '/TN', TASK, '/XML', files.taskXml, '/F']);
  run('schtasks.exe', ['/Run', '/TN', TASK]);
}

function installMac({ autostart, keepalive }) {
  const { port, brainDir } = config();
  const env = { ANTIGRAVITY_DASHBOARD_PORT: String(port), ...(brainDir ? { ANTIGRAVITY_BRAIN_DIR: brainDir } : {}) };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(root, 'service.mjs'))}</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><${autostart}/>
  <key>KeepAlive</key><${keepalive}/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>${xml(join(dir, 'launchd.log'))}</string>
</dict></plist>
`;
  mkdirSync(dirname(files.plist), { recursive: true });
  writeFileSync(files.plist, plist);
  const target = `gui/${process.getuid()}`;
  tryRun('launchctl', ['bootout', target, files.plist]);
  run('launchctl', ['bootstrap', target, files.plist]);
  if (!autostart) run('launchctl', ['kickstart', `${target}/${LABEL}`]);
}

function installLinux({ autostart, keepalive }) {
  const { port, brainDir } = config();
  const quote = (value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const unit = `[Unit]
Description=Antigravity Usage Dashboard (http://127.0.0.1:${port})

[Service]
ExecStart=${quote(node)} ${quote(join(root, 'service.mjs'))} run
WorkingDirectory=${root}
Environment=ANTIGRAVITY_DASHBOARD_PORT=${port}
${brainDir ? `Environment=${quote(`ANTIGRAVITY_BRAIN_DIR=${brainDir}`)}\n` : ''}Restart=${keepalive ? 'always' : 'no'}
RestartSec=5

[Install]
WantedBy=default.target
`;
  mkdirSync(dirname(files.unit), { recursive: true });
  writeFileSync(files.unit, unit);
  run('systemctl', ['--user', 'daemon-reload']);
  if (autostart) run('systemctl', ['--user', 'enable', '--now', `${APP}.service`]);
  else {
    tryRun('systemctl', ['--user', 'disable', `${APP}.service`]);
    run('systemctl', ['--user', 'restart', `${APP}.service`]);
  }
}

function installed() {
  if (platform === 'win32') return tryRun('schtasks.exe', ['/Query', '/TN', TASK]).ok;
  if (platform === 'darwin') return existsSync(files.plist);
  return existsSync(files.unit);
}

async function stopProcesses() {
  const state = readJson(files.state, {});
  const lockOwner = Number(readJson(files.lock, NaN));
  for (const pid of [state.supervisor, lockOwner, state.server]) {
    if (alive(pid) && pid !== process.pid) {
      try { process.kill(pid); } catch { /* 进程已退出。 */ }
    }
  }
  for (let i = 0; i < 20 && [state.supervisor, state.server].some(alive); i++) await sleep(150);
  rmSync(files.lock, { force: true });
}

// ---------- 命令 ----------
async function waitFor(port, expected, ms) {
  for (let waited = 0; waited < ms; waited += 300) {
    if (await health(port) === expected) return true;
    await sleep(300);
  }
  return false;
}

function flag(args, name) {
  if (args.includes(`--${name}`)) return true;
  if (args.includes(`--no-${name}`)) return false;
  return undefined;
}

async function ask(rl, question, fallback) {
  const answer = (await rl.question(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  if (!answer) return fallback;
  return ['y', 'yes', '是', '好'].includes(answer);
}

async function installOptions(args) {
  const saved = config();
  const options = { autostart: flag(args, 'autostart'), keepalive: flag(args, 'keepalive') };
  const unknown = args.filter((arg) => !['--autostart', '--no-autostart', '--keepalive', '--no-keepalive', '--yes', '-y'].includes(arg));
  if (unknown.length) throw new RangeError(`未知参数：${unknown.join(' ')}`);
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.includes('--yes') && !args.includes('-y');
  if (interactive && Object.values(options).includes(undefined)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`将在后台运行面板：http://127.0.0.1:${saved.port}/`);
      options.autostart ??= await ask(rl, '登录系统后自动启动面板？', saved.autostart);
      options.keepalive ??= await ask(rl, '面板异常退出后自动重启？', saved.keepalive);
    } finally {
      rl.close();
    }
  }
  return { autostart: options.autostart ?? saved.autostart, keepalive: options.keepalive ?? saved.keepalive };
}

async function install(args = []) {
  const { port, brainDir } = config();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('端口必须为 1–65535。');
  const options = await installOptions(args);
  if (installed()) {
    if (platform === 'win32') tryRun('schtasks.exe', ['/End', '/TN', TASK]);
    await stopProcesses();
  }
  mkdirSync(dir, { recursive: true });
  writeJson(files.config, { port, brainDir, ...options, root, node, installedAt: new Date().toISOString() });
  if (platform === 'win32') installWindows(options);
  else if (platform === 'darwin') installMac(options);
  else installLinux(options);
  const ok = await waitFor(port, 'ours', 15000);
  console.log(ok ? `已启动后台服务：http://127.0.0.1:${port}/` : `已安装后台服务，但 ${port} 端口暂未响应。请运行 npm run service:status 查看。`);
  console.log(`登录后自动启动：${options.autostart ? '开' : '关'}　异常退出后自动重启：${options.keepalive ? '开' : '关'}`);
  console.log('之后想修改，重新运行 npm run service:install 即可。');
  if (platform === 'linux' && options.autostart) console.log('提示：如需在未登录时也保持运行，可执行 loginctl enable-linger。');
}

async function uninstall() {
  if (platform === 'win32') tryRun('schtasks.exe', ['/Delete', '/TN', TASK, '/F']);
  else if (platform === 'darwin') {
    tryRun('launchctl', ['bootout', `gui/${process.getuid()}`, files.plist]);
    rmSync(files.plist, { force: true });
  } else {
    tryRun('systemctl', ['--user', 'disable', '--now', `${APP}.service`]);
    rmSync(files.unit, { force: true });
    tryRun('systemctl', ['--user', 'daemon-reload']);
  }
  await stopProcesses();
  for (const file of [files.config, files.state, files.launcher, files.taskXml]) rmSync(file, { force: true });
  console.log(`已移除自启项并停止后台服务。日志保留在 ${dir}，可手动删除。`);
}

async function start() {
  if (!installed()) {
    console.log('尚未安装后台服务，请先运行 npm run service:install。');
    process.exitCode = 1;
    return;
  }
  if (platform === 'win32') run('schtasks.exe', ['/Run', '/TN', TASK]);
  else if (platform === 'darwin') {
    tryRun('launchctl', ['bootstrap', `gui/${process.getuid()}`, files.plist]);
    tryRun('launchctl', ['kickstart', `gui/${process.getuid()}/${LABEL}`]);
  }
  else run('systemctl', ['--user', 'start', `${APP}.service`]);
  const { port } = config();
  console.log(await waitFor(port, 'ours', 15000) ? `后台服务已运行：http://127.0.0.1:${port}/` : '已发出启动请求，但端口暂未响应。');
}

async function stop() {
  if (platform === 'win32') tryRun('schtasks.exe', ['/End', '/TN', TASK]);
  else if (platform === 'darwin') tryRun('launchctl', ['bootout', `gui/${process.getuid()}`, files.plist]);
  else tryRun('systemctl', ['--user', 'stop', `${APP}.service`]);
  await stopProcesses();
  const { autostart, keepalive } = config();
  console.log(!installed() || !autostart ? '后台服务已停止。'
    : platform === 'win32' && keepalive ? '后台服务已停止。登录自启仍开启，巡检会在 5 分钟内重新启动它；如需彻底停用请运行 npm run service:uninstall。'
    : '后台服务已停止，下次登录时会重新启动。');
}

async function status() {
  const cfg = config();
  const { port, brainDir } = cfg;
  const state = readJson(files.state, {});
  const owner = await health(port);
  const lines = [
    ['后台服务', installed() ? '已安装' : '未安装'],
    ['登录自启', installed() ? (cfg.autostart ? '开' : '关') : '—'],
    ['自动重启', installed() ? (cfg.keepalive ? '开' : '关') : '—'],
    ['守护进程', alive(state.supervisor) ? `运行中（PID ${state.supervisor}）` : '未运行'],
    ['面板服务', alive(state.server) ? `运行中（PID ${state.server}）` : '未运行'],
    ['访问地址', owner === 'ours' ? `http://127.0.0.1:${port}/ 可访问` : owner === 'other' ? `${port} 端口被其他程序占用` : `${port} 端口无响应`],
    ['日志来源', brainDir || '默认（~/.gemini/antigravity/brain）'],
    ['运行文件', dir],
    ['日志', files.log],
  ];
  for (const [label, value] of lines) console.log(`${label.padEnd(5, '　')}  ${value}`);
  if (owner !== 'ours') process.exitCode = 1;
}

function logs() {
  const lines = Number(process.argv[3]) || 50;
  try {
    console.log(readFileSync(files.log, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'));
  } catch {
    console.log(`还没有日志：${files.log}`);
  }
}

const commands = { install: () => install(process.argv.slice(3)), uninstall, start, stop, status, logs, run: supervise, restart: async () => { await stopProcesses(); await start(); } };
const command = commands[process.argv[2]];
if (!command) {
  console.log('用法：node service.mjs <install [--autostart|--no-autostart] [--keepalive|--no-keepalive] [--yes]|uninstall|status|start|stop|restart|logs [行数]>');
  process.exitCode = 1;
} else {
  try {
    await command();
  } catch (error) {
    console.error(error.stderr?.trim() || error.message);
    process.exitCode = 1;
  }
}
