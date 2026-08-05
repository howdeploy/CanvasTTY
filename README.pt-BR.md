<p align="center">
  <img src="docs/assets/canvastty-cover.png" alt="CanvasTTY — um desktop espacial para terminais locais e agentes de IA" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt-BR.md"><strong>Português</strong></a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<table>
  <tr>
    <td>
      <strong>Seus terminais são lugares, não abas.</strong><br>
      CanvasTTY é um desktop espacial em Electron para PTYs locais reais e sessões CLI de agentes de IA. Zona Home fixa, terminais ao vivo em um canvas infinito e limites de provedores com base em fontes de dados reais.
    </td>
  </tr>
</table>

## Stack

| Desktop | Interface | Terminal | Provedores |
|:--|:--|:--|:--|
| **Electron**<br>electron-vite | **React**<br>TypeScript | **xterm.js**<br>node-pty | **Codex**<br>Claude · Kimi |

## Um canvas, sessões reais

Inicie um shell ou agente no diretório do projeto, mova e redimensione o terminal ao vivo, afaste o zoom para navegar semanticamente e volte ao Home para sessões, limites, mídia e atalhos de lançamento. O CanvasTTY mantém o estado do PTY no processo main confiável e expõe ao renderer apenas capacidades tipadas e na lista de permissões.

## Instalação

Baixe a prévia pública `0.9.x` em [GitHub Releases](https://github.com/howdeploy/CanvasTTY/releases): AppImage/deb para Linux x86_64, instalador/portable para Windows x64 e dmg/zip para macOS Apple Silicon. Os pacotes ainda não são assinados nem notariados; builds para Intel Mac ainda não estão incluídas. Leia [instalação e segurança de dados locais](docs/installing-and-security.md).

Ou execute a partir do código-fonte:

```bash
npm install
npm run dev
```

## Documentação

| Comece aqui | Estenda o CanvasTTY |
|:--|:--|
| [Hub de documentação](docs/README.md) | [Criação de widgets](docs/widget-authoring.md) |
| [Primeiros passos](docs/getting-started.md) | [Métricas e telemetria](docs/metrics-and-telemetry.md) |
| [Instalação, releases e dados locais](docs/installing-and-security.md) | [Política de segurança](SECURITY.md) |
| [Arquitetura](docs/ARCHITECTURE.md) | [Contrato de UI](docs/UI_CONTRACT.md) |

> O CanvasTTY é atualmente um MVP em Electron. Widgets personalizados são extensões no nível do código-fonte; ainda não há registro de plugins em runtime.

## Verificações rápidas

```bash
npm test
npm run typecheck
npm run build
```
