# Domnex Agente

O agente local da Domnex numa casa. Faz três coisas, e só estas:

- **O batimento** — de minuto em minuto diz à consola "estou vivo, o Home
  Assistant é a versão X" e pergunta se o operador deixou alguma coisa para
  fazer: um comando da fila da consola (atualizar, reiniciar, …, ver
  abaixo) ou um dos recados antigos (reiniciar ou atualizar o Home
  Assistant). É o único canal de comando que existe: o relay nunca entra na
  casa, é a casa que vem ao relay.
- **O inventário** — ao arrancar, de hora a hora e depois de cada comando,
  diz à consola o que a casa tem. É o que a página Frota mostra, e é daí
  que a consola sabe o que pode pedir.
- **O carteiro das cópias** — de meia em meia hora espreita as cópias de
  segurança do Home Assistant e, quando há uma nova, entrega-a ao cofre da
  Domnex. Cada cópia é entregue uma vez. As cópias vão encriptadas pelo
  próprio Home Assistant, com a chave da casa — que nunca viaja com elas.
  Só vão as cópias automáticas da casa (`automatic_backup_…` em `/backup`,
  ou `Automatic_backup_…` no Home Assistant antes da 2026.8: as agendadas
  e as do botão da app), e só uma mais nova do que a última entregue. Uma
  cópia mexida há menos de 5 minutos espera pela passagem seguinte — pode
  estar ainda a ser escrita. As parciais que o Home Assistant faz antes de atualizar um
  add-on nunca vão, e uma automática mais antiga também não: o cofre guarda
  uma cópia por dia, e qualquer uma delas ficava por cima da desse dia.

Tudo vai autenticado pelo segredo desta casa.

## O que sai da casa

- No batimento: a versão do Home Assistant (a instalada e a mais recente) e
  a versão do agente.
- No inventário: as versões do Core, do sistema operativo (e a que está à
  espera de reiniciar) e do Supervisor, com o canal e o estado; a placa, a
  máquina e a arquitetura; o nome da máquina, o kernel e o disco (total,
  usado, livre); os IPv4 da interface principal; os add-ons (nome, slug,
  versões, estado, repositório); as integrações (só o domínio, o estado, a
  origem e se estão desligadas); as atualizações pendentes, como o Home
  Assistant as mostra; e as pens USB série (caminho, fabricante, modelo).
- O resultado de cada comando, e o ficheiro da cópia.

**Não sai**: as opções dos add-ons (palavras-passe incluídas — o agente lê
a lista de add-ons, que não as traz, e nunca a ficha de cada um), o nome
que cada integração tem no Home Assistant (pode ter o email do cliente),
entidades, estados, histórico, automações.

## Instalar

1. Adicionar o repositório: **Definições → Add-ons → Loja de add-ons → ⋮ →
   Repositórios**, colar `https://github.com/Luispinto26/domnex-addons`.
2. Na loja, abrir **Domnex Agente** → **Instalar**. A imagem constrói-se no
   próprio Raspberry (um ou dois minutos).
3. Na consola Domnex, **Frota → Nova casa**: escrever o nome da casa e
   **Gerar código de instalação**. O código (`INST-XXXX-XXXX`) usa-se uma
   vez e caduca ao fim de uma semana.
4. No add-on, separador **Configuração** → escrever o código em *Código de
   instalação* → **Guardar** → separador **Informação** → **Iniciar**.
   Ligar *Iniciar no arranque* e *Watchdog*.
5. No **Registo** deve aparecer `Casa registada na consola (<nome>).`; na
   consola a casa aparece na Frota, com o inventário, em menos de um
   minuto.

O segredo que o registo devolve fica guardado em `/data/secret`, onde só o
add-on chega. O campo *Segredo de cópias* fica vazio, e o código pode
ficar escrito: com o segredo guardado, não se volta a usar.

**Reinstalar o agente numa casa que já existe.** Desinstalar o add-on
apaga o `/data`, e com ele o segredo guardado. Para instalar outra vez, a
ficha da casa na consola tem **Código para reinstalar o agente**: gera um
código preso a essa casa. Um código de casa nova é recusado numa casa que
já está registada.

**Casas instaladas antes da 0.3.0** (com o segredo colado em *Segredo de
cópias*): atualizar pela loja chega. O segredo das opções continua a valer
e não é preciso código.

