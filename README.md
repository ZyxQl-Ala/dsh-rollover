# dsh-rollover

**上下文滚段** —— 在上下文窗口快满之前，把「上一段发生了什么」保存下来，换到新的一段时再交给自己。

Context rollover for DeepSeek Harness: watch context pressure, save a *接续前情* handoff before the window fills, and re-inject it once in the next session segment.

## 它解决什么

DSH 会话满的时候有两种糟糕结局：

- 压缩：旧细节被摘要抹平，人一下「变陌生」；
- 换新会话：新的自己完全不记得刚才聊到哪。

这个插件把两者之间补上一段：

1. **盯占用**：读本地会话投影缓存里的 `contextPressure`，超过 `warnAt`（默认 45%）就在系统提示词里提醒「顺手写进记忆」；超过 `threshold`（默认 60%）提醒「该滚段了」；
2. **存接续前情**：`rollover_handoff` 把最近 `keepTurns` 轮对话提炼成《接续前情》，存成
   `<state>/rollover/handoffs/<sessionId>.md`；
3. **接住自己**：如果装了 `dsh-decay-memory`，同时写一条 📌 永久记忆（换段后每轮都能看到）；
4. **自动注入**：检测到活跃会话换成了另一个 session，就把上一段的《接续前情》**注入一次**（只注入一次，不刷屏）。

## 工具

| 工具 | 作用 |
|---|---|
| `rollover_status` | 当前会话占用比例、是否该滚段（fine / getting-full / should-roll） |
| `rollover_handoff` | 生成并保存《接续前情》（可附一句留给下一段的话） |

## 配置

```jsonc
{
  "warnAt": 0.45,        // 开始提醒
  "threshold": 0.6,      // 建议滚段
  "keepTurns": 12,       // 接续前情取最近几轮
  "maxChars": 5000,
  "injectIntoMemory": true, // 同时写进 dsh-decay-memory 的 📌 记忆
  "stateDir": ""         // 默认 $DSH_HOME/rollover
}
```

## 数据

```
$DSH_HOME/rollover/handoffs/<sessionId>.md   接续前情正文
$DSH_HOME/rollover/state.json                已注入记录
$DSH_HOME/decay-memory/memory.json           可选：📌 记忆
```

纯本地、无网络、无遥测。会话识别用的是 DSH 自己的投影缓存（`storages/session_projcache/sessions`），不需要任何额外权限。

## 和 dsh-decay-memory 的关系

- 单独用：能提醒、能生成接续前情文件（新会话注入靠插件自己的 prompt section）；
- 一起用：接续前情同时变成 📌 永久记忆，换段后和别的记忆一起被注入，最稳。

## License

MIT

## 设置页（0.2.0 起自带）

- **DSH 设置面板**：左侧设置里新增「上下文滚段」一节（client 半用 iframe 嵌 host 页面）
- **独立网页**：`<你的 DSH 地址>/rollover`

页面可以：看当前会话占用进度、看《接续前情》存档（自动/手动、已注入/待注入）、改阈值与冷却、点「立即生成接续前情」。

## 自动存档（0.2.0）

默认开启：占用 >= autoAt（默认 60%）时插件**自己**生成《接续前情》——不依赖模型调用，写 `$DSH_HOME/rollover/handoffs/<sessionId>.md`，并写进 `dsh-decay-memory` 的 📌 记忆；同一会话 10 分钟冷却（autoCooldownMs）。

数据接口（同源、需要 DSH 登录态）：

```
GET  /rollover/api/state
POST /rollover/api/config   { warnAt, threshold, autoAt, autoCooldownMs, keepTurns, maxChars, autoHandoff, injectIntoMemory }
POST /rollover/api/action   { op: "handoff" | "reset-injected" | "delete-handoff", ... }
```
