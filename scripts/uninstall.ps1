param(
	[string]$Destination = (Join-Path $env:LOCALAPPDATA "Programs\pi-mini"),
	[switch]$KeepData
)

$ErrorActionPreference = "Stop"

$startDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$desktop = [Environment]::GetFolderPath("Desktop")
foreach ($lnk in @(
	(Join-Path $startDir "pi-mini.lnk"),
	(Join-Path $desktop "pi-mini.lnk")
)) {
	if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
}

$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\pi-mini"
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force }

if (-not $KeepData -and (Test-Path -LiteralPath $Destination)) {
	$full = (Resolve-Path -LiteralPath $Destination).Path
	if ($full -match "\\pi-mini$") {
		Remove-Item -LiteralPath $full -Recurse -Force
	} else {
		Write-Host "目标路径看起来不像 pi-mini 安装目录，跳过删除：$full"
	}
}

Write-Host "pi-mini 已卸载"
if ($KeepData) { Write-Host "已保留安装目录与用户数据" }
