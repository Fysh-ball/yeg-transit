#!/bin/bash
# The Pi's own live-times check, so checking against ETS doesn't need the laptop on (2026-10-30).
#   yeg-check.sh run       every 15 min: check_live.py --page in the site's image, an alert on a wrong time
#   yeg-check.sh deadman   every 5 min: an alert once if no run has landed in 30 min, once more when one does
# Alerts go to Lumi's app through the alert spool on TrueNAS (spool-notify; the owner stopped reading Telegram,
# 2026-10-30). The Pi dying silences both: nas-watch.sh on TrueNAS covers that.
set -u
DIR=/home/Apollo/stacks/yeg-transit
STATE=/var/lib/yeg-check
STAMP=$STATE/last-run      # touched when check_live.py reached a verdict (exit 0, 1 or 3)
LATCH=$STATE/deadman.latch # present while the dead-man has paged and no run has landed since
LOG=$STATE/log
STALE_MIN=${STALE_MIN:-30}

log(){ echo "[$(date -Is)] $*" >> "$LOG"; echo "$*"; }
# $1: the line; $2: ok for a recovery, failed for a fault.
notify(){
  local out
  out=$(printf '%s' "yegbus: $1" | /usr/local/bin/spool-notify "${COND:-hermes-yeg-check}" "$2" 2>&1) \
    && { log "SENT ${1%%$'\n'*}"; return 0; }
  log "NOTIFY FAILED (spool: $(printf '%s' "$out" | tail -n1)): ${1%%$'\n'*}"; return 1
}

mkdir -p "$STATE/home" && chown 65534:65534 "$STATE/home"
case "${1:-}" in
run)
  out=$(timeout 600 docker run --rm -e HOME=/home -v "$STATE/home:/home" -v "$DIR/scripts:/s:ro" \
        yeg-transit:latest python -I /s/check_live.py --page 2>&1); s=$?
  echo "$out"
  # A traceback also exits 1: that's a broken check, not a wrong time, and must not count as a run.
  if [[ $s =~ ^[013]$ ]] && ! grep -q '^Traceback' <<< "$out"; then touch "$STAMP"; fi
  if [ "$s" = 1 ] || [ "$s" = 3 ]; then
    notify "$(grep -E '^(WRONG|UNREACHABLE)' <<< "$out")" failed
  fi
  exit "$s" ;;
deadman)
  last=$(stat -c %Y "$STAMP" 2>/dev/null || echo 0)
  age=$(( ($(date +%s) - last) / 60 ))
  if [ "$age" -le "$STALE_MIN" ]; then
    [ -e "$LATCH" ] && notify "live-times check on the Pi is running again" ok && rm -f "$LATCH"
    exit 0
  fi
  [ -e "$LATCH" ] || { notify "no live-times check has landed on the Pi in $age min (systemctl status yeg-check)" failed && touch "$LATCH"; }
  exit 1 ;;
*) echo "usage: $0 run|deadman" >&2; exit 2 ;;
esac
