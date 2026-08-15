# DSH Multimodal — 实现总结

> 从「模型不支持图片输入」到「拖图即自动识图 + 进度提示」的完整设计过程与踩坑记录。

## 一、整体架构

```
用户拖图 → 浏览器发送(含 image 块)
   ↓
api-proxy prompt 处理器（host，全局）
   ├─ 模型不支持图片 → 异步 multimodalDescribeContent() 逐图识图 → 替换为文本
   └─ 识图期间置 webServer.__multimodalDescribing 标志
   ↓
agent 收到纯文本 → 原模型（DeepSeek）正常回复
   ↓（并行）
外部指示器轮询 /api/dsh-island/status → 读到 describing → 显示「正在识别图片…」
```

## 二、主要修改点

### 1. 多模态模式 preset（`preset/multimodal/`）

`plugins/multimodal-tools/index.js`（host）注册 3 个工具：

- `multimodal_analyze_image` 识图（data URL / 本地路径）
- `multimodal_generate_image` 文生图 / 图编辑（参考图需 http(s) URL）
- `multimodal_generate_video` 文生视频 / 图生视频（异步任务 + 轮询）

`agent.cordis.yml` 加一行：`- id: tool-multimodal → name: ./plugins/multimodal-tools/index.js`。

### 2. api-proxy 补丁（`patch/`，改 `dsh-host-apiproxy/lib/index.js`）

- `multimodalDescribeContent(content)`：模型不接收图片时，逐图交给多模态模型识图，替换为文本。
- `getMultimodalKey()`：先读环境变量，未设置则经 PowerShell 调用 DPAPI 脚本取 key（含 PSModulePath 兼容修复）。
- prompt 处理器 `hasImage` 分支：不再拒绝，改为**异步 + 轮询**（立即 accepted → 后台识图 → 注入文本）。

### 3. 进度提示

- api-proxy：识图期间置 `webServer.__multimodalDescribing = true/false`。
- 外部状态接口（如 `/api/dsh-island/status`）增加 `describing` 字段。
- 桌面灵动岛：`describing=true` 时显示「正在识别图片…」+ 光环脉冲。

## 三、关键设计取舍

### 超时误报 vs 异步轮询

`session.prompt` 前端 unary 默认 30 秒超时，而识图可能更慢。同步等待识图会导致前端先弹「超时」、结果稍后才到。改为**异步 + 轮询**后：prompt 立即返回，识图在后台完成，不再有超时误报；慢请求只是让进度指示多显示一会儿。

### 跨 realm 通信

动态插件跑在 `node:vm` 沙箱，`globalThis` 是独立 realm。用全局变量传状态无效；改用 **`webServer` 服务实例**作桥梁（同一对象，两侧可见）。

### 适配器 vs 补丁

理想做法是把多模态服务注册为 DSH 的 OpenAI 兼容 LLM 适配器（`adapter/`），让「多模态模式」preset 原生支持图片、彻底摆脱 host 补丁。补丁是当前可用的过渡方案；`adapter/` 保留作备选/后续方向。

## 四、踩过的坑

| 坑 | 原因 | 解法 |
|---|---|---|
| preset 本地插件加载失败 | Node ESM 不支持目录式导入 | 行名写**文件路径** `./plugins/xxx/index.js` |
| 图片直输被拒 | api-proxy prompt 硬编码拒绝、无插件钩子 | 只能直接改 api-proxy |
| 动态插件读不到识图标志 | 动态插件跑在 node:vm 沙箱，`globalThis` 独立 realm | 用 **webServer 服务实例**作跨 realm 桥梁 |
| 进度提示读不到输入状态 | 动态插件 root 作用域 + session 插槽，`useInput` 绑定错误会话 | session UI 须走 preset 客户端半部分 |
| `useInput` 崩溃 | `SnapshotSelectorHook` 必须传 selector | `useInput(s => s.phase)` |
| 前端弹「超时报错」但结果随后到 | 同步识图超过前端 unary 30s 超时 | 改异步 + 轮询 |

## 五、遗留事项

1. **API 配置**：环境变量已支持；DPAPI 脚本为可选项。
2. **持久性**：api-proxy 补丁在 npx 缓存、状态接口在动态插件 → 重启部分丢失，需重打/重建。
3. **正式分发**：补丁不可分发 → `adapter/` 是朝 npm 包 + 原生适配器方向的探索。
