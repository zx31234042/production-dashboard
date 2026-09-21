param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [string]$DocTitle = "Document"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression          # ZipArchive / ZipArchiveMode 所在程序集（FileSystem 只是其包装）

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
      $isBold = $boldAll
      $isCode = $false
      $content = $p
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

$build = Join-Path ([System.IO.Path]::GetDirectoryName($OutPath)) "._docx_build"
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
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
New-DocxPackage $build $OutPath
Remove-Item $build -Recurse -Force

$fi = Get-Item $OutPath
Write-Host "OK -> $($fi.FullName) ($($fi.Length) bytes)"
