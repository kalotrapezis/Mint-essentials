# Mint-essentials

My own Cinnamon (Linux Mint) applets, built with Claude. Each applet lives in
its own self-contained folder and can be installed independently.

## Applets

### [grun](grun@kalotrapezis/) — keyboard-driven launcher

A panel launcher for apps, calculator, web/AI search, files, clipboard and
power, with layout-independent fuzzy matching. Its UI is a Cinnamon popup, so
there is no separate window and no open-time flicker.

![grun home dashboard](grun@kalotrapezis/screenshot.png)

See the [grun README](grun@kalotrapezis/README.md) and
[changelog](grun@kalotrapezis/CHANGELOG.md).

## Install

Each applet ships an `install.sh`:

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

[GNU AGPL-3.0](LICENSE).
