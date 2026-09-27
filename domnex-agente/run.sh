#!/usr/bin/with-contenv sh
# O agente da Domnex na casa, com dois ofícios:
#
# — O batimento: de minuto em minuto diz ao relay "estou vivo, o HA é a
#   versão X" e pergunta se a consola deixou algum recado. Um "restart" ou
#   "update" levantado aqui executa-se pela API do Supervisor — é assim que
#   o operador reinicia ou atualiza uma casa sem lá ir, porque o relay
#   nunca consegue entrar: são as casas que vêm cá.
#
# — O carteiro das cópias: de meia em meia hora (30 batimentos) espreita
#   /backup e, quando o HA tiver uma cópia nova, entrega-a ao cofre.
#
# O uuid lê-se do próprio HA; o segredo nasce na consola do operador
# (botão "Segredo cópias") e cola-se na configuração deste add-on. Sem
# segredo, o add-on fica quieto.

# Corre em sh (o ash do busybox), que existe em qualquer imagem-base — uma
# suposição a menos do que o bashio ou o bash. Não se liga modo estrito de
# propósito: um curl falhado não é razão para morrer, é razão para tentar no
# batimento seguinte. (O 'set +o pipefail' que aqui estava nem é válido em sh.)

# O domínio próprio da conta Domnex. O URL antigo (workers.dev da conta
# pessoal) continua a funcionar como proxy para aqui, e é o que as casas
# com add-on antigo usam — mas quem atualiza deixa de depender dele.
# `/agent` e `/backup` são públicos de propósito: a autoridade é o segredo
# desta casa, não um login. Só o `/admin` está atrás do Cloudflare Access.
RELAY="https://admin.domnex.pt"
STATE=/data/last_uploaded

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# As opções do add-on chegam sempre em /data/options.json — era daí que o
# bashio as lia. Lê-se com jq, que já é preciso para o resto, e assim o
# agente não depende de o bashio existir na imagem-base (não existe).
SECRET=$(jq -r '.secret // empty' /data/options.json 2>/dev/null)
UUID=$(jq -r '.data.uuid' /homeassistant/.storage/core.uuid)

if [ -z "$SECRET" ]; then
  log "Sem segredo de cópias — gera um na consola e cola-o na configuração."
fi
if [ -z "$UUID" ]; then
  log "Não consegui ler o uuid da casa em /homeassistant/.storage/core.uuid."
fi

TICK=0
while true; do
  if [ -n "$SECRET" ]; then
    # ── O batimento ────────────────────────────────────────────────────────
    # A versão vem do Supervisor a cada batimento — é ele que sabe também
    # qual é a mais recente disponível, e é isso que acende o "→ nova" na
    # consola. Se o Supervisor não responder, bate-se na mesma sem versão:
    # o relay guarda a última conhecida e o sinal de vida continua.
    INFO=$(curl -s -m 10 -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/info)
    VER=$(echo "$INFO" | jq -r '.data.version // empty' 2>/dev/null)
    LATEST=$(echo "$INFO" | jq -r '.data.version_latest // empty' 2>/dev/null)
    RESP=$(curl -s -m 15 -X POST -H "x-backup-secret: $SECRET" -H "content-type: application/json" \
      -d "{\"version\":\"$VER\",\"latest\":\"$LATEST\"}" "$RELAY/agent/$UUID/heartbeat")
    CMD=$(echo "$RESP" | jq -r '.command // empty' 2>/dev/null)

    # Os recados executam em background: o update pode demorar minutos e o
    # batimento não pode parar — é ele que diz à consola que a casa está
    # viva enquanto o trabalho decorre.
    case "$CMD" in
      restart)
        log "Reinício do Home Assistant pedido pela consola."
        curl -s -m 300 -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/restart >/dev/null &
        ;;
      update)
        log "Atualização do Home Assistant pedida pela consola."
        curl -s -m 1800 -X POST -H "Authorization: Bearer $SUPERVISOR_TOKEN" http://supervisor/core/update >/dev/null &
        ;;
    esac
  fi

  # ── O carteiro das cópias, a cada 30 batimentos ──────────────────────────
  if [ $((TICK % 30)) -eq 0 ]; then
    # As cópias da casa chamam-se "Automatic backup …" (as agendadas e as do
    # botão da app). Os outros tar em /backup são parciais que o HA faz antes
    # de atualizar add-ons — não são a casa, e não os queremos no cofre.
    FILE=$(ls -t /backup/automatic_backup_*.tar 2>/dev/null | head -n 1)
    if [ -z "$FILE" ]; then
      FILE=$(ls -t /backup/*.tar 2>/dev/null | head -n 1)
    fi
    if [ -n "$FILE" ] && [ -n "$SECRET" ]; then
      # A marca é nome+mtime: só se entrega cada cópia uma vez, seja qual for
      # a hora a que o HA a fizer.
      MARK="$FILE $(date -r "$FILE" +%s)"
      if [ "$MARK" != "$(cat "$STATE" 2>/dev/null)" ]; then
        # Uma casa real passa dos 100 MB que o worker aceita, por isso a
        # entrega é direta ao cofre: pede-se um URL assinado ao relay, faz-se
        # o PUT ao R2, e confirma-se no fim para a entrega ficar registada.
        RESP=$(curl -s -X POST -H "x-backup-secret: $SECRET" "$RELAY/backup/$UUID/url")
        URL=$(echo "$RESP" | jq -r '.url // empty')
        KEY=$(echo "$RESP" | jq -r '.key // empty')
        if [ -z "$URL" ]; then
          log "O relay não deu URL de entrega: $RESP"
        else
          CODE=$(curl -s -o /tmp/resposta -w '%{http_code}' -T "$FILE" "$URL")
          if [ "$CODE" = "200" ]; then
            CODE=$(curl -s -o /tmp/resposta -w '%{http_code}' -X POST \
              -H "x-backup-secret: $SECRET" -H "content-type: application/json" \
              -d "{\"key\":\"$KEY\"}" "$RELAY/backup/$UUID/done")
          fi
          if [ "$CODE" = "200" ]; then
            echo "$MARK" > "$STATE"
            log "Cópia entregue: $(basename "$FILE")"
          else
            log "A entrega falhou com $CODE: $(cat /tmp/resposta)"
          fi
        fi
      fi
    fi
  fi

  TICK=$((TICK + 1))
  sleep 60
done
