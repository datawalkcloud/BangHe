Add-Type -AssemblyName System.Drawing
$path = 'C:\Users\Sprin\.qwenworkcn\workspace\mty15mye76w7tnzd\uploads\image_1789197807702_3hywkyj.png'
$img = [System.Drawing.Bitmap]::FromFile($path)
Write-Output ("size {0}x{1}" -f $img.Width, $img.Height)
$maxX = $img.Width - 1
$maxY = $img.Height - 1

function HexOf($c) {
  '#{0}{1}{2}' -f ([int]$c[1]).ToString('x2'), ([int]$c[2]).ToString('x2'), ([int]$c[3]).ToString('x2')
}

function Region($x0, $y0, $x1, $y1, $label) {
  if ($x1 -gt $maxX) { $x1 = $maxX }
  if ($y1 -gt $maxY) { $y1 = $maxY }
  $lum = New-Object System.Collections.Generic.List[object]
  for ($y = $y0; $y -le $y1; $y += 1) {
    for ($x = $x0; $x -le $x1; $x += 1) {
      $p = $img.GetPixel($x, $y)
      $lum.Add(@(0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B, $p.R, $p.G, $p.B))
    }
  }
  $sorted = $lum | Sort-Object { $_[0] } -Descending
  $peak = $sorted[0]
  $p90 = $sorted[[int]($sorted.Count * 0.10)]
  $med = $sorted[[int]($sorted.Count * 0.50)]
  Write-Output ("{0}  peak={1}  p90={2}  median={3}" -f $label, (HexOf $peak), (HexOf $p90), (HexOf $med))
}

Region 50 255 430 335 'LEFT  (placeholder "如 XM")'
Region 460 255 860 335 'RIGHT (typed "大大")'
Region 50 95 860 165 'DESCRIPTION body text'
$img.Dispose()
