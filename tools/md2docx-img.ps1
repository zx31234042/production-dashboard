param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [string]$DocTitle = "Document",
  [int]$MaxImageWidth = 1920,      # 嵌入前把过宽的截图等比缩小到该像素宽
  [int]$JpegQuality = 85
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression          # ZipArchive / ZipArchiveMode 所在程序集（FileSystem 只是其包装）
# ===== E15 入口 BOM 自检（报错文本纯 ASCII，见 tools\Markdown转Word工具说明.md 第十节）=====
$md2docxScriptPath = $MyInvocation.MyCommand.Path
if (-not $md2docxScriptPath) { $md2docxScriptPath = $PSCommandPath }
# 0xEF 0xBB 0xBF 在源码里一律写成 [byte]0xEF 这类形式：ASCII 字节，任何编码下读法相同。
$md2docxBom = [byte[]]@(0xEF,0xBB,0xBF)
# 探针字面量必须留着这 4 个汉字本身（UTF-8 字节 E5 BE AE E8 BD AF E9 9B 85 E9 9B 85）：
# 自检要在本文件自己的字节里找这段序列；写成 [char]0x.. 拼接会找不到自己而误报。
$md2docxCnProbeText = "微软雅黑"
if ($md2docxCnProbeText) { $md2docxCnProbe = [System.Text.Encoding]::UTF8.GetBytes($md2docxCnProbeText) } else { $md2docxCnProbe = [byte[]]@() }
function New-Md2DocxBomFailure([string]$reason) {
  $lines = @(
    '',
    '  [FAIL] BOM SELF-CHECK FAILED - this script cannot produce a trustworthy .docx.',
    ('         reason   : ' + $reason),
    ('         script   : ' + $md2docxScriptPath),
    '         howto    : rewrite the file as UTF-8 WITH BOM (EF BB BF), then re-run.',
    '         why      : PowerShell 5.1 reads a BOM-less .ps1 as system ANSI, so every',
    '                    Chinese literal (e.g. the East Asian font name) is silently decoded',
    '                    wrong and written into the .docx; tests\files-check.js also asserts',
    '                    that tools/*.ps1 must carry a BOM.',
    '         doc      : tools\Markdown转Word工具说明.md - see the BOM section',
    ''
  )
  [Console]::Error.WriteLine(($lines -join [Environment]::NewLine))
  exit 3
}
if (-not $md2docxScriptPath) { New-Md2DocxBomFailure 'cannot resolve this script path ($MyInvocation.MyCommand.Path is empty)' }
$scriptBytes = $null
try { $scriptBytes = [System.IO.File]::ReadAllBytes($md2docxScriptPath) }
catch { New-Md2DocxBomFailure ('cannot read this script file: ' + $_.Exception.Message) }
if ($scriptBytes.Length -lt 3) { New-Md2DocxBomFailure 'file shorter than 3 bytes, so no BOM' }
# 自查本身要能在"脚本正被按 ANSI 读"的处境下活下来：一律用 @() 包住再取 .Count/.Length，
# 不用 $x[0] 直接索引（$null 会抛 "Cannot index into a null array"，那又变成不可读的失败）。
$md2docxBomOk = $false
if (@($md2docxBom).Count -ge 3 -and $scriptBytes.Length -ge 3) {
  $md2docxBomOk = ($md2docxBom[0] -eq $scriptBytes[0]) -and ($md2docxBom[1] -eq $scriptBytes[1]) -and ($md2docxBom[2] -eq $scriptBytes[2])
}
if (-not $md2docxBomOk) {
  New-Md2DocxBomFailure 'missing UTF-8 BOM: first 3 bytes are not EF BB BF'
}
$md2docxProbeFound = $false
$md2docxProbeLen = @($md2docxCnProbe).Count
if ($md2docxProbeLen -ge 4 -and $scriptBytes.Length -ge $md2docxProbeLen) {
  for ($pi = 0; $pi -le ($scriptBytes.Length - $md2docxProbeLen); $pi++) {
    $same = $true
    for ($pj = 0; $pj -lt $md2docxProbeLen; $pj++) {
      if ($scriptBytes[$pi + $pj] -ne $md2docxCnProbe[$pj]) { $same = $false; break }
    }
    if ($same) { $md2docxProbeFound = $true; break }
  }
}
if (-not $md2docxProbeFound) {
  New-Md2DocxBomFailure 'BOM present but the UTF-8 bytes of the East Asian font literal are gone: the body was re-encoded by an ANSI round-trip'
}

