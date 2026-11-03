# 设计审阅与精简记录（2026-11-03）

本轮目标：审阅设计文档，按「精简」优化代码内容，再决定下一步。

## 1. 审阅方式

仓库没有独立的设计文档，实际被审的是四份：

| 文档 | 行数 | 覆盖内容 |
| --- | --- | --- |
| `README.md` | 346 | 面向使用者：功能、构建、配置、实现原理 |
| `HANDOVER.md` | 281 | 面向接手者：架构、模块表、调试要点、陷阱 |
| `dsh-plugin/README.md` | 198 | 插件契约、路由、注入内容 |
| `docs/ua-banner-finding.md` | 82 | UA 横幅归因实验 |

`/code-base-design` 技能在本会话不可用（技能目录中不存在该名字），故按人工等价方式推进：
三条只读审计线并行（服务/IPC 层、插件 JS 层、文档漂移层），全部要求 `file:line` 证据；
结论逐条回贴源码核对后才动手。

## 2. 最重要的发现：设计文档里有一条「假需求」

文档曾写「**部署要求：两个 exe 必须放在同一目录**」，并据此产出 `BubbleAsk.Service.exe`。
追溯需求来源：用户只要求「维护一个统一的后端服务，桌面端和 dsh 插件都通过这个服务来唤起浏览器」——
**是「一个服务角色」，不是「两个文件」**。拆成两个 exe 是实现的自主选择，却被写成了部署约束。

由此得到的教训写进本文件：**实现选择不得升级为需求描述**。文档里每一条「要求」都应能追到原始诉求或代码事实。

处理：合并为一个 exe + `--service` 模式（见 §3）。

## 3. 代码精简（已完成）

### 3.1 一个可执行文件，两种身份

- `BubbleAsk.exe` 无参 = 托盘界面；`--service` = 无界面后台服务。单实例靠互斥锁，不靠文件名。
- 消除的失败模式：「两个文件版本错配」「必须同目录部署」「只拷了其中一个」。
- 代价：编译器不再阻止 `src/ui` 直接 new 引擎对象。用 `build.ps1` 末尾一道 Lint 兜底
  （`src/ui/*.cs` 出现 `ChatDriver` / `CdpClient` / `EdgeHost` 即构建失败），比原方案更显式。

### 3.2 删掉的死代码（IPC 层）

| 删除项 | 理由 |
| --- | --- |
| `open` 命令全链路（`EngineClient.OpenAsync`、`PipeHost.OpenAsync`、`IIpcHost.OpenAsync`、`DispatchAsync` 分支） | 托盘与插件都不发它；`ChatDriver.OpenAsync` 仅被自身内部调用，保留 |
| `state` 命令 | 只是 `health` 的别名，没有任何发送方 |
| `PipeServer` 对 `IpcContract` 的 6 个纯转发成员 | 直接引用 `IpcContract`，少一层无意义间接 |
| `EngineClient` 每次命令先 `EnsureRunning`（内部再 ping） | 改为「直接发，失败才拉起并重试一次」，每条命令少一次往返 |
| `DispatchAsync` 里 5 份 `TryBegin/try/finally/End` | 提取 `RunExclusive(what, body)` |
| 插件 `ask-client.mjs` 的 `shutdown()` 空实现 | 断开租约就是全部清理动作 |
| 插件 `ask-client.mjs` 第二份 socket+分行逻辑 | 合并为 `exchange()`，`request()`/`attachLease` 共用 |
| `renderNativeTrace()`、`buildPrefillUrl()` | 生产路径从不调用（前者只服务过一次格式对照实验） |

### 3.3 契约修正

- 插件的 prompt 路由在通信模块缺失时返回 **503**，而 Client 端对非 2xx 直接抛错 ——
  于是响应里附带的 `prompt` 永远到不了界面，「复制全文」这条逃生口是死的。
  改为 `200 + { ok: false }`，状态交给 body 表达。
- `package.json` 的 `dsh.client.inject` 仍声明从未使用的 `@deepseek-ai/dsh-client-ui-sidebar-right`，删除。

