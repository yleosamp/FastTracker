#!/bin/bash
# macOS includes Bash 3.2, curl, tar, ditto, shasum and defaults. No sudo/Homebrew.
set -euo pipefail
SOURCE="$(cd -P "$(dirname "$0")" && pwd)"
STAGE=""
fail() { printf '\nFastTracker: %s\n' "$1" >&2; exit 1; }
finish() {
  code=$?
  if [ "$code" -ne 0 ]; then
    printf '\nInstalação interrompida. A instalação anterior e seu projeto foram preservados.\n' >&2
    if [ -n "$STAGE" ]; then printf 'Arquivos temporários: %s\n' "$STAGE" >&2; fi
  fi
  if [ -t 0 ]; then printf '\nPressione Enter para fechar. '; read -r unused || true; fi
}
trap finish EXIT
[ "$(uname -s)" = Darwin ] || fail 'Este instalador é para macOS. No Windows, use INSTALAR.bat.'
[ "$(id -u)" -ne 0 ] || fail 'Abra com seu usuário normal, sem sudo.'
ARCH="$(uname -m)"
# Native Apple Silicon runtime also when Terminal is running under Rosetta.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then ARCH=arm64; fi
case "$ARCH" in x86_64) ARCH=x64;; arm64) ;; *) fail 'Arquitetura não suportada (Intel x64 ou Apple Silicon necessários).';; esac
OS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
[ "$OS_MAJOR" -ge 13 ] || fail 'Esta distribuição requer macOS 13 Ventura ou superior.'
printf 'FastTracker — instalação automática para macOS (%s)\n' "$ARCH"
printf 'Baixará Node.js e FFmpeg/FFprobe com SHA-256 verificado, apenas para o plugin.\nSem Homebrew, sudo ou alteração no Gatekeeper global.\n'
if [ "$ARCH" = x64 ]; then printf 'Intel/Hackintosh: use Premiere 25/26 com CEP. Premiere 27 para Mac exige Apple Silicon.\n'; fi
CEP_ROOT="$HOME/Library/Application Support/Adobe/CEP/extensions"
mkdir -p "$CEP_ROOT"
CEP_ROOT="$(cd -P "$CEP_ROOT" && pwd)"
DEST="$CEP_ROOT/PontoTracker"
[ ! -L "$DEST" ] || fail 'A pasta PontoTracker é um link simbólico. Confira a instalação manualmente.'
STAGE="$(mktemp -d "$CEP_ROOT/.FastTracker-install-XXXXXX")"
for entry in CSXS engine host licenses node_modules index.html styles.css main.js core.cjs updates.cjs updates-ui.js package.json package-lock.json LICENSE THIRD-PARTY-NOTICES.md README.md; do
  [ -e "$SOURCE/$entry" ] || fail "Pacote incompleto: $entry. Baixe o ZIP macOS, não o código-fonte."
  /usr/bin/ditto "$SOURCE/$entry" "$STAGE/$entry"
done
mkdir -p "$STAGE/runtime/downloads" "$STAGE/runtime/bin"
download() {
  url="$1"; output="$2"; checksum="$3"
  /usr/bin/curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 --max-time 900 --output "$output" "$url"
  printf '%s  %s\n' "$checksum" "$output" | /usr/bin/shasum -a 256 -c - >/dev/null || fail 'Download não corresponde ao SHA-256 publicado. Nada será instalado.'
}
NODE_VERSION=v22.23.4
if [ "$ARCH" = arm64 ]; then NODE_SHA=c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428; else NODE_SHA=efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819; fi
NODE_ARCHIVE="node-$NODE_VERSION-darwin-$ARCH.tar.gz"
printf '\n1/4 — Node.js privado do plugin…\n'
download "https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE" "$STAGE/runtime/downloads/node.tar.gz" "$NODE_SHA"
/usr/bin/tar -xzf "$STAGE/runtime/downloads/node.tar.gz" -C "$STAGE/runtime" "node-$NODE_VERSION-darwin-$ARCH/bin/node" "node-$NODE_VERSION-darwin-$ARCH/LICENSE"
mv "$STAGE/runtime/node-$NODE_VERSION-darwin-$ARCH/bin/node" "$STAGE/runtime/bin/node"
mv "$STAGE/runtime/node-$NODE_VERSION-darwin-$ARCH/LICENSE" "$STAGE/runtime/NODE-LICENSE"
if [ "$ARCH" = arm64 ]; then
  FFMPEG_BASE=https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2
  FFMPEG_SHA=c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924
  FFPROBE_SHA=fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6
