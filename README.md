# Antigravity Usage Dashboard

在本机浏览 Antigravity 的 token 用量。打开面板即可查看四张总览卡、模型分组和会话详情。

## 启动

安装 Node.js 20 或更新版本，在仓库目录运行：

```sh
npm start
```

打开 [http://127.0.0.1:8768](http://127.0.0.1:8768/)。默认显示上海时区的今日用量。项目使用 Node.js 自带模块，无需安装项目依赖。

默认读取 `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`。Windows PowerShell 中可设置自定义目录和端口：

```powershell
$env:ANTIGRAVITY_BRAIN_DIR = 'D:\path\to\brain'
$env:ANTIGRAVITY_DASHBOARD_PORT = '8768'
npm start
```

## 查看用量

- 顶部显示总用量、输出用量、会话数和缓存命中率。使用快捷日期或自定义区间，按模型和时区筛选。
- 左栏支持搜索模型或会话、按用量等字段排序，以及在模型分组和会话列表之间切换。模型分组把会话归入当前范围内用量最高的模型，每个会话只出现一次。
- 选择会话后，右栏显示未缓存输入、缓存输入和输出的构成，以及累计走势、模型明细和请求明细。
- 页面可每 20 秒自动刷新。设置中也可以隐藏界面上的会话标题。

## 统计口径

- 一条有效的 `PLANNER_RESPONSE` 日志计为一次请求，按其记录时间归入所选时区和日期。
- 总用量等于未缓存输入、缓存输入和输出之和。缓存命中率等于缓存输入除以全部输入。没有输入时显示 `—`。
- 统计覆盖本机现存的上述日志，可能因 Antigravity 版本和日志保留范围而异。页面展示日志记录的用量与请求次数。
- 服务仅监听 `127.0.0.1`，只读本地日志。页面资源随项目提供，运行时无需 API 密钥或外部服务。

## 致谢

界面布局和交互参考 [luyh7/codex-usage-dashboard v1.1.4](https://github.com/luyh7/codex-usage-dashboard/tree/v1.1.4)。
