# 11snap

Windows 11-style **snap layouts** for Linux Mint (Cinnamon / X11).

Drag a window to the top of the screen and a row of layout templates appears.
Drop the window onto a zone and it snaps there — with a live preview of exactly
where it will land. Layouts are fully editable, including a visual editor.

![dragging a window opens the snap picker](Screenshots/WindowSnap.png)

Unlike the basic edge-snapping Cinnamon already has, 11snap gives you the
*zone picker overlay*: several templates, each split into zones, and a
full-screen preview while you choose.

Once a window is snapped, **Snap Assist** lets you fill the rest of the layout
by clicking the icon of any other open window:

![Snap Assist fills the empty zone](Screenshots/SnapAssist.png)

## How it works

* **Snap:** grab a window's title bar, drag it to the top edge. The picker
  appears; move over a zone (a big highlighted preview shows the target) and
  release to snap.
* **Snap Assist:** after you snap a window, the layout's still-empty zones light
  up, each showing the icons of your other open windows. Click an icon to snap
  that window into the zone; repeat until the layout is full (Esc / click empty
  space to dismiss). Turn it off with `"snap_assist": false`.
* **Edit layouts:** press **Ctrl+Alt+~** for the visual editor, or run
  `11snap --editor`.
  * **Ctrl + drag** in a zone = vertical split · **Shift + drag** = horizontal
  * **left-drag a divider** to resize · **right-click a divider** to remove (merge)
  * pick / **+ New** / **Delete** layouts from the toolbar, name it, **Save**
* **Edit the file directly:** `11snap --edit` opens
  `~/.config/11snap/layouts.json`. Each zone is `[x, y, width, height]` as a
  fraction (0–1) of the usable screen. Changes hot-reload on the next drag.

The snap target is computed from `_NET_WORKAREA`, so it respects your panel.
Modern GTK4/libadwaita apps draw an invisible shadow margin; 11snap measures
each window after snapping and corrects for it, so GTK, Qt, Electron and
native windows all fill their zone exactly.

## Install

### .deb package (recommended)

```bash
./build-deb.sh                              # produces 11snap_<version>_all.deb
sudo apt install ./11snap_0.0.1_all.deb     # installs + autostarts on login
sudo apt remove 11snap                      # uninstall
```

This installs `/usr/bin/11snap`, an autostart entry in `/etc/xdg/autostart`
(so it appears in **Startup Applications** and launches on every login), a menu
launcher for the editor, and pulls in the dependencies automatically. The
editor keybinding is per-user, so bind it once with `11snap --install-hotkey`
(or any shortcut to `11snap --editor`).

### Script (no packaging)

```bash
./install.sh             # ~/.local/bin, autostart, bind Ctrl+Alt+~, start now
./install.sh --no-hotkey # skip the keybinding
./install.sh --uninstall # remove (keeps your layouts)
```

## Uninstall

Use whichever matches how you installed:

```bash
sudo apt remove 11snap   # if installed from the .deb
./install.sh --uninstall # if installed with the script
```

Either way your layouts in `~/.config/11snap/` are left untouched. To remove
those too, and the editor keybinding:

```bash
11snap --remove-hotkey   # only if you bound the Ctrl+Alt+~ shortcut
rm -rf ~/.config/11snap
```

If it's still running in the current session, stop it now with
`pkill -f 11snap`.

## Requirements

* Cinnamon on **X11** (Mint's default; developed on 6.6).
* `wmctrl`, `python3-xlib`, `gir1.2-gtk-3.0`, `python3-gi-cairo`
  (the installer checks and prints the exact `apt` line if any are missing).

## Config

`~/.config/11snap/layouts.json`:

| key            | meaning                                            |
|----------------|----------------------------------------------------|
| `gap`          | pixels of space between/around snapped windows     |
| `trigger_px`   | how close to the top edge a drag opens the picker  |
| `card_height`  | on-screen size of each template thumbnail          |
| `shadow_correct` | compensate GTK4 shadow margins (default `true`)   |
| `snap_assist`  | offer to fill empty zones after a snap (default `true`) |
| `layouts`      | list of `{ "name", "zones": [[x,y,w,h], …] }`      |

The picker, editor and assist colours are read from your GTK (Mint-Y) theme on
every drag, so switching light/dark or changing the accent (orange→purple) is
picked up live — nothing is hardcoded.

## License

[GNU AGPL-3.0](../LICENSE).
