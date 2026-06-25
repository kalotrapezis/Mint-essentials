#!/usr/bin/env bash
# Install (or dev-symlink) the grun Cinnamon applet.
#
#   ./install.sh           copy the applet into place
#   ./install.sh --link    symlink it instead (live editing for development)
#   ./install.sh --zip     build grun@kalotrapezis.zip for the Cinnamon Spices
#
set -euo pipefail

UUID="grun@kalotrapezis"
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
echo "  1. Right-click the panel -> Applets, find 'grun', add it."
echo "  2. If it doesn't appear, reload Cinnamon: Alt+F2, type 'r', Enter."
echo "  3. Default shortcut to open: Ctrl+Alt+A (change it in the applet settings)."
