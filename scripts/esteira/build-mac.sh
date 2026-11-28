#!/bin/sh
# DMG/ZIP assinados com o certificado autoassinado do fork. Roda nativo no Mac
# do dono (esteira run); a chave fica no próprio Mac e nunca vai ao homelab.
set -eu
. "$(dirname "$0")/lib.sh"
. ./.esteira-release.env
group "Certificado autoassinado do fork"
dir="$HOME/.config/t3code-fork-signing"
T3CODE_DESKTOP_MAC_SELF_SIGN_P12="$(base64 < "$dir/cert.p12" | tr -d '\n')"
T3CODE_DESKTOP_MAC_SELF_SIGN_PASSWORD="$(cat "$dir/password.txt")"
export T3CODE_DESKTOP_MAC_SELF_SIGN_P12 T3CODE_DESKTOP_MAC_SELF_SIGN_PASSWORD
endgroup
group "electron-builder: DMG + ZIP assinados"
node_modules/.bin/vp run dist:desktop:artifact --platform mac --target dmg --arch arm64 --build-version "$T3_VERSION" --skip-build --verbose
endgroup
