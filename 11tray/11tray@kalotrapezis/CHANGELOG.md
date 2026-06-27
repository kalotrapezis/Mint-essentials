# Changelog

## 0.0.2

- **Drawer redesigned as a grid** — icons wrap into rows (configurable *icons per
  row*), left-aligned, inside a rounded box with a **border in the active theme's
  accent colour**.
- **Bigger, easier-to-hit arrow**, with more padding around it.
- **Hidden-by-default** — a fresh install tucks every icon into the drawer; you
  choose what shows on the panel (Ctrl+click an icon, or the right-click switches;
  *off* = shown).
- **Per-app exceptions** loaded from standalone `exceptions/*.exeption` files —
  override an app's icon (themed `Dark-/Light-<base>.png`) and collapse duplicate
  registrations, all without touching the code.
- **Graceful fallback** for apps that report a broken/empty icon (e.g.
  `image-missing`) — a neutral generic icon instead of a broken glyph.
- **Theme-following** arrow, drawer border, and exception icons; the panel icon
  size and the drawer width are settings.
- **Stable identity** — icons are keyed by their declared name, not the shared
  D-Bus sender, and re-evaluated when an app names itself late (e.g. Claude).
- Right-click a drawer icon to use its app menu: it briefly pops onto the panel,
  shows the menu, and slides back when it closes (an Xorg pointer-grab limitation
  keeps the menu from opening while the icon is inside the modal drawer).

## 0.0.1

- Initial release: host XApp status icons, hide the overflow behind an arrow
  drawer, remember the choice per app, and group system icons (update manager,
  Bluetooth, …) together. Replaces the stock XApp status applet.
