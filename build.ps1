[CmdletBinding()]
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$trackerRoot = $PSScriptRoot
$trackerVersion = (Get-Content -LiteralPath (Join-Path $trackerRoot 'package.json') -Raw | ConvertFrom-Json).version
$trackerOutput = Join-Path (Split-Path -Parent $trackerRoot) ('dist/FastTracker-' + $trackerVersion + '-Windows.zip')
if ((Test-Path -LiteralPath $trackerOutput) -and -not $Force) { throw 'Package already exists. Use -Force to rebuild.' }
Push-Location -LiteralPath $trackerRoot
try {
  & npm.cmd run check
  if ($LASTEXITCODE -ne 0) { throw 'Syntax checks failed' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
} finally { Pop-Location }
$trackerFiles = @('CSXS','engine','host','index.html','styles.css','main.js','core.cjs','updates.cjs','updates-ui.js','package.json','package-lock.json','LICENSE','THIRD-PARTY-NOTICES.md','README.md','INSTALAR.bat','install.ps1')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$trackerStream = [IO.File]::Open($trackerOutput, [IO.FileMode]::Create)
try {
  $trackerArchive = [IO.Compression.ZipArchive]::new($trackerStream,[IO.Compression.ZipArchiveMode]::Create,$true)
  try {
    foreach ($trackerEntry in $trackerFiles) {
      $trackerPath = Join-Path $trackerRoot $trackerEntry
      $trackerItems = if (Test-Path -LiteralPath $trackerPath -PathType Container) { Get-ChildItem -LiteralPath $trackerPath -Recurse -File } else { Get-Item -LiteralPath $trackerPath }
      foreach ($trackerFile in $trackerItems) {
        $trackerRelative = $trackerFile.FullName.Substring($trackerRoot.Length + 1).Replace('\','/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($trackerArchive,$trackerFile.FullName,('FastTracker/' + $trackerRelative),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
      }
    }
  } finally { $trackerArchive.Dispose() }
} finally { $trackerStream.Dispose() }
Write-Host $trackerOutput