# ===== E14 目标占用预检（只读探测，不改动目标文件一个字节）=====
$buildDir = $null          # 本次构建目录（打包结束后删除）
$targetFile = $null        # 本次目标 .docx（占用时按名清理同目录 ~$ 锁文件）
$newTargetFile = $false         # 目标原本不存在（保留变量名：文档/自检里引用它）
$targetExistedBeforeRun = $true # 真实判据：**写出之前**目标是否存在（见清理函数；别在写出后再判）
$buildCompleted = $false        # 打包成功返回后才置位 ⇒ 正常路径不删任何东西
$buildOwned = $false       # 构建目录由本次创建/重建 ⇒ 失败清理时才归我删
$exitCode = 0

function Get-Md2DocxLockInfo([string]$file) {
  if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return $null
  } catch {
    return $_.Exception.Message
  } finally {
    if ($null -ne $fs) { $fs.Dispose() }
  }
}

function Get-Md2DocxLockSibling([string]$file) {
  if (-not $file) { return @() }
  $dir = [System.IO.Path]::GetDirectoryName($file)
  if (-not $dir -or -not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }
  $leaf = [System.IO.Path]::GetFileName($file)
  return @(Get-ChildItem -LiteralPath $dir -Force -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name.StartsWith('~$') -and $_.Name.Substring(2).ToLowerInvariant().Contains($leaf.ToLowerInvariant()) } |
    ForEach-Object { $_.FullName })
}

function Write-Md2DocxOccupied([string]$file, [string]$reason) {
  $leafName = [System.IO.Path]::GetFileName($file)
  $sibs = Get-Md2DocxLockSibling $file
  [Console]::Error.WriteLine('')
  [Console]::Error.WriteLine("  [FAIL] 请先关闭 $leafName（可能被 Word/WPS 打开）—— 目标文件当前被占用，本次转换已中止。")
  [Console]::Error.WriteLine("         target : $file")
  [Console]::Error.WriteLine("         cause  : $reason")
  if ($sibs.Count -gt 0) {
    [Console]::Error.WriteLine('         lock   : ' + ($sibs -join ' , '))
    [Console]::Error.WriteLine('                  （~$ 前缀是 Word/WPS 的锁文件；关掉文档后它会自己消失）')
  } else {
    [Console]::Error.WriteLine('         lock   : 未见 ~$ 锁文件 —— 可能是别的程序/脚本持有句柄，或只读属性/权限不足')
  }
  [Console]::Error.WriteLine('         hint   : 这是"目标被占用"，不是转换工具损坏；关掉该文档后原样重跑即可。')
  [Console]::Error.WriteLine('')
}

function Invoke-Md2DocxSafe([string]$what, [scriptblock]$action) {
  try { & $action }
  catch {
    $ex = $_.Exception
    if ($ex.InnerException) { $ex = $ex.InnerException }
    if ($ex -is [System.IO.IOException] -or $ex -is [System.UnauthorizedAccessException]) {
      Write-Md2DocxOccupied $targetFile ($what + '：' + $ex.GetType().Name + ' - ' + $ex.Message)
      exit 1
    }
    [Console]::Error.WriteLine('')
    [Console]::Error.WriteLine("  [FAIL] $what 失败：$($ex.GetType().Name) - $($ex.Message)")
    [Console]::Error.WriteLine("         target : $targetFile")
    [Console]::Error.WriteLine('')
    exit 1
  }
}

