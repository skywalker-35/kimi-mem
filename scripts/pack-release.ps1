# kimi-mem release 打包脚本
# 构建 vendor → 拼出自包含 zip：kimi.plugin.json 在 zip 根，daemon/ 收在插件根内，
# vendor 带预构建 dist/（用户只需 bun install 装运行时依赖，首跑由 ensureDaemon 自动 bootstrap）
# 用法: pwsh scripts/pack-release.ps1 [-Version 0.1.1]
param([string]$Version = "")

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not $Version) {
    $pkg = Get-Content "$root\plugin\package.json" | ConvertFrom-Json
    $Version = $pkg.version
}
Write-Host "==> 打包 kimi-mem v$Version"

# 1. 构建 vendor（tsc 产物 + Web UI → dist/ 与 dist/web/）
Write-Host "==> 构建 vendor opencode-mem"
Push-Location "$root\daemon\opencode-mem"
try {
    bun install
    if ($LASTEXITCODE -ne 0) { throw "bun install 失败" }
    bun x tsc
    if ($LASTEXITCODE -ne 0) { throw "bun x tsc 失败" }
    Push-Location web
    try {
        bun install
        if ($LASTEXITCODE -ne 0) { throw "web bun install 失败" }
        bun run build
        if ($LASTEXITCODE -ne 0) { throw "web build 失败" }
    } finally { Pop-Location }
} finally { Pop-Location }

# 2. 拼 staging
$staging = "$root\.pack-staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging | Out-Null
Write-Host "==> 拼装 staging: $staging"

# robocopy 退出码 0-7 都算成功；函数名不能叫 RoboCopy（会和 robocopy.exe 递归调用）
function Copy-WithRobo($src, $dst, $files) {
    if ($files) {
        robocopy.exe $src $dst $files | Out-Null
    } else {
        robocopy.exe $src $dst /MIR | Out-Null
    }
    if ($LASTEXITCODE -gt 7) { throw "robocopy 失败: $src -> $dst (exit $LASTEXITCODE)" }
}

# 插件本体放 zip 根（含 node_modules，MCP SDK 依赖需要）
Copy-WithRobo "$root\plugin" $staging
# 根级文档/许可
Copy-WithRobo $root $staging @("README.md", "LICENSE")
# daemon 顶层脚本
Copy-WithRobo "$root\daemon" "$staging\daemon" @("*.mjs", "*.ps1", "*.vbs")
# vendor：只要包清单 + 锁文件 + 预构建产物（不带 node_modules/src/web/tests，bun install 由首跑 bootstrap）
$vendorSrc = "$root\daemon\opencode-mem"
$vendorDst = "$staging\daemon\opencode-mem"
Copy-WithRobo $vendorSrc $vendorDst @("package.json", "bun.lock", "LICENSE", "PATCHES.md")
Copy-WithRobo "$vendorSrc\dist" "$vendorDst\dist"

# 3. 打 zip
$outDir = "$root\release"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$zip = "$outDir\kimi-mem-v$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "==> 压缩: $zip"
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force

Remove-Item $staging -Recurse -Force
$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "==> 完成: $zip ($sizeMB MB)"
