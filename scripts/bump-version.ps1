# kimi-mem 版本 bump 脚本：同步修改 plugin/package.json 与 plugin/kimi.plugin.json 的版本号，
# 提交并打 git tag（tag 推送后由 GitHub Actions 自动打包发 Release）
# 用法:
#   pwsh scripts/bump-version.ps1 patch          # 0.1.0 -> 0.1.1（修 bug）
#   pwsh scripts/bump-version.ps1 minor          # 0.1.0 -> 0.2.0（新功能）
#   pwsh scripts/bump-version.ps1 major          # 0.1.0 -> 1.0.0（破坏性变更）
#   pwsh scripts/bump-version.ps1 patch -NoGit   # 只改文件，不提交不打 tag
param(
    [Parameter(Mandatory = $true)][ValidateSet("major", "minor", "patch")]$Bump,
    [switch]$NoGit
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$targets = @("$root\plugin\package.json", "$root\plugin\kimi.plugin.json")

# 读当前版本（以 kimi.plugin.json 为准）
$manifest = Get-Content $targets[1] | ConvertFrom-Json
$old = $manifest.version
$parts = $old.Split(".")
$major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
switch ($Bump) {
    "major" { $major++; $minor = 0; $patch = 0 }
    "minor" { $minor++; $patch = 0 }
    "patch" { $patch++ }
}
$new = "$major.$minor.$patch"

foreach ($f in $targets) {
    $json = Get-Content $f -Raw | ConvertFrom-Json
    $json.version = $new
    $json | ConvertTo-Json -Depth 20 | Set-Content $f -Encoding utf8 -NoNewline
    Write-Host "  $([IO.Path]::GetFileName($f)): $old -> $new"
}

if (-not $NoGit) {
    Push-Location $root
    try {
        git add plugin/package.json plugin/kimi.plugin.json
        git commit -m "chore: bump version to $new"
        git tag "v$new"
        Write-Host "==> 已提交并打 tag v$new"
        Write-Host "==> 推送发布: git push origin main --follow-tags"
    } finally { Pop-Location }
} else {
    Write-Host "==> 已改版本号 $old -> $new（-NoGit，未提交）"
}
