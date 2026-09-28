#!/usr/bin/with-contenv sh
# O agente da Domnex na casa, com três ofícios:
#
# — O batimento: de minuto em minuto diz ao relay "estou vivo, o HA é a
#   versão X" e pergunta se a consola deixou algum recado. Um "restart" ou
#   "update" levantado aqui executa-se pela API do Supervisor — é assim que
#   o operador reinicia ou atualiza uma casa sem lá ir, porque o relay
#   nunca consegue entrar: são as casas que vêm cá. Desde a 0.3.0 o
#   batimento traz também os comandos da fila da consola (atualizar um
#   componente, reiniciar o HA ou o Pi, iniciar/parar/reiniciar um add-on,
#   mandar o inventário), um de cada vez, e o agente devolve o resultado.
#
# — O inventário: ao arrancar, de 60 em 60 batimentos e depois de cada
#   comando, diz ao relay o que a casa tem — Core, SO, Supervisor, add-ons,
#   integrações, atualizações pendentes, pens USB. É o que a página Frota
#   da consola mostra, e é dele que a consola tira o que pode pedir.
#
# — O carteiro das cópias: de meia em meia hora (30 batimentos) espreita
#   /backup e, quando o HA tiver uma cópia nova, entrega-a ao cofre.
#
# O uuid lê-se do próprio HA. O segredo nasce na consola: numa casa nova o
# instalador escreve na configuração o código de instalação, e o agente
# troca-o sozinho pelo segredo da casa (guarda-o em /data/secret, onde só o
# add-on chega). Nas casas de antes da 0.3.0 o segredo foi colado à mão na
# configuração, e esse continua a valer. Sem segredo, o add-on fica quieto.

# Corre em sh (o ash do busybox), que existe em qualquer imagem-base — uma
# suposição a menos do que o bashio ou o bash. Não se liga modo estrito de
# propósito: um curl falhado não é razão para morrer, é razão para tentar no
# batimento seguinte. (O 'set +o pipefail' que aqui estava nem é válido em sh.)

# O domínio próprio da conta Domnex. O URL antigo (workers.dev da conta
# pessoal) continua a funcionar como proxy para aqui, e é o que as casas
# com add-on antigo usam — mas quem atualiza deixa de depender dele.
# `/agent` e `/backup` são públicos de propósito: a autoridade é o segredo
# desta casa, não um login. Só o `/admin` está atrás do Cloudflare Access.
#
# As DOMNEX_* existem só nos testes (test/ na raiz do repositório), para
# apontar o agente a um relay e a um Supervisor falsos e encurtar o
# batimento. Em produção nenhuma está definida e valem os valores de sempre.
RELAY="${DOMNEX_RELAY:-https://admin.domnex.pt}"
SUP="${DOMNEX_SUPERVISOR:-http://supervisor}"
DATA="${DOMNEX_DATA:-/data}"
CONF="${DOMNEX_CONFIG:-/homeassistant}"
BACKUP_DIR="${DOMNEX_BACKUP:-/backup}"
TICK_SECONDS="${DOMNEX_TICK:-60}"
AGENT_VERSION="0.3.0"
STATE="$DATA/last_uploaded"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── Pedidos ────────────────────────────────────────────────────────────────
# O Supervisor responde 401/403 sem JSON, 502 enquanto o Core não está a
# correr, e às vezes 500 sem envelope; um jq sobre isso dava lixo, ou um
# "parse error" no registo. Por isso os pedidos passam por aqui: o corpo
# fica num ficheiro, o código HTTP sai à parte ("000" quando não houve
# resposta), e quem chama só lê o corpo com 2xx.
#
# O ficheiro ($CORPO) é de cada processo, feito com mktemp: o ciclo
# principal tem o seu e cada comando em background cria o dele ao começar.
# Com um nome fixo, um comando a meio lia a resposta do batimento.
#
# Esvazia-se com `true` e não com `:`: o `:` é um comando especial do sh, e
# um redirecionamento que falhe nele (um /tmp sem espaço) mata a shell
# inteira — aqui, o $(...) de quem chama, que ficava sem código nenhum.
pedir() {
  true > "$CORPO"
  _codigo=$(curl -s -o "$CORPO" -w '%{http_code}' "$@" 2>/dev/null)
  echo "${_codigo:-000}"
}

# Ao Supervisor (e ao Core, pelo proxy /core/api dele), com o token do
# add-on. Um -m nos argumentos passa à frente dos 20 s por omissão.
sup() {
  _caminho=$1
  shift
  pedir -m 20 -H "Authorization: Bearer $SUPERVISOR_TOKEN" "$@" "$SUP$_caminho"
}

# O .data de um GET ao Supervisor, numa linha — ou nada, e 1, quando a
# resposta não é 2xx com um objeto lá dentro.
sup_dados() {
  case $(sup "$1") in
    2??) jq -ce '.data | objects' "$CORPO" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

# Ao relay, com o segredo desta casa.
relay() {
  _caminho=$1
  shift
  pedir -H "x-backup-secret: $SECRET" "$@" "$RELAY$_caminho"
}

# A mensagem de erro que veio no corpo — o Core e o Supervisor mandam
# {"message": …}, o relay {"error", "errorMessage"}; um 500 genérico ou um
# proxy mandam texto —, numa linha e curta, para caber no registo e na
# consola.
mensagem_erro() {
  _m=$(jq -r '.message // .errorMessage // .error // empty' "$CORPO" 2>/dev/null)
  [ -n "$_m" ] || _m=$(head -c 2000 "$CORPO" 2>/dev/null)
  printf '%s' "$_m" | tr '\r\n\t' '   ' | head -c 300 | sed 's/  */ /g; s/^ //; s/ $//'
}

# O porquê de uma falha, para as mensagens: "502: Bad Gateway", "sem resposta".
motivo() {
  _m=$(mensagem_erro)
  if [ "$1" = "000" ]; then
    echo "sem resposta"
  elif [ -n "$_m" ]; then
    echo "$1: $_m"
  else
    echo "$1"
  fi
}

