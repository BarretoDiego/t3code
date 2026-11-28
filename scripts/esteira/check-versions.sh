#!/bin/sh
# Todos os artefatos precisam ter a mesma versão; senão a release mistura builds.
set -eu
vals="$(cat dist-esteira/release-*.env | sed -n "s/^export T3_VERSION='\(.*\)'/\1/p" | sort -u)"
n="$(printf '%s\n' "$vals" | grep -c .)"
echo "versões: $vals"
[ "$n" -eq 1 ] || { echo "artefatos com versões diferentes; rode os jobs de novo" >&2; exit 1; }
cp "$(ls dist-esteira/release-*.env | head -1)" .esteira-release.env
