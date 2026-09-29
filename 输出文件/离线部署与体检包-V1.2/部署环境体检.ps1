# ==========================================================================
#  现场部署环境体检（离线可跑；不需要管理员、不需要外网）
#  用途：在到货的看板主机（联想开天 M630Z）上采集 ENV / DEP / Q-26 相关实测读数，**本包自带便携 Node 24 并自动定位**（无需操作员改 PATH）。
#        并在装了 Node 24 且仓库已就位时顺带跑 preflight 与全量门禁（不依赖任何 npm 包）。
#  产出：同目录 部署环境体检报告-<主机名>-<时间戳>.txt（UTF-8 带 BOM，记事本可直接看）
#  依据：需求 ENV-01/ENV-16/ENV-20、DEP-04、NFR-05；技术债 Q-26；ADR-0002（Node 24 LTS 基线）
#  编码：本文件必须保存为 UTF-8 **带 BOM**（PS 5.1 按 ANSI 读无 BOM 的 UTF-8 会把中文读崩）。
#  注意：只读采集、不改系统，除自身报告文件外不写任何东西；唯第六节在仓库就位时会跑
#        仓库自带门禁，那一步只写 <仓库>\tests\._verify\ 下的日志/账本（不写系统、不装东西）。
# ==========================================================================
#  三个入口（都是双击式）：① 体检-双击运行.cmd ⇒ 只读体检；② 配置-DEP04.cmd ⇒ 写配置（自动提权）；③ 跑现场门禁.cmd ⇒ 逐个跑浏览器/视觉类门禁
param([switch]$ConfigureDep04, [switch]$RunFieldGates, [string]$Only = '')

$ErrorActionPreference = 'Continue'