# ── Segredo e registo ─────────────────────────────────────────────────────
# O segredo das opções ganha sempre: é o que o operador escreveu à mão, e
# escrevê-lo é também a forma de o substituir. Sem ele, vale o que o registo
# guardou em $DATA/secret.
ler_segredo() {
  SECRET=$(jq -r '.secret // empty' "$DATA/options.json" 2>/dev/null)
  [ -n "$SECRET" ] || SECRET=$(cat "$DATA/secret" 2>/dev/null)
}

# Troca o código de instalação pelo segredo da casa. O relay trava ao fim de
# 5 falhas por hora e por IP; por isso um código que o relay recusa (400,
# 404, 409) diz-se uma vez no registo e não se volta a tentar até o add-on
# reiniciar — tentar de minuto a minuto gastava as tentativas da casa (e do
# IP dela) em vão. O resto (sem rede, 429, 5xx, um 403 de uma firewall ou
# de um portal de hotel) não é culpa do código: tenta-se no batimento
# seguinte.
registar() {
  _rcorpo=$(jq -nc --arg code "$CODIGO_INST" --arg uuid "$UUID" '{code: $code, uuid: $uuid}')
  _rh=$(pedir -m 30 -X POST -H "content-type: application/json" -d "$_rcorpo" "$RELAY/agent/register")
  case $_rh in
    2??)
      _rs=$(jq -r '.secret // empty' "$CORPO" 2>/dev/null)
      case $_rs in
        '' | *[!0-9A-Za-z]*)
          log "O relay aceitou o registo mas não mandou um segredo válido — tenta no batimento seguinte."
          REGISTO_INCERTO=1
          return 1
          ;;
      esac
      # umask 077: o segredo fica legível só por quem o escreveu. Escreve-se
      # ao lado e muda-se de nome, para nunca ficar meio ficheiro.
      if ! (umask 077 && printf '%s\n' "$_rs" > "$DATA/secret.tmp" && mv "$DATA/secret.tmp" "$DATA/secret"); then
        log "Não consegui guardar o segredo em $DATA/secret — vale até o add-on reiniciar."
      fi
      SECRET=$_rs
      _rnota=$(jq -r '.note // empty | tostring | gsub("[[:cntrl:]]"; " ")' "$CORPO" 2>/dev/null)
      if [ -n "$_rnota" ]; then
        log "Casa registada na consola ($_rnota)."
      else
        log "Casa registada na consola."
      fi
      ;;
    400 | 404 | 409)
      _rm=$(jq -r '.errorMessage // empty | tostring | gsub("[[:cntrl:]]"; " ")' "$CORPO" 2>/dev/null)
      [ -n "$_rm" ] || _rm="o relay respondeu $_rh."
      # Um pedido anterior que ficou sem resposta pode ter chegado ao relay e
      # gastado o código: o 409 de agora é o eco disso, e um código de casa
      # nova também seria recusado (a casa já tem segredo lá). Só o código
      # para reinstalar, gerado na ficha da casa, a desbloqueia.
      _rdica=""
      if [ "$_rh" = 409 ] && [ -n "$REGISTO_INCERTO" ]; then
        _rdica=" Um pedido anterior ficou sem resposta e pode ter gastado o código: se a casa já aparece na consola, gera na ficha dela o Código para reinstalar o agente e usa-o aqui."
      fi
      log "Registo recusado: $_rm Corrige o código na configuração e reinicia o add-on.$_rdica"
      REGISTO_PARADO=1
      ;;
    *)
      [ "$_rh" = "$REGISTO_ERRO" ] || log "O registo não passou ($(motivo "$_rh")) — tenta no batimento seguinte."
      REGISTO_ERRO=$_rh
      [ "$_rh" != 000 ] || REGISTO_INCERTO=1
      ;;
  esac
}

# ── Comandos da consola ───────────────────────────────────────────────────
# Cada comando corre em background (uma atualização do Core leva minutos e o
# batimento não pode parar — é ele que diz à consola que a casa está viva),
# e um de cada vez: o $DATA/command.json é o comando em curso, gravado antes
# de começar e apagado quando o resultado está escrito. Vive em /data de
# propósito: se o contentor morrer a meio (reiniciar o Pi, o agente a
# atualizar-se a si próprio), o agente que arranca encontra-o e retoma.

# Uma linha para o registo: o que a consola pediu, em português.
descrever() {
  jq -r 'def nome(k): (.title | strings | select(. != "")) // .[k] // "?";
    (if .type == "update" then "atualizar \(nome("entity_id")) para \(.to // "?")"
     elif .type == "restart" then "reiniciar o Home Assistant"
     elif .type == "reboot" then "reiniciar o Pi"
     elif .type == "addon_start" then "iniciar o add-on \(nome("slug"))"
     elif .type == "addon_stop" then "parar o add-on \(nome("slug"))"
     elif .type == "addon_restart" then "reiniciar o add-on \(nome("slug"))"
     elif .type == "inventory" then "mandar o inventário"
     else "tipo \(.type)" end) | gsub("[[:cntrl:]]"; " ")' "$1" 2>/dev/null
}

# Responde já a um comando, sem passar pelo result.json: é o caso do "outro
# comando em curso", que nem chega a começar, do comando cujo trabalho
# morreu a meio, e do resultado que não coube em /data.
responder() {
  _pcorpo=$(jq -nc --argjson ok "$2" --arg m "$3" --arg v "${4:-}" \
    '{ok: $ok, message: $m, installed_version: (if $v == "" then null else $v end)}')
  _ph=$(relay "/agent/$UUID/commands/$1" -m 15 -X POST -H "content-type: application/json" -d "$_pcorpo")
  case $_ph in
    2?? | 404 | 409) ;;
    *) log "A resposta ao comando #$1 não foi entregue ($(motivo "$_ph"))." ;;
  esac
}

# O trabalho do comando em curso ainda corre? ($TRABALHO é o $! de quem o
# lançou: o executar, ou a retoma ao arrancar.)
a_correr() {
  [ -n "$TRABALHO" ] && kill -0 "$TRABALHO" 2>/dev/null
}

