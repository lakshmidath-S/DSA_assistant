#!/bin/sh
# Installs myIDE as a launchable app on macOS or Linux.
#
# The Windows equivalent is install.ps1. Both do the same job: put an entry
# where the system's application search will find it, so myIDE can be launched
# by name rather than by remembering a directory and typing npm start.
#
#   ./install.sh            install
#   ./install.sh --remove   uninstall
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
REMOVE=${1:-}

case "$(uname -s)" in
	Darwin) PLATFORM=mac ;;
	Linux)  PLATFORM=linux ;;
	*)      echo "Unsupported system: $(uname -s). On Windows use install.ps1." >&2; exit 1 ;;
esac

if [ "$PLATFORM" = mac ]; then
	APP="$HOME/Applications/myIDE.app"

	if [ "$REMOVE" = "--remove" ]; then
		rm -rf "$APP"
		echo "Removed $APP"
		exit 0
	fi

	# A minimal bundle: Spotlight indexes ~/Applications, so this is what makes
	# myIDE findable by name. The executable is a two-line shell script.
	mkdir -p "$APP/Contents/MacOS"
	cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>myIDE</string>
	<key>CFBundleDisplayName</key><string>myIDE</string>
	<key>CFBundleIdentifier</key><string>local.myide</string>
	<key>CFBundleVersion</key><string>0.1.0</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleExecutable</key><string>myide</string>
</dict>
</plist>
PLIST

	cat > "$APP/Contents/MacOS/myide" <<LAUNCH
#!/bin/sh
cd "$ROOT" && exec npm start
LAUNCH

	chmod +x "$APP/Contents/MacOS/myide"
	echo "Created $APP"
	echo
	echo "Press Command-Space and type 'myIDE' to launch it."
	exit 0
fi

# --- Linux -------------------------------------------------------------------
DESKTOP="$HOME/.local/share/applications/myide.desktop"

if [ "$REMOVE" = "--remove" ]; then
	rm -f "$DESKTOP"
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true
	echo "Removed $DESKTOP"
	exit 0
fi

if [ ! -d "$ROOT/node_modules/electron" ]; then
	echo "Dependencies are missing. Run 'npm install' in $ROOT first." >&2
	exit 1
fi

mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<DESK
[Desktop Entry]
Type=Application
Name=myIDE
Comment=Python for DSA practice
Exec=sh -c 'cd "$ROOT" && npm start'
Path=$ROOT
Terminal=false
Categories=Development;IDE;
DESK

chmod +x "$DESKTOP"
# Without this the entry can take until the next login to show up in search.
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true

echo "Created $DESKTOP"
echo
echo "Open your application launcher and type 'myIDE'."
