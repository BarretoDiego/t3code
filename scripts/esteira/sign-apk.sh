#!/bin/sh
# Reassina o APK com a chave permanente do fork (só o deploy recebe a chave).
set -eu
. "$(dirname "$0")/lib.sh"
. ./.esteira-release.env
group "Reassinar com a chave do fork"
s="${ESTEIRA_SECRETS_DIR:?}"
creds="$(cat "$s/android_credentials")"
field() { printf '%s' "$creds" | python3 -c "import json,sys;print(json.load(sys.stdin)['$1'])"; }
bt="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)"
in="dist-esteira/T3-Code-Fork-${T3_VERSION}.unsigned.apk"
out="dist-esteira/T3-Code-Fork-${T3_VERSION}.apk"
tmp="$(mktemp -d)"; umask 077
field storePassword > "$tmp/store"; field keyPassword > "$tmp/key"
"$bt/apksigner" sign --ks "$s/android_keystore" --ks-pass "file:$tmp/store" \
  --ks-key-alias "$(field keyAlias)" --key-pass "file:$tmp/key" --out "$out" "$in"
rm -rf "$tmp" "$in" "$out.idsig"
endgroup
group "Verificar assinatura e gerar sha256"
"$bt/apksigner" verify --print-certs "$out" | grep -E "Signer #1 certificate (DN|SHA-256)"
(cd dist-esteira && sha256sum "$(basename "$out")" > android-sha256.txt)
endgroup