## Configuração

| Opção | O que é |
|---|---|
| `code` | O código de instalação, gerado na consola (Frota → Nova casa). Usa-se uma vez: o agente regista a casa e guarda o segredo sozinho. Um código recusado (errado, caducado, já usado) aparece no registo e o agente não volta a tentar até o add-on reiniciar. |
| `secret` | O segredo de cópias, colado à mão — o caminho das casas de antes da 0.3.0, ou para substituir o segredo guardado. Se estiver preenchido, é este que vale. Sem segredo nem código o add-on fica quieto e diz no registo porquê. |

O uuid da casa (o id da instância do Home Assistant) o add-on lê-o sozinho
em `/homeassistant/.storage/core.uuid`.

## Os comandos da consola

Chegam no batimento, um de cada vez; enquanto um corre, outro que chegue é
recusado ("outro comando em curso"). Cada um acaba com um resultado para a
consola — feito ou falhou, e porquê — e com um inventário novo.

- **Atualizar** um componente (Core, sistema operativo, Supervisor, um
  add-on, HACS, firmware de um aparelho): pelo mesmo botão *Instalar* das
  atualizações do Home Assistant, com cópia antes quando a consola a pede.
  Antes, o agente confirma que a entidade existe e está disponível — o Home
  Assistant aceita em silêncio instalar numa entidade indisponível, e não
  faz nada —, e que a versão disponível ainda é a que a consola pediu (se a
  loja mudou desde o último inventário, não instala e diz qual é a nova;
  pede-se outra vez). Depois, só dá a atualização por feita quando a versão
  nova está mesmo a correr — no Core, quando o Core novo já responde e o
  Supervisor acabou de o verificar —, e espera por isso até 45 min (o Core
  reinicia a meio; o Supervisor volta à versão anterior se a nova não
  arrancar — então o resultado diz em que versão ficou).
- **Sistema operativo**: fica instalado mas só passa a correr depois de
  reiniciar o Pi. O resultado diz isso ("o Pi precisa de reiniciar"); o
  agente nunca reinicia o Pi por iniciativa própria — é o operador que
  escolhe a hora, com *Reiniciar o Pi*.
- **Reiniciar o Home Assistant**, **Reiniciar o Pi**, **iniciar, parar ou
  reiniciar um add-on**, **mandar o inventário já**.

Se o agente parar a meio de um comando (o Pi a reiniciar, o próprio agente
a atualizar-se), ao arrancar retoma: uma atualização volta só à
confirmação (não se instala duas vezes), um reinício do Pi confirma-se por
o último arranque já não ser o de antes do pedido (não pela hora, que num
Pi sem relógio próprio vem errada até à primeira sincronização). O
resultado que não chegou à consola (sem rede, relay em baixo) fica guardado
e é entregue no batimento seguinte; se nem se consegue guardar (`/data`
cheio), vai logo direto à consola.

## O que aparece no registo

Um batimento que corre bem não escreve nada. O resto, uma linha por
acontecimento:

- `Domnex Agente 0.3.1 a arrancar.` — o add-on arrancou, nesta versão.
- `Sem segredo nem código de instalação — …` — as duas opções estão
  vazias; o add-on não faz nada até ter uma.
- `Sem segredo: a registar a casa na consola com o código de instalação.`
  e depois `Casa registada na consola (<nome>).` — o registo com o código
  correu bem.
- `Registo recusado: <motivo> Corrige o código na configuração e reinicia o
  add-on.` — o código está errado, caducou ou já foi usado (o motivo vem da
  consola). O agente não volta a tentar até reiniciar. Se um pedido anterior
  ficou sem resposta, a linha acrescenta que o código se pode ter gastado
  nele: com a casa já na consola, usa-se o *Código para reinstalar o
  agente* da ficha dela.
- `O registo não passou (<motivo>) — tenta no batimento seguinte.` — sem
  rede, consola em baixo, demasiadas tentativas, ou uma firewall pelo
  caminho; tenta de minuto a minuto, e só volta a escrever se o motivo
  mudar.
- `Não consegui ler o uuid da casa …` — o ficheiro `core.uuid` não está
  onde devia; o Home Assistant ainda não acabou de arrancar, ou o mapeamento
  `homeassistant_config` falhou.
