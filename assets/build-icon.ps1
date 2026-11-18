# Builds assets/icon-1024.png, assets/icon-256.png and assets/icon.svg.
#
# One geometry, two renderers: System.Drawing paints the raster (drawn at 2x and
# downsampled, so the arcs stay smooth), and the same numbers are written out as
# SVG. Change a value here and both outputs follow.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File assets/build-icon.ps1

Add-Type -AssemblyName System.Drawing

$Invariant = [System.Globalization.CultureInfo]::InvariantCulture
$S = 2048                      # working canvas, 2x the final size
$Scale = 2                     # every design number below is in 1024-space
$C = $S / 2                    # centre
$Out = Join-Path $PSScriptRoot "..\assets"

function Px([double]$v) { return $v * $Scale }
function Pt([double]$cx, [double]$cy, [double]$r, [double]$deg) {
    $rad = $deg * [math]::PI / 180
    return @(($cx + $r * [math]::Cos($rad)), ($cy + $r * [math]::Sin($rad)))
}
function F([double]$v) { return $v.ToString("0.##", $Invariant) }

# --- design tokens -----------------------------------------------------------
$bgTop = [System.Drawing.Color]::FromArgb(255, 14, 17, 23)
$bgBottom = [System.Drawing.Color]::FromArgb(255, 27, 34, 51)
$corner = Px 232
$R = Px 380                    # ring outer radius
$thickness = Px 80
$inner = $R - $thickness       # 286
$gap = 5                       # degrees between ring segments
$segment = (360 / 5) - $gap    # 67 degrees of arc

# Composition palette: one colour per band of the stacked bar.
$palette = @(
    [System.Drawing.Color]::FromArgb(255, 91, 157, 255),   # system prompt
    [System.Drawing.Color]::FromArgb(255, 79, 209, 197),   # user messages
    [System.Drawing.Color]::FromArgb(255, 123, 216, 143),  # assistant replies
    [System.Drawing.Color]::FromArgb(255, 255, 180, 84),   # tool results
    [System.Drawing.Color]::FromArgb(255, 199, 146, 234)   # tool schemas
)

# The centre mark: the same five bands, in the same order, as one capsule.
$capW = Px 420
$capH = Px 92
$capX = $C - ($capW / 2)
$capY = $C - ($capH / 2)
$shares = @(0.26, 0.16, 0.19, 0.16, 0.23)
$segGap = Px 9

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# --- raster ------------------------------------------------------------------
$bmp = [System.Drawing.Bitmap]::new($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

$bgPath = New-RoundedPath 0 0 $S $S $corner
$bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    ([System.Drawing.Rectangle]::new(0, 0, $S, $S)), $bgTop, $bgBottom, 90)
$g.FillPath($bgBrush, $bgPath)

# Soft blue glow in the upper left, clipped to the tile.
$g.SetClip($bgPath)
$glowPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$glowPath.AddEllipse((Px (-120)), (Px (-180)), (Px 1100), (Px 1100))
$glow = [System.Drawing.Drawing2D.PathGradientBrush]::new($glowPath)
$glow.CenterColor = [System.Drawing.Color]::FromArgb(64, 91, 157, 255)
$glow.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 91, 157, 255))
$g.FillPath($glow, $glowPath)
$g.ResetClip()

# Vignette: darken the tile's edges so the ring reads as lit from the middle.
$g.SetClip($bgPath)
$vigPath = [System.Drawing.Drawing2D.GraphicsPath]::new()
$vigPath.AddEllipse((Px (-220)), (Px (-220)), (Px 1464), (Px 1464))
$vig = [System.Drawing.Drawing2D.PathGradientBrush]::new($vigPath)
$vig.CenterColor = [System.Drawing.Color]::FromArgb(0, 0, 0, 0)
$vig.SurroundColors = @([System.Drawing.Color]::FromArgb(110, 0, 0, 0))
$g.FillPath($vig, $vigPath)
$g.ResetClip()

# Ring segments.
for ($i = 0; $i -lt 5; $i++) {
    $start = -90 + $i * 72 + ($gap / 2)
    $pen = [System.Drawing.Pen]::new($palette[$i], $thickness)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Flat
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Flat
    $g.DrawArc($pen, ($C - $R), ($C - $R), ($R * 2), ($R * 2), $start, $segment)
    $pen.Dispose()
}

# Faint inner keyline, so the ring reads as a gauge rather than a logo.
$keyR = Px 286
$keyline = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(26, 255, 255, 255), (Px 2))
$g.DrawEllipse($keyline, ($C - $keyR), ($C - $keyR), ($keyR * 2), ($keyR * 2))
$keyline.Dispose()

# Centre capsule, clipped so the outer ends stay round and the inner cuts sharp.
$capPath = New-RoundedPath $capX $capY $capW $capH ($capH / 2)
$g.SetClip($capPath)
$usable = $capW - ($segGap * ($shares.Count - 1))
$x = $capX
for ($i = 0; $i -lt $shares.Count; $i++) {
    $w = $usable * $shares[$i]
    $brush = [System.Drawing.SolidBrush]::new($palette[$i])
    $g.FillRectangle($brush, $x, $capY, $w, $capH)
    $brush.Dispose()
    $x += $w + $segGap
}
$g.ResetClip()

