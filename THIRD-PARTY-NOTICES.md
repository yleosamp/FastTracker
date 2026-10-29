# Dependencias

O codigo proprio do Ponto Tracker usa MIT. As dependencias mantem as licencas dos respectivos autores:

- OpenCV.js 4.11.0, distribuido por `@techstark/opencv-js@4.11.0-release.1`: Apache-2.0. Repositorios: https://github.com/opencv/opencv e https://github.com/TechStark/opencv-js. A copia instalada inclui os avisos do pacote em `node_modules/@techstark/opencv-js`.
- `jpeg-js@0.4.4`: BSD-3-Clause. https://github.com/jpeg-js/jpeg-js. Licenca incluida em `node_modules/jpeg-js/LICENSE`.
- FFmpeg/FFprobe: no Windows, executaveis externos escolhidos pelo usuario. No macOS, o instalador baixa binarios privados da compilacao independente **9.0.2 de Martin Riedl**, com URLs e SHA-256 fixos, diretamente do fornecedor; os ZIPs de distribuicao do FastTracker nao redistribuem esses binarios. Essa compilacao habilita GPL/version3 e libx264/libx265: licenca GPLv3+. Informacoes, configuracao e fontes correspondentes: https://ffmpeg.martin-riedl.de/ e https://ffmpeg.org/legal.html. O instalador nao recompila nem modifica os binarios.
- Node.js: no Windows, runtime externo; no macOS, download privado da distribuicao oficial **v22.23.4**, SHA-256 fixo. Sua licenca e mantida como `runtime/NODE-LICENSE`. https://nodejs.org/dist/v22.23.4/ e https://github.com/nodejs/node/blob/main/LICENSE.

O projeto possui nome, codigo e interface proprios. Nao inclui arquivos, codigo, marca, imagens ou recursos do MotionPlug/MotionTracker e nao possui afiliacao com eles ou com a Adobe.
