# FastTracker — 0.5.1 experimental

Painel local de tracking de ponto 2D para Premiere Pro no Windows e macOS. Código próprio, licença MIT. Selecione um vídeo, carregue, marque um detalhe e use **TRACK**. Depois, **PASTE TRACK** aplica o movimento aos itens selecionados; **STABILIZE** estabiliza o vídeo carregado. Não abre After Effects nem depende de tracking de máscara.

Distribuições **Windows** e **macOS (Intel + Apple Silicon)**: [Baixar ZIP da plataforma](https://github.com/yleosamp/FastTracker/releases/latest). Código próprio, sem vínculo com Adobe ou MotionPlug. O port Mac é experimental: não existe garantia de 100% em todo conjunto macOS/Premiere/hardware/Hackintosh. Testes por código/CI não certificam a UI nativa do Premiere.

## Instalar ou atualizar

### macOS — instalação automática

Requer **macOS 13 Ventura+** e Premiere **25/26 com CEP**. **Premiere 27 para Mac exige Apple Silicon**; um Hackintosh Intel precisa permanecer numa versão compatível do Premiere. [Aviso oficial da Adobe](https://community.adobe.com/announcements-504/important-notice-upcoming-system-requirement-changes-in-v27-0-1639158).

1. Baixe **FastTracker-0.5.1-macOS.zip** e extraia.
2. Botão direito em **INSTALAR.command > Abrir**. A arquitetura Intel/ARM é detectada automaticamente, inclusive em Terminal sob Rosetta.
3. Aguarde o download automático e verificado de Node.js e FFmpeg/FFprobe privados do plugin (~150–250 MB). **Não precisa instalar Homebrew, npm, Node, Python ou FFmpeg por fora**, nem usar sudo.
4. Abra **Janela > Extensões (Legacy) > FastTracker**. Feche/reabra o painel; se necessário, salve o trabalho e reinicie o Premiere.

Depois da instalação, pode apagar o ZIP e a pasta extraída. Tudo necessário fica em `~/Library/Application Support/Adobe/CEP/extensions/PontoTracker`. Uma versão anterior é movida para backup em `~/Library/Application Support/Yleo Tools/FastTracker/backups`, antes da troca final; o instalador não mexe em projetos/mídias. Não instale o mesmo identificador em outra pasta CEP.

O pacote inclui OpenCV.js/jpeg-js e os downloads nativos usam versões/URLs fixas com SHA-256: Node **22.23.4**, FFmpeg/FFprobe **9.0.2** (compilação independente de Martin Riedl). Falha de download, hash ou execução interrompe antes de substituir a instalação anterior. Requer internet apenas na instalação; processamento é local. O instalador comunitário **não é assinado/notarizado pela Apple**: macOS pode exigir **Privacidade e Segurança > Abrir Mesmo Assim** para esse arquivo. Não desative Gatekeeper/SIP globalmente. Somente a cópia privada do plugin tem seus atributos de quarentena tratados após a escolha de instalação.

### Windows

Requer Premiere Pro 25/26 com CEP, Node.js 18+ e FFmpeg/FFprobe. O instalador procura FFmpeg no PATH, no Shutter Encoder ou em `C:\ffmpeg\bin`.

1. Extraia o ZIP e execute `INSTALAR.bat`. Node.js 18+ e FFmpeg/FFprobe precisam estar instalados (o instalador também encontra FFmpeg no Shutter Encoder).
2. Feche e reabra o painel em **Janela > Extensões > FastTracker**. Confira **0.5.1** no cabeçalho.
3. Se o nome antigo continuar em cache, salve o projeto e reinicie o Premiere quando for conveniente.

A atualização mantém a pasta `%APPDATA%\Adobe\CEP\extensions\PontoTracker` e os identificadores internos `com.leoda.ponto-tracker` para preservar a instalação e o clipboard existentes. Não instale uma segunda cópia com outro identificador.

Para indicar FFmpeg manualmente:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -FFmpegPath 'C:\ffmpeg\bin\ffmpeg.exe'
```

O instalador copia os arquivos, instala OpenCV.js/jpeg-js e grava os caminhos locais em `runtime.json`. Também habilita CEP de desenvolvimento com `PlayerDebugMode` (REG_SZ, CSXS 11–14). A instalação das dependências usa internet; o processamento não exige servidor, login ou chave/API.

## Usar

### Correção da 0.5.1 — carregar clipes no macOS

Corrigido o erro **“O processo encerrou sem resultado”** ao carregar um clipe. O Node integrado ao CEP no Premiere para Mac pode entregar o evento `exit` antes da resposta do processo de mídia. O painel agora aguarda `close`, depois da leitura das mensagens e dos streams; o motor também aguarda o envio da resposta final antes de desconectar. Se houver uma falha real, a mensagem inclui o código/sinal de saída e o diagnóstico do motor.

A ordem dos eventos foi reproduzida dentro do Premiere 26.5.2 com CEP/Node 17.7.2 e o Node privado 22.23.4 no macOS Intel. Os testes incluem essa ordem de eventos e a transmissão de um preview JPEG maior que o buffer do canal IPC. Para atualizar uma instalação existente, execute o instalador do pacote novo e feche/reabra o painel.

Validação da correção: 133 testes automatizados passaram com os binários privados no macOS Intel, além de 23 verificações de interface em Chromium. A importação da 0.5.1 foi confirmada no Premiere instalado neste Mac.

### Atualizações e privacidade

O painel consulta anonimamente `https://api.github.com/repos/yleosamp/FastTracker/releases/latest`, no máximo uma vez por 24 horas. Clique no número da versão para conferir manualmente. Quando há versão estável mais nova, aparece **↑ Atualizar**; só um clique abre a release no navegador. Não há download/instalação automática nem reinício do Premiere. Falhas de rede/cache não bloqueiam tracking. O cache contém somente data e versão, em `%TEMP%/fasttracker-updates.json`. Nenhum arquivo, caminho, projeto ou mídia é enviado; o GitHub recebe os metadados normais da conexão.

133 testes automatizados passam no macOS Intel, usando Node.js e FFmpeg privados do plugin. O workflow `macOS installer and engine` testa o instalador e os binários/motor em runners Intel e ARM; confira seu resultado na release correspondente. Testes de host simulado não certificam todos os comportamentos nativos do Premiere. Faça backup e revise o resultado antes de usar em produção.

### English — macOS quick setup

Extract the **macOS ZIP**, right-click **INSTALAR.command > Open**, and wait. The installer detects Intel/Apple Silicon and automatically downloads SHA-256-pinned private Node.js, FFmpeg and FFprobe binaries. No Homebrew/npm/manual runtime setup or sudo required. macOS 13+ and Premiere 25/26 with CEP; Intel/Hackintosh cannot run Premiere 27 for Mac. An unsigned community installer may require Open Anyway for this file only. Native Premiere/macOS behavior remains experimental. Existing installation is backed up before replacement; no projects/media are edited.

1. Selecione **um clipe de vídeo** na timeline e clique em **Carregar clipe selecionado**.
2. Navegue pela waveform ou pela barra de frames. O botão Play reproduz uma prévia local com o áudio do arquivo de origem, quando disponível; não é o Play do monitor do Premiere.
3. Clique em um detalhe com textura/contraste no preview. A lupa amplia o local sob o mouse; o botão de centralizar reposiciona o ponto sem apagar o tracking salvo.
4. Opcionalmente, marque **In/Out** pelos botões, campos de frame ou alças. Com o foco no painel, **I/O** marcam o intervalo, **Espaço** reproduz/pausa e as setas navegam frames (Shift: 10 frames).
5. Clique em **TRACK**. Sem In/Out, analisa o clipe inteiro, antes e depois do frame de referência. Com In/Out, analisa só o trecho; o cursor/ponto precisa estar dentro dele.
6. Selecione textos, ícones, gráficos ou clipes na timeline e use **PASTE TRACK**. Para estabilizar o vídeo carregado, use **STABILIZE**, independentemente da seleção atual.

**PASTE TRACK mantém a posição inicial do destino.** Posicione o item onde ele deve começar; o tracking soma o deslocamento a essa posição. Até 20 destinos podem receber a mesma análise. Destinos sobrepostos à origem acompanham os frames correspondentes; destinos em outro momento começam a animação no primeiro frame disponível, respeitando sua duração.

### Corrigir só um trecho

O resultado anterior permanece disponível ao escolher outro ponto. Marque um In/Out em torno da falha, coloque o cursor em um frame desse intervalo, escolha um detalhe do mesmo objeto e rode **TRACK** novamente. Os frames fora do In/Out são preservados.

Inclua **pelo menos um frame já rastreado e válido** no trecho novo: ele serve para alinhar a correção ao movimento anterior. Se a emenda produzir um salto excessivo, o painel recusa a substituição; amplie o intervalo ou rastreie tudo com o mesmo detalhe. Frames perdidos não são interpolados nem inventados. Uma análise parcial fica disponível para reparo, mas Paste/Stabilize só são liberados quando o intervalo analisado está completo. Se a primeira análise já foi limitada por In/Out, é esse intervalo completo que será aplicado.

Falha ou cancelamento preserva o resultado anterior. **Limpar tracking** apaga apenas o buffer local, não remove efeitos já aplicados no Premiere. Sem In/Out, uma nova análise substitui o buffer inteiro.

## Correção da 0.4.3

- Corrigido o leitor JSON do adaptador: um condicional encadeado convertia `true` e `false` em `NaN` na ordem de avaliação do ExtendScript, bloqueando **PASTE TRACK** e **STABILIZE** com “Opção de motion blur inválida”, tanto ligado quanto desligado. Agora usa condições explícitas, sem afrouxar a validação.
- Adaptador JSX salvo com assinatura UTF-8 (BOM), evitando acentos corrompidos no carregamento pelo interpretador legado.
- Análise salva, identificadores e clipboard preservados. Fechar/reabrir o painel basta; não é necessário refazer o tracking por causa desta correção.

## Correção da 0.4.2

- Mira com tamanho visível constante: quadrado de 18 px, traço branco de 2 px e contorno preto de 5 px, mesmo com vídeo vertical reduzido dentro do painel.
- Trajetória e área de busca com contorno de alto contraste, e a mesma mira reforçada na lupa. Redimensionar o painel redesenha os contornos sem encolher a marcação.
- Mudança somente visual: ponto, raio real de busca e dados já rastreados não são alterados.

## Correção da 0.4.1

- Orientação de câmera em metadados (90°/180°/270°) reconhecida automaticamente: preview, tracking e proxy usam a imagem na posição correta, sem esticar nem girar duas vezes.
- Dimensões e proporção de pixels coerentes com essa orientação, inclusive para Paste/Stabilize. Não exige converter, girar ou editar o bruto; a prévia temporária é preparada pelo plugin.
- Falhas do decoder não são mais escondidas por “Não foi possível carregar o preview”. A causa real permanece visível, e um log local limitado fica em `%TEMP%\fasttracker-diagnostics.log`, sem upload.

## O que mudou na 0.4

- Interface escura e enxuta, com preview grande, toolbar, waveform, In/Out e configurações avançadas recolhíveis; sem Quick Presets.
- Prévia audiovisual por proxy local e waveform calculada do áudio real. Arquivos sem áudio são identificados; falhas de prévia não impedem o tracking frame a frame.
- Tracking em ambas as direções a partir da referência, reparos por intervalo, trajetória opcional, lupa e recentralização.
- Controle de área de busca, confiança mínima, tolerância de perda e suavização de 0 a 8 frames.
- Motion **fixo** na origem é aceito: Position, Scale, Rotation e Anchor não precisam ser resetados. Um stopwatch ligado ou keyframes com valor constante, inclusive após Reset, não são tratados por si só como animação. Nenhum ajuste de Motion é apagado ou desligado.
- Motion blur opcional no **Transform criado pelo painel**, com shutter angle de 180° ao ativar e 0° ao desativar. O adaptador procura os controles por identidade/nome e confere os valores; se não puder alterá-los com segurança, avisa e mantém o tracking. Não altera efeitos do usuário nem controles de blur animados manualmente.

O motor usa OpenCV pyramidal Lucas–Kanade, verificação ida/volta, rejeição por consenso e fallback de template matching. A aplicação grava X/Y com interpolação linear em um Transform próprio e lê os valores de volta. Transform preexistente do usuário não é reaproveitado; edições manuais nos keyframes do Transform do tracker são protegidas.

O clipboard fica no armazenamento local e é restaurado ao reabrir o painel. Prévia/proxy e arquivos de aplicação são locais e temporários. Nenhuma mídia é enviada. A waveform usa o áudio do arquivo original, não a mixagem ou os efeitos de áudio da timeline.

## Limites importantes

- Tracking de **translação X/Y**, não solve de câmera 3D, tracking planar, perspectiva, escala/rotação do objeto ou segmentação por IA.
- **Motion realmente animado na origem ainda não é suportado.** O painel verifica se os valores mudam no trecho visível e bloqueia esse caso com mensagem específica. Ajustes fixos e stopwatches constantes são aceitos; a transformação de escala/rotação fixa é compensada na transferência X/Y.
- O preview mostra **mídia original, sem Motion nem efeitos da timeline**. Recortes, distorções ou outros efeitos geométricos anteriores, como outro Transform já alterado, podem comprometer a correspondência. Não há promessa de compensação de qualquer pilha de efeitos.
- Até **60 segundos e 3.600 frames**, velocidade 100%, sem reverso. Orientações de câmera de 0°/90°/180°/270° são automáticas; ângulos de metadados não ortogonais ainda não são suportados. A origem precisa ser um arquivo de vídeo online, não uma sequência aninhada. Os destinos ficam na mesma sequência. PAR quadrado/anamórfico é considerado.
- Oclusão, desfoque, saltos grandes e falta de textura podem perder o ponto. A tolerância tenta recuperá-lo, mas frames não medidos continuam faltantes; aplicação só é liberada para um intervalo completo e válido. Confiança alta não garante resultado perfeito.
- Estabilização pode expor bordas; não há crop/zoom automático. Ajuste a escala manualmente no Premiere e revise o playback.
- A criação de Transform usa **QE não documentado**. Não há promessa de rollback atômico ou de um único Undo para milhares de keyframes. Na mesma sessão, reaplicar reutiliza o Transform registrado pelo painel; após reiniciar o Premiere, pode criar outro Transform em vez de substituir o antigo.
- Testes por código e readback não comprovam renderização no Premiere. Esta versão continua **experimental para Windows/CEP**; o manifesto aceitar uma versão não constitui certificação de compatibilidade. macOS e futuras versões sem CEP não estão validados.

## Desenvolver e verificar

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
npm.cmd run qa
```

`check` verifica sintaxe e versões de pacote; `test` cobre motor, worker, intervalos, painel e adaptador com host simulado. Há testes reais com FFmpeg, H.264/AAC e waveform; configure `PONTO_FFMPEG`/`PONTO_FFPROBE` se necessário. `qa` usa navegador isolado, `main.js`/`core.cjs` reais e mídia sintética, com host CEP e IPC do worker simulados; requer Playwright/Chromium disponíveis no ambiente de QA. Seus caminhos podem ser indicados por `FASTTRACKER_PLAYWRIGHT`, `FASTTRACKER_BROWSER` e `FASTTRACKER_FFMPEG`. Consulte `VALIDACAO.md` para os resultados e pendências no Premiere real.

Estrutura: `engine/` processa mídia/tracking; `host/bridge.jsx` integra com Premiere; `main.js` controla o painel; `core.cjs` converte e combina os deslocamentos. Preserve `LICENSE` e `THIRD-PARTY-NOTICES.md` ao distribuir. Esta atualização não publica release nem habilita download público do FastTracker.
