#!/bin/sh
# Copia os instaláveis e os manifestos de atualização do electron-builder.
set -eu
mkdir -p dist-esteira
n=0
for f in release/*.dmg release/*.zip release/*.AppImage release/*.deb release/*.blockmap release/*.yml; do
  [ -f "$f" ] || continue
  case "$f" in */builder-debug.yml) continue ;; esac
  cp "$f" dist-esteira/ && n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "nenhum artefato em release/" >&2; ls -la release >&2 || true; exit 1; }
ls -la dist-esteira
