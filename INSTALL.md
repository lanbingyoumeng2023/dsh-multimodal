# 一键让 DSH 自己完成安装

下面这段提示词可以直接粘贴给 DSH（DeepSeek Harness 的 Web 会话），让它**自动完成本插件的安装与配置**。DSH 会自己读写文件、跑命令、打补丁——你只需要在它停下时提供 API Key 并手动重启网关。

---

## 直接扔给 DSH 的提示词

````text
请帮我安装 DSH 多模态插件（拖图自动识图），仓库地址：
https://github.com/lanbingyoumeng2023/dsh-multimodal

目标：让当前 DSH 支持「拖图自动识图」——当会话模型不支持图片输入时，
自动把图片交给一个 OpenAI 兼容的多模态模型转成文本描述，再喂回原模型，
主模型保持不变、无需手动切换。

请依次完成以下步骤，并在每一步完成时简要汇报：

1. 下载仓库：把 dsh-multimodal 仓库克隆到本地（例如 D:\DSH\dsh-multimodal
   或任意你偏好的目录）。

2. 复制 preset：把仓库里的 preset/multimodal 目录复制到
   ~/.dsh/.agent-presets/multimodal/（即用户主目录下 .dsh\.agent-presets\multimodal）。

3. 配置环境变量（关键，务必停下来问我，不要凭空编造）：
   - MULTIMODAL_API_KEY：必填，OpenAI 兼容多模态服务的 API Key。
     请停下来问我该填什么；如果我没有现成的 key，就告诉我如何用 DPAPI
     加密保存到 ~/.dsh/secrets/，或如何导出环境变量。
   - MULTIMODAL_BASE_URL：服务基址（OpenAI 兼容，形如 https://host/v1）。
   - MULTIMODAL_VISION_MODEL / MULTIMODAL_IMAGE_MODEL / MULTIMODAL_VIDEO_MODEL：
     识图/生图/生视频模型名。
   注意：API Key 绝不写入任何文件、配置文件或 git 提交。

4. 打 host 补丁（拖图识图的关键）：
   运行  pwsh -File patch/apply-multimodal-patch.ps1
   这个脚本会找到 npx 缓存里的 dsh-host-apiproxy/lib/index.js 并写入
   识图降级逻辑。打完确认文件里包含 multimodalDescribeContent。

5. 打完补丁后，需要重启 DSH web 网关才能生效。这一步由我（用户）手动执行，
   请你在此时停下来提醒我重启，并告诉我重启完成后怎么验证。

6. 重启完成后：新建一个会话选择「多模态模式」preset，拖一张图测试，
   确认图片被自动转成文本描述、原模型正常回复。

安全要求（严格遵守）：
- API Key 绝不出现在任何文件、命令历史、git 提交里；
- 补丁只改 npx 缓存里的 dsh-host-apiproxy，不要改动其他包；
- 每步先说明再动手，涉及覆盖/删除时先询问我。
````

---

## 提示词做了什么

| 步骤 | 动作 | 为什么 |
|---|---|---|
| 1 | 克隆仓库 | 拿到 preset 与补丁脚本 |
| 2 | 复制 preset | preset 是唯一「可分发」部分，DSH 从 `~/.dsh/.agent-presets/` 挂载 |
| 3 | 配置环境变量 | Key 必须由你提供，提示词明确禁止 DSH 编造 |
| 4 | 打 host 补丁 | 识图逻辑在 api-proxy 里，无插件钩子，只能直接改（见 README） |
| 5 | 提醒手动重启 | 补丁在 npx 缓存，需重启进程加载；DSH 不能重启它自己 |
| 6 | 建会话拖图测试 | 端到端验证拖图 → 识图 → 文本描述 → 原模型回复 |

## 手动安装（等价步骤）

如果你不想用提示词，按 [README.md](README.md) 的「安装」章节手动执行即可，两者等价。
