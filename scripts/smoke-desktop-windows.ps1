param([int]$OwnerProcessId = 0)
$ErrorActionPreference = 'Stop'
if ($OwnerProcessId -eq 0) {
  & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $PSCommandPath -OwnerProcessId $PID
  exit $LASTEXITCODE
}
$root = Split-Path $PSScriptRoot -Parent
$hostSource = [IO.File]::ReadAllText((Join-Path $root 'native\desktop-apps\WindowHost.cs'))
$testSource = [IO.File]::ReadAllText((Join-Path $root 'tests\fixtures\DesktopWindowSmoke.cs'))
Add-Type -TypeDefinition ($hostSource + "`n" + $testSource) -ReferencedAssemblies System.Windows.Forms,System.Drawing
try { [DesktopWindowSmoke]::Run($OwnerProcessId) } catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 1 }
