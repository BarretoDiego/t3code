#!/bin/sh
# Publica a release nightly no fork, como o job "Publish GitHub Release" do
# fork-release.yml. Idempotente: reaproveita a release da tag e só sobe os
# arquivos que faltam. O token fica num arquivo de cabeçalho, nunca na linha de comando.
set -eu
. "$(dirname "$0")/lib.sh"
. ./.esteira-release.env
repo=BarretoDiego/t3code
api="https://api.github.com/repos/$repo"
tmp="$(mktemp -d)"; umask 077
trap 'rm -rf "$tmp"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$ESTEIRA_SECRETS_DIR/github_token")" > "$tmp/auth"
gh() { curl -fsS -H @"$tmp/auth" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }

group "Release $T3_TAG"
if gh "$api/releases/tags/$T3_TAG" -o "$tmp/rel.json" 2>/dev/null; then
  echo "release $T3_TAG já existe; completando os arquivos"
else
  prev="$(gh "$api/releases?per_page=1" | json "d[0]['tag_name'] if d else ''")"
  python3 - "$T3_TAG" "$ESTEIRA_COMMIT" "$prev" > "$tmp/notes-req.json" <<'PY'
import json, sys
tag, sha, prev = sys.argv[1:]
req = {"tag_name": tag, "target_commitish": sha}
if prev: req["previous_tag_name"] = prev
print(json.dumps(req))
PY
  body="$(gh -X POST "$api/releases/generate-notes" --data @"$tmp/notes-req.json" | json "d['body']")"
  python3 - "$T3_TAG" "$ESTEIRA_COMMIT" "$T3_RELEASE_NAME" "$body" > "$tmp/create.json" <<'PY'
import json, sys
tag, sha, name, body = sys.argv[1:]
body += "\n\nBuild e publicação pela Esteira (homelab), sem GitHub Actions."
print(json.dumps({"tag_name": tag, "target_commitish": sha, "name": name, "body": body,
                  "prerelease": True, "make_latest": "false"}))
PY
  gh -X POST "$api/releases" --data @"$tmp/create.json" -o "$tmp/rel.json"
  echo "release $T3_TAG criada"
fi
endgroup
group "Enviar arquivos"
id="$(json "d['id']" < "$tmp/rel.json")"
have="$(json "'\n'.join(a['name'] for a in d['assets'])" < "$tmp/rel.json")"
cd dist-esteira
for f in *.dmg *.zip *.AppImage *.deb *.blockmap *.yml *.apk android-sha256.txt; do
  [ -f "$f" ] || continue
  if printf '%s\n' "$have" | grep -qxF "$f"; then echo "já enviado: $f"; continue; fi
  curl -fsS -H @"$tmp/auth" -H "Content-Type: application/octet-stream" \
    --data-binary @"$f" "https://uploads.github.com/repos/$repo/releases/$id/assets?name=$f" -o /dev/null
  echo "enviado: $f ($(du -h "$f" | cut -f1))"
done
endgroup