# Um comando que chega no batimento: regista-se, recusa-se se já há outro,
# grava-se e arranca em background.
receber() {
  _cf=$(mktemp)
  printf '%s\n' "$1" > "$_cf"
  _cid=$(jq -r '.id // empty' "$_cf" 2>/dev/null)
  case $_cid in
    '' | *[!0-9]*)
      log "Chegou um comando sem id válido — ignorado."
      rm -f "$_cf"
      return
      ;;
  esac
  log "Comando #$_cid recebido: $(descrever "$_cf")."
  # Um trabalho acaba sempre por apagar o command.json antes de sair; se já
  # não corre e o ficheiro está lá, morreu a meio (o sistema matou-o, por
  # falta de memória, por exemplo). Sem isto a fila ficava presa em "outro
  # comando em curso" até o add-on reiniciar. (Ver primeiro se corre, e só
  # depois o ficheiro: ao contrário, um trabalho a acabar nesse instante
  # parecia morto.)
  if ! a_correr && [ -f "$DATA/command.json" ]; then
    _corfao=$(jq -r '.id // empty' "$DATA/command.json" 2>/dev/null)
    log "O comando #${_corfao:-?} ficou a meio sem resultado (o trabalho parou) — dado por falhado."
    case $_corfao in
      '' | *[!0-9]*) ;;
      *) responder "$_corfao" false "O trabalho do agente parou a meio deste comando, sem resultado; vê no inventário se chegou a acontecer." ;;
    esac
    rm -f "$DATA/command.json"
  fi
  if [ -f "$DATA/command.json" ]; then
    _coutro=$(jq -r '.id // "?"' "$DATA/command.json" 2>/dev/null)
    responder "$_cid" false "Outro comando em curso (#$_coutro); este não foi executado."
    log "Comando #$_cid recusado: outro comando em curso (#$_coutro)."
  elif jq -c --argjson agora "$(date +%s)" '. + {started_at: $agora}' "$_cf" > "$DATA/command.json.tmp" \
    && mv "$DATA/command.json.tmp" "$DATA/command.json"; then
    executar &
    TRABALHO=$!
  else
    rm -f "$DATA/command.json.tmp"
    responder "$_cid" false "O agente não conseguiu gravar o comando em $DATA; não foi executado."
    log "Comando #$_cid recusado: não consegui gravar $DATA/command.json."
  fi
  rm -f "$_cf"
}

# Um campo do comando em curso, numa linha (um título com uma quebra de
# linha não parte o registo).
campo() {
  jq -r --arg k "$1" '.[$k] // empty | tostring | gsub("[[:cntrl:]]"; " ")' "$DATA/command.json" 2>/dev/null
}

ler_comando() {
  ID=$(campo id)
  TIPO=$(campo type)
  INICIO=$(campo started_at)
  ENTIDADE=$(campo entity_id)
  PARA=$(campo to)
  HID=$(campo hassio_id)
  SLUG=$(campo slug)
  COPIA=$(campo backup)
  NOME=$(campo title)
  case $INICIO in '' | *[!0-9]*) INICIO=$(date +%s) ;; esac
}

# O fim de um comando. O resultado vai para $DATA/result.json (um
# temporário e mv: o ciclo principal nunca lê meio ficheiro) e é o ciclo
# principal que o entrega, em cada batimento até o relay o aceitar. Só
# depois se apaga o command.json: se o agente morrer entre os dois, a
# retoma encontra o resultado já gravado e não o refaz.
#
# Se o resultado não se consegue gravar (/data cheio — a base de dados do
# HA a encher o cartão é o caso típico), vai já direto ao relay, em vez de
# se perder em silêncio. O command.json apaga-se na mesma: preso, a fila
# ficava em "outro comando em curso".
terminar() {
  _tt=$(mktemp "$DATA/result.XXXXXX" 2>/dev/null)
  if [ -z "$_tt" ] || ! jq -nc --argjson id "$ID" --argjson ok "$1" --arg m "$2" --arg v "${3:-}" \
    '{id: $id, ok: $ok, message: $m, installed_version: (if $v == "" then null else $v end)}' > "$_tt" 2>/dev/null \
    || ! mv "$_tt" "$DATA/result.json"; then
    [ -z "$_tt" ] || rm -f "$_tt"
    log "Não consegui gravar o resultado do comando #$ID em $DATA — vai direto à consola."
    responder "$ID" "$1" "$2" "${3:-}"
  fi
  rm -f "$DATA/command.json"
  if [ "$1" = true ]; then
    log "Comando #$ID concluído: $2"
  else
    log "Comando #$ID falhou: $2"
  fi
}

# A entity_id vai parar a um URL: só a forma update.<letras, números, _>.
validar_update() {
  case $ENTIDADE in
    update.*) ;;
    *) terminar false "Entidade inválida: $ENTIDADE."; return 1 ;;
  esac
  case ${ENTIDADE#update.} in
    '' | *[!a-z0-9_]*) terminar false "Entidade inválida: $ENTIDADE."; return 1 ;;
  esac
  if [ -z "$PARA" ]; then
    terminar false "O comando não diz para que versão atualizar."
    return 1
  fi
  [ -n "$NOME" ] || NOME=$ENTIDADE
}

