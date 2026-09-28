# ==========================================================================
#  现场部署环境体检（离线可跑；不需要管理员、不需要外网）
#  用途：在到货的看板主机（联想开天 M630Z）上采集 ENV / DEP / Q-26 相关实测读数，
#        并在装了 Node 24 且仓库已就位时顺带跑 preflight 与全量门禁（不依赖任何 npm 包）。
#  产出：同目录 部署环境体检报告-<主机名>-<时间戳>.txt（UTF-8 带 BOM，记事本可直接看）
#  依据：需求 ENV-01/ENV-16/ENV-20、DEP-04、NFR-05；技术债 Q-26；ADR-0002（Node 24 LTS 基线）
#  编码：本文件必须保存为 UTF-8 **带 BOM**（PS 5.1 按 ANSI 读无 BOM 的 UTF-8 会把中文读崩）。
#  注意：只读采集、不改系统，除自身报告文件外不写任何东西；唯第六节在仓库就位时会跑
#        仓库自带门禁，那一步只写 <仓库>\tests\._verify\ 下的日志/账本（不写系统、不装东西）。
# ==========================================================================
$ErrorActionPreference = 'Continue'

$Lines = New-Object System.Collections.Generic.List[string]
function W($s) { $script:Lines.Add([string]$s) }
function Section($t) { W ''; W ('=' * 78); W ('== ' + $t); W ('=' * 78) }
function Try-Run($label, $block) {
  try { $v = & $block; W ("{0,-34} {1}" -f $label, ($v | Out-String).Trim()) }
  catch { W ("{0,-34} {1}" -f $label, ('读取失败：' + $_.Exception.Message)) }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
W ("现场部署环境体检报告（离线采集）")
W ("生成时间   ：" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
W ("采集主机   ：" + $env:COMPUTERNAME + "    用户：" + $env:USERNAME)
W ("脚本位置   ：" + $PSScriptRoot)
W ("说明       ：本文件由 部署环境体检.ps1 只读采集；不含任何修改系统的动作。")

# ---------------------------------------------------------------- 一、操作系统
Section '一、操作系统与固件（ENV / Q-26）'
Try-Run 'OS 版本'      { Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture, InstallDate | Format-List }
Try-Run '系统区域/时区' { Get-CimInstance Win32_TimeZone | Select-Object Caption, StandardName, Bias | Format-List }
Try-Run 'BIOS'         { Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SMBIOSBIOSVersion, ReleaseDate | Format-List }
Try-Run '系统型号'     { Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer, Model, SystemType, TotalPhysicalMemory | Format-List }
Try-Run 'PowerShell'   { $PSVersionTable.PSVersion.ToString() }

# ---------------------------------------------------------------- 二、CPU / 内存 / 存储
Section '二、CPU / 内存 / 存储（Q-26 兆芯平台实测）'
Try-Run 'CPU'          { Get-CimInstance Win32_Processor | Select-Object Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, Architecture | Format-List }
Try-Run '内存条'       { Get-CimInstance Win32_PhysicalMemory | Select-Object Manufacturer, Capacity, Speed, PartNumber | Format-Table -AutoSize }
Try-Run '内存总量(GB)' { [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 2) }
Try-Run '物理磁盘'     { Get-CimInstance Win32_DiskDrive | Select-Object Model, Size, InterfaceType | Format-Table -AutoSize }
Try-Run '分区余量'     { Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, @{n='SizeGB';e={[math]::Round($_.Size/1GB,1)}}, @{n='FreeGB';e={[math]::Round($_.FreeSpace/1GB,1)}} | Format-Table -AutoSize }

# ---------------------------------------------------------------- 三、显示（ENV-01 / ENV-16 / UI-00 替代屏登记）
Section '三、显示与缩放（ENV-01 目标 3840×2160；ENV-16 缩放与 DPI 固定）'
Try-Run '显示适配器'   { Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, DriverDate, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate, VideoModeDescription | Format-List }
Try-Run '桌面分辨率'   { Get-CimInstance Win32_DesktopMonitor | Select-Object Name, ScreenWidth, ScreenHeight | Format-Table -AutoSize }
Try-Run 'DPI 缩放'     { $lp = (Get-ItemProperty 'HKCU:\Control Panel\Desktop' -Name LogPixels -ErrorAction SilentlyContinue).LogPixels; if ($lp) { "LogPixels=$lp （96=100%，120=125%，144=150%）" } else { "LogPixels 未显式设置（默认 96=100%）；请另在「设置→系统→显示→缩放」看实际值" } }
Try-Run '显示器 EDID'  { Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction Stop | ForEach-Object { ($_.UserFriendlyName | Where-Object { $_ -ne 0 } | ForEach-Object { [char]$_ }) -join '' } }

# ---------------------------------------------------------------- 四、电源 / 屏保 / 自动更新（DEP-04）
Section '四、无人值守相关策略（DEP-04：禁休眠/睡眠/屏保、禁自动更新重启、锁分辨率与缩放）'
function IdxOf($sub, $set) {
  $q = powercfg /q SCHEME_CURRENT $sub $set 2>&1
  $hits = @($q | Select-String -Pattern '0x[0-9a-fA-F]+' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value })
  return (($hits | Select-Object -Last 2) -join ' / ')
}
Try-Run '睡眠(待机) AC/DC' { IdxOf '238c9fa8-0aad-41ed-83f4-97be242c8f20' '29f6c1db-86da-48c5-9fdb-f2b67b1f44da' }   # 0=从不
Try-Run '休眠 AC/DC'       { IdxOf '238c9fa8-0aad-41ed-83f4-97be242c8f20' '9d7815a6-7ee4-497e-8888-515a05f02364' }
Try-Run '关闭显示器 AC/DC' { IdxOf '7516b95f-f776-4464-8c53-06167f40cc99' '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e' }
Try-Run '无线适配器省电'   { IdxOf '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1' '12bbebe6-58d6-4636-95bb-3217ef867c1a' }   # 0=最高性能
Try-Run '活动电源方案'     { powercfg /getactivescheme }
Try-Run '屏保'             { $d = Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue; 'ScreenSaveActive=' + $d.ScreenSaveActive + '  Timeout=' + $d.ScreenSaveTimeOut + 's  Secure=' + $d.ScreenSaverIsSecure }
Try-Run '更新自动重启策略' { $au = Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -ErrorAction SilentlyContinue; if ($au) { 'NoAutoRebootWithLoggedOnUsers=' + $au.NoAutoRebootWithLoggedOnUsers } else { 'AU 策略键不存在（未配置）⇒ 交付前需按 DEP-04 配' } }
Try-Run '待重启标志'       { 'WU RebootRequired=' + (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') + '  CBS RebootPending=' + (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') }

# ---------------------------------------------------------------- 五、Node / 浏览器 / 网络
Section '五、运行时与浏览器（ADR-0002：Node 24 LTS 基线；浏览器类门禁需 msedge）'
Try-Run 'node --version'  { $v = & node --version 2>&1; $v }
Try-Run 'node:sqlite 可用' { & node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(a)');d.prepare('insert into t values(1)').run();const r=d.prepare('select count(*) c from t').get();console.log('ok rows='+r.c)" 2>&1 }
Try-Run 'npm --version'   { & npm --version 2>&1 }
Try-Run 'msedge 路径'     { $p = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1; if ($p) { $p + '  版本=' + (Get-Item $p).VersionInfo.ProductVersion } else { '未找到 msedge.exe' } }
Try-Run '网络适配器'      { Get-NetAdapter -ErrorAction SilentlyContinue | Select-Object Name, InterfaceDescription, Status, LinkSpeed | Format-Table -AutoSize }
Try-Run 'IP 配置'         { Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object InterfaceAlias, IPAddress, PrefixLength | Format-Table -AutoSize }
Try-Run '时间服务状态'    { $s = Get-Service w32time -ErrorAction SilentlyContinue; if ($s) { 'w32time=' + $s.Status } else { 'w32time 服务不存在' } }

# ---------------------------------------------------------------- 六、仓库与门禁（若已就位）
Section '六、仓库与门禁（若仓库已拷到本机且 Node 24 已装；不需要外网）'
$repoCandidates = @()
if ($PSScriptRoot) {
  # 本包常见的两种摆放：<仓库>\离线部署包  与  <仓库>\本地归档\离线部署包
  $parent = Split-Path $PSScriptRoot -Parent
  $grand = $null
  if ($parent) { $grand = Split-Path $parent -Parent }
  if ($parent) { $repoCandidates += $parent; $repoCandidates += (Join-Path $parent 'production-dashboard') }
  if ($grand) { $repoCandidates += $grand }
}
$repoCandidates += 'D:\work\vibecoding\production-dashboard'
$repo = $repoCandidates | Where-Object { $_ -and (Test-Path (Join-Path $_ 'tests\preflight.js')) } | Select-Object -First 1
if (-not $repo) {
  W '未找到仓库（期望含 tests\preflight.js）。请把整个仓库目录拷到本机后重跑本脚本，或手工执行：'
  W '    node tests\preflight.js'
  W '    node tests\run-all.js            （完整；含浏览器与 5 分钟长跑）'
  W '    node tests\run-all.js --fast      （快跑；跳过耗时/浏览器类）'
} else {
  W ('仓库位置：' + $repo)
  Try-Run 'git 状态' { (git -C $repo status -sb 2>&1 | Out-String).Trim() }
  Try-Run 'git HEAD' { (git -C $repo log --oneline -1 2>&1 | Out-String).Trim() }
  $nodeOk = $false
  try { $mv = (& node --version 2>&1) -replace '^v',''; $major = [int]($mv.Split('.')[0]); $nodeOk = ($major -ge 24) } catch { $nodeOk = $false }
  if (-not $nodeOk) {
    W 'Node 未安装或低于 24 ⇒ 先解压离线包（node-v24.21.0-win-x64.zip）并把其目录加入 PATH，再重跑本脚本。'
  } else {
    W 'Node ≥ 24 已就位 ⇒ 开始跑 preflight 与门禁（输出同时打印在本报告里）'
    Try-Run 'preflight' { Push-Location $repo; try { & node 'tests\preflight.js' 2>&1 | Out-String } finally { Pop-Location } }
    Try-Run 'run-all --fast' { Push-Location $repo; try { & node 'tests\run-all.js' '--fast' 2>&1 | Out-String } finally { Pop-Location } }
    W '（完整门禁请另跑：node tests\run-all.js —— 含浏览器类与 5 分钟长跑）'
  }
}

# ---------------------------------------------------------------- 输出
# 报告写到本目录下的 `._env-report\`：目录名以 `._` 开头 ⇒ 既被 .gitignore 的 `._*` 规则忽略，
# 也被 tests\files-check.js 的"点号目录跳过"规则跳过。**这不是洁癖**：报告是 UTF-8 **带 BOM** 的
# .txt，而本仓门禁要求"除 .ps1 外一律不带 BOM" ⇒ 报告若落在被扫描目录里，会把 files-check 直接判红
# （2026-09-28 出包前实测发现）。
$outDir = Join-Path $PSScriptRoot '._env-report'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$outFile = Join-Path $outDir ('部署环境体检报告-' + $env:COMPUTERNAME + '-' + $stamp + '.txt')
$text = ($Lines -join "`r`n")
[System.IO.File]::WriteAllText($outFile, $text, (New-Object System.Text.UTF8Encoding($true)))   # 带 BOM，记事本友好
Write-Output ''
Write-Output ('体检完成。报告文件：' + $outFile)
Write-Output ('请把该 txt 原样回传（含第六节的门禁输出）。')
