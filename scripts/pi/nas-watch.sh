#!/bin/sh
# TrueNAS watches the Pi's live-times check (yeg-check.sh), so a dead Pi pages too: the Pi's own dead-man dies
# with it. TrueNAS dying is caught by the hc-ping it already sends every 5 min (owner's choice, 2026-10-30).
# Every 15 min from a TrueNAS cron job (midclt, as Apollo: survives updates, unlike /etc on the boot environment).
#   nas-watch.sh [--dry-run]
# Telegram once when the last run is over 30 min old or hermes doesn't answer, once more when it recovers.
DIR=$(cd "$(dirname "$0")/../.." && pwd)
STATE=$DIR/.pi-watch
LATCH=$STATE/latch  # present while paged and not yet recovered
LOG=$STATE/log
KEY=/mnt/Playground/Apollo-home/.ssh/claude_agent_truenas  # the key cron job 43 uses to reach hermes
PI=${PI-Apollo@100.64.0.10}
TOK=/run/sodium/jarvis/holypi_bot_token
CHAT=/run/sodium/jarvis/allowed_chat_ids
STALE_MIN=${STALE_MIN-30}
DRY=0; [ "$1" = "--dry-run" ] && DRY=1

mkdir -p "$STATE"
log() { echo "$(date '+%F %T') $*" >> "$LOG"; echo "$*"; }
# The token goes in the URL only, and curl's body to /dev/null (as backup-stamp-watch does).
notify() {
  [ "$DRY" = 1 ] && { echo "WOULD SEND: $1"; return 0; }
  if [ ! -r "$TOK" ] || [ ! -r "$CHAT" ]; then log "NOTIFY FAILED (no credentials): $1"; return 1; fi
  tok=$(cat "$TOK"); chat=$(head -n1 "$CHAT" | tr -d '[:space:]')
  code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "https://api.telegram.org/bot$tok/sendMessage" \
    --data-urlencode "chat_id=$chat" --data-urlencode "text=yegbus: $1" 2>/dev/null)
  tok=
  [ "$code" = 200 ] && { log "SENT $1"; return 0; }
  log "NOTIFY FAILED http=$code: $1"; return 1
}

last=$(timeout 30 ssh -n -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 "$PI" \
  'stat -c %Y /var/lib/yeg-check/last-run' 2>&1); s=$?
case "$last" in
  ''|*[!0-9]*) bad="TrueNAS can't read the Pi's live-times check (ssh exit $s: $(echo "$last" | tail -n1 | cut -c1-200))" ;;
  *) age=$(( ($(date +%s) - last) / 60 ))
     [ "$age" -gt "$STALE_MIN" ] && bad="the Pi's live-times check last landed $age min ago, seen from TrueNAS" ;;
esac
if [ -z "$bad" ]; then
  [ -e "$LATCH" ] && notify "the Pi's live-times check is landing again, seen from TrueNAS" && { [ "$DRY" = 1 ] || rm -f "$LATCH"; }
  log "OK ${age} min"
  exit 0
fi
log "BAD $bad"
[ -e "$LATCH" ] || { notify "$bad" && [ "$DRY" = 0 ] && touch "$LATCH"; }
exit 1
