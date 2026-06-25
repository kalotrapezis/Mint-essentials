# 11tray — Windows 11-style tray overflow for Cinnamon

A panel applet that gives you a Windows 11-style tray: a small `^` arrow that
reveals a box of **hidden** status icons. You drag an app's icon into the box to
tuck it away, and drag it back out to show it on the panel again. The applet
**replaces** the stock tray applets and becomes the single tray host.

## Goal

Keep the system tray from getting cluttered as apps accumulate over time —
**without** touching the icons you actually want visible, and without a tedious
settings page of checkboxes.

- Default for every icon is **shown**. Nothing is auto-hidden, ever.
- You decide what to hide, by dragging it behind the arrow.
- The arrow only appears when at least one icon is hidden (like Windows 11).
- The hide/show choice is **remembered per app** across reboots.

## Scope (and non-goals)

In scope:

- Host status icons and split them into a visible strip + a hidden overflow box.
- Per-icon "hidden" state, persisted, keyed to a stable icon identity.
- Drag-and-drop between the strip and the box to toggle hidden/shown.

Explicitly **not** doing:

- Not auto-classifying icons as "system vs app" and force-hiding anything. The
  user mentioned only wanting to manage installed-app icons — we honour that by
  making hiding **opt-in per icon**, so system icons (network, sound, battery,
  input method, update manager…) simply stay shown unless the user drags one in.
  No allow/deny heuristics to get wrong.
- Not reordering the whole panel or dropping icons onto arbitrary panel zones —
  Cinnamon applets live in fixed zones, so the "taskbar" here is this applet's
  own inline strip.
- Phase 1 does not handle legacy XEmbed icons (see Phases).

## Interaction model

```
panel:   … [ visible app icons ] [ ^ ]        ← arrow shown only if box non-empty
                                   │ click
                                   ▼
                            ┌──────────────┐
                            │  ▦  ▦  ▦  ▦  │   ← hidden icons (popup box)
                            └──────────────┘

drag a strip icon  → into the box   = hide it      (remember as hidden)
drag a box icon    → onto the strip = show it       (remember as shown)
```

- The box is a Cinnamon `PopupMenu` anchored under the arrow (same popup
  machinery grun already uses — no separate top-level window, no flicker).
- Left-click an icon (strip or box) still does its normal activate/menu action;
  drag is distinguished from click by a small movement threshold.

## Cinnamon technical background

Cinnamon exposes **two** independent tray-icon systems. They must be handled
separately, and only one host may own each at a time.

1. **XApp status icons** — modern apps expose these over D-Bus
   (`org.x.StatusIcon`). We act as a monitor (`XApp.StatusIconMonitor`),
   receive `icon-added` / `icon-removed` with `XApp.StatusIcon` proxies, and
   **render them ourselves** as St buttons. Because we control rendering,
   placing an icon in the strip vs. the box is just a flag. **This is Phase 1.**

2. **Legacy XEmbed icons** — real X windows embedded via
   `Cinnamon.TrayManager`, which claims the `_NET_SYSTEM_TRAY_S0` selection.
   Only one host can own that selection, and reparenting the embedded actor
   between strip and box is fiddly. **Phase 2.**

> Consequence: 11tray must be the *sole* tray host. Installation removes the
> stock `xapp-status@cinnamon.org` (and later `systray@cinnamon.org`) from the
> panel and adds 11tray in their place, or duplicate icons / selection fights
> result.

## P0 findings — verified against Cinnamon 6.6.7 (X11)

Read from the stock `xapp-status@cinnamon.org` and `systray@cinnamon.org`
applets. These are now confirmed, not assumed.

**XApp icons (Phase 1) — all confirmed:**

- Monitor: `new XApp.StatusIconMonitor()`, signals `icon-added` /
  `icon-removed`, each handing back an `icon_proxy`.
- Proxy API in use: `get_name()`, `get_object_path()`, and properties
  `icon_name`, `label`, `tooltip_text`, `visible`, settable `icon_size`,
  `primary_menu_is_open` / `secondary_menu_is_open`. Property changes arrive via
  the proxy's `g-properties-changed` signal (prop names `IconName`,
  `TooltipText`, `Label`, `Visible`, `Name`…).
- **We render the icon ourselves** (St.Icon, or `St.TextureCache` for file-path
  icons). Placement in strip vs box is entirely ours — exactly the freedom we need.
- **Clicks must be forwarded manually:** the stock applet computes a screen
  position and calls `proxy.call_button_press(x,y,button,time,orientation,…)` and
  `call_button_release(...)` on `button-press/release-event`; scroll via
  `call_scroll(...)`. Our DND layer must let genuine clicks through to these and
  only swallow movements past the drag threshold. Reuse the stock
  `getEventPositionInfo()` math verbatim.

**Scope is even cleaner than expected:** both stock applets already *skip* any
icon whose role has a dedicated native applet, via
`Main.systrayManager.getRoles()` (`shouldIgnoreStatusIcon`). So core system
indicators (network, sound, power, input method…) mostly arrive through their own
applets and never show here — meaning the XApp icon stream is *already*
predominantly third-party **app** icons. 11tray should replicate the same
`getRoles()` skip so it never grabs an icon that has a native applet.

**Legacy XEmbed (Phase 6) — confirmed via `systray@`:**

