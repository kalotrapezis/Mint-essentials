# Mint-essentials

My own Cinnamon (Linux Mint) applets, built with Claude. Each applet lives in
its own self-contained folder and can be installed independently.

## Applets

### [grun](Mint-runner/) — keyboard-driven launcher

A panel launcher for apps, calculator, web/AI search, files, clipboard and
power, with layout-independent fuzzy matching. Its UI is a Cinnamon popup, so
there is no separate window and no open-time flicker.

![grun home dashboard](Mint-runner/grun@kalotrapezis/screenshot.png)

See the [grun README](Mint-runner/README.md).

### [11tray](11tray/) — Windows 11-style tray overflow

A system tray that tucks the app status icons you don't want behind a small
arrow, in a drawer. Everything starts hidden and you pick what shows; the choice
is per-app and remembered, so the tray stays tidy as you install more apps.
System icons (update manager, Bluetooth…) are grouped together automatically.

![11tray with the drawer open](11tray/Screenshots/tray-open.png)

See the [11tray README](11tray/README.md).

## Install

Each applet ships an `install.sh` in its folder:

```bash
./install.sh          # copy into ~/.local/share/cinnamon/applets/
./install.sh --link   # symlink instead (for development)
./install.sh --zip    # build a .zip for the Cinnamon Spices
```

Then right-click the panel → **Applets**, select the applet, and add it. If it
doesn't appear, reload Cinnamon (Alt+F2 → `r` → Enter).

## Requirements

- Cinnamon 6.0+ (developed on 6.6, X11).

## License

[GNU AGPL-3.0](Mint-runner/LICENSE).