# E1. Atualizar pela entidade update.* do Core — o mesmo botão "Instalar"
# do HA. É pelo Core, e não pelo Supervisor, porque só assim o agente se
# consegue atualizar a si próprio (o Supervisor recusa a um add-on
# atualizar-se pela API dele) e porque é o Core que sabe atualizar o que
# não é do Supervisor (HACS, firmware).
atualizar() {
  validar_update || return
  # O update.install numa entidade indisponível não faz nada e responde
  # 200 — por isso olha-se primeiro, em vez de confiar na resposta.
  _uh=$(sup "/core/api/states/$ENTIDADE")
  case $_uh in
    2??) ;;
    404) terminar false "O Home Assistant não conhece a entidade $ENTIDADE."; return ;;
    *) terminar false "Não consegui ler o estado de $NOME no Home Assistant ($(motivo "$_uh"))."; return ;;
  esac
  _uestado=$(jq -r '.state // empty' "$CORPO" 2>/dev/null)
  _uinstalada=$(jq -r '.attributes.installed_version // empty' "$CORPO" 2>/dev/null)
  _udisponivel=$(jq -r '.attributes.latest_version // empty | tostring | gsub("[[:cntrl:]]"; " ")' "$CORPO" 2>/dev/null)
  if [ "$_uestado" = unavailable ]; then
    terminar false "$NOME está indisponível no Home Assistant; a atualização não foi pedida."
    return
  fi
  if [ "$_uinstalada" = "$PARA" ]; then
    terminar true "Já estava na versão $PARA." "$PARA"
    return
  fi
  # O install instala a versão disponível agora, e a consola tirou o "to" do
  # último inventário (até uma hora antes): se a loja mudou entretanto, a
  # confirmação ficava 45 min à espera de uma versão que não vem, e dava por
  # falhada uma atualização que correu bem.
  if [ -n "$_udisponivel" ] && [ "$_udisponivel" != "$PARA" ]; then
    terminar false "A versão disponível de $NOME mudou para $_udisponivel (o pedido era a $PARA); a atualização não foi pedida — pede outra vez."
    return
  fi

  # A chamada bloqueia até o serviço acabar, e o Core não desiste a meio;
  # quem corta é o proxy do Supervisor, aos 300 s, com 502 — e no update do
  # Core a ligação cai quando o Core é parado. Nada disso quer dizer que
  # falhou: 2xx, 502/504 ou sem resposta seguem para a confirmação. O 503 é
  # outra coisa: vem do próprio Core, que o dá aos pedidos novos enquanto
  # está a parar, antes de chamar o serviço (com o Core em baixo o proxy
  # responde 502 sem lhe chegar) — não foi pedido nada, não há o que
  # confirmar. Um erro com corpo (400, 404, 500 "Backup is not supported…")
  # é recusa, e recusa já.
  _ucorpo=$(jq -nc --arg e "$ENTIDADE" --arg b "$COPIA" '{entity_id: $e} + (if $b == "true" then {backup: true} else {} end)')
  _uh=$(sup /core/api/services/update/install -m 3600 -X POST -H "content-type: application/json" -d "$_ucorpo")
  case $_uh in
    2?? | 502 | 504 | 000) ;;
    503) terminar false "O Home Assistant estava a parar e não aceitou o pedido (503); a atualização de $NOME não foi pedida."; return ;;
    *) terminar false "O Home Assistant recusou atualizar $NOME ($(motivo "$_uh"))."; return ;;
  esac
  confirmar_update
}

# O Core novo está mesmo a correr, e o Supervisor já acabou com ele? O
# /core/info passa à versão nova logo que o Supervisor pára o Core antigo —
# antes de o novo arrancar, e antes da verificação (API, interface) que o
# desfaz e volta à versão anterior se ele não servir. Por isso: o proxy
# /core/api só responde com o Core a correr, e o /api/config diz a versão de
# quem responde; e a volta atrás acontece dentro do trabalho
# home_assistant_core_update do Supervisor — enquanto ele não acabar, nada
# está decidido.
core_pronto() {
  case $(sup /core/api/config) in
    2??) [ "$(jq -r '.version // empty' "$CORPO" 2>/dev/null)" = "$PARA" ] || return 1 ;;
    *) return 1 ;;
  esac
  sup_dados /jobs/info \
    | jq -e '[.. | objects | select(.name? == "home_assistant_core_update" and .done != true)] == []' >/dev/null 2>&1
}

# De 20 em 20 s, até 45 min desde o início, pergunta a versão a quem a sabe
# de facto: o Supervisor para o Core, o SO, o próprio Supervisor e os
# add-ons (o Core pode estar em baixo a meio, e o Supervisor volta à versão
# anterior se a nova não arrancar); a entidade só para o resto (HACS,
# firmware), que só o Core conhece.
confirmar_update() {
  _ufim=$((INICIO + 2700))
  _uultima=""
  while :; do
    _uatual=""
    _upendente=""
    _uespera=""
    case $HID in
      core)
        _uatual=$(sup_dados /core/info | jq -r '.version // empty')
        [ "$_uatual" != "$PARA" ] || core_pronto || _uespera=1
        ;;
      OS)
        # O Supervisor não reinicia o Pi depois de instalar o SO: a versão
        # nova fica pendente até alguém reiniciar. Não é o agente que o
        # decide — diz-se ao operador, que tem o comando "Reiniciar o Pi".
        _uos=$(sup_dados /os/info)
        _uatual=$(printf '%s' "$_uos" | jq -r '.version // empty' 2>/dev/null)
        _upendente=$(printf '%s' "$_uos" | jq -r '.version_pending // empty' 2>/dev/null)
        ;;
      supervisor)
        _uatual=$(sup_dados /supervisor/info | jq -r '.version // empty')
        ;;
      '')
        case $(sup "/core/api/states/$ENTIDADE") in
          2??) _uatual=$(jq -r '.attributes.installed_version // empty' "$CORPO" 2>/dev/null) ;;
        esac
        ;;
      *)
        _uatual=$(sup_dados /addons | jq -r --arg s "$HID" '.addons[]? | objects | select(.slug == $s) | .version // empty')
        ;;
    esac
    if [ -n "$_upendente" ] && [ "$_upendente" = "$PARA" ]; then
      terminar true "Instalado $PARA — o Pi precisa de reiniciar para ficar nessa versão (usa Reiniciar o Pi)." "$PARA"
      return
    fi
    if [ "$_uatual" = "$PARA" ] && [ -z "$_uespera" ]; then
      terminar true "Instalado $PARA." "$PARA"
      return
    fi
    [ -z "$_uatual" ] || _uultima=$_uatual
    [ "$(date +%s)" -lt "$_ufim" ] || break
    sleep 20
  done
  if [ "$HID" = core ]; then
    _uquem="O Core não voltou"
  else
    _uquem="$NOME não ficou"
  fi
  if [ "$HID" = core ] && [ "$_uultima" = "$PARA" ]; then
    terminar false "O Core $PARA ficou instalado, mas ao fim de 45 min ainda não estava a correr (ou o Supervisor ainda o verificava)." "$PARA"
  elif [ -n "$_uultima" ]; then
    terminar false "$_uquem na versão $PARA ao fim de 45 min — ficou na $_uultima." "$_uultima"
  else
    terminar false "$_uquem na versão $PARA ao fim de 45 min — não consegui ler a versão atual."
  fi
}

