# Testes do Domnex Agente

Correm o `run.sh` verdadeiro, dentro da imagem verdadeira do add-on, contra
um Supervisor + Core falso e um relay falso — sem Home Assistant e sem o
worker. Node puro, sem dependências (`npm install` não é preciso).

## Correr

Precisa do Docker a correr (Docker Desktop no Windows) e do Node 18 ou mais
recente. Da raiz do repositório:

```
node test/cenarios.js
```

Constrói a imagem `domnex-agente:0.3.1-teste` a partir de `domnex-agente/`
(base `ghcr.io/home-assistant/amd64-base:latest`) e corre os cenários um a
um. Demora uns 9 minutos. Sai com 0 se todos passarem.

- `node test/cenarios.js 6 8 10` — só esses cenários.
- `node test/cenarios.js --sem-build` — usa a imagem já construída.
- `IMAGEM=domnex-agente:<etiqueta> node test/cenarios.js --sem-build` — corre
  contra outra imagem (uma versão anterior do agente, para ver um cenário
  novo falhar antes da correção).

O cenário 14 instala o `dash` num contentor descartável (`apk add`), por
isso precisa de rede.

## Como funciona

- `supervisor-falso.js` — responde como o Supervisor (envelope
  `{"result":"ok","data":…}`, 401 sem token) e como o Core atrás do proxy
  `/core/api` (502 enquanto o Core está "a reiniciar", o template devolvido
  como texto, entidades `unavailable`…), com os trabalhos do Supervisor em
  `/jobs/info` e o `/core/api/config` do Core que está a correr. Grava tudo
  o que recebe.
- `relay-falso.js` — os endpoints do agente (`/agent/register`,
  `/agent/<uuid>/heartbeat|inventory|commands/<id>`, `/backup/<uuid>/url|done`
  e o PUT do cofre). Grava tudo o que recebe e pode "cair" (corta as
  ligações sem responder).
- `cenarios.js` — os dois servidores ficam neste processo, em portas livres
  que o sistema escolhe (ou `PORTA_RELAY`/`PORTA_SUP`). Os contentores levam
  o pid da corrida no nome (`domnex-agente-teste-<pid>-<n>`): duas corridas
  ao mesmo tempo não se atrapalham, e um Ctrl+C apaga os desta. Cada
  cenário cria uma pasta temporária com `data/options.json` e
  `config/.storage/core.uuid`, e arranca um contentor com `sh /run.sh`,
  as `DOMNEX_*` a apontar para `host.docker.internal` e o batimento a 1 s.
  Depois verifica o registo do agente, os ficheiros em `/data` e os pedidos
  que os falsos gravaram, e imprime as evidências.

Em todos os cenários verifica-se também que o registo nunca mostra o
segredo nem o código, e que o stderr do agente fica vazio.

Os dois falsos também arrancam sozinhos, para experimentar à mão:
`node test/relay-falso.js` e `node test/supervisor-falso.js`.

## Os cenários

1. Sem segredo, com código → regista, grava `/data/secret` (600), bate com
   esse segredo; reiniciado, não volta a registar.
2. Registo com 409 → uma linha no registo e nenhuma tentativa a seguir.
3. Batimento 0.3 com o corpo certo; os recados antigos `restart` e `update`
   ainda funcionam; o segredo das opções ganha ao de `/data/secret`.
4. Inventário: JSON válido, a forma da §3.1 do contrato (+
   `version_pending`), sem opções de add-ons nem títulos das integrações.
5. Core a responder 502 → o inventário vai com `null` à 3.ª falha, não antes.
6. `update` de um add-on: pré-verificação, install, confirmação pelo
   `/addons`, resultado, inventário a seguir.
7. `update` com a entidade `unavailable` → falha sem chamar o install.
8. `update` do Core com 502 no install e a versão a mudar 30 s depois → ok.
9. `update` do SO → ok com a mensagem de reinício pendente.
10. `reboot` + retoma: o contentor pára a meio e volta; o resultado sai
    quando o `boot_timestamp` é posterior ao pedido.
