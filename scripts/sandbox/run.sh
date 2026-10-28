#!/usr/bin/env bash
# Proof of concept for #201: one Claude Code run in yolo mode inside an Apple container.
#
#   scripts/sandbox/run.sh <repo> "<prompt>" [base-ref]
#
# - The agent works in a fresh clone (never a worktree of <repo>, whose .git it could poison).
# - Its stream goes through `dovre agent-host`, so the filter runs on the host, outside the sandbox.
# - Its commits come out as a git bundle made inside the container. The host only fetches that
#   bundle into <repo> as branch sandbox/<id>. It never runs git in the agent-written clone.
# - Nothing is pushed.
#
# Known gaps (fine for the proof of concept): the subscription token is inside the container,
# and the network is fully open.
set -euo pipefail

[ $# -ge 2 ] || { echo "usage: $0 <repo> <prompt> [base-ref]" >&2; exit 2; }
repo=$(cd "$1" && pwd)
prompt=$2
base=${3:-HEAD}
image=${SANDBOX_IMAGE:-dovre-sandbox}

id=$(date +%Y%m%d-%H%M%S)
run=$(mktemp -d "${TMPDIR:-/tmp}/dovre-sandbox.XXXXXX")
mkdir -p "$run/out"
echo "run $id in $run"

base_sha=$(git -C "$repo" rev-parse --verify "$base^{commit}")
git clone -q --no-local --no-checkout "$repo" "$run/work"
git -C "$run/work" checkout -q -b work "$base_sha"
git -C "$run/work" remote remove origin

# The token goes in through a 0600 file (not argv), removed when the script ends.
umask 077
trap 'rm -f "$run/env"' EXIT
# Runs are unattended, so the token comes from a 0600 file, never from an op prompt.
# Make it once, while you're there: op item get "Claude Setup TOken" --fields credential --reveal > ~/.dovre/sandbox-token
token_file=${SANDBOX_TOKEN_FILE:-$HOME/.dovre/sandbox-token}
[ -r "$token_file" ] || { echo "no token at $token_file (see the comment above)" >&2; exit 1; }
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$(tr -d '[:space:]' < "$token_file")" > "$run/env"

full_prompt="$prompt

You are running unattended in a sandbox. Nobody can answer questions. When you are done, commit your work with git on the current branch. You cannot push."

echo "agent running..."
dovre agent-host --out "$run/out.jsonl" --err "$run/err.txt" --exit "$run/exit.json" -- \
  container run --progress none --rm --name "dovre-sb-$id" -m 4g -c 4 \
    --env-file "$run/env" -v "$run/work:/work" "$image" \
    claude -p --dangerously-skip-permissions --output-format stream-json --verbose "$full_prompt" \
  < /dev/null
rm -f "$run/env"
echo "agent exit: $(cat "$run/exit.json")"

# Bundle the agent's work inside the container, so no host git ever reads its .git.
container run --progress none --rm -v "$run/work:/work" -v "$run/out:/out" "$image" sh -c '
  set -e
  git add -A
  git diff --cached --quiet || git commit -qm "Uncommitted work from sandbox run"
  n=$(git rev-list --count '"$base_sha"'..HEAD)
  echo "$n" > /out/count
  [ "$n" = 0 ] || { git update-ref refs/heads/dovre-out HEAD; git bundle create -q /out/work.bundle refs/heads/dovre-out ^'"$base_sha"'; }
'

n=$(cat "$run/out/count")
if [ "$n" = 0 ]; then
  echo "no commits."
else
  branch="sandbox/$id"
  git -C "$repo" fetch -q "$run/out/work.bundle" "refs/heads/dovre-out:refs/heads/$branch"
  echo "branch $branch: $n commit(s)"
  git -C "$repo" log --oneline "$base_sha..$branch"
  git -C "$repo" diff --stat "$base_sha..$branch" | tail -20
  if git -C "$repo" diff --name-only "$base_sha..$branch" | grep -q '^\.github/'; then
    echo "WARNING: the agent changed files under .github/ (CI runs with repo secrets on push)."
  fi
fi

jq -r 'select(.type=="result") | "cost: $\(.total_cost_usd)  error: \(.is_error)\n\(.result)"' "$run/out.jsonl" 2>/dev/null | head -30
[ -s "$run/err.txt" ] && { echo "--- stderr (end)"; tail -5 "$run/err.txt"; }
echo "stream: $run/out.jsonl"
