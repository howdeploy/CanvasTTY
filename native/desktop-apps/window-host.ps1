param([Parameter(Mandatory=$true)][int]$OwnerProcessId)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'WindowHost.cs') -ReferencedAssemblies System.Windows.Forms,System.Drawing
[CanvasDesktopHost]::Start($OwnerProcessId)
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
      $request = $line | ConvertFrom-Json
      $result = $null
      switch ($request.action) {
        'list' { $result = @([CanvasDesktopHost]::List()) }
        'attach' { [CanvasDesktopHost]::Attach($request.token,$request.handle,$request.pid,$request.parent) }
        'update' { [CanvasDesktopHost]::Update($request.token,$request.x,$request.y,$request.width,$request.height,$request.visible) }
        'detach' { [CanvasDesktopHost]::Detach($request.token) }
        default { throw 'Unsupported desktop app action.' }
      }
      [Console]::WriteLine((@{id=$request.id;ok=$true;result=$result} | ConvertTo-Json -Compress -Depth 5))
    } catch {
      [Console]::WriteLine((@{id=$request.id;ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress))
    }
  }
} finally { [CanvasDesktopHost]::Stop() }
