# 架构详解：拖图自动识图的完整链路

本文深入讲清楚「拖图 → 识图 → 文本描述 → 原模型回复」背后的状态机、数据流，以及为什么补丁长成现在这样。完整的补丁 diff 见 [`apiproxy.patch.diff`](apiproxy.patch.diff)。

## 一、端到端数据流

```
浏览器（Web GUI）
   │  session.prompt { content: [ {type:"text"}, {type:"image", data: base64} ] }
   ▼
dsh-host-apiproxy · prompt 处理器（本补丁改的位置）
   │  1. 判断 content 是否含 image 块
   │  2. 查当前会话模型的 inputModalities
   │     ├─ 模型接受图片 ──▶ 原样准入（durablePromptContent 落盘图片附件）
   │     └─ 模型不接受图片 ──▶ 异步识图分支（下图状态机）
   ▼
多模态模型（OpenAI 兼容 /chat/completions）
   │  图片 → 文本描述
   ▼
agent.followup(文本消息) ──▶ 原模型（如 DeepSeek）正常流式回复
```

关键点：**图片从不出现在原模型的上下文里**。原模型看到的是一条「用户上传了一张图片，图片内容如下：…」的纯文本消息。这就是为什么主模型可以保持 DeepSeek 不变、无需切换。

## 二、异步识图状态机

`session.prompt` 是前端 unary 调用，默认 **30 秒超时**（`DEFAULT_TIMEOUT_MS = 3e4`）。识图本身可能更慢（大图、TTFT 抖动）。如果同步等待识图，前端会先弹「超时报错」，而识图结果随后才到——典型的超时误报。

因此 prompt 处理器对「模型不接受图片」的路径采用**异步 + 轮询**：

```
                 ┌───────────────────────────┐
   收到图片      │  prompt 处理器（同步部分）   │
   ───────────▶ │  1. 查模型 inputModalities │
                 │  2. 不接受图片？            │
                 └────────────┬──────────────┘
                              │ 是
                              ▼
              ┌─────────────────────────────────┐
              │ 置 ws.__multimodalDescribing=true │◀── 外部指示器轮询此标志
              │ 立即 return ok(accepted:true)      │    （如桌面灵动岛显示「正在识别图片…」）
              └────────────┬────────────────────┘
                           │  前端 30s 超时不再触发（prompt 已秒回）
                           ▼
              ┌─────────────────────────────────┐
              │ serializeImageAdmission(agent,   │
              │   async () => {                  │
              │     multimodalDescribeContent()  │◀── 后台逐图识图（可跨多秒）
              │     agent.followup(文本消息)      │
              │   }                              │
              │ )                                │
              └────────────┬────────────────────┘
                           │  三种结局
            ┌──────────────┼──────────────────┐
            ▼              ▼                  ▼
     识图成功          识图失败            会话不可用
  followup(描述)    followup(错误文本)    静默忽略(e2)
            │              │
            └──────┬───────┘
                   ▼
      finally: ws.__multimodalDescribing=false
                   │
                   ▼
     原模型收到文本消息，正常流式回复
```

### 状态机要点

| 状态 | 触发 | 效果 |
|---|---|---|
| 同步判定 | prompt 收到含 image 的 content | 一次 `resolveModelInfo`，读 `inputModalities` |
| 原样准入 | 模型 `inputModalities` 含 `image`（或未声明） | 走原 `durablePromptContent`，图片落盘附件 |
| 异步识图 | 模型明确不支持图片 | 立即 `accepted` + 后台识图 + 完成后注入文本 |
| 失败降级 | 识图抛错 | 注入「图片自动识图失败：…」文本，不静默丢输入 |
| 进度清除 | `finally` | `__multimodalDescribing=false`，指示器恢复 |

## 三、补丁改动逐块解析

完整 diff 在 [`apiproxy.patch.diff`](apiproxy.patch.diff)，共四处：

### 1. imports（+3 行）

```diff
+import { execFile } from "node:child_process";
-import { dirname, extname } from "node:path";
+import { dirname, extname, join } from "node:path";
+import os from "node:os";
```

