#!/usr/bin/env bash
# Install 11snap - Windows 11-style snap layouts for Cinnamon / X11.
#
#   ./install.sh             install, autostart on login, bind Ctrl+Alt+~, start
#   ./install.sh --no-hotkey install without binding the editor hotkey
#   ./install.sh --uninstall remove everything
#
# 11snap is a small background app (not a Cinnamon applet): it watches for
# window drags and shows the snap picker. Requires X11 (Cinnamon's default).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/11snap.py"
BIN_DIR="$HOME/.local/bin"
BIN="$BIN_DIR/11snap"
AUTOSTART="$HOME/.config/autostart/11snap.desktop"

uninstall() {
  "$BIN" --remove-hotkey 2>/dev/null || true
  pkill -f "$BIN" 2>/dev/null || true
  rm -f "$BIN" "$AUTOSTART"
  echo "Removed 11snap (your layouts in ~/.config/11snap were kept)."
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall

# --- dependency check -------------------------------------------------------
miss=()
command -v wmctrl >/dev/null    || miss+=(wmctrl)
python3 -c "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk" 2>/dev/null \
  || miss+=(gir1.2-gtk-3.0 python3-gi-cairo)
python3 -c "import Xlib" 2>/dev/null || miss+=(python3-xlib)
if [ "${#miss[@]}" -ne 0 ]; then
  echo "Missing dependencies. Install them with:"
  echo "  sudo apt install ${miss[*]}"
  exit 1
fi

# --- install binary ---------------------------------------------------------
mkdir -p "$BIN_DIR"
cp "$SRC" "$BIN"
chmod +x "$BIN"
echo "Installed $BIN"

# --- autostart on login -----------------------------------------------------
mkdir -p "$(dirname "$AUTOSTART")"
cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=11snap
Comment=Windows 11-style snap layouts
Exec=$BIN
Icon=preferences-system-windows
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
echo "Autostart enabled ($AUTOSTART)"

# --- editor hotkey ----------------------------------------------------------
if [ "${1:-}" != "--no-hotkey" ]; then
  "$BIN" --install-hotkey "$BIN --editor" || true
fi

# --- (re)start now ----------------------------------------------------------
pkill -f "$BIN" 2>/dev/null || true
sleep 0.3
setsid "$BIN" >/dev/null 2>&1 < /dev/null &
echo
echo "11snap is running."
echo "  * Drag a window to the top of the screen to snap it."
echo "  * Press Ctrl+Alt+~ to edit layouts (or run: 11snap --editor)."
echo "  * Edit the JSON directly with: 11snap --edit"
echo
echo "If ~/.local/bin isn't on your PATH, use the full path: $BIN"
