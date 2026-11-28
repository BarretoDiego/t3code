#!/bin/sh
# APK release com o JS embutido. O build NÃO recebe a chave do fork: assina com
# uma chave descartável e o deploy reassina com a chave real (apksigner).
set -eu
. "$(dirname "$0")/lib.sh"
. ./.esteira-release.env
export APP_VARIANT=production T3CODE_MOBILE_UPDATES_ENABLED=0 \
  T3CODE_MOBILE_VERSION="$T3_VERSION" T3CODE_MOBILE_VERSION_CODE="$T3_RUN_NUMBER" \
  NODE_OPTIONS=--max-old-space-size=4096
group "Chave descartável de build"
tmp="$(mktemp -d)"
keytool -genkeypair -v -keystore "$tmp/throwaway.jks" -storepass throwaway -keypass throwaway \
  -alias throwaway -keyalg RSA -keysize 2048 -validity 1 -dname "CN=esteira-build" >/dev/null 2>&1
export T3CODE_ANDROID_KEYSTORE="$tmp/throwaway.jks" T3CODE_ANDROID_STORE_PASSWORD=throwaway \
  T3CODE_ANDROID_KEY_ALIAS=throwaway T3CODE_ANDROID_KEY_PASSWORD=throwaway
endgroup
group "Gradle :app:assembleRelease (arm64-v8a, x86_64)"
cd apps/mobile/android
# Build cache do Gradle no volume /root/.gradle: tarefas iguais entre commits não recompilam.
# Cabe em 13 GB: heap do Gradle 4 GB, Kotlin no mesmo processo, 4 workers (cada
# worker nativo/Kotlin usa ~1-2 GB fora do heap).
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64 --no-daemon --max-workers=4 --build-cache \
  -Dorg.gradle.jvmargs="-Xmx4g -XX:MaxMetaspaceSize=1g -Dfile.encoding=UTF-8" \
  -Pkotlin.compiler.execution.strategy=in-process
cd ../../..
apk=apps/mobile/android/app/build/outputs/apk/release/app-release.apk
endgroup
group "Conferir manifesto e bundle JS"
apkanalyzer manifest print "$apk" > "$tmp/manifest.xml"
python3 - "$tmp/manifest.xml" <<'PY'
import os, sys, xml.etree.ElementTree as ET
m = ET.parse(sys.argv[1]).getroot()
a = "{http://schemas.android.com/apk/res/android}"
app = m.find("application")
assert m.get("package") == "com.barretodiego.t3code.fork", m.get("package")
assert m.get(a + "versionCode") == os.environ["T3CODE_MOBILE_VERSION_CODE"]
assert app is not None and app.get(a + "debuggable", "false") == "false"
meta = {i.get(a + "name"): i.get(a + "value") for i in app.findall("meta-data")}
assert meta.get("expo.modules.updates.ENABLED") == "false"
print("manifesto ok:", m.get("package"), m.get(a + "versionCode"))
PY
unzip -l "$apk" | grep -q 'assets/index.android.bundle'
endgroup
group "Copiar APK"
mkdir -p dist-esteira
cp "$apk" "dist-esteira/T3-Code-Fork-${T3_VERSION}.unsigned.apk"
rm -rf "$tmp"
ls -la dist-esteira
endgroup