# E2. O mesmo que o recado antigo, mas com resultado: o Supervisor só
# responde depois de o Core voltar — e espera por isso até 10 min pela API
# e mais 15 até o Core estar a correr (mais ainda durante uma migração da
# base de dados). Um -m mais curto dava "não reiniciou" a um Pi que só
# estava a demorar.
reiniciar_ha() {
  _hh=$(sup /core/restart -m 3600 -X POST)
  case $_hh in
    2??) terminar true "O Home Assistant reiniciou." ;;
    *) terminar false "O Supervisor não reiniciou o Home Assistant ($(motivo "$_hh"))." ;;
  esac
}

# E3. O contentor morre com o Pi: o command.json já está gravado (o ciclo
# principal grava-o antes de lançar o comando), e é a retoma, no arranque
# seguinte, que confirma. Sem resposta é o normal aqui — a ligação cai com
# o Pi.
reiniciar_pi() {
  # O arranque de agora (boot_timestamp) fica no command.json antes do
  # pedido, para a confirmação ver que mudou. Compará-lo com a hora do
  # pedido não chega: um Pi sem RTC arranca com a hora errada até o NTP a
  # acertar, e o arranque novo podia sair "anterior" ao pedido.
  _pantes=$(sup_dados /host/info | jq -r '.boot_timestamp | numbers | select(. > 0)' 2>/dev/null)
  _pt=$(mktemp "$DATA/command.XXXXXX" 2>/dev/null)
  if [ -n "$_pantes" ] && [ -n "$_pt" ] \
    && jq -c --argjson b "$_pantes" '. + {boot_before: $b}' "$DATA/command.json" > "$_pt" 2>/dev/null; then
    mv "$_pt" "$DATA/command.json"
  fi
  [ -z "$_pt" ] || rm -f "$_pt"
  _ph2=$(sup /host/reboot -m 300 -X POST)
  case $_ph2 in
    2?? | 000) confirmar_reboot ;;
    *) terminar false "O Supervisor recusou reiniciar o Pi ($(motivo "$_ph2"))." ;;
  esac
}

# O Pi reiniciou se o último arranque (boot_timestamp, em microssegundos)
# já não é o de antes do pedido. Sem esse (a leitura falhou antes do
# pedido), vale ser posterior à hora do pedido. As contas fazem-se no jq:
# são números de 16 algarismos.
confirmar_reboot() {
  _pfim=$((INICIO + 2700))
  _pantes=$(campo boot_before)
  case $_pantes in '' | *[!0-9]*) _pantes=0 ;; esac
  while :; do
    if sup_dados /host/info | jq -e --argjson t "$INICIO" --argjson a "$_pantes" \
      'if $a > 0 then (.boot_timestamp | numbers) as $b | $b > 0 and $b != $a else .boot_timestamp > $t * 1000000 end' \
      >/dev/null 2>&1; then
      terminar true "O Pi reiniciou."
      return
    fi
    [ "$(date +%s)" -lt "$_pfim" ] || break
    sleep 20
  done
  terminar false "O Pi não reiniciou: ao fim de 45 min o último arranque ainda é anterior ao pedido."
}

# E5. Iniciar, parar ou reiniciar um add-on, pelo Supervisor.
addon() {
  _aacao=${TIPO#addon_}
  case $SLUG in
    '' | *[!a-z0-9_]*) terminar false "Add-on inválido: $SLUG."; return ;;
  esac
  [ -n "$NOME" ] || NOME=$SLUG
  case $_aacao in
    start) _afeito="iniciado"; _afazer="iniciar" ;;
    stop) _afeito="parado"; _afazer="parar" ;;
    *) _afeito="reiniciado"; _afazer="reiniciar" ;;
  esac
  _ah=$(sup "/addons/$SLUG/$_aacao" -m 600 -X POST)
  case $_ah in
    2??) terminar true "Add-on $NOME $_afeito." ;;
    *) terminar false "Não consegui $_afazer o add-on $NOME ($(motivo "$_ah"))." ;;
  esac
}

# O trabalho de um comando, em background. É um subshell: as variáveis
# daqui não tocam nas do ciclo principal, e o $CORPO passa a ser outro.
executar() {
  CORPO=$(mktemp)
  ler_comando
  case $TIPO in
    update) atualizar ;;
    restart) reiniciar_ha ;;
    reboot) reiniciar_pi ;;
    addon_start | addon_stop | addon_restart) addon ;;
    # O inventário manda-o o ciclo principal logo a seguir a entregar este
    # resultado, como depois de qualquer comando — uma só entrega, e com as
    # mesmas regras de quando o Core está em baixo.
    inventory) terminar true "Inventário pedido; segue logo a seguir a esta resposta." ;;
    *) terminar false "Tipo de comando desconhecido: $TIPO." ;;
  esac
  rm -f "$CORPO"
}