# ---- 子进程输出编码（现场实测缺口，2026-09-29 修）---------------------------------
# 本脚本会把 node 的输出捕获进报告（`& node … | Out-String`）。PS 5.1 用**控制台输出编码**
# 解码子进程的字节流；中文系统默认是 936/GBK，而 node 写的是 UTF-8 ⇒ 捕获到的中文会变成
# "閫氳繃"式乱码（现场机 DESKTOP-1K4A22L 实测：第六节整段不可读）。
# 这里**只改本进程**的输出编码，不改系统设置；设置失败也不阻断（退化为原行为）。
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch { }
# ==========================================================================
#  -ConfigureDep04：现场"无人值守"配置（DEP-04）—— **需要管理员**
#  只改下列几项（其余一概不碰），改完立即**回读**并写报告：
#    ① 睡眠/休眠/关屏 = 从不（AC＋DC 共六项）  ② 无线适配器省电 = 最高性能
#    ③ 屏保 = 关闭（HKCU）                    ④ 更新后不自动重启（HKLM 策略；**不关闭更新本身**）
#  不在本脚本内：分辨率与缩放（须 75 寸屏到位后人工设 3840×2160@30 并锁定缩放，见 README）。
#  背景：现场首份报告（2026-09-29）实测 DEP-04 **六项全未配**（睡眠 30/15 min、休眠 3 h、
#        关屏 10/5 min、屏保开、AU 策略键缺、方案＝平衡）。
# ==========================================================================
if ($ConfigureDep04) {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { Write-Output '需要管理员权限：请双击同目录的 配置-DEP04.cmd（它会自行请求提权）。'; exit 2 }
  $dir = Join-Path $PSScriptRoot '._env-report'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $rep = Join-Path $dir ('DEP04配置报告-' + $env:COMPUTERNAME + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
  $L2 = New-Object System.Collections.Generic.List[string]
  function W2($s) { $script:L2.Add([string]$s) }
  function IdxOf2($sub, $set) {
    $q = & powercfg /q SCHEME_CURRENT $sub $set 2>&1
    $hits = @($q | Select-String -Pattern '0x[0-9a-fA-F]+' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value })
    return (($hits | Select-Object -Last 2) -join ' / ')
  }
  W2 '现场无人值守配置报告（DEP-04）'
  W2 ('生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '    主机：' + $env:COMPUTERNAME + '    管理员：' + $admin)
  W2 ''
  W2 '—— 改前 ——'
  W2 ('睡眠 AC/DC      : ' + (IdxOf2 '238c9fa8-0aad-41ed-83f4-97be242c8f20' '29f6c1db-86da-48c5-9fdb-f2b67b1f44da'))
  W2 ('休眠 AC/DC      : ' + (IdxOf2 '238c9fa8-0aad-41ed-83f4-97be242c8f20' '9d7815a6-7ee4-497e-8888-515a05f02364'))
  W2 ('关屏 AC/DC      : ' + (IdxOf2 '7516b95f-f776-4464-8c53-06167f40cc99' '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e'))
  W2 ('无线省电 AC/DC  : ' + (IdxOf2 '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1' '12bbebe6-58d6-4636-95bb-3217ef867c1a'))
  foreach ($k in @('standby-timeout-ac','standby-timeout-dc','hibernate-timeout-ac','hibernate-timeout-dc','monitor-timeout-ac','monitor-timeout-dc')) { & powercfg /change $k 0 | Out-Null }
  & powercfg /setacvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0 | Out-Null
  & powercfg /setdcvalueindex SCHEME_CURRENT 19cbb8fa-5279-450e-9fac-8a3d5fedd0c1 12bbebe6-58d6-4636-95bb-3217ef867c1a 0 | Out-Null
  & powercfg /setactive SCHEME_CURRENT | Out-Null
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveActive -Value '0' -Force -ErrorAction SilentlyContinue
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaveTimeOut -Value '0' -Force -ErrorAction SilentlyContinue
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name ScreenSaverIsSecure -Value '0' -Force -ErrorAction SilentlyContinue
  $au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
  if (-not (Test-Path $au)) { New-Item -Path $au -Force | Out-Null }
  New-ItemProperty -Path $au -Name NoAutoRebootWithLoggedOnUsers -Value 1 -PropertyType DWord -Force | Out-Null
  W2 ''
  W2 '—— 改后（回读） ——'
  W2 ('睡眠 AC/DC      : ' + (IdxOf2 '238c9fa8-0aad-41ed-83f4-97be242c8f20' '29f6c1db-86da-48c5-9fdb-f2b67b1f44da') + '   （0x0 = 从不）')
  W2 ('休眠 AC/DC      : ' + (IdxOf2 '238c9fa8-0aad-41ed-83f4-97be242c8f20' '9d7815a6-7ee4-497e-8888-515a05f02364') + '   （0x0 = 从不）')
  W2 ('关屏 AC/DC      : ' + (IdxOf2 '7516b95f-f776-4464-8c53-06167f40cc99' '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e') + '   （0x0 = 从不）')
  W2 ('无线省电 AC/DC  : ' + (IdxOf2 '19cbb8fa-5279-450e-9fac-8a3d5fedd0c1' '12bbebe6-58d6-4636-95bb-3217ef867c1a') + '   （0x0 = 最高性能）')
  $dk = Get-ItemProperty 'HKCU:\Control Panel\Desktop' -ErrorAction SilentlyContinue
  W2 ('屏保            : ScreenSaveActive=' + $dk.ScreenSaveActive + '  Timeout=' + $dk.ScreenSaveTimeOut + '   （应为 0 / 0）')
  $a2 = Get-ItemProperty $au -ErrorAction SilentlyContinue
  W2 ('更新自动重启    : NoAutoRebootWithLoggedOnUsers=' + $a2.NoAutoRebootWithLoggedOnUsers + '   （1 = 已禁止"登录用户在线时自动重启"；更新本身未关闭）')
  W2 ('活动电源方案    : ' + ((& powercfg /getactivescheme) -join ''))
  W2 ''
  W2 '说明：分辨率与缩放**不在本脚本内** —— 须 75 寸屏到位后人工设 3840×2160@30Hz，并在'
  W2 '      「设置 → 系统 → 显示 → 缩放」固定缩放（建议 150%）后锁定。'
  W2 '请把本报告随体检报告一并回传（主代理据此登记）。'
  [System.IO.File]::WriteAllText($rep, ($L2 -join "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  Write-Output ('配置完成。报告：' + $rep)
  exit 0
}



# ---------------------------------------------------------------- Node 定位（不要求操作员改 PATH）
# 现场最容易卡住的一步是"装 Node 并把它加进 PATH"，且 **Win10 与 Win11 的图形入口不一致**：
# Win11 的「系统」页里没有"系统信息"，高级系统设置藏在「关于」里（2026-09-28 在本机实测）。
# 因此本脚本按顺序自己找 Node，**只在本次进程内**把找到的目录前置到 PATH —— 不改系统、不改用户变量：
#   ① 本包同目录下的 `._node\`（推荐：随包发布；点号前缀是**故意的** —— 该目录必须被仓库文件卫生门禁跳过，见 E53）
#   ② 本包同目录下的 node\   ③ 本包同目录下任意 node-v*-win-x64\
#   ④ 都没有 ⇒ 用系统 PATH 上已有的 node（第五节会如实报出实际路径）
$NodeDir = $null
if ($PSScriptRoot) {
  $cands = @((Join-Path $PSScriptRoot '._node'), (Join-Path $PSScriptRoot 'node'))
  $cands += @(Get-ChildItem -Path $PSScriptRoot -Directory -Filter '._node-v*-win-x64' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  $cands += @(Get-ChildItem -Path $PSScriptRoot -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  foreach ($d in $cands) { if ($d -and (Test-Path (Join-Path $d 'node.exe'))) { $NodeDir = $d; break } }
}
if ($NodeDir) { $env:PATH = $NodeDir + ';' + $env:PATH }
# ==========================================================================
#  -RunFieldGates：现场"逐个跑"浏览器类＋视觉类门禁（不需管理员、不需外网）
#  为什么单列：现场手工敲 `node tests\…` 极易敲错（2026-09-29 现场把 `tests\` 敲成
#  `test\` ⇒ 报 "Cannot find module"）；且**逐个跑**能避开 `E55`（无 git 的机器跑全量
#  `run-all` 会误报"权威数字已漂移"）。本模式复用上面的仓库/Node 定位逻辑，
#  按顺序跑、**每个脚本输出各落一份日志**，最后写一份汇总报告。
#  用法：-RunFieldGates            ⇒ 跑全部五项
#        -RunFieldGates -Only screenshot-diff,browser-check   ⇒ 只跑指定项
# ==========================================================================
if ($RunFieldGates) {
  $stampG = Get-Date -Format 'yyyyMMdd-HHmmss'
  $dirG = Join-Path $PSScriptRoot '._env-report'
  if (-not (Test-Path $dirG)) { New-Item -ItemType Directory -Path $dirG | Out-Null }
  $logDir = Join-Path $dirG ('现场门禁日志-' + $stampG)
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $repG = Join-Path $dirG ('现场门禁报告-' + $env:COMPUTERNAME + '-' + $stampG + '.txt')
  $G = New-Object System.Collections.Generic.List[string]
  function WG($s) { $script:G.Add([string]$s) }
  $repoG = $null
  $candG = @()
  if ($PSScriptRoot) {
    $pG = Split-Path $PSScriptRoot -Parent
    $gG = $null
    if ($pG) { $gG = Split-Path $pG -Parent }
    if ($pG) { $candG += $pG; $candG += (Join-Path $pG 'production-dashboard') }
    if ($gG) { $candG += $gG }
  }
  $candG += 'D:\production-dashboard'
  foreach ($d in $candG) { if ($d -and (Test-Path (Join-Path $d 'tests\preflight.js'))) { $repoG = $d; break } }
  $nodeFrom = '系统 PATH'
  if ($NodeDir) { $nodeFrom = $NodeDir }
  WG '现场门禁报告（浏览器类 ＋ 视觉类，逐个跑）'
  WG ('生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '    主机：' + $env:COMPUTERNAME)
  if ($repoG) { WG ('仓库    ：' + $repoG) } else { WG '仓库    ：**未找到**' }
  WG ('Node    ：' + $nodeFrom)
  WG ('日志目录：' + $logDir)
  WG ''
  if (-not $repoG) {
    WG '未找到仓库（期望含 tests\preflight.js）⇒ 请把整个仓库目录拷到本机后重跑本入口。'
    [System.IO.File]::WriteAllText($repG, ($G -join "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
    Write-Output ('未找到仓库。报告：' + $repG)
    exit 1
  }
  $items = @(
    @{ n = 'capture-baseline'; why = '生成候选截图（screenshot-diff 的前置，需 Edge ≥ 112）' },
    @{ n = 'screenshot-diff';  why = '视觉回归（基线为 1920×1080）' },
    @{ n = 'browser-check';    why = '真实浏览器（无头 Edge ＋ CDP）' },
    @{ n = 'overlap-check';    why = '元素重叠检测' },
    @{ n = 'stress-check';     why = '长跑稳定性（默认 5 分钟；--soak 为整班次）' }
  )
  if ($Only -ne '') {
    $want = @($Only -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    $items = @($items | Where-Object { $want -contains $_.n })
  }
  Push-Location $repoG
  try {
    foreach ($it in $items) {
      $log = Join-Path $logDir ($it.n + '.log')
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $out = & node ('tests\' + $it.n + '.js') 2>&1 | Out-String
      $code = $LASTEXITCODE
      $sw.Stop()
      [System.IO.File]::WriteAllText($log, $out, (New-Object System.Text.UTF8Encoding($false)))
      $sum = ($out -split "`r?`n" | Where-Object { $_ -match '通过\s*\d+\s*项' } | Select-Object -Last 1)
      if (-not $sum) { $sum = ($out -split "`r?`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1) }
      WG ('{0,-17} {1,7:N1}s  退出码={2}   {3}' -f $it.n, $sw.Elapsed.TotalSeconds, $code, $sum.Trim())
      WG ('   → ' + $it.why + '；日志：' + $log)
      Write-Output ('  ' + $it.n + '  退出码=' + $code + '   ' + $sum.Trim())
    }
  } finally { Pop-Location }
  WG ''
  WG '说明：本模式**逐个**跑，故不会触发 E55（无 git 的机器跑全量 run-all 会误报"权威数字漂移"）。'
  WG '请把本报告 ＋ 日志目录里的 .log 一并回传（主代理据此登记）。'
  [System.IO.File]::WriteAllText($repG, ($G -join "`r`n"), (New-Object System.Text.UTF8Encoding($true)))
  Write-Output ('完成。报告：' + $repG)
  exit 0
}

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
W ("控制台输出编码：" + [Console]::OutputEncoding.WebName + "（子进程输出按此编码解码；UTF-8 才能正确显示中文）")
if ($NodeDir) { W ("Node 定位  ：" + $NodeDir + "（本包自带；仅本次进程内前置到 PATH，未改系统、未改用户变量）") }
else { W "Node 定位  ：本包同目录未自带便携 Node ⇒ 用系统 PATH 上的 node（见第五节实际路径）" }

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
Try-Run 'node 实际路径' { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { '（PATH 上找不到 node）' } }
Try-Run 'PATH 上另装的 node' {
  $pk = $NodeDir
  $all = @(Get-Command node -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source } | Where-Object { $_ })
  if ($pk) { $all = @($all | Where-Object { $_.ToLower() -ne ((Join-Path $pk 'node.exe')).ToLower() }) }
  if ($all.Count -eq 0) { '无（门禁用的就是包内那份）' }
  else {
    $other = $all[0]
    $ov = (& $other --version 2>&1)
    if ($pk) { $pv = (& (Join-Path $pk 'node.exe') --version 2>&1); ('另装：' + $other + '（' + $ov + '）；包内：' + $pv + ' ⇒ 两者不同时**门禁读数以包内为准**（本包入口已把包内目录前置到 PATH）') }
    else { ('另装：' + $other + '（' + $ov + '）') }
  }
}

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
  Try-Run 'git 可用性' { if (Get-Command git -ErrorAction SilentlyContinue) { 'git 可用（docs-check 的历史提交信息类断言可判定）' } else { '**未安装 git** ⇒ docs-check 读不到提交历史（会打印"共 0 条"而报红）、docs-cross-check 的逐脚本比对也不成立 ⇒ 报告里若出现 docs-check / docs-cross-check 红项，属**环境所致、不是代码问题**，照常回传即可' } }
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
