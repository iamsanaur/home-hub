#!/usr/bin/env bash
# Installs/updates the `homehub-hermes` Hermes profile from agents/hermes.
# Safe to re-run. Never writes secrets: copy agents/hermes/config/env.example to the
# profile's .env yourself and fill in values.
#
# Usage: scripts/hermes-install-profile.sh [--clone-provider-from <profile>]
#   --clone-provider-from  copy model/provider config (and its .env) from an existing profile
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="homehub-hermes"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
DIR="$HERMES_HOME/profiles/$PROFILE"

command -v hermes >/dev/null || { echo "hermes not found — install Hermes Agent first (docs/hermes-setup.md)"; exit 1; }
echo "Hermes: $(hermes --version 2>/dev/null | head -1)"

if [[ ! -d "$DIR" ]]; then
  if [[ "${1:-}" == "--clone-provider-from" && -n "${2:-}" ]]; then
    hermes profile create "$PROFILE" --clone-from "$2" --no-skills --no-alias \
      --description "HomeHub household coordinator (API server + homehub MCP only)"
  else
    hermes profile create "$PROFILE" --no-skills --no-alias \
      --description "HomeHub household coordinator (API server + homehub MCP only)"
  fi
fi

mkdir -p "$DIR/skills"
for s in "$ROOT"/agents/hermes/skills/*/; do
  name="$(basename "$s")"
  rm -rf "$DIR/skills/$name"
  cp -R "$s" "$DIR/skills/$name"
done
cp "$ROOT/agents/hermes/profiles/$PROFILE/SOUL.md" "$DIR/SOUL.md"

# Merge the HomeHub config fragment into the profile config (keys in the fragment win).
# Use Hermes' own interpreter (it ships PyYAML).
PY="$HERMES_HOME/hermes-agent/venv/bin/python"; [[ -x "$PY" ]] || PY="$HERMES_HOME/hermes-agent/.venv/bin/python"; [[ -x "$PY" ]] || PY=python3
"$PY" -I - "$DIR/config.yaml" "$ROOT/agents/hermes/config/config.yaml" <<'PY'
import sys, yaml, pathlib
target, fragment = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
base = yaml.safe_load(target.read_text()) if target.exists() else {}
frag = yaml.safe_load(fragment.read_text())
def merge(a, b):
    for k, v in b.items():
        a[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return a
target.write_text(yaml.safe_dump(merge(base or {}, frag), sort_keys=False))
print(f"merged {fragment} -> {target}")
PY

[[ -f "$DIR/.env" ]] || { cp "$ROOT/agents/hermes/config/env.example" "$DIR/.env"; chmod 600 "$DIR/.env"; echo "Created $DIR/.env from template — fill in the placeholders."; }
echo "Installed skills: $(ls "$DIR/skills" | tr '\n' ' ')"
echo "Start the API server:  hermes -p $PROFILE gateway"