11. Um segundo comando enquanto um corre → "outro comando em curso".
12. Resultado não entregue (relay em baixo) → fica em `/data/result.json`
    e sai no batimento seguinte.
13. O carteiro das cópias entrega uma cópia (url → PUT → done), uma vez só.
14. `sh -n` e `dash -n` limpos; nenhum `\r` nos ficheiros do add-on.
15. (extra) Registo com 503, 429 e um 403 de uma firewall → tenta no
    batimento seguinte; depois regista.
16. (extra) `update` sem `hassio_id` → confirma pelo estado da entidade.
17. (extra) Install recusado com 500 e mensagem → falha já, com a mensagem.
18. (extra) `update` do Core que o Supervisor desfaz (a nova arranca, falha
    a verificação, volta à anterior) → nunca dá ok; no fim do prazo falha
    com a versão em que ficou. Retoma com o prazo quase no fim.
19. (extra) Relay em baixo → o inventário não se recolhe a cada batimento
    falhado; sai quando o relay volta.
20. (extra) Install com 503 (o Core a parar) → falha já.
21. (extra) A versão disponível já não é a do pedido → falha sem install.
22. (extra) O agente parou entre gravar o resultado e apagar o
    `command.json` → entrega esse resultado, sem o reescrever.
23. (extra) `/data` sem espaço para o `result.json` → o resultado vai
    direto ao relay (o `/data` é um tmpfs sem inodes livres).
24. (extra) O trabalho de um comando morre (`kill -9`) → o comando seguinte
    corre, e o que morreu é dado por falhado.
25. (extra) Registo sem resposta e depois 409 → a linha aponta o código
    para reinstalar.
26. (extra) `reboot` num Pi que arranca com o relógio atrasado → ok; o
    add-on reiniciado sem o Pi reiniciar → não.
27. (extra) Resultado com 409 → apagado, uma linha, sem repetir.
28. (extra) O batimento com o ficheiro dos comandos impossível de abrir →
    erro no registo, mas o agente não morre (a função `batimento` do
    `/run.sh` da imagem, com o resto a fingir).

Os do carteiro da 0.3.1 (o incidente de 29 set 2026 na casa-piloto: uma
parcial de 20 KB ficou no cofre no lugar da cópia do dia). As cópias em
`/backup` têm a mtime fixada, e o cenário muda-as por fora, como outro
add-on; o carteiro passa nos batimentos 0, 30, 60…, e o cenário espera por
esses batimentos (como o 13). Contra a imagem da 0.3.0
(`IMAGEM=domnex-agente:0.3.0-teste`) o 29, o 30, o 31, o 33 e o 36 falham.

29. Em `/backup` só parciais de add-ons (a do Cloudflared da casa-piloto) →
    nenhum pedido ao cofre; uma linha no registo, que não se repete na
    passagem seguinte.
30. O incidente: a automática de hoje é entregue e depois sai de `/backup`,
    ficando uma parcial (o tar mais recente) e a automática de ontem → nas
    duas passagens seguintes não se entrega nenhuma; a linha "não é mais
    nova" aparece uma vez.
31. A seguir (a marca da de hoje, a de ontem em `/backup`) aparece a
    automática da noite seguinte → é entregue na passagem seguinte.
32. Vinda da 0.3.0: com `/data/last_uploaded` a apontar para a parcial (o
    estado real da casa-piloto), vazio, ou com lixo → entrega a automática
    mais recente e a marca passa para ela.
33. HA antes da 2026.8: a automática chama-se
    `Automatic_backup_2026.7.3_…` (A grande, versão com pontos) → entrega-se.
34. A marca é de uma cópia com a mtime no futuro (relógio adiantado) → não
    trava a automática de hoje.
35. Vinda da 0.3.0 com a marca numa parcial mais nova do que a automática
    do dia → entrega a automática.
36. A automática foi mexida há 1 minuto (o Supervisor ainda a escrever) →
    não vai na passagem 0; mexida há 10 minutos, vai na passagem 30, sem
    linhas no registo pela espera.
