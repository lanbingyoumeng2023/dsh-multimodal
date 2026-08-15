# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中 / 待办
- `adapter/` 方向：把多模态服务注册为 DSH 原生 LLM 适配器，彻底摆脱 host 补丁。
- 识图补丁 settings 化：key 与 base URL 从 DSH settings 页配置，而非环境变量。
- 桌面灵动岛 / 状态接口的正式分发（当前依赖动态插件，重启丢失）。

## [0.1.0] - 2026-08-15

首个公开版本。

### Added
- **拖图自动识图**：`dsh-host-apiproxy` host 补丁，模型不支持图片时自动调用多模态模型识图，替换为文本描述，原模型保持不变。
- **异步 + 轮询识图**：`session.prompt` 立即返回 `accepted`，后台识图完成后注入文本，规避前端 30s unary 超时误报。
- **进度标志**：识图期间置 `webServer.__multimodalDescribing`，供外部指示器（如桌面灵动岛）轮询显示「正在识别图片…」。
- **agent preset**（`preset/multimodal/`）：`multimodal_analyze_image`（识图）、`multimodal_generate_image`（文生图/图编辑）、`multimodal_generate_video`（文生视频/图生视频，异步+轮询）。
- **可选 LLM 适配器**（`adapter/`）：零依赖自包含的 OpenAI 兼容适配器，作为「原生支持图片」的备选方向。
- **DPAPI 密钥脚本**（`secrets/Get-MultimodalKey.ps1`）：Windows 本机可选的密钥存储方案。
- **文档**：`README.md`、`INSTALL.md`（一键让 DSH 自装）、`SUMMARY.md`（踩坑记录）、`docs/architecture.md`（状态机+数据流）、`docs/apiproxy.patch.diff`（精确 diff）。
- **CI**：`.github/workflows/ci.yml` 对 adapter / preset 工具 / 补丁文件做 `node --check` 语法校验。

### Changed
- 全部第三方默认值去品牌化，改为 `your-multimodal-provider.example.com` 占位 + `MULTIMODAL_*` 环境变量。

### Security
- API Key 绝不写入代码、配置或仓库；仅通过环境变量 `MULTIMODAL_API_KEY` 注入，或经 DPAPI 脚本本机解密取用。