为 DPAPI 取 key 需要 `execFile`（调 PowerShell）和 `join`/`os.homedir()`（拼 key 脚本路径）。

### 2. 识图函数块（+115 行）

`decodeBase64` 之后插入一整个自包含块：

- 常量：`MULTIMODAL_BASE` / `MULTIMODAL_VISION_MODEL` / `MULTIMODAL_KEY_SCRIPT` / 超时 / 默认提问词，全部走环境变量。
- `findPwsh()`：PATH 里找 pwsh.exe（PowerShell 7），找不到回退 powershell.exe（5.1）。
- `getMultimodalKey()`：环境变量优先，否则经 DPAPI 脚本取；带 PSModulePath 兼容修复（详见下方「坑」）。
- `multimodalDescribeImage()`：一次 OpenAI 兼容 `/chat/completions` 调用，`image_url` 传 data URL，`AbortSignal.timeout` 兜底。
- `multimodalDescribeContent()`：把 prompt 里的所有 image 块逐张识图，拼成「用户上传了图片，图片内容如下：…」的文本块。

### 3. 删除原「拒绝图片」分支（−9 行）

原始代码在 `admit()` 里，模型不支持图片时**直接返回错误**：

```diff
-					if (hasImage) {
-						const current = selectionFor(agent).current;
-						const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
-						if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image")) return err(request, {
-							code: "attachment-error",
-							message: `Model "${current.model}" does not support image input.`,
-							details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
-						});
-					}
```

这就是为什么「图片直输被拒、且无插件钩子」——只能直接改 api-proxy。

### 4. 替换 prompt 分派逻辑（−1 +37 行）

原：`return hasImage ? serializeImageAdmission(agent, admit) : admit();`

新：把「是否识图」的判断提前到 `admit()` 之外，分成三条路径：

```js
if (!hasImage) return admit();                         // 无图：照旧
const modelInfo = await ctx.llm.resolveModelInfo(...);
if (接受图片) return serializeImageAdmission(agent, admit);  // 原生支持：照旧
// 否则：异步识图分支（状态机第二节）
```

## 四、跨 realm 通信的坑

动态 Cordis 插件（如灵动岛的状态接口）跑在 `node:vm` 沙箱里，它的 `globalThis` 是**独立 realm**——在插件里 `globalThis.foo = 1`，主 realm 读不到。

解法：**用 `webServer` 服务实例作桥梁**。补丁里往实例上挂 `__multimodalDescribing` 属性，插件侧通过 `ctx.get("webServer")` 拿到**同一个实例对象**，读写同一个属性。两侧共享的是对象引用，不受 realm 隔离影响。

## 五、DPAPI 取 key 的 Windows 兼容性

`getMultimodalKey()` 里有几处非显而易见的兼容处理，是踩坑后留下的：

1. **PSModulePath 补全**：宿主从 PowerShell 7 启动时，子进程继承的 `$PSModulePath` 不含 5.1 模块目录，`ConvertTo-SecureString` 会加载失败 → 显式 prepend `C:\Windows\System32\WindowsPowerShell\v1.0\Modules`。
2. **优先 pwsh.exe**：`Microsoft.PowerShell.Security` 模块仅在 pwsh 7 里稳定存在。
3. **`where pwsh.exe` 跳过 WindowsApps**：避免命中 Windows Store 的 pwsh stub（那是一个不能直接执行的 alias）。

## 六、为什么不是「注册一个 LLM 适配器」

理想做法是把多模态服务注册成 DSH 的 OpenAI 兼容适配器（见 [`adapter/`](../adapter/)），让 preset 原生支持图片、彻底摆脱 host 补丁。但那条路径有它自己的约束（注册生命周期、settings 集成、与 DeepSeek 主路由的并存）。补丁是**当前可用的过渡方案**：改动集中、语义清晰、不引入新 provider。

`adapter/` 保留了这条探索，README 与 SUMMARY 都有标注。
