#!/bin/sh
# Resolve a versão nightly como o Fork Release faria no próximo run e grava em
# .esteira-release.env (lido pelos passos seguintes do mesmo job). O número do
# run é o próximo do workflow fork-release no GitHub, para o versionCode do
# Android continuar crescendo e bater com o run que o push vai disparar.
set -eu
job="${1:?job}"
api="https://api.github.com/repos/BarretoDiego/t3code/actions/workflows/fork-release.yml/runs?per_page=1"
last="$(curl -fsSL "$api" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).workflow_runs?.[0]?.run_number ?? 0))')"
run=$((last + 1))
meta="$(node scripts/resolve-nightly-release.ts --date "$(date -u +%Y%m%d)" --run-number "$run" --sha "$ESTEIRA_COMMIT")"
val() { printf '%s\n' "$meta" | sed -n "s/^$1=//p" | head -1; }
version="$(val version)"; tag="$(val tag)"; name="$(val name)"
[ -n "$version" ] && [ -n "$tag" ] || { echo "resolve-nightly-release sem versão: $meta" >&2; exit 1; }
cat > .esteira-release.env <<ENV
export T3_VERSION='$version'
export T3_TAG='$tag'
export T3_RELEASE_NAME='$name'
export T3_RUN_NUMBER='$run'
export T3CODE_FORK_BRAND=1
export GITHUB_REPOSITORY=BarretoDiego/t3code
ENV
mkdir -p dist-esteira
cp .esteira-release.env "dist-esteira/release-$job.env"
echo "versão $version (run $run, tag $tag)"