function Clear-Md2DocxResidue {
  if (-not $buildDir) { return }
  # 清构建目录：置空 + [System.IO.Directory]::Delete(path, true)。
  #   为什么必须先置空：Remove-Item -Recurse -Force 在遇到"外部句柄占住的文件"时会**中途 abort**
  #   （报错后不再删剩余项）；实测残留只剩被占住的那一项、其余已清干净。
  #   为什么用 Directory::Delete(_, $true) 而不是 Remove-Item：前者能把"空目录"一并删掉。
  if ($buildOwned -and (Test-Path -LiteralPath $buildDir -PathType Container)) {
    Get-ChildItem -LiteralPath $buildDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (@(Get-ChildItem -LiteralPath $buildDir -Force -ErrorAction SilentlyContinue).Count -eq 0) {
      try { [System.IO.Directory]::Delete($buildDir, $true) } catch { }
    }
  }
  if ($targetFile) {
    foreach ($sib in (Get-Md2DocxLockSibling $targetFile)) {
      Remove-Item -LiteralPath $sib -Force -ErrorAction SilentlyContinue
    }
  }
  # 只在**失败**路径上删除"本次新写出"的目标文件：
  #   $targetExistedBeforeRun 在**写出之前**取（见预检段）；$buildCompleted 只在打包**成功返回**后置位。
  #   正常路径（打包成功）什么都不删 ⇒ 与改动前行为逐字一致；失败路径才清掉半成品。
  #   为什么不用时间戳：刚写出的文件 LastWriteTime 必然晚于运行起始时刻，拿它当判据会把正常产物删掉（实测踩到）。
  if ($targetExistedBeforeRun -eq $false -and -not $buildCompleted -and $targetFile -and (Test-Path -LiteralPath $targetFile)) {
    Remove-Item -LiteralPath $targetFile -Force -ErrorAction SilentlyContinue
  }
}

Add-Type -AssemblyName System.Drawing

function Esc([string]$s) {
  if ($null -eq $s) { return "" }
  $s = $s -replace '&', '&amp;'
  $s = $s -replace '<', '&lt;'
  $s = $s -replace '>', '&gt;'
  return $s
}

$FONT_EA = "微软雅黑"
$FONT_AS = "Segoe UI"
$FONT_MONO = "Consolas"
$CONTENT_TWIPS = 10466           # A4 纵向、左右页边距 720 twip 时的正文宽度
$EMU_PER_TWIP = 635

# 段落内换行：Markdown 表格单元格无法写多行，作者用 <br> 分段。
# 这里输出 Word 的行内换行 <w:br/>（同一段落内），**不拆段落** —— 拆段落会在表格单元格里引入多余间距。
function Brk() {
  return "<w:r><w:br/></w:r>"
}

