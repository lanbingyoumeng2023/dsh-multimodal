# Get-MultimodalKey.ps1
# 解密并输出已保存的多模态服务 API Key（DPAPI 加密，仅限本机当前 Windows 用户可解）。
# 可选方案：也可直接用环境变量 MULTIMODAL_API_KEY，无需本脚本。
#
# 使用前请先在本机用如下方式把密钥加密保存（PowerShell，仅本机当前用户可解）：
#   $enc = Read-Host -AsSecureString "Paste API key" | ConvertFrom-SecureString
#   Set-Content -Path "$env:USERPROFILE\.dsh\secrets\multimodal-api-key.enc" -Value $enc
#
# 用法:
#   $key = & "$env:USERPROFILE\.dsh\secrets\Get-MultimodalKey.ps1"

$encFile = Join-Path $env:USERPROFILE ".dsh\secrets\multimodal-api-key.enc"
if (-not (Test-Path $encFile)) { throw "encrypted multimodal key file not found: $encFile" }
$enc = [System.IO.File]::ReadAllText($encFile)
$secure = $enc | ConvertTo-SecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
}
finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
