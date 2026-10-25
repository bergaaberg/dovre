#!/bin/sh
# The Mac's bridge (PLAN D24, WP-N10) as a launchd agent: `pnpm bridge` at login, started again if
# it stops. Writes ~/Library/LaunchAgents/dev.dovre.bridge.plist for this checkout and the node
# and PATH of the shell that runs it (so the agent CLIs are found), then loads it.
#   sh scripts/install-bridge.sh            install (or reinstall) and start
#   sh scripts/install-bridge.sh --remove   stop and remove
# Its log (connections only, never what agents say) is ~/Library/Logs/dovre-bridge.log.
set -eu

label="dev.dovre.bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "dovre bridge: removed"
  exit 0
fi

repo=$(cd "$(dirname "$0")/.." && pwd)
node=$(command -v node) || { echo "dovre bridge: node isn't on PATH" >&2; exit 1; }
[ -f "$repo/.dev.vars" ] || { echo "dovre bridge: $repo/.dev.vars is missing (BRIDGE_URL, BRIDGE_KEY, BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET)" >&2; exit 1; }

# XML-escape what goes into the plist.
x() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(x "$node")</string>
    <string>$(x "$repo/src/bridge/main.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(x "$repo")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(x "$PATH")</string>
    <key>HOME</key><string>$(x "$HOME")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(x "$HOME/Library/Logs/dovre-bridge.log")</string>
  <key>StandardErrorPath</key><string>$(x "$HOME/Library/Logs/dovre-bridge.log")</string>
</dict>
</plist>
EOF
chmod 600 "$plist"
launchctl bootout "$domain/$label" 2>/dev/null || true
launchctl bootstrap "$domain" "$plist"
echo "dovre bridge: started ($plist); log in ~/Library/Logs/dovre-bridge.log"
