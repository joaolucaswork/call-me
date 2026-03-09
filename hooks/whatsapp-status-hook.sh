#!/bin/bash
# WhatsApp Status Hook (Stop hook)
# Sends intermediate progress updates via WhatsApp when there's an active session.
# Rate-limited to once per 60 seconds to avoid spam.

API_URL="http://localhost:3334"
RATE_LIMIT_FILE="/tmp/callme-whatsapp-last-status"
SESSIONS_DIR="$(dirname "$0")/../server/.whatsapp-sessions"
RATE_LIMIT_SECONDS=60

# Check if WhatsApp is configured by hitting health endpoint
HEALTH=$(curl -s "$API_URL/api/health" 2>/dev/null)
if [[ -z "$HEALTH" ]]; then
  exit 0
fi

# Check if there's an active WhatsApp session (updated in last hour)
ACTIVE_SESSION=""
NOW=$(date +%s)
ONE_HOUR_AGO=$((NOW - 3600))

if [[ -d "$SESSIONS_DIR" ]]; then
  for session_file in "$SESSIONS_DIR"/*.json; do
    [[ -f "$session_file" ]] || continue
    UPDATED_AT=$(jq -r '.updatedAt // 0' "$session_file" 2>/dev/null)
    # Convert ms to seconds
    UPDATED_AT_SEC=$((UPDATED_AT / 1000))
    if [[ $UPDATED_AT_SEC -gt $ONE_HOUR_AGO ]]; then
      ACTIVE_SESSION="$session_file"
      break
    fi
  done
fi

# No active session = nothing to notify
if [[ -z "$ACTIVE_SESSION" ]]; then
  exit 0
fi

# Rate limit: don't send more than once per 60 seconds
if [[ -f "$RATE_LIMIT_FILE" ]]; then
  LAST_SENT=$(cat "$RATE_LIMIT_FILE" 2>/dev/null)
  ELAPSED=$((NOW - LAST_SENT))
  if [[ $ELAPSED -lt $RATE_LIMIT_SECONDS ]]; then
    exit 0
  fi
fi

# Send a brief status message
# The message is intentionally short — just to let the user know Claude is still working
curl -s -X POST "$API_URL/api/whatsapp/send_text" \
  -H "Content-Type: application/json" \
  -d '{"message": "\u23f3 Ainda trabalhando..."}' \
  >/dev/null 2>&1

# Update rate limit timestamp
echo "$NOW" > "$RATE_LIMIT_FILE"

exit 0
