#!/bin/sh
# The Mac's bridge (PLAN D24, WP-N10) as a launchd agent: started at login, and again if it stops.
# It runs a fixed copy of one commit, not this checkout, so switching branches or editing here never
# changes what the bridge runs. Run this again to move it to a newer commit.
#   sh scripts/install-bridge.sh            install (or update to) origin/main and start
#   sh scripts/install-bridge.sh <ref>      install that commit instead (a tag, a sha, a branch)
#   sh scripts/install-bridge.sh --remove   stop and remove the agent (the copies and data stay)
# The copies live in ~/Library/Application Support/dovre/bridge/versions/<sha>, with `current`
# pointing at the one running. Runs and the reply queue are in .../bridge/data, kept across updates.
# .dev.vars is this checkout's (a link), and the plist keeps the node and PATH of the shell that runs
# this (so the agent CLIs are found).
# Its log (connections only, never what agents say) is ~/Library/Logs/dovre-bridge.log; each start
# names the commit: "dovre bridge: <sha>; claude, omp, agy; dialling …".
set -eu

label="dev.dovre.bridge"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
root="$HOME/Library/Application Support/dovre/bridge"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "dovre bridge: removed (copies and data stay in $root)"
  exit 0
fi

repo=$(cd "$(dirname "$0")/.." && pwd)
ref="${1:-origin/main}"
node=$(command -v node) || { echo "dovre bridge: node isn't on PATH" >&2; exit 1; }
pnpm=$(command -v pnpm) || { echo "dovre bridge: pnpm isn't on PATH" >&2; exit 1; }
[ -f "$repo/.dev.vars" ] || { echo "dovre bridge: $repo/.dev.vars is missing (BRIDGE_URL, BRIDGE_KEY, BRIDGE_CLIENT_ID, BRIDGE_CLIENT_SECRET)" >&2; exit 1; }

case "$ref" in origin/*) git -C "$repo" fetch -q origin ;; esac
sha=$(git -C "$repo" rev-parse --verify -q "$ref^{commit}") || { echo "dovre bridge: no commit $ref" >&2; exit 1; }
short=$(git -C "$repo" rev-parse --short=12 "$sha")
dest="$root/versions/$short"

if [ ! -f "$dest/REVISION" ]; then
  echo "dovre bridge: copying $short"
  tmp="$root/versions/.new-$short"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  git -C "$repo" archive "$sha" | tar -x -C "$tmp"
  (cd "$tmp" && "$pnpm" install --prod --frozen-lockfile --prefer-offline --silent)
  # The agent host, from the same commit: built if Go is here, else this checkout's build if any.
  if command -v go >/dev/null 2>&1; then
    go -C "$tmp/launcher" build -trimpath -ldflags '-s -w' -o "$tmp/bin/dovre" .
  elif [ -x "$repo/bin/dovre" ]; then
    mkdir -p "$tmp/bin" && cp "$repo/bin/dovre" "$tmp/bin/dovre"
  fi
  printf '%s\n' "$sha" > "$tmp/REVISION"
  rm -rf "$dest"
  mv "$tmp" "$dest"
fi

# State shared by every copy. The first install brings the checkout's along.
mkdir -p "$root/data"
if [ ! -e "$root/data/bridge" ] && [ -d "$repo/data/bridge" ]; then cp -R "$repo/data/bridge" "$root/data/bridge"; fi
ln -sfn "$root/data" "$dest/data"
ln -sfn "$repo/.dev.vars" "$dest/.dev.vars"
ln -sfn "versions/$short" "$root/current"

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
    <string>$(x "$root/current/src/bridge/main.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(x "$root/current")</string>
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

# Keep the running copy and the two before it (to go back to); drop the rest.
ls -t "$root/versions" | grep -v '^\.' | grep -vx "$short" | tail -n +3 | while read -r old; do rm -rf "$root/versions/$old"; done

echo "dovre bridge: started $short ($plist); log in ~/Library/Logs/dovre-bridge.log"
