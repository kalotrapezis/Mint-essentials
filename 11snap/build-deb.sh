#!/usr/bin/env bash
# Build a .deb that installs 11snap system-wide and autostarts it on login.
#
#   ./build-deb.sh          builds 11snap_<version>_all.deb in this folder
#
# Install the result with:  sudo apt install ./11snap_<version>_all.deb
set -euo pipefail

VERSION="0.0.1"
PKG="11snap"
ARCH="all"
MAINT="Theologos Kalotrapezis <kalotrapezis@gmail.com>"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/${PKG}_${VERSION}_${ARCH}.deb"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- file layout ------------------------------------------------------------
install -Dm755 "$HERE/11snap.py"        "$STAGE/usr/bin/11snap"
install -d                              "$STAGE/etc/xdg/autostart"
install -d                              "$STAGE/usr/share/applications"
install -d                              "$STAGE/usr/share/doc/$PKG"

# autostart on login (all users) — this is the "startup programs" entry
cat > "$STAGE/etc/xdg/autostart/11snap.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=11snap
Comment=Windows 11-style snap layouts
Exec=/usr/bin/11snap
Icon=preferences-system-windows
X-GNOME-Autostart-enabled=true
OnlyShowIn=X-Cinnamon;GNOME;XFCE;MATE;
NoDisplay=true
EOF

# menu launcher for the layout editor
cat > "$STAGE/usr/share/applications/11snap-editor.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=11snap Layout Editor
Comment=Edit your 11snap snap layouts
Exec=/usr/bin/11snap --editor
Icon=preferences-system-windows
Categories=Settings;Utility;
Keywords=snap;layout;tiling;window;
EOF

# docs
cp "$HERE/README.md"    "$STAGE/usr/share/doc/$PKG/README.md"
cp "$HERE/CHANGELOG.md" "$STAGE/usr/share/doc/$PKG/CHANGELOG.md" 2>/dev/null || true

cat > "$STAGE/usr/share/doc/$PKG/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: 11snap

Files: *
Copyright: 2026 Theologos Kalotrapezis
License: AGPL-3.0+
 This program is free software: you can redistribute it and/or modify it under
 the terms of the GNU Affero General Public License as published by the Free
 Software Foundation, either version 3 of the License, or (at your option) any
 later version. On Debian systems the full text is in
 /usr/share/common-licenses/AGPL-3.
EOF

printf '%s (%s) unstable; urgency=low\n\n  * Release %s.\n\n -- %s  %s\n' \
  "$PKG" "$VERSION" "$VERSION" "$MAINT" "$(date -R)" \
  | gzip -9n > "$STAGE/usr/share/doc/$PKG/changelog.Debian.gz"

# --- control + maintainer scripts ------------------------------------------
install -d "$STAGE/DEBIAN"
INSTALLED_KB=$(( $(du -sk "$STAGE/usr" "$STAGE/etc" | awk '{s+=$1} END {print s}') ))
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Section: x11
Priority: optional
Architecture: $ARCH
Depends: python3, python3-gi, python3-gi-cairo, gir1.2-gtk-3.0, python3-xlib, wmctrl
Installed-Size: $INSTALLED_KB
Maintainer: $MAINT
Homepage: https://github.com/kalotrapezis/Mint-essentials
Description: Windows 11-style snap layouts for Cinnamon/X11
 Drag a window to the top of the screen and a picker of layout templates
 appears; drop it on a zone and the window snaps there, with a live preview
 and optional Snap Assist to fill the remaining zones from your open windows.
 Includes a visual layout editor. Runs as a small background app and starts
 automatically on login.
EOF

# start the daemon for the installing user(s) after install; tidy up on remove
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
    # launch now for the user running the graphical session (best effort)
    for uid in $(loginctl list-users --no-legend 2>/dev/null | awk '{print $1}'); do
        u=$(id -nu "$uid" 2>/dev/null) || continue
        if pgrep -u "$uid" cinnamon >/dev/null 2>&1 || \
           pgrep -u "$uid" -x cinnamon-session >/dev/null 2>&1; then
            su - "$u" -c 'DISPLAY=:0 setsid /usr/bin/11snap >/dev/null 2>&1 < /dev/null &' \
                >/dev/null 2>&1 || true
        fi
    done
fi
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

cat > "$STAGE/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
pkill -f /usr/bin/11snap 2>/dev/null || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/prerm"

# --- build ------------------------------------------------------------------
chmod 755 "$STAGE"  # mktemp -d defaults to 0700; package root should be 0755
find "$STAGE/usr/share" "$STAGE/etc" -type f -exec chmod 644 {} +
fakeroot dpkg-deb --build "$STAGE" "$OUT" >/dev/null
echo "Built $OUT"
dpkg-deb --info "$OUT" | sed -n '1,20p'
echo
echo "Install with:  sudo apt install $OUT"
echo "Remove with:   sudo apt remove $PKG"
