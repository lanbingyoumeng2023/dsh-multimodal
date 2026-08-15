param()
# Re-apply the multimodal image-describe patch to dsh-host-apiproxy in the npx cache.
# Use after `npm cache clean` or a dsh version upgrade when the patch goes missing.
$ErrorActionPreference = "Stop"

$ref = Join-Path $PSScriptRoot "dsh-host-apiproxy-index.js"
if (-not (Test-Path $ref)) { Write-Error "reference patched file missing: $ref" }

$cacheRoot = Join-Path $env:LOCALAPPDATA "npm-cache\_npx"
$targets = Get-ChildItem -Path $cacheRoot -Recurse -Filter "index.js" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'dsh-host-apiproxy[\\/]lib[\\/]index\.js$' }

if (-not $targets) { Write-Host "no dsh-host-apiproxy found in npx cache"; exit 0 }

foreach ($t in $targets) {
  $content = [System.IO.File]::ReadAllText($t.FullName)
  if ($content.Contains("multimodalDescribeContent")) {
    Write-Host "patched : $($t.FullName)"
  } else {
    Copy-Item $ref $t.FullName -Force
    Write-Host "RE-APPLIED : $($t.FullName)  (restart dsh web to take effect)"
  }
}
Write-Host "done"