# Hairline border.
$borderPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(20, 255, 255, 255), (Px 2))
$g.DrawPath($borderPen, $bgPath)
$borderPen.Dispose()

$g.Dispose()

# Downsample to the shipping size.
$final = [System.Drawing.Bitmap]::new(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($final)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$dest = [System.Drawing.Rectangle]::new(0, 0, 1024, 1024)
$g2.DrawImage($bmp, $dest, 0, 0, $S, $S, [System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()
$pngPath = Join-Path $Out "icon-1024.png"
$final.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

$previewSizes = @(256, 128, 64)
foreach ($n in $previewSizes) {
    $preview = [System.Drawing.Bitmap]::new($n, $n, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gp = [System.Drawing.Graphics]::FromImage($preview)
    $gp.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gp.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gp.DrawImage($final, ([System.Drawing.Rectangle]::new(0, 0, $n, $n)), 0, 0, 1024, 1024, [System.Drawing.GraphicsUnit]::Pixel)
    $gp.Dispose()
    $preview.Save((Join-Path $Out "icon-$n.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $preview.Dispose()
}

$final.Dispose()
$bmp.Dispose()

# --- svg ---------------------------------------------------------------------
$sb = [System.Text.StringBuilder]::new()
[void]$sb.AppendLine('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="CC-Context">')
[void]$sb.AppendLine('  <defs>')
[void]$sb.AppendLine('    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">')
[void]$sb.AppendLine('      <stop offset="0" stop-color="#0E1117"/>')
[void]$sb.AppendLine('      <stop offset="1" stop-color="#1B2233"/>')
[void]$sb.AppendLine('    </linearGradient>')
[void]$sb.AppendLine('    <radialGradient id="glow" cx="0.28" cy="0.2" r="0.55">')
[void]$sb.AppendLine('      <stop offset="0" stop-color="#5B9DFF" stop-opacity="0.25"/>')
[void]$sb.AppendLine('      <stop offset="1" stop-color="#5B9DFF" stop-opacity="0"/>')
[void]$sb.AppendLine('    </radialGradient>')
[void]$sb.AppendLine('    <clipPath id="tile"><rect width="1024" height="1024" rx="232" ry="232"/></clipPath>')
[void]$sb.AppendLine('    <clipPath id="capsule"><rect x="302" y="466" width="420" height="92" rx="46" ry="46"/></clipPath>')
[void]$sb.AppendLine('  </defs>')
[void]$sb.AppendLine('  <g clip-path="url(#tile)">')
[void]$sb.AppendLine('    <rect width="1024" height="1024" fill="url(#bg)"/>')
[void]$sb.AppendLine('    <rect width="1024" height="1024" fill="url(#glow)"/>')

for ($i = 0; $i -lt 5; $i++) {
    $a1 = -90 + $i * 72 + ($gap / 2)
    $a2 = $a1 + $segment
    $o1 = Pt 512 512 380 $a1
    $o2 = Pt 512 512 380 $a2
    $i2 = Pt 512 512 300 $a2
    $i1 = Pt 512 512 300 $a1
    $hex = "#{0:X2}{1:X2}{2:X2}" -f $palette[$i].R, $palette[$i].G, $palette[$i].B
    $d = "M {0} {1} A 380 380 0 0 1 {2} {3} L {4} {5} A 300 300 0 0 0 {6} {7} Z" -f (F $o1[0]), (F $o1[1]), (F $o2[0]), (F $o2[1]), (F $i2[0]), (F $i2[1]), (F $i1[0]), (F $i1[1])
    [void]$sb.AppendLine("    <path d=`"$d`" fill=`"$hex`"/>")
}

[void]$sb.AppendLine('    <circle cx="512" cy="512" r="286" fill="none" stroke="#FFFFFF" stroke-opacity="0.10" stroke-width="2"/>')

# The capsule: five bands, proportions matching the ring order.
$capsX = 302
$capsUsable = 420 - (9 * 4)
$cx = $capsX
for ($i = 0; $i -lt $shares.Count; $i++) {
    $w = [math]::Round($capsUsable * $shares[$i], 2)
    $hex = "#{0:X2}{1:X2}{2:X2}" -f $palette[$i].R, $palette[$i].G, $palette[$i].B
    [void]$sb.AppendLine("    <rect x=`"$cx`" y=`"466`" width=`"$w`" height=`"92`" fill=`"$hex`"/>")
    $cx += $w + 9
}

[void]$sb.AppendLine('    <rect x="1" y="1" width="1022" height="1022" rx="231" ry="231" fill="none" stroke="#FFFFFF" stroke-opacity="0.08" stroke-width="2"/>')
[void]$sb.AppendLine('  </g>')
[void]$sb.AppendLine('</svg>')

$svgPath = Join-Path $Out "icon.svg"
[System.IO.File]::WriteAllText($svgPath, $sb.ToString(), [System.Text.UTF8Encoding]::new($false))

Write-Output "wrote:"
Write-Output "  $pngPath"
foreach ($n in @(64, 128, 256)) { Write-Output "  $(Join-Path $Out "icon-$n.png")" }
Write-Output "  $svgPath"



