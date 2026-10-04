param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [string]$DocTitle = "Document"
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

# 行内 span 正则（行内代码 / 粗体）。GFM 允许用「更多反引号」作定界符来包含反引号本身，
# 例如 `` ④`需求文档\历史文件\` `` 是内容内含反引号的代码跨距；
# 只识别单反引号会把 `` 与内层 ` 错配，结尾多出一个反引号当普通文本漏进 docx。
function InlinePattern() {
  return '(`{2,}[\s\S]+?`{2,}|\*\*.+?\*\*|`[^`]+`)'
}

$INLINE_PATTERN = InlinePattern

# 段落内换行：Markdown 表格单元格无法写多行，作者用 <br> 分段。
# 这里输出 Word 的行内换行 <w:br/>（同一段落内），**不拆段落** —— 拆段落会在表格单元格里引入多余间距。
function Brk() {
  return "<w:r><w:br/></w:r>"
}

function Runs([string]$text, [int]$sz = 21, [bool]$boldAll = $false, [string]$color = "", [hashtable]$scope = $null) {
  $sb = New-Object System.Text.StringBuilder
  if ($null -eq $text) { return "" }
  $pattern = $INLINE_PATTERN
  # 先按 <br> / <br/> / <br /> 切段（大小写不敏感、允许中间空格），再逐段做行内解析；
  # 注意：字面 &lt;br&gt; 是转义形式，不被 -split 命中，仍由 Esc() 原样输出。
  $segs = $text -split '(?i)<br\s*/?>'
  for ($si = 0; $si -lt $segs.Count; $si++) {
    if ($si -gt 0) { [void]$sb.Append((Brk)) }
    $parts = [regex]::Split($segs[$si], $pattern)
    foreach ($p in $parts) {
      if ([string]::IsNullOrEmpty($p)) { continue }
      $isBold = $boldAll
      $isCode = $false
      $content = $p
      $face = $FONT_AS
      $szv = $sz
      $col = $color
      if ($p -match '^\*\*(.+)\*\*$') {
        $content = $Matches[1]
        $isBold = $true
        # E26 修法①：粗体段内若还嵌着行内代码，必须递归解析后再输出 ——
        #   否则 `x` 的分隔反引号会当普通文本漏进 docx（本次就是「为过出口自检而剥反引号」的根因）。
        if ($content.Contains([char]0x60)) {
          $innerScope = @{ Face = $FONT_AS; Bold = $true; Color = $color; Sz = $sz }
          [void]$sb.Append((Runs $content $sz $true $color $innerScope))
          continue
        }
      }
      elseif (($p.Length -ge 2) -and $p.StartsWith('`') -and $p.EndsWith('`')) { $content = $p.Trim('`'); $isCode = $true }
      $t = Esc $content
      if ($null -ne $scope) { $face = $scope.Face; $szv = $scope.Sz; $isBold = $scope.Bold; if ($scope.Color -ne "") { $col = $scope.Color } }
      if ($isCode) { $face = $FONT_MONO; $szv = $sz - 1; if ($col -eq "") { $col = "A31515" } }
      $rf = "<w:rFonts w:ascii=`"$face`" w:hAnsi=`"$face`" w:eastAsia=`"$FONT_EA`"/>"
      $b = if ($isBold) { "<w:b/>" } else { "" }
      $c = if ($col -ne "") { "<w:color w:val=`"$col`"/>" } else { "" }
      [void]$sb.Append("<w:r><w:rPr>$rf$b$c<w:sz w:val=`"$szv`"/><w:szCs w:val=`"$szv`"/></w:rPr><w:t xml:space=`"preserve`">$t</w:t></w:r>")
    }
  }
  return $sb.ToString()
}

function Para([string]$text, [string]$style = "", [string]$pPrExtra = "", [int]$sz = 21, [bool]$boldAll = $false, [string]$color = "") {
  $s = if ($style -ne "") { "<w:pStyle w:val=`"$style`"/>" } else { "" }
  $runs = Runs $text $sz $boldAll $color
  return "<w:p><w:pPr>$s$pPrExtra</w:pPr>$runs</w:p>"
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
      $cellSz = 18
      [void]$sb.Append("<w:tc><w:tcPr><w:tcW w:w=`"$colW`" w:type=`"dxa`"/>$shd<w:vAlign w:val=`"center`"/></w:tcPr>")
      [void]$sb.Append("<w:p><w:pPr><w:spacing w:before=`"20`" w:after=`"20`" w:line=`"240`" w:lineRule=`"auto`"/></w:pPr>$(Runs $cell $cellSz $isHeader)</w:p>")
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
  $cells = $l -split '\|'
  return @($cells | ForEach-Object { $_.Trim() })
}

# ---------------- parse markdown ----------------
$lines = Get-Content -LiteralPath $InPath -Encoding UTF8
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
      foreach ($cl in $codeBuf) {
        [void]$body.Append("<w:p><w:pPr><w:pStyle w:val=`"CodeBlock`"/></w:pPr>$(Runs $cl 18)</w:p>")
      }
    }
    $i++; continue
  }
  if ($inCode) { $codeBuf.Add($line); $i++; continue }

  if ($trim -eq '') { $i++; continue }

  # horizontal rule
  if ($trim -match '^-{3,}$' -or $trim -match '^\*{3,}$') {
    [void]$body.Append("<w:p><w:pPr><w:pBdr><w:bottom w:val=`"single`" w:sz=`"6`" w:space=`"1`" w:color=`"BFBFBF`"/></w:pBdr></w:pPr></w:p>")
    $i++; continue
  }

  # table
  if ($trim.StartsWith('|')) {
    $rows = New-Object System.Collections.Generic.List[object]
    $sepCount = 0
    while ($i -lt $lines.Count -and $lines[$i].Trim().StartsWith('|')) {
      $t = $lines[$i].Trim()
      if ($t -match '^\|[\s\-:\|]+\|$') { $sepCount++; $i++; continue }
      $rows.Add((SplitRow $t))
      $i++
    }
    [void]$body.Append((TableXml $rows 1))
    continue
  }

  # headings
  if ($trim -match '^(#{1,6})\s+(.*)$') {
    $lvl = $Matches[1].Length
    $txt = $Matches[2]
    $style = "Heading$lvl"
    [void]$body.Append((Para $txt $style))
    $i++; continue
  }

  # blockquote
  if ($trim.StartsWith('>')) {
    $txt = $trim.Substring(1).Trim()
    [void]$body.Append("<w:p><w:pPr><w:pStyle w:val=`"Quote`"/></w:pPr>$(Runs $txt 20 $false '595959')</w:p>")
    $i++; continue
  }

  # bullets
  if ($trim -match '^[-*+]\s+(.*)$') {
    $indent = $line.Length - $line.TrimStart().Length
    $lvl = if ($indent -ge 2) { 1 } else { 0 }
    $txt = $Matches[1]
    $mark = if ($lvl -eq 0) { "• " } else { "◦ " }
    $ind = 360 + ($lvl * 360)
    [void]$body.Append("<w:p><w:pPr><w:ind w:left=`"$ind`" w:hanging=`"240`"/><w:spacing w:after=`"40`" w:line=`"260`" w:lineRule=`"auto`"/></w:pPr>$(Runs ($mark + $txt) 21)</w:p>")
    $i++; continue
  }

  # numbered list: keep as-is with indent
  if ($trim -match '^(\d+)\.\s+(.*)$') {
    $txt = $trim
    [void]$body.Append("<w:p><w:pPr><w:ind w:left=`"360`" w:hanging=`"300`"/><w:spacing w:after=`"40`" w:line=`"260`" w:lineRule=`"auto`"/></w:pPr>$(Runs $txt 21)</w:p>")
    $i++; continue
  }

  # plain paragraph
  [void]$body.Append((Para $trim "" "<w:spacing w:after=`"80`" w:line=`"280`" w:lineRule=`"auto`"/>"))
  $i++
}

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

$docRels = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
"@

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
<Application>DSH md2docx</Application>
</Properties>
"@

# E14 预检：目标 .docx 被 Word/WPS 打开时，先给出"请先关闭 <文件名>"，而不是抛 IO 异常。
$occupied = Get-Md2DocxLockInfo $OutPath
if ($occupied) { Write-Md2DocxOccupied $OutPath $occupied; exit 1 }
$targetFile = $OutPath
# 占位判定必须在**写出之前**取：写出后再判会恒为 true ⇒ 收尾清理把刚生成的 docx 删掉。
$targetExistedBeforeRun = Test-Path -LiteralPath $OutPath

$build = Join-Path ([System.IO.Path]::GetDirectoryName($OutPath)) "._docx_build"
$buildDir = $build
$buildOwned = $true
if (Test-Path $build) { Clear-Md2DocxResidue }
New-Item -ItemType Directory -Path $build | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "word") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "word\_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $build "docProps") | Out-Null

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
Invoke-Md2DocxSafe '写出 .docx（打包为 OPC 包）' { New-DocxPackage $build $OutPath }
$buildCompleted = $true
Remove-Item $build -Recurse -Force

try {
$fi = Get-Item $OutPath
Write-Host "OK -> $($fi.FullName) ($($fi.Length) bytes)"
} finally { Clear-Md2DocxResidue }
exit $exitCode