function Runs([string]$text, [int]$sz = 21, [bool]$boldAll = $false, [string]$color = "") {
  $sb = New-Object System.Text.StringBuilder
  if ($null -eq $text) { return "" }
  $pattern = '(\*\*.+?\*\*|`[^`]+`)'
  # 先按 <br> / <br/> / <br /> 切段（大小写不敏感、允许中间空格），再逐段做行内解析；
  # 注意：字面 &lt;br&gt; 是转义形式，不被 -split 命中，仍由 Esc() 原样输出。
  $segs = $text -split '(?i)<br\s*/?>'
  for ($si = 0; $si -lt $segs.Count; $si++) {
    if ($si -gt 0) { [void]$sb.Append((Brk)) }
    $parts = [regex]::Split($segs[$si], $pattern)
    foreach ($p in $parts) {
      if ([string]::IsNullOrEmpty($p)) { continue }
      $isBold = $boldAll; $isCode = $false; $content = $p
      if ($p -match '^\*\*(.+)\*\*$') { $content = $Matches[1]; $isBold = $true }
      elseif ($p -match '^`(.+)`$') { $content = $Matches[1]; $isCode = $true }
      $t = Esc $content
      $rf = if ($isCode) { "<w:rFonts w:ascii=`"$FONT_MONO`" w:hAnsi=`"$FONT_MONO`" w:eastAsia=`"$FONT_EA`"/>" } else { "<w:rFonts w:ascii=`"$FONT_AS`" w:hAnsi=`"$FONT_AS`" w:eastAsia=`"$FONT_EA`"/>" }
      $b = if ($isBold) { "<w:b/>" } else { "" }
      $c = if ($color -ne "") { "<w:color w:val=`"$color`"/>" } elseif ($isCode) { "<w:color w:val=`"A31515`"/>" } else { "" }
      $szv = if ($isCode) { $sz - 1 } else { $sz }
      [void]$sb.Append("<w:r><w:rPr>$rf$b$c<w:sz w:val=`"$szv`"/><w:szCs w:val=`"$szv`"/></w:rPr><w:t xml:space=`"preserve`">$t</w:t></w:r>")
    }
  }
  return $sb.ToString()
}

function Para([string]$text, [string]$style = "", [string]$pPrExtra = "", [int]$sz = 21, [bool]$boldAll = $false, [string]$color = "") {
  $s = if ($style -ne "") { "<w:pStyle w:val=`"$style`"/>" } else { "" }
  return "<w:p><w:pPr>$s$pPrExtra</w:pPr>$(Runs $text $sz $boldAll $color)</w:p>"
}

function TableXml($rows, [int]$headerRows = 1) {
  $nCols = 0
  foreach ($r in $rows) { if ($r.Count -gt $nCols) { $nCols = $r.Count } }
  if ($nCols -eq 0) { return "" }
  $totalW = 10400
  $colW = [int]([math]::Floor($totalW / $nCols))
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append("<w:tbl><w:tblPr><w:tblStyle w:val=`"TableGrid`"/><w:tblW w:w=`"$totalW`" w:type=`"dxa`"/><w:tblBorders>")
  foreach ($edge in @("top","left","bottom","right","insideH","insideV")) {
    [void]$sb.Append("<w:$edge w:val=`"single`" w:sz=`"4`" w:space=`"0`" w:color=`"8EA9DB`"/>")
  }
  [void]$sb.Append("</w:tblBorders><w:tblLayout w:type=`"fixed`"/></w:tblPr><w:tblGrid>")
  for ($i = 0; $i -lt $nCols; $i++) { [void]$sb.Append("<w:gridCol w:w=`"$colW`"/>") }
  [void]$sb.Append("</w:tblGrid>")
  $rowIdx = 0
  foreach ($r in $rows) {
    $isHeader = $rowIdx -lt $headerRows
    $trPr = if ($isHeader) { "<w:trPr><w:tblHeader/></w:trPr>" } else { "" }
    [void]$sb.Append("<w:tr>$trPr")
    for ($i = 0; $i -lt $nCols; $i++) {
      $cell = if ($i -lt $r.Count) { $r[$i] } else { "" }
      $shd = if ($isHeader) { "<w:shd w:val=`"clear`" w:color=`"auto`" w:fill=`"DEEAF6`"/>" } else { "" }
      [void]$sb.Append("<w:tc><w:tcPr><w:tcW w:w=`"$colW`" w:type=`"dxa`"/>$shd<w:vAlign w:val=`"center`"/></w:tcPr>")
      [void]$sb.Append("<w:p><w:pPr><w:spacing w:before=`"20`" w:after=`"20`" w:line=`"240`" w:lineRule=`"auto`"/></w:pPr>$(Runs $cell 18 $isHeader)</w:p>")
      [void]$sb.Append("</w:tc>")
    }
    [void]$sb.Append("</w:tr>")
    $rowIdx++
  }
  [void]$sb.Append("</w:tbl><w:p><w:pPr><w:spacing w:after=`"0`" w:line=`"120`" w:lineRule=`"auto`"/></w:pPr></w:p>")
  return $sb.ToString()
}

function SplitRow([string]$line) {
  $l = $line.Trim()
  $l = $l -replace '^\|', ''
  $l = $l -replace '\|$', ''
  return @(($l -split '\|') | ForEach-Object { $_.Trim() })
}

function ImageXml([string]$rid, [int]$id, [long]$wEmu, [long]$hEmu, [string]$name) {
  return @"
<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="140" w:after="60" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:drawing>
<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<wp:extent cx="$wEmu" cy="$hEmu"/><wp:effectExtent l="0" t="0" r="0" b="0"/>
<wp:docPr id="$id" name="Picture$id"/>
<wp:cNvGraphicFramePr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:nvPicPr><pic:cNvPr id="$id" name="$name"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="$rid"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="$wEmu" cy="$hEmu"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
"@
}

# ---------------- 构建目录 ----------------
$mdFull = (Resolve-Path -LiteralPath $InPath).Path
$mdDir = [System.IO.Path]::GetDirectoryName($mdFull)
$outFull = [System.IO.Path]::GetFullPath($OutPath)
$outDir = [System.IO.Path]::GetDirectoryName($outFull)
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

# E14 预检：目标 .docx 被 Word/WPS 打开时，先给出"请先关闭 <文件名>"，而不是抛 IO 异常。
$occupied = Get-Md2DocxLockInfo $outFull
if ($occupied) { Write-Md2DocxOccupied $outFull $occupied; exit 1 }
$targetFile = $outFull
# 占位判定必须在**写出之前**取：写出后再判会恒为 true ⇒ 收尾清理把刚生成的 docx 删掉。
$targetExistedBeforeRun = Test-Path -LiteralPath $outFull

$build = Join-Path $outDir "._docx_build"
$buildDir = $build
$buildOwned = $true
if (Test-Path $build) { Clear-Md2DocxResidue }
New-Item -ItemType Directory -Path $build | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "word") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "word\_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "word\media") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "docProps") | Out-Null

$mediaDir = Join-Path $build "word\media"
$images = New-Object System.Collections.Generic.List[object]
$imgCount = 0

# ---------------- 图片预处理（等比缩小 + JPEG 压缩，控制文档体积） ----------------
function PrepareImage([string]$srcPath, [int]$maxW, [int]$quality) {
  $script:imgCount++
  $img = [System.Drawing.Image]::FromFile($srcPath)
  try {
    $w = $img.Width; $h = $img.Height
    $scale = if ($w -gt $maxW) { $maxW / $w } else { 1.0 }
    $nw = [int][math]::Round($w * $scale)
    $nh = [int][math]::Round($h * $scale)
    if ($scale -lt 1.0) {
      $name = "image$($script:imgCount).jpg"
      $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($img, 0, 0, $nw, $nh)
      $g.Dispose()
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
      $bmp.Save((Join-Path $mediaDir $name), $codec, $ep)
      $bmp.Dispose()
    } else {
      $ext = [System.IO.Path]::GetExtension($srcPath).ToLower()
      if ($ext -eq '.jpeg') { $ext = '.jpg' }
      $name = "image$($script:imgCount)$ext"
      Copy-Item $srcPath (Join-Path $mediaDir $name) -Force
    }
    return [pscustomobject]@{ Name = $name; W = $nw; H = $nh }
  } finally { $img.Dispose() }
}

# ---------------- 解析 Markdown ----------------
$lines = Get-Content -LiteralPath $mdFull -Encoding UTF8
$body = New-Object System.Text.StringBuilder
$i = 0
$inCode = $false
$codeBuf = New-Object System.Collections.Generic.List[string]

while ($i -lt $lines.Count) {
  $line = $lines[$i]
  $trim = $line.Trim()

  if ($trim -like '````*') {
    if (-not $inCode) { $inCode = $true; $codeBuf.Clear() }
    else {
      $inCode = $false
      foreach ($cl in $codeBuf) { [void]$body.Append("<w:p><w:pPr><w:pStyle w:val=`"CodeBlock`"/></w:pPr>$(Runs $cl 18)</w:p>") }
    }
    $i++; continue
  }
  if ($inCode) { $codeBuf.Add($line); $i++; continue }
  if ($trim -eq '') { $i++; continue }

  # 图片：![alt](path){w=NN}
  if ($trim -match '^!\[([^\]]*)\]\(([^)]+)\)\s*(?:\{w=(\d+)\})?\s*$') {
    $alt = $Matches[1]; $rel = $Matches[2]
    $pct = if ($Matches[3]) { [int]$Matches[3] } else { 100 }
    $srcPath = if ([System.IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path $mdDir $rel }
    $srcPath = [System.IO.Path]::GetFullPath($srcPath)
    if (Test-Path -LiteralPath $srcPath) {
      $info = PrepareImage $srcPath $MaxImageWidth $JpegQuality
      $rid = "rIdImg$($images.Count + 1)"
      $wEmu = [long]([math]::Round($CONTENT_TWIPS * $pct / 100.0 * $EMU_PER_TWIP))
      $hEmu = [long]([math]::Round($wEmu * $info.H / $info.W))
      $images.Add([pscustomobject]@{ Rid = $rid; Name = $info.Name })
      [void]$body.Append((ImageXml $rid ($images.Count) $wEmu $hEmu $info.Name))
      if ($alt.Trim() -ne '') {
        [void]$body.Append("<w:p><w:pPr><w:jc w:val=`"center`"/><w:spacing w:after=`"200`" w:line=`"240`" w:lineRule=`"auto`"/></w:pPr>$(Runs $alt 17 $false '595959')</w:p>")
      }
    } else {
      [void]$body.Append((Para "［图片缺失：$rel］" "" "<w:spacing w:after=`"120`"/>"))
    }
    $i++; continue
  }

  if ($trim -match '^-{3,}$' -or $trim -match '^\*{3,}$') {
    [void]$body.Append("<w:p><w:pPr><w:pBdr><w:bottom w:val=`"single`" w:sz=`"6`" w:space=`"1`" w:color=`"BFBFBF`"/></w:pBdr></w:pPr></w:p>")
    $i++; continue
  }

  if ($trim.StartsWith('|')) {
    $rows = New-Object System.Collections.Generic.List[object]
    while ($i -lt $lines.Count -and $lines[$i].Trim().StartsWith('|')) {
      $t = $lines[$i].Trim()
      if ($t -match '^\|[\s\-:\|]+\|$') { $i++; continue }
      $rows.Add((SplitRow $t)); $i++
    }
    [void]$body.Append((TableXml $rows 1)); continue
  }

  if ($trim -match '^(#{1,6})\s+(.*)$') {
    [void]$body.Append((Para $Matches[2] ("Heading" + $Matches[1].Length))); $i++; continue
  }

  if ($trim.StartsWith('>')) {
    [void]$body.Append("<w:p><w:pPr><w:pStyle w:val=`"Quote`"/></w:pPr>$(Runs ($trim.Substring(1).Trim()) 20 $false '595959')</w:p>")
    $i++; continue
  }

  if ($trim -match '^[-*+]\s+(.*)$') {
    $indent = $line.Length - $line.TrimStart().Length
    $lvl = if ($indent -ge 2) { 1 } else { 0 }
    $mark = if ($lvl -eq 0) { "• " } else { "◦ " }
    $ind = 360 + ($lvl * 360)
    [void]$body.Append("<w:p><w:pPr><w:ind w:left=`"$ind`" w:hanging=`"240`"/><w:spacing w:after=`"40`" w:line=`"260`" w:lineRule=`"auto`"/></w:pPr>$(Runs ($mark + $Matches[1]) 21)</w:p>")
    $i++; continue
  }

  if ($trim -match '^(\d+)\.\s+(.*)$') {
    [void]$body.Append("<w:p><w:pPr><w:ind w:left=`"360`" w:hanging=`"300`"/><w:spacing w:after=`"40`" w:line=`"260`" w:lineRule=`"auto`"/></w:pPr>$(Runs $trim 21)</w:p>")
    $i++; continue
  }

  [void]$body.Append((Para $trim "" "<w:spacing w:after=`"80`" w:line=`"280`" w:lineRule=`"auto`"/>"))
  $i++
}

# ---------------- 组装各 XML 部件 ----------------
$docXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
$($body.ToString())
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="720" w:bottom="1134" w:left="720" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:linePitch="312"/></w:sectPr>
</w:body>
</w:document>
"@

$stylesXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="$FONT_AS" w:hAnsi="$FONT_AS" w:eastAsia="$FONT_EA" w:cs="$FONT_AS"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="280" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="1F4E79"/></w:pBdr></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="300" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="1F4E79"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:color w:val="404040"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:before="80" w:after="80"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="200"/></w:pPr><w:rPr><w:rFonts w:ascii="$FONT_MONO" w:hAnsi="$FONT_MONO" w:eastAsia="$FONT_EA"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="8EA9DB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="8EA9DB"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="8EA9DB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="8EA9DB"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="8EA9DB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="8EA9DB"/></w:tblBorders></w:tblPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>
"@

$contentTypes = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpg" ContentType="image/jpeg"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>
"@

$rels = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>
"@

$docRelsSb = New-Object System.Text.StringBuilder
[void]$docRelsSb.Append("<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?>`n<Relationships xmlns=`"http://schemas.openxmlformats.org/package/2006/relationships`">`n")
[void]$docRelsSb.Append("<Relationship Id=`"rId1`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles`" Target=`"styles.xml`"/>`n")
foreach ($im in $images) {
  [void]$docRelsSb.Append("<Relationship Id=`"$($im.Rid)`" Type=`"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image`" Target=`"media/$($im.Name)`"/>`n")
}
[void]$docRelsSb.Append("</Relationships>")
$docRels = $docRelsSb.ToString()

$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$coreXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>$(Esc $DocTitle)</dc:title>
<dcterms:created xsi:type="dcterms:W3CDTF">$now</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">$now</dcterms:modified>
<cp:revision>1</cp:revision>
</cp:coreProperties>
"@

$appXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>DSH md2docx-img</Application>
</Properties>
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $build "[Content_Types].xml"), $contentTypes, $utf8)
[System.IO.File]::WriteAllText((Join-Path $build "_rels\.rels"), $rels, $utf8)
[System.IO.File]::WriteAllText((Join-Path $build "word\document.xml"), $docXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $build "word\styles.xml"), $stylesXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $build "word\_rels\document.xml.rels"), $docRels, $utf8)
[System.IO.File]::WriteAllText((Join-Path $build "docProps\core.xml"), $coreXml, $utf8)
[System.IO.File]::WriteAllText((Join-Path $build "docProps\app.xml"), $appXml, $utf8)

# 打包为 OPC 合规的 docx：部件名必须用正斜杠。
# 注意：.NET Framework 的 ZipFile::CreateFromDirectory 在 Windows 上会写成反斜杠（不合规），
#       因此这里手工建条目，并把 [Content_Types].xml / _rels/.rels 放在最前面。
function New-DocxPackage([string]$SourceDir, [string]$TargetPath) {
  $root = (Resolve-Path -LiteralPath $SourceDir).Path      # 统一成绝对路径，避免相对路径截断出错
  $target = if ([System.IO.Path]::IsPathRooted($TargetPath)) { $TargetPath }
            else { Join-Path (Get-Location).Path $TargetPath }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  $zip = [System.IO.Compression.ZipFile]::Open($target, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $all = @(Get-ChildItem -Path $root -Recurse -File | ForEach-Object {
      $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    })
    $head = @('[Content_Types].xml', '_rels/.rels')
    $names = @($head | Where-Object { $all -contains $_ }) + @($all | Where-Object { $head -notcontains $_ })
    foreach ($name in $names) {
      $entry = $zip.CreateEntry($name, [System.IO.Compression.CompressionLevel]::Optimal)
      $stream = $entry.Open()
      try {
        $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root $name.Replace('/', '\')))
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
    }
  } finally { $zip.Dispose() }
}
Invoke-Md2DocxSafe '写出 .docx（打包为 OPC 包）' { New-DocxPackage $build $outFull }
$buildCompleted = $true
Remove-Item $build -Recurse -Force

try {
$fi = Get-Item $outFull
Write-Host "OK -> $($fi.FullName)"
Write-Host "     size: $([math]::Round($fi.Length/1MB,2)) MB   images: $($images.Count)"
} finally { Clear-Md2DocxResidue }
exit $exitCode
