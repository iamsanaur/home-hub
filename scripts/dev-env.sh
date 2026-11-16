#!/usr/bin/env bash
# Source this for local backend work: `source scripts/dev-env.sh`
# Firebase emulators need JDK 21+; firebase-admin 14 needs Node >= 22.12.
if [[ -d /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home ]]; then
  export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
  export PATH="$JAVA_HOME/bin:$PATH"
fi
NODE22="$(ls -d "$HOME"/.nvm/versions/node/v22.* 2>/dev/null | sort -V | tail -1)"
[[ -n "$NODE22" ]] && export PATH="$NODE22/bin:$PATH"
command -v firebase >/dev/null || export PATH="$PATH:$(ls -d "$HOME"/.nvm/versions/node/*/bin | tr '\n' ':')"
export FIRESTORE_EMULATOR_HOST_LOCAL=127.0.0.1:8181
echo "node $(node -v) · java $(java -version 2>&1 | head -1) · firebase $(firebase --version)"
