#!/bin/bash
# Records the usemu.dev home page's terminal replay: site/recording/replay-<lang>.json.
#
# usage: site/recording/tools/record.sh <en|zh> <path to the mu binary> [work dir]
#
# mu runs in tmux (84x30) in a fresh home, in a copy of the relay project. Its judge is the real
# one (the free Jev when no judge key is set up). The coding model is mockmodel.py: it answers as
# xiaomi/mimo-v2.6-pro with the scripted replies, at no cost. The page says the replies are scripted.
# Needs tmux, python3, git and node; port 8799 must be free.
set -euo pipefail

lang="${1:?usage: record.sh <en|zh> <mu binary> [work dir]}"
mu="${2:?usage: record.sh <en|zh> <mu binary> [work dir]}"
work="${3:-$(mktemp -d)}"
tools="$(cd "$(dirname "$0")" && pwd)"
recording="$(dirname "$tools")"
case "$lang" in
	en) play="$recording/s-play-en.json" ;;
	zh) play="$recording/s-play.json" ;;
	*) echo "language must be en or zh" >&2; exit 1 ;;
esac

home="$work/home-$lang"
if [ -e "$home" ]; then
	echo "$home already exists; pass a new work dir" >&2
	exit 1
fi
version="$(env -i HOME="$work" PATH="/opt/homebrew/bin:/usr/bin:/bin" "$mu" --version)"

mkdir -p "$home/.mu/agent/mu" "$home/code"
cat > "$home/.mu/agent/settings.json" <<EOF
{
  "lastChangelogVersion": "$version",
  "defaultProvider": "xiaomi",
  "defaultModel": "mimo-v2.6-pro",
  "defaultThinkingLevel": "high"
}
EOF
cat > "$home/.mu/agent/models.json" <<'EOF'
{
  "providers": {
    "xiaomi": {
      "baseUrl": "http://127.0.0.1:8799/v1",
      "modelOverrides": { "mimo-v2.6-pro": { "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } } }
    }
  }
}
EOF
# The free Jev's once-a-day notice and the first-start setup question stay out of the picture.
printf '{\n\t"version": 1,\n\t"freeJev": "%s"\n}\n' "$(date +%F)" > "$home/.mu/agent/mu/notices.json"
echo "mu asked on its first start whether to set up a model, and the answer was no." > "$home/.mu/agent/setup-declined"

cp -R "$tools/relay" "$home/code/relay"
(
	cd "$home/code/relay"
	git init -q -b main
	git -c user.name=relay -c user.email=relay@example.com add -A
	git -c user.name=relay -c user.email=relay@example.com commit -q -m "relay 0.4.2"
)

python3 -I "$tools/mockmodel.py" 8799 "$work/requests-$lang.jsonl" > "$work/mockmodel-$lang.log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null' EXIT
sleep 1

python3 -I "$tools/recorder.py" "$lang" "$mu" "$home" "$play" "$recording/replay-$lang.json"
echo "mu $version → $recording/replay-$lang.json (work dir $work)"