# E4. Havia um comando em curso quando o agente parou. Um update retoma só
# a confirmação (o install já foi pedido — pedi-lo outra vez podia instalar
# duas vezes); um reboot confirma pelo arranque; o resto já tinha acabado
# ou morreu com o agente, e não se repete.
retomar() {
  CORPO=$(mktemp)
  ler_comando
  case $ID in
    '' | *[!0-9]*)
      log "O comando em curso em $DATA/command.json não tem id válido — apagado."
      rm -f "$DATA/command.json" "$CORPO"
      return
      ;;
  esac
  # O agente parou entre gravar o resultado e apagar o command.json: o
  # comando acabou, e o resultado segue no batimento. Retomá-lo escrevia
  # por cima dele (um "Concluído" no lugar de uma falha, por exemplo).
  if [ "$(jq -r '.id // empty' "$DATA/result.json" 2>/dev/null)" = "$ID" ]; then
    rm -f "$DATA/command.json" "$CORPO"
    return
  fi
  log "A retomar o comando #$ID ($TIPO), que estava em curso quando o agente parou."
  case $TIPO in
    update) validar_update && confirmar_update ;;
    reboot) confirmar_reboot ;;
    *) terminar true "Concluído; o agente reiniciou entretanto." ;;
  esac
  rm -f "$CORPO"
}

# Entrega o resultado do último comando. O ficheiro só se apaga quando o
# relay o registou (200) ou já não o quer (404: não conhece o comando; 409:
# já terminou ou foi cancelado); até lá tenta em cada batimento — é o que
# sobrevive a um relay em baixo ou ao agente reiniciar.
entregar_resultado() {
  [ -f "$DATA/result.json" ] || return 0
  _eid=$(jq -r '.id // empty' "$DATA/result.json" 2>/dev/null)
  case $_eid in
    '' | *[!0-9]*)
      log "O $DATA/result.json não se lê — apagado."
      rm -f "$DATA/result.json"
      return 0
      ;;
  esac
  _ecorpo=$(jq -c '{ok: (.ok == true), message, installed_version}' "$DATA/result.json" 2>/dev/null)
  _eh=$(relay "/agent/$UUID/commands/$_eid" -m 15 -X POST -H "content-type: application/json" -d "$_ecorpo")
  case $_eh in
    2?? | 404 | 409)
      # Só se apaga se ainda for o mesmo resultado (um comando novo pode ter
      # acabado entretanto).
      [ "$(jq -r '.id // empty' "$DATA/result.json" 2>/dev/null)" != "$_eid" ] || rm -f "$DATA/result.json"
      case $_eh in
        404 | 409) log "O relay já não esperava o resultado do comando #$_eid ($_eh)." ;;
      esac
      RESULTADO_ERRO=""
      # Depois de qualquer comando, o inventário: é assim que a consola vê
      # a versão nova, o add-on parado, o Pi que voltou.
      INV_AT=$TICK
      ;;
    *)
      [ "$_eh" = "$RESULTADO_ERRO" ] || log "O resultado do comando #$_eid não foi entregue ($(motivo "$_eh")) — fica guardado e tenta no batimento seguinte."
      RESULTADO_ERRO=$_eh
      ;;
  esac
}

# ── O inventário ──────────────────────────────────────────────────────────
# Sai da casa só o que está escolhido aqui, campo a campo. Duas exclusões de
# propósito:
# — as opções dos add-ons. A lista vem de GET /addons, que não as traz;
#   o /addons/<slug>/info, para um add-on com papel manager, mostra as
#   opções dos outros add-ons, palavras-passe incluídas — nunca se usa aqui.
# — o título das integrações, que pode ter o email do cliente: das config
#   entries só saem domain, state, source e disabled_by.

# As atualizações pendentes, com o que o Supervisor não diz: de onde vem
# cada uma (o identificador hassio do aparelho: core, OS, supervisor, ou o
# slug do add-on) e a plataforma (hassio, hacs, shelly…). Testado na casa
# do Luís; o Core devolve-o como texto que é JSON.
molde() {
  cat <<'EOF'
{%- set ns = namespace(out=[]) -%}
{%- for s in states.update -%}
{%- set dev = device_id(s.entity_id) -%}
{%- set h = namespace(id=none) -%}
{%- if dev -%}{%- for i in (device_attr(dev, 'identifiers') or []) -%}{%- if i[0] == 'hassio' -%}{%- set h.id = i[1] -%}{%- endif -%}{%- endfor -%}{%- endif -%}
{%- set entry = config_entry_id(s.entity_id) -%}
{%- set ns.out = ns.out + [{'entity_id': s.entity_id, 'title': s.attributes.title or s.name, 'installed_version': s.attributes.installed_version, 'latest_version': s.attributes.latest_version, 'supported_features': s.attributes.supported_features, 'platform': (config_entry_attr(entry, 'domain') if entry else none), 'hassio_id': h.id, 'in_progress': s.attributes.in_progress, 'release_url': s.attributes.release_url, 'state': s.state, 'skipped_version': s.attributes.skipped_version}] -%}
{%- endfor -%}
{{ ns.out | tojson }}
EOF
}