- Host is `Main.statusIconDispatcher`; must be `.start(panelActor)`-ed (only one
  host). Signals: `status-icon-added` (gives `icon` actor **and a `role`
  string**), `status-icon-removed`, and `before-redisplay`.
- `before-redisplay` **clears and rebuilds all icons**, so placement is decided
  fresh on every redisplay — same per-icon-placement model as XApp, convenient.
- The `role` (≈ WM_CLASS) is the stable identity key for XEmbed icons.
- **Risk:** XEmbed icons are live embedded X windows. Parking a hidden one inside
  a *closed* popup may leave its X window unmapped / not rendering until the popup
  opens. May force "hidden XEmbed = parked offscreen but mapped" rather than
  inside the popup actor. Validate before committing to the box-holds-XEmbed model.

## Architecture

```
11tray@kalotrapezis/
  applet.js          # the applet: panel actor, strip, arrow, popup box
  iconStore.js       # XApp monitor wrapper → list of live icons + identity keys
  dnd.js             # drag/drop wiring between strip and box
  state.js           # load/save hidden-set, keyed by icon identity
  metadata.json
  settings-schema.json
  stylesheet.css
  icon.png
  install.sh
```

Components:

- **iconStore** — subscribes to `XApp.StatusIconMonitor`; maintains a live list
  of icons, each with a **stable identity key** (see below). Emits change events.
- **applet** — owns two St containers: the panel **strip** and the popup **box**.
  On each icon-list change, places each icon in strip or box per the hidden-set,
  and shows/hides the arrow based on whether the box is empty.
- **dnd** — makes each icon button draggable; strip and box are drop targets;
  a drop flips the icon's hidden flag and persists it.
- **state** — the hidden-set, persisted in settings.

## Icon identity (the crux of "remember per app")

We must re-recognise an app's icon after a reboot to restore its hidden state.
Two distinct keys, now informed by P0:

- **Runtime key** (live, this session only): the stock applet uses
  `get_name() + get_object_path()`. The object path is *not* stable across
  restarts, so it is fine for the live dictionary but must **not** be persisted.
- **Persistent key** (saved hidden-set): use `get_name()` only, with the
  `org.x.StatusIcon.` prefix stripped (the stock sort already strips it). This is
  the app-stable identity. Fallback to `icon_name` if `name` is empty.

Persist the **set of persistent keys that are hidden**. Unknown/new icons aren't
in the set → shown by default → no surprise hiding when you install something new.
Open question still worth an empirical check: how constant `get_name()` stays
across app versions (test Nextcloud, Telegram, Discord, etc.). For XEmbed
(Phase 6) the persistent key is the `role` string.

## Persistence

`settings-schema.json` holds one key:

- `hidden-icons` — a `generic` key storing a JSON array of identity keys.

Read/written via `imports.ui.settings.AppletSettings`. No settings UI page is
required for the core flow (dragging is the UI). A simple read-only list could be
added later for users who prefer it, but it is **not** the primary surface.

## Drag-and-drop design

- Use `imports.ui.dnd` `makeDraggable` on each icon button.
- Each icon's `_delegate` carries its identity key + current bucket.
- Strip and box implement `handleDragOver` / `acceptDrop`; on accept, set the
  icon's hidden flag to match the target bucket, persist, and re-place.
- Movement threshold separates a drag from a plain click so normal icon
  activation still works.
- Polish items: drag preview actor, insertion indicator, snap-back on invalid
  drop. These are the most time-consuming pieces.

## Phases / milestones

- **P0 — Verify APIs. ✅ DONE** (Cinnamon 6.6.7). See "P0 findings" above.
- **P1 — Render XApp icons. ✅ DONE.** Applet hosts and draws all XApp status
  icons, forwards clicks/scroll, replicates the `getRoles()` skip. Replaces
  xapp-status applet.
- **P2 — Strip + box + arrow. ✅ DONE.** Live split driven by the hidden-set;
  grun's pointer assets used for the arrow (theme-aware); arrow auto-hides when
  the drawer is empty.
- **P3 — Persistence. ✅ DONE.** Hidden-set saved to settings (`hidden-icons`),
  keyed by `get_name()`; survives reload/reboot.
- **P4 — Drag-and-drop. ⏳ NEXT.** Replace the interim **Ctrl+click** toggle with
  real drag between strip and drawer. This is the headline feature and the
  hardest part (click-vs-drag threshold, drop targets, previews).
- **P5 — Polish.** Drag previews, animations, theming (accent-aware like grun),
  empty-state, edge cases (icon removed while hidden, duplicate keys).
- **P6 — Legacy XEmbed (optional).** Add `Cinnamon.TrayManager` host and bring
  XEmbed icons into the same strip/box model. Hardest part: reparenting.

## Risks / open questions

- **Identity stability** — does XApp `name` stay constant across app updates? If
  not, hidden state could "forget." Needs empirical check (P0/P3).
- **Selection ownership** — taking over the tray cleanly without races against
  the stock applets; install script must remove them.
- **XEmbed reparenting** — may constrain how freely XEmbed icons move between
  strip and box; could end up "hide = move to box, but limited animation."
- **DND ergonomics** — getting click-vs-drag and drop targets to feel native.

## Reuse from grun

Popup/St/PopupMenu patterns, `AppletSettings` usage, accent-aware theming, and
the install.sh structure all transfer directly from `grun@kalotrapezis`.
