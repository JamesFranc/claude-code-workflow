#!/bin/bash
# Builds "Agent Session.app" into ~/Applications and registers it for agent-session:// links (FLOW-433).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${AGENT_SESSION_APP_DIR:-$HOME/Applications}/Agent Session.app"
PLIST="$APP/Contents/Info.plist"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
osacompile -o "$APP" "$SCRIPT_DIR/handler.applescript"
cp "$SCRIPT_DIR/find-live-session.py" "$SCRIPT_DIR/validate-link.py" "$SCRIPT_DIR/check-resume-dir.py" "$APP/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string com.denormans.agent-session" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.denormans.agent-session" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string Agent Session" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string agent-session" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"
codesign --force --sign - "$APP"
"$LSREGISTER" -f "$APP"
echo "Installed $APP for agent-session:// links"
