#!/bin/bash
# Builds android/build/yeg-arrivals.apk with the bare SDK tools: no Gradle, no libraries.
# Usage: android/build.sh [install]   (install = adb install -r onto the connected phone)
set -euo pipefail
cd "$(dirname "$0")"
SDK=$HOME/Android/Sdk  # ANDROID_HOME here points at /opt/android-sdk, which has no build-tools
BT=$SDK/build-tools/35.0.0
JAR=$SDK/platforms/android-35/android.jar
VERSION=${VERSION:-1}
rm -rf build && mkdir -p build/classes build/gen

"$BT/aapt2" compile --dir res -o build/res.zip
# ponytail: targetSdk 34 skips Android 15's forced edge-to-edge, which would put the page under the status bar.
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml --java build/gen \
  --min-sdk-version 26 --target-sdk-version 34 --version-code "$VERSION" --version-name "1.$VERSION" build/res.zip
javac --release 11 -classpath "$JAR" -d build/classes $(find src build/gen -name '*.java')
"$BT/d8" --lib "$JAR" --min-api 26 --output build $(find build/classes -name '*.class')
(cd build && jar -u -M -f unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
# The SDK's stock debug key (its password is the public default "android"); fine for sideloading.
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android --out build/yeg-arrivals.apk build/aligned.apk
echo "built android/build/yeg-arrivals.apk"
if [ "${1:-}" = install ]; then adb install -r build/yeg-arrivals.apk; fi
