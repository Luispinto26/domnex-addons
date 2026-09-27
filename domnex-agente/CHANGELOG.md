# Changelog

## 0.2.4 — 2026-09-28

- O agente passa a instalar-se e a atualizar-se pela loja de add-ons, a
  partir do repositório `Luispinto26/domnex-addons`. Até aqui copiava-se a
  pasta para `/addons` em cada casa e cada versão nova era uma visita.
- Sem mudanças de comportamento: o batimento, os recados e a entrega das
  cópias são os da 0.2.3.
- Uma casa que vinha da instalação local muda uma vez, à mão, para este
  add-on (o Home Assistant vê-o como outro add-on, porque o prefixo do slug
  muda de `local_` para o deste repositório). O passo a passo está no
  DOCS.md. A primeira cópia do dia é reenviada uma vez — escreve por cima
  da mesma chave no cofre, não duplica.

## 0.2.3 — 2026-08-24

- O Dockerfile tira um eventual `\r` do fim das linhas do `run.sh` antes de
  o tornar executável: um ficheiro copiado a partir do Windows chegava com
  `sh\r` no shebang e o add-on morria em ciclo no arranque.
- O relay passa a `https://admin.domnex.pt` (o domínio da conta Domnex).
- O nome visível passa a "Domnex Agente"; o slug fica `omnex_backup`.

## 0.2.2 — 2026-08-24

- O script corre em `sh` (o ash do busybox), que existe em qualquer
  imagem-base, e é POSIX: deixa de assumir `bash` ou `bashio` na base.

## 0.2.1 — 2026-08-24

- Deixa de depender do `bashio`, que a imagem-base do HA já não traz: lê as
  opções em `/data/options.json` com `jq`. O `apk add` garante `curl`, `jq`
  e `coreutils`.

## 0.2.0 — 2026-08-21

- O batimento: de minuto em minuto diz ao relay a versão do HA (e a mais
  recente disponível) e levanta os recados da consola — reiniciar ou
  atualizar o Home Assistant à distância, pela API do Supervisor.

## 0.1.0 — 2026-08-18

- O carteiro das cópias: de meia em meia hora espreita `/backup` e entrega
  cada cópia nova ao cofre da Domnex (URL pré-assinado, PUT direto,
  confirmação no fim). Cada cópia é entregue uma vez só.
