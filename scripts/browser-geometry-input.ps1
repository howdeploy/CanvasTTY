param([string]$Operation, [string]$A, [string]$B, [string]$C, [string]$D)
$ErrorActionPreference = "Stop"
if ($env:CANVASTTY_GEOMETRY_DISPOSABLE_DESKTOP -ne "1") { throw "Requires disposable desktop" }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GeometryMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[GeometryMouse]::SetProcessDPIAware() | Out-Null
if ($Operation -eq "screenshot") {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($A, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
} elseif ($Operation -eq "drag") {
  $x = [int]$A; $y = [int]$B; $endX = [int]$C; $endY = [int]$D
  [GeometryMouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 80
  [GeometryMouse]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  try {
    for ($i = 1; $i -le 6; $i++) {
      Start-Sleep -Milliseconds 30
      [GeometryMouse]::SetCursorPos([int]($x + ($endX - $x) * $i / 6), [int]($y + ($endY - $y) * $i / 6)) | Out-Null
    }
  } finally { [GeometryMouse]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
} else { throw "Unsupported operation" }
