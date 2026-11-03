param(
	[string]$Source = (Join-Path $PSScriptRoot "..\dist\pi-mini"),
	[string]$Destination = (Join-Path $env:LOCALAPPDATA "Programs\pi-mini"),
	[switch]$NoShortcuts,
	[switch]$NoRegistry
)

$ErrorActionPreference = "Stop"

$Source = (Resolve-Path -LiteralPath $Source).Path
$exeName = "electron.exe"
if (-not (Test-Path -LiteralPath (Join-Path $Source $exeName))) {
	throw "源目录里没有 $exeName：$Source（先运行 npm run build:portable）"
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
robocopy $Source $Destination /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "复制失败（robocopy exit $LASTEXITCODE）" }

$exe = Join-Path $Destination $exeName

if (-not $NoShortcuts) {
	$ws = New-Object -ComObject WScript.Shell
	$startDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
	New-Item -ItemType Directory -Force -Path $startDir | Out-Null
	$lnk = $ws.CreateShortcut((Join-Path $startDir "pi-mini.lnk"))
	$lnk.TargetPath = $exe
	$lnk.WorkingDirectory = $Destination
	$lnk.IconLocation = "$exe,0"
	$lnk.Description = "pi-mini - minimal desktop client for the pi CLI"
	$lnk.Save()

	$desktop = [Environment]::GetFolderPath("Desktop")
	if ($desktop) {
		$lnk2 = $ws.CreateShortcut((Join-Path $desktop "pi-mini.lnk"))
		$lnk2.TargetPath = $exe
		$lnk2.WorkingDirectory = $Destination
		$lnk2.IconLocation = "$exe,0"
		$lnk2.Description = "pi-mini"
		$lnk2.Save()
	}
}

if (-not $NoRegistry) {
	$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\pi-mini"
	New-Item -Path $key -Force | Out-Null
	Set-ItemProperty -Path $key -Name DisplayName -Value "pi-mini"
	Set-ItemProperty -Path $key -Name DisplayVersion -Value "0.1.0"
	Set-ItemProperty -Path $key -Name Publisher -Value "May5921"
	Set-ItemProperty -Path $key -Name InstallLocation -Value $Destination
	Set-ItemProperty -Path $key -Name DisplayIcon -Value $exe
	Set-ItemProperty -Path $key -Name UninstallString -Value ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot "uninstall.ps1"))
}

Write-Host "pi-mini 已安装到 $Destination"
Write-Host "启动：$exe"
if (-not $NoShortcuts) { Write-Host "已创建桌面与开始菜单快捷方式" }
