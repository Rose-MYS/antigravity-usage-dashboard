# Antigravity Usage Dashboard

独立的本地用量面板，用来浏览 Antigravity 的 token 用量。打开面板即可查看四张总览卡、模型分组和会话详情。界面配色取自 Antigravity 彩色图标的蓝、绿、金黄和珊瑚红。

## 启动

安装 Node.js 20 或更新版本，然后克隆仓库并启动。

```sh
git clone https://github.com/Rose-MYS/antigravity-usage-dashboard.git
cd antigravity-usage-dashboard
npm start
```

打开 [http://127.0.0.1:8768](http://127.0.0.1:8768/)。默认显示上海时区的今日用量。项目使用 Node.js 自带模块，无需安装项目依赖。

默认读取 `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`。Windows PowerShell 中可设置自定义目录和端口：

```powershell
$env:ANTIGRAVITY_BRAIN_DIR = 'D:\path\to\brain'
$env:ANTIGRAVITY_DASHBOARD_PORT = '8768'
npm start
```

## 后台常驻与开机自启

不想每次都开着终端运行 `npm start`，可以把面板装成后台服务：

```sh
npm run service:install     # 安装并立即启动，会询问是否开启下面两项
npm run service:status      # 查看自启项、进程和访问地址
npm run service:logs        # 查看最近 50 行日志（可写 npm run service:logs -- 200）
npm run service:restart     # 重启后台服务
npm run service:stop        # 暂时停止
npm run service:uninstall   # 移除自启项并停止后台服务
```

安装时可以选择：

| 选项 | 默认 | 说明 |
|---|---|---|
| 登录后自动启动 | 开 | 开机或重新登录后自动运行面板 |
| 异常退出后自动重启 | 开 | 面板服务意外退出时自动拉起；关闭后，退出就停止 |

在终端里运行会逐项询问，直接回车使用默认值。也可以用参数跳过询问（npm 需在参数前加 `--`）：

```sh
npm run service:install -- --yes                       # 全部使用默认值
npm run service:install -- --no-autostart              # 只在后台运行，不开机自启
npm run service:install -- --autostart --no-keepalive  # 开机自启，但不自动重启
```

想改选项时，重新运行 `npm run service:install` 即可。

- **Windows**：注册一个当前用户的计划任务「Antigravity Usage Dashboard」。开启自启时在登录时启动；同时开启自动重启时，每 5 分钟巡检一次。程序通过 `wscript` 隐藏窗口运行，不弹黑框；使用电池时不会停止，也没有运行时长限制。无需管理员权限。
- **macOS**：写入 `~/Library/LaunchAgents/com.github.rose-mys.antigravity-usage-dashboard.plist`（`launchd`，`KeepAlive`）。
- **Linux**：写入 `~/.config/systemd/user/antigravity-usage-dashboard.service`（`systemd --user`，`Restart=always`）。如需在未登录时也运行，执行 `loginctl enable-linger`。

后台由一个守护进程拉起 `server.mjs`，开启自动重启时，面板服务异常退出后会在 1–30 秒内重新拉起；同一时间只会运行一个实例。端口已被手动运行的 `npm start` 占用时，守护进程会等待它退出后再接管。

安装时的 `ANTIGRAVITY_DASHBOARD_PORT` 和 `ANTIGRAVITY_BRAIN_DIR` 会被记住；修改后重新执行 `npm run service:install` 即可。日志、PID 和状态文件写在用户数据目录，不写入仓库：

| 系统 | 目录 |
|---|---|
| Windows | `%LOCALAPPDATA%\antigravity-usage-dashboard` |
| macOS | `~/Library/Application Support/antigravity-usage-dashboard` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/antigravity-usage-dashboard` |

日志超过 1 MB 会轮转为 `dashboard.log.1`，最多占用约 2 MB。移动仓库目录或升级 Node.js 后，请重新执行 `npm run service:install`。

## 更新到新版本

有新版本时，面板顶部会出现提示条。在项目目录运行：

```sh
npm run update
```

它会用 `git pull --ff-only` 拉取最新代码；如果你改过项目里的文件，会停下来提示，不会覆盖你的修改。装了后台服务时会自动重启，新版本立即生效；否则请重新运行 `npm start`。

- 面板大约每天联网检查一次 [GitHub Releases](https://github.com/Rose-MYS/antigravity-usage-dashboard/releases)，只读取最新版本号和更新说明，不上传任何数据。
- 不想联网检查：在设置中取消「有新版本时提醒我」，或启动前设置 `ANTIGRAVITY_DASHBOARD_UPDATE_CHECK=0`。
- 也可以在 GitHub 仓库页点 **Watch → Custom → Releases**，发版时收到 GitHub 通知。

## 查看用量

- 顶部显示总用量、输出用量、会话数和缓存命中率。使用快捷日期或自定义区间，按模型和时区筛选。
- 点击右上角的日期打开日历：左侧是快捷范围，日历格子里显示每天的 token 用量，点击两天即可选出区间（也可直接输入起止日期），底部显示本月和今年的合计。
- 点击「总用量」卡片，其他概览卡会切换成各模型的 token 用量和占比，卡片边框按各模型占比分段着色。再次点击或按 Esc 回到概览。模型用量按请求归集，并随日期、时区和模型筛选更新。
- 鼠标悬停在输出柱状图、圆环和模型卡上可查看具体数值。
- 左栏支持搜索模型或会话、按用量等字段排序，以及在模型分组和会话列表之间切换。模型分组把会话归入当前范围内用量最高的模型，每个会话只出现一次。
- 选择会话后，右栏显示未缓存输入、缓存输入和输出的构成，以及累计走势、模型明细和请求明细。走势图带坐标轴；悬停或用左右方向键可逐条查看请求的累计用量和单次用量。
- 页面可每 20 秒自动刷新。设置中也可以隐藏界面上的会话标题。

## 统计口径

- 一条有效的 `PLANNER_RESPONSE` 日志计为一次请求，按其记录时间归入所选时区和日期。
- 总用量等于未缓存输入、缓存输入和输出之和。缓存命中率等于缓存输入除以全部输入。没有输入时显示 `—`。
- 统计覆盖本机现存的上述日志，可能因 Antigravity 版本和日志保留范围而异。页面展示日志记录的用量与请求次数。
- 服务仅监听 `127.0.0.1`，只读本地日志。页面资源随项目提供，运行时无需 API 密钥。唯一的外部请求是检查新版本（可关闭，见上文）。

## 发布新版本（维护者）

1. 把 `package.json` 的 `version` 改高（如 `1.1.0` → `1.2.0`），提交并推送。
2. 打标签并推送：`git tag v1.2.0 && git push origin v1.2.0`。
3. 在 GitHub 上基于这个标签发布 Release，写几行更新说明（会显示在面板的提示里）。

只推送标签、不建 Release 也能触发提醒，但提示里不会有更新说明。平时的普通提交不改版本号，就不会打扰用户。

## 本地图标

如需在侧栏和浏览器标签页显示官方彩色图标，请下载 Antigravity 的 **Icon - Full Color** PNG，保存为 `web/antigravity.local.png` 后重启面板。该文件由本机服务读取，已加入 Git 忽略规则。缺少文件时，面板显示自带图标。Antigravity 品牌图标归 Google 所有。 [官方媒体素材](https://antigravity.google/press)

## 致谢

界面布局和交互参考 [luyh7/codex-usage-dashboard v1.1.4](https://github.com/luyh7/codex-usage-dashboard/tree/v1.1.4)。
