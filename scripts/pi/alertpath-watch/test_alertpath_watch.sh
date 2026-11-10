#!/bin/bash
# alertpath-watch: one down mail after 2 dead probes (with a 503 retried after a jittered backoff),
# nothing while it stays dead, one "back" mail on recovery. Stub curl and local URLs: no Resend, no TrueNAS.
set -u
H=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/apw-test.XXXXXX")
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
mkdir "$T/state" "$T/www"; echo dummy > "$T/key"
echo '{"epoch":"x","high":1}' > "$T/www/liveness"; echo '{"ok":true}' > "$T/www/health"
# Stub curl: 503 (no Retry-After) on the first call, 200 after; one line per call in calls.
cat > "$T/curl" <<'EOF'
#!/bin/bash
D=$(dirname "$0"); hdr=""
while [ $# -gt 0 ]; do [ "$1" = -D ] && hdr=$2; shift; done
cat > /dev/null; : > "$hdr"
n=$(wc -l < "$D/calls" 2>/dev/null || echo 0); echo call >> "$D/calls"
[ "$n" -eq 0 ] && printf 503 || printf 200
EOF
chmod +x "$T/curl"
python3 -m http.server 18788 --bind 127.0.0.1 --directory "$T/www" >/dev/null 2>&1 & SRV=$!
sleep 1
export DEFIB_MAIL_STATE="$T/state" DEFIB_MAIL_KEY="$T/key" DEFIB_MAIL_CURL="$T/curl" \
  ALERTPATH_MAILER="$H/../defib-tn/defib-tn-mail" ALERTPATH_TO=test@example.invalid \
  ALERTPATH_MAILBOX_URL=http://127.0.0.1:18788/health
calls() { [ -e "$T/calls" ] && wc -l < "$T/calls" || echo 0; }
fail=0; check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got $2, want $3"; fail=1; fi; }
run() { ALERTPATH_URL=$1 python3 -I "$H/alertpath-watch" 2>>"$T/log"; }
run http://127.0.0.1:1/liveness;            check "dead probe 1 mails nothing" "$(calls)" 0
run http://127.0.0.1:1/liveness;            check "dead probe 2 mails once, 503 then 200" "$(calls)" 2
grep -q "attempt 1 failed (HTTP 503); next try in" "$T/log"; check "503 waited with backoff" $? 0
run http://127.0.0.1:1/liveness;            check "still dead: no repeat mail" "$(calls)" 2
run http://127.0.0.1:18788/liveness;        check "recovery mails once" "$(calls)" 3
run http://127.0.0.1:18788/liveness;        check "stays up: nothing more" "$(calls)" 3
check "day count" "$(cut -d' ' -f2 "$T/state/count")" 2
[ $fail = 0 ] && echo PASS || { echo "--- log"; cat "$T/log"; exit 1; }