# Recolhe e manda. Um pedaço que falhe vira null e não impede o resto.
# O Core é o único que se espera: enquanto arranca, o proxy responde 502 a
# tudo — e um inventário sem integrações nem atualizações só porque o Core
# estava a meio de reiniciar enganava a consola. Tenta-se outra vez 5
# batimentos depois; à 3.ª falha seguida manda-se na mesma, com null nesses
# dois (null é "o Core não respondeu", diferente de [] "não há").
# Devolve 0 entregue; 1 não entregue, tenta no batimento seguinte; 2 o Core
# em baixo, não mandou; 3 recusado pelo relay, tenta no próximo inventário.
enviar_inventario() {
  _d=$(mktemp -d)
  sup_dados /info > "$_d/info" || echo null > "$_d/info"
  sup_dados /core/info > "$_d/core" || echo null > "$_d/core"
  sup_dados /os/info > "$_d/os" || echo null > "$_d/os"
  sup_dados /supervisor/info > "$_d/sup" || echo null > "$_d/sup"
  sup_dados /host/info > "$_d/host" || echo null > "$_d/host"
  sup_dados /network/info > "$_d/net" || echo null > "$_d/net"
  sup_dados /hardware/info > "$_d/hw" || echo null > "$_d/hw"
  sup_dados /addons > "$_d/addons" || echo null > "$_d/addons"

  _core_em_baixo=""
  _ih=$(sup /core/api/config/config_entries/entry -m 30)
  case $_ih in
    2??)
      jq -c 'if type == "array" then [.[] | objects | {domain, state, source, disabled_by}] else null end' \
        "$CORPO" > "$_d/entries" 2>/dev/null || echo null > "$_d/entries"
      ;;
    502 | 503 | 504 | 000) _core_em_baixo=1; echo null > "$_d/entries" ;;
    *) echo null > "$_d/entries" ;;
  esac
  echo null > "$_d/updates"
  if [ -z "$_core_em_baixo" ]; then
    molde | jq -Rsc '{template: .}' > "$_d/molde"
    _ih=$(sup /core/api/template -m 60 -X POST -H "content-type: application/json" --data-binary "@$_d/molde")
    case $_ih in
      2??)
        jq -c 'if type == "array" then [.[] | objects | {entity_id, title, installed_version, latest_version,
          supported_features, platform, hassio_id, in_progress, release_url, state, skipped_version}] else null end' \
          "$CORPO" > "$_d/updates" 2>/dev/null || echo null > "$_d/updates"
        ;;
      502 | 503 | 504 | 000) _core_em_baixo=1 ;;
    esac
  fi
  if [ -n "$_core_em_baixo" ]; then
    CORE_FALHAS=$((CORE_FALHAS + 1))
    if [ "$CORE_FALHAS" -lt 3 ]; then
      rm -rf "$_d"
      return 2
    fi
    echo null > "$_d/entries"
    echo null > "$_d/updates"
    log "O Core não respondeu ($CORE_FALHAS vezes seguidas) — o inventário vai sem integrações nem atualizações."
  else
    CORE_FALHAS=0
  fi

  jq -n --arg agent "$AGENT_VERSION" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --slurpfile info "$_d/info" --slurpfile core "$_d/core" --slurpfile os "$_d/os" \
    --slurpfile sup "$_d/sup" --slurpfile host "$_d/host" --slurpfile net "$_d/net" \
    --slurpfile hw "$_d/hw" --slurpfile addons "$_d/addons" \
    --slurpfile entries "$_d/entries" --slurpfile updates "$_d/updates" '
    def talvez(f): if . == null then null else f end;
    def obj: if type == "object" then . else {} end;
    {
      agent: $agent,
      collected_at: $at,
      system: {
        core: ($core[0] | talvez({version, version_latest})),
        supervisor: ($sup[0] | talvez({version, version_latest, channel, healthy, supported})),
        os: ($os[0] | talvez({version, version_latest, version_pending, board})),
        host: ($host[0] | talvez({hostname, disk_total, disk_used, disk_free, kernel, operating_system})),
        machine: ($info[0] | talvez(.machine)),
        arch: ($info[0] | talvez(.arch)),
        ipv4: ($net[0] | talvez([.interfaces[]? | objects | select(.primary == true) | (.ipv4 | obj | .address[]?) | strings]))
      },
      addons: ($addons[0] | talvez([.addons[]? | objects | {slug, name, version, version_latest, update_available, state, repository}])),
      integrations: $entries[0],
      updates: $updates[0],
      usb: ($hw[0] | talvez([.devices[]? | objects | select(.subsystem == "tty" and .by_id != null)
        | (.attributes | obj) as $a
        | {by_id, dev_path,
           vendor_id: ($a.ID_VENDOR_ID // $a.ID_USB_VENDOR_ID),
           model_id: ($a.ID_MODEL_ID // $a.ID_USB_MODEL_ID),
           vendor: ($a.ID_VENDOR // $a.ID_USB_VENDOR),
           model: ($a.ID_MODEL // $a.ID_USB_MODEL)}]))
    }' > "$_d/inventario" 2>/dev/null
  if [ ! -s "$_d/inventario" ]; then
    log "Não consegui montar o inventário — tenta no próximo."
    rm -rf "$_d"
    return 3
  fi

  _ih=$(relay "/agent/$UUID/inventory" -m 60 -X POST -H "content-type: application/json" --data-binary "@$_d/inventario")
  rm -rf "$_d"
  case $_ih in
    2??)
      INV_ERRO=""
      return 0
      ;;
    429 | 5?? | 000)
      [ "$_ih" = "$INV_ERRO" ] || log "Inventário não entregue ($(motivo "$_ih")) — tenta no batimento seguinte."
      INV_ERRO=$_ih
      return 1
      ;;
    *)
      # Um 400 ou 413 repete-se igual no minuto seguinte: espera-se pelo
      # próximo inventário, em vez de mandar o mesmo de minuto a minuto.
      [ "$_ih" = "$INV_ERRO" ] || log "Inventário não entregue ($(motivo "$_ih")) — tenta no próximo inventário."
      INV_ERRO=$_ih
      return 3
      ;;
  esac
}

# ── O batimento ───────────────────────────────────────────────────────────
batimento() {
  # A versão vem do Supervisor a cada batimento — é ele que sabe também
  # qual é a mais recente disponível, e é isso que acende o "→ nova" na
  # consola. Se o Supervisor não responder, bate-se na mesma sem versão:
  # o relay guarda a última conhecida e o sinal de vida continua.
  VER=""
  LATEST=""
  if _binfo=$(sup_dados /core/info); then
    VER=$(printf '%s' "$_binfo" | jq -r '.version // empty' 2>/dev/null)
    LATEST=$(printf '%s' "$_binfo" | jq -r '.version_latest // empty' 2>/dev/null)
  fi
  # O "agent" diz ao relay que este agente executa comandos da fila; sem
  # ele, o relay responde como aos agentes 0.2 (só o recado antigo).
  _bcorpo=$(jq -nc --arg version "$VER" --arg latest "$LATEST" --arg agent "$AGENT_VERSION" \
    '{version: $version, latest: $latest, agent: $agent}')
  case $(relay "/agent/$UUID/heartbeat" -m 15 -X POST -H "content-type: application/json" -d "$_bcorpo") in
    2??) ;;
    *) return 1 ;;
  esac
  CMD=$(jq -r '.command // empty' "$CORPO" 2>/dev/null)
  # Os comandos novos copiam-se já para um ficheiro à parte: a resposta a
  # um deles ("outro comando em curso") reutiliza o $CORPO. (`true` e não
  # `:`, como no pedir: aqui um `:` que não abrisse o ficheiro matava o
  # agente.)
  jq -c '.commands[]? | objects' "$CORPO" > "$NOVOS" 2>/dev/null || true > "$NOVOS"

  # Os recados executam em background: o update pode demorar minutos e o
  # batimento não pode parar — é ele que diz à consola que a casa está
  # viva enquanto o trabalho decorre.
  case "$CMD" in
    restart)
      log "Reinício do Home Assistant pedido pela consola."
      curl -s -m 300 -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" "$SUP/core/restart" >/dev/null &
      ;;
    update)
      log "Atualização do Home Assistant pedida pela consola."
      curl -s -m 1800 -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" "$SUP/core/update" >/dev/null &
      ;;
  esac

  # A lista lê-se pelo descritor 3, para nada dentro do ciclo lhe comer
  # linhas pelo stdin.
  while IFS= read -r _bc <&3; do
    receber "$_bc"
  done 3< "$NOVOS"
  return 0
}

