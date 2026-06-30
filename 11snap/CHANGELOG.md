# Changelog

## 0.0.1

First release.

* Drag-to-top snap picker with a row of layout templates and a full-screen
  live preview of the snap target.
* Pixel-accurate snapping for server-side, Qt and Electron windows; automatic
  shadow compensation so GTK4/libadwaita windows fill their zone too.
* Visual layout editor (`--editor`, bound to Ctrl+Alt+~): split zones
  (Ctrl/Shift), drag dividers to resize, right-click to merge, manage and save
  named layouts.
* Snap Assist: after a snap, the layout's empty zones show the icons of your
  other open windows; click one to snap it into that zone, repeat until full.
* Editable `~/.config/11snap/layouts.json` with hot-reload on each drag.
* Whole palette (accent + light/dark) derived from the live GTK/Mint-Y theme,
  re-read on every drag — nothing hardcoded.
* `install.sh` with autostart and keybinding setup.