- `Comando #<n> recebido: <o quê>.` e depois `Comando #<n> concluído: …` ou
  `Comando #<n> falhou: …` — um comando da consola, do princípio ao fim.
- `Comando #<n> recusado: outro comando em curso (#<m>).` — chegou outro
  comando enquanto um corria.
- `A retomar o comando #<n> (<tipo>), …` — o agente reiniciou a meio de um
  comando e está a acabá-lo.
- `O comando #<n> ficou a meio sem resultado (o trabalho parou) — dado por
  falhado.` — o trabalho de um comando morreu sem acabar (o sistema
  matou-o); a consola recebe-o como falhado e o comando seguinte corre.
- `Não consegui gravar o resultado do comando #<n> em /data — vai direto à
  consola.` — o `/data` está cheio; o resultado é entregue logo.
- `O resultado do comando #<n> não foi entregue (…) — fica guardado …` — a
  consola não respondeu; o resultado vai no batimento seguinte.
- `O relay já não esperava o resultado do comando #<n> (…).` — o comando
  foi cancelado ou já tinha resposta; o resultado deita-se fora.
- `O Core não respondeu (<n> vezes seguidas) — o inventário vai sem
  integrações nem atualizações.` — o Home Assistant está a arrancar ou em
  baixo; o resto do inventário vai na mesma.
- `Inventário não entregue (…)` — a consola não o recebeu; tenta no
  batimento seguinte (ou no próximo inventário, se a consola o recusou).
- `Cópia entregue: <ficheiro>` — uma cópia nova chegou ao cofre.
- `Nenhuma cópia automática em /backup — nada para entregar ao cofre (…).`
  — não há nenhuma `automatic_backup_…` em `/backup`: as cópias automáticas
  não estão ligadas no Home Assistant, só vão para fora (o local "Este
  sistema" não está escolhido), ou outro add-on (o Google Drive Backup, por
  exemplo) tirou-as de lá. As parciais dos add-ons, as manuais
  (`custom_backup_…`) e as que outro add-on faz não se entregam. Diz-se uma vez, não a cada passagem; volta a
  dizer-se se aparecer uma automática e depois deixar de haver.
- `A cópia automática em /backup (<ficheiro>) não é mais nova do que a
  última entregue — não se entrega.` — a automática mais recente saiu de
  `/backup` (outro add-on levou-a) e a que ficou à frente é mais antiga do
  que a que já está no cofre; não vai, para não ficar por cima da de hoje.
  Também aparece se o relógio da casa estava atrasado quando a cópia se fez.
  Uma vez por cópia; a próxima automática nova entrega-se normalmente.
- `A entrega falhou com <código>` / `O relay não deu URL de entrega` — o
  relay recusou (segredo errado dá 401) ou não respondeu; tenta na passagem
  seguinte, de meia em meia hora.
- `Reinício do Home Assistant pedido pela consola.` / `Atualização do Home
  Assistant pedida pela consola.` — um recado antigo levantado e a
  executar.

O segredo e o código nunca aparecem no registo.

## Mudar uma casa da instalação local para esta

Até à 0.2.3 o agente instalava-se copiando a pasta para `/addons`, e o Home
Assistant conhecia-o como `local_omnex_backup`. Este add-on tem o mesmo slug
mas outro prefixo, por isso o HA vê-o como um add-on diferente — a mudança
faz-se uma vez, à mão:

1. Anotar o segredo que está na configuração do add-on local (ou gerar um
   novo na consola — os dois funcionam, o novo substitui o antigo).
2. Instalar **Domnex Agente** a partir deste repositório (passos 1–2 acima),
   colar o segredo em *Segredo de cópias*, iniciar. Confirmar na consola
   que a casa está online.
3. **Parar e desinstalar** o add-on local ("Local add-ons → Domnex Agente"
   com slug `local_omnex_backup`). Dois agentes a bater ao mesmo tempo não
   partem nada, mas não faz sentido.
4. Apagar a pasta `/addons/omnex-backup` (Samba, SSH ou o editor de
   ficheiros), para não voltar a aparecer na loja.

A marca da última cópia entregue vive no `/data` do add-on, que não passa de
um para o outro: a cópia de hoje é reenviada uma vez, escreve por cima da
mesma chave no cofre (`<uuid>/<dia>.tar`) e não duplica nada.
