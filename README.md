# DSH Multimodal — 拖图自动识图插件

让 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）支持**拖图即识图**：当会话当前模型不支持图片输入时，自动把图片交给一个可配置的多模态模型转成文本描述，再喂回原模型。主模型保持 DeepSeek 不变，**无需手动切换模型**。

> API 兼容任意 **OpenAI 风格多模态服务**（`/chat/completions`），完全通过环境变量配置，不绑定具体供应商。

## 解决什么问题

DSH 的 api-proxy 在图片消息进入模型前会硬编码拒绝「当前模型不支持图片」，且该位置**没有插件钩子**。本仓库给出两条路径：

1. **host 补丁（拖图识图的核心）**：直接修改 `dsh-host-apiproxy` 的 prompt 处理器，把「拒绝图片」改成「自动识图 → 文本描述 → 继续」。
2. **agent preset（可分发部分）**：注册三个模型工具——识图 / 文生图 / 文生视频。

## 目录结构

```
dsh-multimodal/
├── README.md                本文档
├── INSTALL.md               一键安装：可直接扔给 DSH 自己执行的提示词
├── SUMMARY.md               实现总结（改动点 + 踩坑记录 + 设计取舍）
├── docs/
│   ├── architecture.md      架构详解：异步轮询状态机 + 补丁 diff 解析
│   └── apiproxy.patch.diff  精确补丁 diff（原始 vs 补丁后）
├── LICENSE                  MIT
├── .gitignore
├── preset/multimodal/       可分发的 agent preset
│   ├── agent.cordis.yml     标准 agent + tool-multimodal 行
│   ├── preset.yml
│   └── plugins/multimodal-tools/
│       ├── package.json
│       └── index.js         识图/生图/生视频三个工具
├── adapter/                 备选：把多模态服务注册成 DSH 的 LLM 适配器
│   ├── package.json
│   └── index.js             零依赖自包含的 OpenAI 兼容适配器
├── patch/
│   ├── dsh-host-apiproxy-index.js   （已打补丁的 api-proxy 完整文件，供重打参考）
│   └── apply-multimodal-patch.ps1   补丁重打脚本（npx 缓存清理/升级后恢复）
└── secrets/
    └── Get-MultimodalKey.ps1        DPAPI 密钥读取脚本示例（Windows 本机可选项）
```

## 安装

> **懒人路径**：不想手动操作？见 [INSTALL.md](INSTALL.md)，里面有一段提示词，直接粘贴给 DSH 让它自己完成下载、复制 preset、打补丁、配置 API——你只需在它停下时提供 API Key 并手动重启网关。

### 1. 复制 preset

把 `preset/multimodal/` 复制到 `~/.dsh/.agent-presets/multimodal/`。

### 2. 配置 API（环境变量，必需）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MULTIMODAL_API_KEY` | — | **必填**（API 密钥，绝不写入代码/配置/仓库） |
| `MULTIMODAL_BASE_URL` | 占位地址 | OpenAI 兼容 API 基址，如 `https://your-provider.example.com/v1` |
| `MULTIMODAL_VISION_MODEL` | `your-vision-model` | 识图模型 |
| `MULTIMODAL_IMAGE_MODEL` | `your-image-model` | 生图模型 |
| `MULTIMODAL_VIDEO_MODEL` | `your-video-model` | 生视频模型 |
| `MULTIMODAL_VIDEO_HOST` | 占位地址 | 视频轮询基址 |
| `MULTIMODAL_VIDEO_POLL_PATH` | `/videos/tasks?video_id=` | 视频轮询端点路径 |
| `MULTIMODAL_CONTEXT_WINDOW` | `131072` | （adapter 用）上下文窗口 |

> 所有默认值都是占位符，**开箱不可用**——请替换为你自己的服务与模型。这正是有意的：本仓库不捆绑任何第三方服务。

### 3. 打 api-proxy 补丁（拖图识图的关键，host 层）

```powershell
pwsh -File patch/apply-multimodal-patch.ps1
```

补丁作用：在 `dsh-host-apiproxy` 的 prompt 处理器里，当模型不支持图片时调用 `multimodalDescribeContent` 识图替换（异步 + 轮询，见下）。

### 4. （可选）DPAPI 密钥存储

Windows 上若不想用环境变量，可把密钥用 DPAPI 加密存到 `~/.dsh/secrets/`，运行时经 `secrets/Get-MultimodalKey.ps1` 解密取用。代码在环境变量未设置时自动回退到此脚本。

## 使用

- 新建会话选「多模态模式」preset
- **拖图到对话框发送** → 自动识图（模型收到图片的文本描述，原模型不变）
- 工具：`multimodal_analyze_image`（识图）、`multimodal_generate_image`（生图）、`multimodal_generate_video`（生视频）

## 架构与关键设计

### 为什么识图要在 host 层打补丁

DSH 的 api-proxy 在图片消息进模型前会硬编码拒绝「模型不支持图片」，且**无插件钩子**。因此拖图识图只能直接改 `dsh-host-apiproxy`。这是本方案的**非分发点**——`apply-multimodal-patch.ps1` 用于在 npx 缓存清理或 dsh 升级后重打。

### 异步 + 轮询（避免超时误报）

`session.prompt` 是前端 unary 调用，默认 **30 秒超时**。识图本身可能更慢（尤其大图、TTFT 抖动）。若在 prompt 处理器里**同步**等待识图，前端会先弹「超时报错」，而识图结果随后才到——典型的超时误报。

因此补丁把识图改成**异步**：

1. prompt 收到图片 + 模型不接受图片时，**立即返回 `accepted`**（前端不阻塞）；
2. 后台异步调用多模态模型识图；
3. 完成后把文本描述作为用户消息注入会话，原模型继续正常回复；
4. 识图期间在 `webServer` 服务实例上置 `__multimodalDescribing` 标志，供外部（如桌面灵动岛）轮询显示「正在识别图片…」。

### 跨 realm 通信的坑

动态 Cordis 插件跑在 `node:vm` 沙箱，其 `globalThis` 是独立 realm，无法用全局变量在主 realm 与插件间传状态。解法是**用 `webServer` 服务实例作桥梁**（往实例上挂 `__multimodalDescribing` 属性），因为两侧拿到的是同一个服务对象。

## 已知限制

- 识图补丁依赖 npx 缓存中的 `dsh-host-apiproxy`；`npm cache clean` 或 dsh 版本升级后需重打（脚本已备，且用 `multimodalDescribeContent` 标记检测是否已打）。
- 补丁是直接改第三方包文件，非正式插件分发方式；`adapter/` 是朝「原生支持图片、彻底摆脱补丁」方向的备选实现。

## 许可证

MIT（各仓库代码按其原许可证）