else
  FFMPEG_BASE=https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2
  FFMPEG_SHA=7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4
  FFPROBE_SHA=2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd
fi
printf '\n2/4 — FFmpeg/FFprobe privados do plugin…\n'
download "$FFMPEG_BASE/ffmpeg.zip" "$STAGE/runtime/downloads/ffmpeg.zip" "$FFMPEG_SHA"
download "$FFMPEG_BASE/ffprobe.zip" "$STAGE/runtime/downloads/ffprobe.zip" "$FFPROBE_SHA"
/usr/bin/ditto -xk "$STAGE/runtime/downloads/ffmpeg.zip" "$STAGE/runtime/bin"
/usr/bin/ditto -xk "$STAGE/runtime/downloads/ffprobe.zip" "$STAGE/runtime/bin"
chmod 755 "$STAGE/runtime/bin/node" "$STAGE/runtime/bin/ffmpeg" "$STAGE/runtime/bin/ffprobe"
# User explicitly chose to install this bundle. Only its staged copy is changed;
# never disable Gatekeeper/SIP or remove quarantine from other apps/directories.
/usr/bin/xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
printf '\n3/4 — Conferindo executáveis e motor de tracking…\n'
"$STAGE/runtime/bin/node" --version
"$STAGE/runtime/bin/ffmpeg" -version >/dev/null
"$STAGE/runtime/bin/ffprobe" -version >/dev/null
"$STAGE/runtime/bin/node" -e 'require(process.argv[1]);Promise.resolve(require(process.argv[2])).then(cv=>{const m=new cv.Mat(8,8,cv.CV_8UC1);m.delete();console.log("OpenCV/WASM OK");}).catch(e=>{console.error(e.message);process.exitCode=1;});' "$STAGE/node_modules/jpeg-js" "$STAGE/node_modules/@techstark/opencv-js"
printf '{"node":"runtime/bin/node","ffmpeg":"runtime/bin/ffmpeg","ffprobe":"runtime/bin/ffprobe","platform":"darwin","arch":"%s"}\n' "$ARCH" > "$STAGE/runtime.json"
# Exact owned download files only, after validation; do not retain duplicate ZIPs.
rm "$STAGE/runtime/downloads/node.tar.gz" "$STAGE/runtime/downloads/ffmpeg.zip" "$STAGE/runtime/downloads/ffprobe.zip"
printf '\n4/4 — Instalando o painel…\n'
for version in 11 12 13 14; do /usr/bin/defaults write "com.adobe.CSXS.$version" PlayerDebugMode -string 1; done
if [ -e "$DEST" ]; then
  BACKUP_ROOT="$HOME/Library/Application Support/Yleo Tools/FastTracker/backups"
  mkdir -p "$BACKUP_ROOT"
  BACKUP="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-$$"
  mv "$DEST" "$BACKUP"
  if ! mv "$STAGE" "$DEST"; then mv "$BACKUP" "$DEST"; fail 'Não foi possível concluir a troca. A versão anterior foi restaurada.'; fi
  printf 'Backup da instalação anterior: %s\n' "$BACKUP"
else
  mv "$STAGE" "$DEST"
fi
STAGE=""
printf '\nPronto! No Premiere: Janela > Extensões (Legacy) > FastTracker.\nFeche/reabra o painel; se necessário, salve seu trabalho e reinicie o Premiere.\nVocê pode apagar a pasta/ZIP baixado. Nenhum projeto ou mídia foi alterado.\n'
