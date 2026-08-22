param([string]$Title = "kimi-mem", [string]$Message = "")
# Windows toast 通知（WinRT），发送者显示为 PowerShell
# 注意：本文件必须保持纯 ASCII，中文内容通过参数传入
$log = Join-Path $env:USERPROFILE ".kimi-mem\toast.log"
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  $escTitle = [System.Security.SecurityElement]::Escape($Title)
  $escMsg = [System.Security.SecurityElement]::Escape($Message)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$escTitle</text><text>$escMsg</text></binding></visual></toast>")

  $appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') shown: $Message" -Encoding UTF8
} catch {
  Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ERROR: $_" -Encoding UTF8
}
