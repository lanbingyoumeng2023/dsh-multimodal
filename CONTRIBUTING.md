# 贡献指南

感谢你有兴趣贡献！本项目是「DeepSeek Harness 多模态识图」的开源参考实现，欢迎 issue 与 PR。

## 提交前的检查

1. **不要提交任何密钥**：检查你的改动里没有真实 API Key、个人路径、真实第三方域名。
2. **跑语法校验**：本地执行与 CI 相同的检查：

   ```bash
   node --check adapter/index.js
   node --check preset/multimodal/plugins/multimodal-tools/index.js
   node --input-type=module --check < patch/dsh-host-apiproxy-index.js
   ```

3. **默认值保持占位**：新配置项的默认值用 `your-*` 或 `example.com` 占位，不捆绑任何真实服务。

## 目录职责

| 路径 | 职责 | 注意 |
|---|---|---|
| `preset/multimodal/` | 可分发的 agent preset（3 个工具） | 相对路径引用本地插件 |
| `patch/` | api-proxy 补丁 + 重打脚本 | 直接改第三方包，升级 DSH 后需重打 |
| `adapter/` | 备选：原生 LLM 适配器 | 尚未完成 settings 集成 |
| `docs/` | 架构说明 + 精确 diff | 与代码同步更新 |
| `secrets/` | DPAPI 密钥脚本示例 | 仅解密逻辑，无密钥 |

## 提交规范

- 提交信息用英文（或中英混合），一句话说清改了什么。
- 涉及行为变更时，同步更新 `CHANGELOG.md`、`README.md` 或 `docs/`。
- 保持每个 PR 聚焦一个目标。

## 许可证

MIT。提交即表示你同意将贡献按 MIT 授权。
