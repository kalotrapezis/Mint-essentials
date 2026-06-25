#!/usr/bin/env bash
# Install (or dev-symlink) the 11tray Cinnamon applet.
#
#   ./install.sh           copy the applet into place
#   ./install.sh --link    symlink it instead (live editing for development)
#   ./install.sh --zip     build 11tray@kalotrapezis.zip for the Cinnamon Spices
#
# 11tray takes over hosting XApp status icons, so remove the stock
# "xapp-status@cinnamon.org" applet from the panel (right-click the panel ->
# Applets) after adding 11tray, or icons will appear twice.
set -euo pipefail

UUID="11tray@kalotrapezis"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/$UUID"
DEST_DIR="$HOME/.local/share/cinnamon/applets"
DEST="$DEST_DIR/$UUID"

case "${1:-}" in
  --zip)
    OUT="$HERE/$UUID.zip"
    rm -f "$OUT"
    ( cd "$HERE" && zip -r "$OUT" "$UUID" -x '*/.*' >/dev/null )
    echo "Built $OUT"
    exit 0
    ;;
  --link)
    mkdir -p "$DEST_DIR"
    rm -rf "$DEST"
    ln -s "$SRC" "$DEST"
    echo "Symlinked $DEST -> $SRC"
    ;;
  *)
    mkdir -p "$DEST_DIR"
    rm -rf "$DEST"
    cp -r "$SRC" "$DEST"
    echo "Installed to $DEST"
    ;;
esac

echo
echo "Next:"
echo "  1. Right-click the panel -> Applets, find '11tray', add it."
echo "  2. Remove the stock 'XApp Status Applet' so icons don't show twice."
echo "  3. If it doesn't appear, reload Cinnamon: Alt+F2, type 'r', Enter."
echo "  4. Ctrl+click a tray icon to tuck it into the drawer (or back out)."
