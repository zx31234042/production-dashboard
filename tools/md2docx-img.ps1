param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [string]$DocTitle = "Document",
  [int]$MaxImageWidth = 1920,      # 嵌入前把过宽的截图等比缩小到该像素宽
  [int]$JpegQuality = 85
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
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

function Runs([string]$text, [int]$sz = 21, [bool]$boldAll = $false, [string]$color = "") {
  $sb = New-Object System.Text.StringBuilder
  if ($null -eq $text) { return "" }
  $pattern = '(\*\*.+?\*\*|`[^`]+`)'
  $parts = [regex]::Split($text, $pattern)
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

$build = Join-Path $outDir "._docx_build"
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
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

if (Test-Path $outFull) { Remove-Item $outFull -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($build, $outFull, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item $build -Recurse -Force

$fi = Get-Item $outFull
Write-Host "OK -> $($fi.FullName)"
Write-Host "     size: $([math]::Round($fi.Length/1MB,2)) MB   images: $($images.Count)"