### 3.4 实测修掉的两个真 bug

1. **管道收尾把成功的请求变成失败**：`SendRaw` 用三层 `using`（pipe → writer → reader），
   释放顺序相反 —— `StreamReader.Dispose()` 先关管道，`StreamWriter.Dispose()` 再 flush 已关闭的管道，
   抛 `ObjectDisposedException: 无法访问关闭的管道`。后果是托盘 50 次探活全部「失败」，
   服务因无人持租约在 8 秒后自杀。改为手工按 写→读→管道 顺序释放，并吞掉释放期异常。
2. **冷启动空等 5 秒**：服务未运行时 `Connect(5000)` 会一直重试到超时（`Connect` 对不存在的管道
   同样抛「操作已超时」，不能靠异常区分）。改为先读发现文件判断 pid 是否存活，再决定是否连接。
   实测冷启动从 5.8 秒降到 0.77 秒。

### 3.5 补做的两项验证（已完成）

1. **真实发送端到端**：走插件真实客户端 `sendPrompt`，返回 `{ ok: true, stage: "sent" }`，耗时 2496 ms；
   日志依次为 `注入输入框结果: textarea` → `发送按钮回读: clicked: ds-button ds-button--primary …` →
   `发送校验结果: sent`。此前只验证到 `filled`。
2. **轨迹噪声改用 `source.kind` 判别**：不再靠正则黑名单猜 Harness 的文案。DSH 给每条
   `user/message` 都写了 `source.kind`，真实用户消息是 `user`，注入的是 `time-context` /
   `runtime-context` / `skill-catalog` / `agent-message` / `agent-instructions` /
   `compact-checkpoint` 等。扫本机 75 个会话计 895 条 user 消息：`kind === 'user'` 的 315 条正是
   用户原话，其余 580 条全是注入。实测过滤结果：注入泄漏 0 条、用户原话误丢 0 条；
   拿不到 `source` 的旧会话仍退回原正则黑名单。

## 4. 文档漂移修正（已完成）

按 `file:line` 证据逐条改正，代表性的几条：

- `README.md` 项目结构树原本是扁平的 `src/*.cs`，实际早已分 5 个子目录（shared 8 / engine 3 / service 3 / ui 12 / tests 1）；重画并补上缺失的 6 个文件。
- 构建产物表与部署要求整段重写；`HANDOVER.md` 的「编译两个 exe」「同一份源码」两处错误同步改正。
- 浏览器探测顺序两处写作五种、一处写六种（漏 Chromium），统一为六种。
- `?q=` 回退条件写宽了：实际只有 `null` / `noaction` / `filllost` / `nobox` 才回退，`pending-*`、`unverified` 明确不回退（否则同一句话会发两遍）。
- 自测覆盖被写成「400/403/404/413/422」，实际只断言 401 与 404。
- `LastStatus` 的取值集合、`EdgeHost.IsRunning` 是否有调用方、`maxHits` / `hitWindowChars` 的默认值，均按代码改正。
- 自测项数「103」改为「约 104」（静态计 107 处 `Check`，健康机器约 3 处不执行）。

## 5. 仍未验证 / 已知遗留

- 托盘全局热键 `Ctrl+Alt+Q/A/D` 在改成 `EngineClient` 之后未手动回归。
- `send-image`（截图提问）经管道未验证。
- 轨迹相关性仍可能选中与本轮无关的消息（如 `m62`、`m862`）：注入的消息已按 `source.kind` 排除了，但「用户真说过、只是与本轮无关」的消息仍需相关性打分来处理。
- `PipeServer` 的命名管道最大实例数需确认：若为 1，长 `send`（读超时 180s）期间第二个客户端连接会失败。
- 服务未注册开机自启；无安装/分发路径。

## 6. 下一步的建议

按「对用户价值 ÷ 工作量」排序：

1. 分发：把 `dist\BubbleAsk.exe` 做成可安装产物（现在是裸 exe）。
