[CmdletBinding()]
param([ValidateSet('Windows','macOS','All')][string]$Platform='All',[switch]$Force)
$ErrorActionPreference = 'Stop'
$trackerRoot = $PSScriptRoot
$trackerVersion = (Get-Content -LiteralPath (Join-Path $trackerRoot 'package.json') -Raw | ConvertFrom-Json).version
Push-Location -LiteralPath $trackerRoot
try {
  & npm.cmd run check
  if ($LASTEXITCODE -ne 0) { throw 'Syntax checks failed' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
  $trackerArguments=@('tools/package.cjs','--platform',$Platform)
  if($Force){$trackerArguments+='--force'}
  & node @trackerArguments
  if($LASTEXITCODE -ne 0){throw 'Packaging failed'}
} finally { Pop-Location }