# ── Arranque ──────────────────────────────────────────────────────────────
log "Domnex Agente $AGENT_VERSION a arrancar."
CORPO=$(mktemp)
NOVOS=$(mktemp)

# As opções do add-on chegam sempre em /data/options.json — era daí que o
# bashio as lia. Lê-se com jq, que já é preciso para o resto, e assim o
# agente não depende de o bashio existir na imagem-base (não existe).
ler_segredo
CODIGO_INST=$(jq -r '.code // empty' "$DATA/options.json" 2>/dev/null)
UUID=$(jq -r '.data.uuid // empty' "$CONF/.storage/core.uuid" 2>/dev/null)

if [ -z "$SECRET" ] && [ -z "$CODIGO_INST" ]; then
  log "Sem segredo nem código de instalação — gera um código na consola (Frota → Nova casa) e escreve-o na configuração."
elif [ -z "$SECRET" ]; then
  log "Sem segredo: a registar a casa na consola com o código de instalação."
fi
if [ -z "$UUID" ]; then
  log "Não consegui ler o uuid da casa em $CONF/.storage/core.uuid."
fi

TRABALHO=""
if [ -f "$DATA/command.json" ]; then
  retomar &
  TRABALHO=$!
fi

TICK=0
INV_AT=0
CORE_FALHAS=0
REGISTO_PARADO=""
REGISTO_ERRO=""
REGISTO_INCERTO=""
RESULTADO_ERRO=""
INV_ERRO=""
while true; do
  if [ -z "$SECRET" ] && [ -n "$CODIGO_INST" ] && [ -n "$UUID" ] && [ -z "$REGISTO_PARADO" ]; then
    registar
  fi

  if [ -n "$SECRET" ]; then
    # O resultado pendente vai antes do batimento: o relay só entrega o
    # comando seguinte depois de registar este.
    entregar_resultado

    # O batimento, e a seguir o inventário: ao arrancar (INV_AT começa em
    # 0), de 60 em 60 batimentos, e depois de cada comando
    # (entregar_resultado põe-no para já). Não depois de um batimento que
    # falhou (relay em baixo, sem internet): a entrega falhava na mesma, e
    # recolhê-lo custa ao Pi uma dúzia de pedidos ao Supervisor e um molde
    # no Core — de minuto a minuto, numa falha de horas. Fica para o
    # primeiro batimento que passe.
    if batimento && [ "$TICK" -ge "$INV_AT" ]; then
      enviar_inventario
      case $? in
        0 | 3) INV_AT=$((TICK + 60)) ;;
        1) INV_AT=$((TICK + 1)) ;;
        2) INV_AT=$((TICK + 5)) ;;
      esac
    fi
  fi

  # ── O carteiro das cópias, a cada 30 batimentos ──────────────────────────
  if [ $((TICK % 30)) -eq 0 ]; then
    # As cópias da casa chamam-se "Automatic backup …" (as agendadas e as do
    # botão da app). Os outros tar em /backup são parciais que o HA faz antes
    # de atualizar add-ons — não são a casa, e não os queremos no cofre.
    FILE=$(ls -t "$BACKUP_DIR"/automatic_backup_*.tar 2>/dev/null | head -n 1)
    if [ -z "$FILE" ]; then
      FILE=$(ls -t "$BACKUP_DIR"/*.tar 2>/dev/null | head -n 1)
    fi
    if [ -n "$FILE" ] && [ -n "$SECRET" ]; then
      # A marca é nome+mtime: só se entrega cada cópia uma vez, seja qual for
      # a hora a que o HA a fizer.
      MARK="$FILE $(date -r "$FILE" +%s)"
      if [ "$MARK" != "$(cat "$STATE" 2>/dev/null)" ]; then
        # Uma casa real passa dos 100 MB que o worker aceita, por isso a
        # entrega é direta ao cofre: pede-se um URL assinado ao relay, faz-se
        # o PUT ao R2, e confirma-se no fim para a entrega ficar registada.
        CODE=$(relay "/backup/$UUID/url" -X POST)
        URL=""
        KEY=""
        case $CODE in
          2??)
            URL=$(jq -r '.url // empty' "$CORPO" 2>/dev/null)
            KEY=$(jq -r '.key // empty' "$CORPO" 2>/dev/null)
            ;;
        esac
        if [ -z "$URL" ]; then
          log "O relay não deu URL de entrega: $(cat "$CORPO")"
        else
          CODE=$(pedir -T "$FILE" "$URL")
          if [ "$CODE" = "200" ]; then
            CODE=$(relay "/backup/$UUID/done" -X POST -H "content-type: application/json" \
              -d "{\"key\":\"$KEY\"}")
          fi
          if [ "$CODE" = "200" ]; then
            echo "$MARK" > "$STATE"
            log "Cópia entregue: $(basename "$FILE")"
          else
            log "A entrega falhou com $CODE: $(cat "$CORPO")"
          fi
        fi
      fi
    fi
  fi

  TICK=$((TICK + 1))
  sleep "$TICK_SECONDS"
done
