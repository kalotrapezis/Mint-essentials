# 11tray — Windows 11-style tray overflow for Cinnamon

A system tray that hosts your app status icons and lets you tuck the ones you
don't want to see behind a small arrow — a drawer, like Windows 11. The choice
is per-app and remembered, so the tray stays tidy as you install more apps.

![the tray](Screenshots/tray.png)

11tray **replaces** the stock XApp status applet and renders the icons itself, so
it can split them into a visible strip and a hidden drawer.

## What it does

- **Hide what you don't need.** Send an app's icon into a drawer; the panel stays
  clean. The drawer opens from a small arrow that only appears when something is
  hidden.
- **Per-app, remembered.** Hide/show is keyed to the app, so it survives reloads
  and reboots — and new apps you install start out visible (never auto-hidden).
- **System icons grouped.** Update manager, Bluetooth, system reports and the
  like are detected and kept together, next to the panel's other system
  indicators. Your app icons sit on the other side.
- **Size follows the panel.** Icon size is taken from the settings (defaults to
  match the panel's system icons) and is adjustable.
- **Theme-aware arrow**, reusing grun's pointer assets.

## The drawer

Collapsed, with a couple of icons hidden — note the arrow at the end:

![drawer collapsed](Screenshots/drawer-collapsed.png)

Click the arrow and the hidden icons drop down:

![drawer open](Screenshots/drawer-open.png)

## Hiding and showing icons

Two ways:

- **Ctrl+click** any tray icon to tuck it into the drawer (or pull it back out).
- **Right-click the applet** for a per-icon switch list. Because the icons fill
  the applet, the easy way to get a bare spot to right-click is to turn on
  **Panel edit mode** (right-click the panel → Troubleshoot → Panel edit mode),
  which spaces the applets out. Turn it off when you're done.

![hide/show menu](Screenshots/hide-menu.png)

## Install

```bash
./install.sh          # copy into ~/.local/share/cinnamon/applets/
./install.sh --link   # symlink instead (for development)
./install.sh --zip    # build 11tray@kalotrapezis.zip for the Cinnamon Spices
```

Then right-click the panel → **Applets**, add **11tray**, and **remove the stock
"XApp Status Applet"** so icons don't appear twice. If it doesn't show up, reload
Cinnamon (Alt+F2 → `r` → Enter).

> 11tray currently hosts **XApp status icons** (the modern kind most apps use).
> Legacy XEmbed tray icons are still served by the stock `systray` applet — leave
> that one in place for now.

## Settings

Open the applet's settings (the gear in the Applets list) to set the **tray icon
size**. The hide/show list is in the right-click menu (see above), since it has
to reflect your live icons.

## Status

Working today: hosting and rendering icons, the hide drawer, per-app persistence,
system grouping, and configurable size. **Drag-and-drop** to move icons between
the strip and the drawer is the next planned step — for now use Ctrl+click or the
right-click switches. See [plan.md](plan.md) for the roadmap.

## Requirements

- Cinnamon 6.0+ (developed on 6.6, X11).

## License

[GNU AGPL-3.0](../Mint-runner/LICENSE).
