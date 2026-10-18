[CmdletBinding()]
param([string]$FFmpegPath, [string]$FFprobePath)
$ErrorActionPreference = 'Stop'
$sourceRoot = $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Join-Path (Split-Path -Parent $nodeCommand.Source) 'npm.cmd'
$nodeVersion = & $nodeCommand.Source -p 'process.versions.node'
if ([version]$nodeVersion -lt [version]'18.0.0') { throw 'Instale Node.js 18 ou superior.' }

if (-not $FFmpegPath) {
    $found = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if ($found) { $FFmpegPath = $found.Source }
    else {
        $candidates = @(
            'C:\Program Files\Shutter Encoder\app\Library\ffmpeg.exe',
            'C:\Program Files\Shutter Encoder\Library\ffmpeg.exe',
            'C:\ffmpeg\bin\ffmpeg.exe'
        )
        $FFmpegPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if (-not $FFmpegPath) { throw 'FFmpeg nao encontrado. Instale FFmpeg ou Shutter Encoder, ou use -FFmpegPath "C:\caminho\ffmpeg.exe".' }
$FFmpegPath = (Resolve-Path -LiteralPath $FFmpegPath).Path
if (-not $FFprobePath) { $FFprobePath = Join-Path (Split-Path -Parent $FFmpegPath) 'ffprobe.exe' }
if (-not (Test-Path -LiteralPath $FFprobePath)) { throw 'FFprobe nao encontrado junto do FFmpeg. Informe -FFprobePath.' }
$FFprobePath = (Resolve-Path -LiteralPath $FFprobePath).Path
Push-Location -LiteralPath $sourceRoot
try {
    & $npmCommand ci --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar OpenCV.js/jpeg-js.' }
} finally { Pop-Location }

$cepRoot = [IO.Path]::GetFullPath((Join-Path $env:APPDATA 'Adobe\CEP\extensions'))
$destination = [IO.Path]::GetFullPath((Join-Path $cepRoot 'PontoTracker'))
if (-not $destination.StartsWith($cepRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Destino fora da pasta CEP.' }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach ($entry in @('CSXS','engine','host','node_modules','index.html','styles.css','main.js','core.cjs','updates.cjs','updates-ui.js','package.json','package-lock.json','LICENSE','THIRD-PARTY-NOTICES.md','README.md')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $entry) -Destination $destination -Recurse -Force
}
$runtime = @{ node=$nodeCommand.Source; ffmpeg=$FFmpegPath; ffprobe=$FFprobePath } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $destination 'runtime.json'), $runtime, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $sourceRoot 'runtime.json'), $runtime, [Text.UTF8Encoding]::new($false))
foreach ($version in 11..14) {
    $key = "HKCU:\SOFTWARE\Adobe\CSXS.$version"
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name PlayerDebugMode -PropertyType String -Value '1' -Force | Out-Null
}
$packageVersion = (Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "FastTracker $packageVersion instalado: $destination" -ForegroundColor Green
Write-Host 'Feche/reabra o painel. Use Janela > Extensoes > FastTracker; se o nome antigo ficar em cache, reinicie o Premiere quando for conveniente.'
