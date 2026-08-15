# Security Policy

## 支持的版本

| 版本 | 支持 |
|---|---|
| 0.1.x | ✅ |

## 报告漏洞

如果你发现安全漏洞，请**不要公开 issue**。通过 GitHub 的「Report a vulnerability」私密通道（Security → Advisories → New draft security advisory）提交，或直接联系仓库维护者。

我们会尽力在合理时间内确认并修复。

## 密钥处理约定（本项目红线）

- API Key **绝不**写入代码、配置文件、示例文件、日志或任何 git 提交。
- 运行时的 Key 来源只有两个，按优先级：
  1. 环境变量 `MULTIMODAL_API_KEY`；
  2. Windows 本机 DPAPI 加密存储（经 `secrets/Get-MultimodalKey.ps1` 解密，仅本机当前用户可解）。
- `.env.example` 只提供变量名与占位符，不包含任何真实值。
- 本仓库代码里出现的 `startsWith("sk-")` 均为**校验逻辑**（判断 Key 前缀是否合法），不是密钥本身。

## 已知风险（诚实披露）

- **host 补丁属于直接修改第三方包文件**：`patch/` 会覆盖 npx 缓存里的 `dsh-host-apiproxy/lib/index.js`。升级 DSH 版本后补丁可能失效或与上游冲突，需重新评估后再打。
- **DPAPI 脚本依赖本机用户上下文**：换用户、换机器、删除 Windows 用户配置后，加密的 Key 无法解密。

请只在信任的多模态服务上使用本插件，并自行评估图片外传带来的隐私影响。
