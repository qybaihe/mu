---
title: 排错
summary: mu 启动不了、连不上模型，或者判定器好像什么都没做时，该检查什么。
---

先运行 `mu doctor`，或在会话里用 `/doctor`：它检查安装、模型、判定器和各项连接，并告诉你要修什么。在桌面端，日志在「设置 → 关于」里，点一下就能打开。

如果这些都没用，请[提一个 issue](https://github.com/qybaihe/mu/issues/new/choose)，附上版本、平台和 `mu doctor` 的输出。

## 安装和启动 {#install}

**`mu needs Node >= 22.19 (found v20…)`。** 命令行需要 Node.js 22.19 或更新：`nvm install 24`，或者用你系统的包。桌面端自带 Node.js，什么都不需要装。

**Windows 显示 SmartScreen 警告。** Windows 版还没有代码签名。选**更多信息**，再选**仍要运行**。每个下载文件的校验和都在发布页的 `SHA256SUMS` 里。

**Windows：对话里说缺少 Git for Windows。** mu 在 Windows 上用 POSIX shell 运行命令。装上 [Git for Windows](https://git-scm.com/download/win)，再开一个新对话。

## 模型和网络 {#models}

**没有设置模型。** 运行 `mu setup`，或者用桌面端的新手引导：粘贴一个 API key，或者用订阅登录。

**桌面端里出现「User location is not supported」或请求超时，终端里却正常。** 模型的服务拒绝了你所在网络的地区，或者桌面端没看到你的网络代理。没有设置 `HTTPS_PROXY` 时，桌面端会跟随系统代理；检查代理是否打开，或者为 mu 设置 `HTTPS_PROXY`。

## 判定器 {#judge}

**判定器好像什么都没做。** 处于影子模式的判定点只记录判定，不改变任何东西；关闭的判定点根本不问。`/status` 显示每个判定点的模式；看看 `~/.mu/agent/mu.json` 里有没有 `"default": "shadow"` 或 `"off"`，或者你的环境里有没有 `MU_JUDGE_MODE`。

**「还没有可用的判定器，所以每一步都先问你。」** 在「判定模式」下，没有判定器能回答时，mu 会对每一个需要审批的步骤都问你：没有密钥且免费的 Jev 不可用、账户额度用完，或者只有本地判定器 Laya，而 Laya 不被信任来审批。设置一个 Jev 密钥（`mu setup`），或者用 `/permissions` 切换模式。

**免费的 Jev 不再回答了。** 它是 OpenCode Zen 的限时活动，结束时 mu 会告诉你。为某个 [Jev 服务](@docs/judges#jev)设置密钥，或者选另一个判定器。

**判定很慢。** 每个判定点都有时限，超时后 mu 不等判定继续往下；不会有什么卡很久。`mu ledger --json` 显示每次判定的延迟。慢的或远的判定器可以用 `routes` 按判定点替换。

**本地判定器要下载模型。** Laya 的模型约 930 MB；只有你同意后，mu 才会在 `mu judge setup` 里或桌面端里下载它。

**mude 1.0 没有回答。** `mu judge mude status` 显示它的服务是否在运行，`mu judge mude start` 启动它；`mu doctor` 会检查服务和它的密钥。在它能回答之前，由排在它后面的判定器回答；如果用了 `--local-only`，每个决策按兜底规则处理。

**mude 1.0 安装中途停了。** 再运行一次 `mu judge mude install`，或者在桌面端点**继续安装**：会从已经下载的部分接着装。

## 从头开始 {#reset}

`mu setup` 会先把它要改的每个文件复制到 `~/.mu/backups/<time>/`。要重置 mu 自己的设置，把 `~/.mu/agent/mu.json` 移走；mu 会用默认值启动。会话、登录和经验是单独的文件，都会保留。
