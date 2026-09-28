# Changelog

## 0.3.0 — 2026-09-28

- **Código de instalação.** Uma casa nova já não precisa de segredo colado
  à mão: gera-se um código na consola (Frota → Nova casa), escreve-se na
  opção *Código de instalação*, e o agente troca-o sozinho pelo segredo da
  casa, que guarda em `/data/secret`. Um código recusado diz-se uma vez no
  registo e não se repete até o add-on reiniciar. As casas com o segredo
  nas opções continuam como estão (e o das opções ganha sempre).
- **Inventário.** Ao arrancar, de hora a hora e depois de cada comando, o
  agente manda à consola o que a casa tem: versões do Core, SO e
  Supervisor (e a versão do SO à espera de reinício), disco, rede, add-ons,
  integrações, atualizações pendentes e pens USB. Não saem as opções dos
  add-ons nem o nome das integrações (que pode ter o email do cliente).
  Com o Core a arrancar, espera; à terceira tentativa manda sem as
  integrações e as atualizações.
- **Comandos da consola**, um de cada vez e com resultado: atualizar um
  componente (Core, SO, Supervisor, add-on, HACS, firmware — pela entidade
  de atualização do HA, com cópia antes quando se pede), reiniciar o Home
  Assistant, reiniciar o Pi, iniciar/parar/reiniciar um add-on, mandar o
  inventário. Uma atualização só é pedida se a versão disponível ainda é a
  que a consola viu, e só conta como feita quando a versão nova está mesmo
  a correr (até 45 min) — no Core, quando o Core novo responde e o
  Supervisor acabou de o verificar; se o Supervisor voltar à versão
  anterior, o resultado diz em que versão ficou. A do SO fica à espera de
  reiniciar o Pi, que o agente nunca faz sozinho. Se o agente parar a meio
  (o Pi a reiniciar, o próprio agente a atualizar-se), retoma ao arrancar;
  um comando cujo trabalho morra a meio não prende a fila, e um resultado
  que não caiba em `/data` vai direto à consola.
- Uma permissão nova, `homeassistant_api`: o inventário e as atualizações
  falam com o Core pela API do Supervisor.
- O batimento diz a versão do agente; a consola só manda comandos a quem
  tem a 0.3.0. O batimento, os recados antigos (reiniciar/atualizar o HA)
  e a entrega das cópias portam-se como na 0.2.4.

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
