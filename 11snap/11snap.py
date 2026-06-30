#!/usr/bin/env python3
"""11snap - Windows 11-style snap layouts for Cinnamon / X11.

Drag a window to the top of the screen and a picker of layout templates
appears; drop the window onto a zone and it snaps there. Layouts are fully
editable in ~/.config/11snap/layouts.json and hot-reload on every drag.

Architecture (X11 / Muffin):
  * Pointer + button state is polled with python-xlib (works during the WM's
    move grab, where GTK motion events never arrive).
  * A drag is recognised when button 1 is held and the active window actually
    moves. The picker is shown while the pointer sits in the top trigger band.
  * Snapping uses wmctrl -e with work-area coordinates. On Muffin this lands
    pixel-perfect for both server-side and client-side (GTK shadow) windows,
    so no frame-extent math is needed.
"""

import json
import os
import shutil
import subprocess
import sys

import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gdk, GLib, GdkPixbuf  # noqa: E402
import cairo  # noqa: E402

from Xlib import X, display  # noqa: E402


DEBUG = os.environ.get("SNAP_DEBUG") == "1"


def dbg(*a):
    if DEBUG:
        sys.stderr.write("[11snap] " + " ".join(str(x) for x in a) + "\n")
        sys.stderr.flush()


CONFIG_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "11snap"
)
CONFIG_PATH = os.path.join(CONFIG_DIR, "layouts.json")

DEFAULT_CONFIG = {
    "gap": 8,            # pixels of breathing room between/around snapped windows
    "trigger_px": 14,    # how close to the top edge a drag must get to open the picker
    "card_height": 150,  # on-screen height of each template thumbnail
    "card_gap": 20,      # spacing between thumbnails
    "top_margin": 24,    # gap between the work-area top and the picker row
    "snap_assist": True,  # after snapping, offer to fill the empty zones
    "layouts": [
        {"name": "Halves",
         "zones": [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]},
        {"name": "Thirds",
         "zones": [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]]},
        {"name": "Wide + side",
         "zones": [[0, 0, 0.7, 1], [0.7, 0, 0.3, 1]]},
        {"name": "Quarters",
         "zones": [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5],
                   [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]]},
        {"name": "Main + stack",
         "zones": [[0, 0, 0.6, 1], [0.6, 0, 0.4, 0.5], [0.6, 0.5, 0.4, 0.5]]},
    ],
}

# Palette. All of these are derived from the live GTK (Mint-Y) theme by
# apply_theme(); the values below are only fallbacks if the lookup fails.
ACCENT = (0.20, 0.47, 0.96)        # zone highlight / selection
PANEL_BG = (0.12, 0.12, 0.14, 0.94)
CARD_BG = (1, 1, 1, 0.10)
ZONE_BG = (1, 1, 1, 0.16)
ZONE_BORDER = (1, 1, 1, 0.30)
TEXT_COLOR = (0.92, 0.92, 0.92)
CANVAS_BG = (0.10, 0.10, 0.12)


def apply_theme():
    """Derive the whole palette from the current GTK theme (accent + light/dark).

    Cheap enough to call on every drag so theme changes take effect live."""
    global ACCENT, PANEL_BG, CARD_BG, ZONE_BG, ZONE_BORDER, TEXT_COLOR, CANVAS_BG

    def look(ctx, name, fb):
        ok, c = ctx.lookup_color(name)
        return (c.red, c.green, c.blue, c.alpha) if ok else fb

    try:
        w = Gtk.Window()
        ctx = w.get_style_context()
        acc = look(ctx, "theme_selected_bg_color", (0.20, 0.47, 0.96, 1))
        bg = look(ctx, "theme_bg_color", (0.13, 0.13, 0.15, 1))
        fg = look(ctx, "theme_fg_color", (0.92, 0.92, 0.92, 1))
        base = look(ctx, "theme_base_color", bg)
        w.destroy()
    except Exception:
        return
    ACCENT = acc[:3]
    TEXT_COLOR = fg[:3]
    PANEL_BG = (bg[0], bg[1], bg[2], 0.95)
    CANVAS_BG = base[:3]
    # tint cards/zones with whichever of black/white contrasts with the panel
    lum = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]
    t = (1, 1, 1) if lum < 0.5 else (0, 0, 0)
    CARD_BG = (t[0], t[1], t[2], 0.10)
    ZONE_BG = (t[0], t[1], t[2], 0.16)
    ZONE_BORDER = (t[0], t[1], t[2], 0.32)


def load_config():
    """Read the user config, falling back to (and seeding) the defaults."""
    if not os.path.exists(CONFIG_PATH):
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        return dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH) as f:
            user = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        sys.stderr.write(f"11snap: bad config ({e}); using defaults\n")
        return dict(DEFAULT_CONFIG)
    cfg = dict(DEFAULT_CONFIG)
    cfg.update(user)
    if not cfg.get("layouts"):
        cfg["layouts"] = DEFAULT_CONFIG["layouts"]
    return cfg


def rounded_rect(cr, x, y, w, h, r):
    r = min(r, w / 2, h / 2)
    cr.new_sub_path()
    cr.arc(x + w - r, y + r, r, -1.5708, 0)
    cr.arc(x + w - r, y + h - r, r, 0, 1.5708)
    cr.arc(x + r, y + h - r, r, 1.5708, 3.1416)
    cr.arc(x + r, y + r, r, 3.1416, 4.7124)
    cr.close_path()


class SnapOverlay(Gtk.Window):
    """Full-screen, click-through, always-on-top picker drawn with Cairo."""

    def __init__(self, screen_w, screen_h):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.screen_w = screen_w
        self.screen_h = screen_h
        self.cards = []          # list of dicts: {name, rect, zones:[{screen,target}]}
        self.hover = None        # (card_index, zone_index) or None
        self.hover_target = None  # target work-rect under the pointer, for the preview

        self.set_app_paintable(True)
        self.set_decorated(False)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_accept_focus(False)
        self.set_keep_above(True)
        self.set_type_hint(Gdk.WindowTypeHint.DOCK)
        self.set_default_size(screen_w, screen_h)
        self.move(0, 0)

        scr = self.get_screen()
        visual = scr.get_rgba_visual()
        if visual is not None:
            self.set_visual(visual)
        self.connect("draw", self._on_draw)
        self.connect("realize", self._on_realize)

    def _on_realize(self, _w):
        # Empty input region => fully click-through; the WM keeps its drag grab.
        gdkwin = self.get_window()
        region = cairo.Region()
        gdkwin.input_shape_combine_region(region, 0, 0)

    def _on_draw(self, _w, cr):
        cr.set_operator(cairo.Operator.SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.Operator.OVER)
        if not self.cards:
            return False

        # 1) Full-screen preview of exactly where the window will land.
        if self.hover_target is not None:
            tx, ty, tw, th = self.hover_target
            rounded_rect(cr, tx, ty, tw, th, 10)
            cr.set_source_rgba(*ACCENT, 0.28)
            cr.fill_preserve()
            cr.set_source_rgba(*ACCENT, 0.95)
            cr.set_line_width(3)
            cr.stroke()

        # 2) The picker panel (drawn on top so it stays readable over the preview).
        xs = [c["rect"][0] for c in self.cards]
        ys = [c["rect"][1] for c in self.cards]
        xe = [c["rect"][0] + c["rect"][2] for c in self.cards]
        ye = [c["rect"][1] + c["rect"][3] for c in self.cards]
        pad = 18
        label_h = 22
        px, py = min(xs) - pad, min(ys) - pad
        pw = max(xe) - px + pad
        ph = max(ye) - py + pad + label_h
        rounded_rect(cr, px, py, pw, ph, 16)
        cr.set_source_rgba(*PANEL_BG)
        cr.fill()

        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_NORMAL)
        for ci, card in enumerate(self.cards):
            cx, cy, cw, ch = card["rect"]
            rounded_rect(cr, cx, cy, cw, ch, 8)
            cr.set_source_rgba(*CARD_BG)
            cr.fill()
            for zi, zone in enumerate(card["zones"]):
                zx, zy, zw, zh = zone["screen"]
                rounded_rect(cr, zx, zy, zw, zh, 4)
                if self.hover == (ci, zi):
                    cr.set_source_rgba(*ACCENT, 0.9)
                    cr.fill_preserve()
                    cr.set_source_rgba(1, 1, 1, 0.9)
                    cr.set_line_width(1.5)
                    cr.stroke()
                else:
                    cr.set_source_rgba(*ZONE_BG)
                    cr.fill_preserve()
                    cr.set_source_rgba(*ZONE_BORDER)
                    cr.set_line_width(1)
                    cr.stroke()
            # label under the card
            name = card.get("name", "")
            if name:
                cr.set_font_size(13)
                ext = cr.text_extents(name)
                tx = cx + (cw - ext.width) / 2 - ext.x_bearing
                ty = cy + ch + 16
                cr.set_source_rgba(*TEXT_COLOR, 0.9)
                cr.move_to(tx, ty)
                cr.show_text(name)
        return False

    def build(self, work, cfg):
        """Compute card + zone screen rectangles and their target work rects."""
        wx, wy, ww, wh = work
        layouts = cfg["layouts"]
        ch = cfg["card_height"]
        cw = ch * (ww / wh)
        cgap = cfg["card_gap"]
        n = len(layouts)
        total = n * cw + (n - 1) * cgap
        start_x = (self.screen_w - total) / 2
        top = wy + cfg["top_margin"]
        gap = cfg["gap"]

        self.cards = []
        for i, layout in enumerate(layouts):
            cx = start_x + i * (cw + cgap)
            zones = []
            for fx, fy, fw, fh in layout["zones"]:
                # thumbnail rect (with a hairline inset so zones read as separate)
                zones.append({
                    "screen": (cx + fx * cw + 1, top + fy * ch + 1,
                               fw * cw - 2, fh * ch - 2),
                    "target": (
                        int(round(wx + fx * ww + gap / 2)),
                        int(round(wy + fy * wh + gap / 2)),
                        int(round(fw * ww - gap)),
                        int(round(fh * wh - gap)),
                    ),
                })
            self.cards.append({
                "name": layout.get("name", ""),
                "rect": (cx, top, cw, ch),
                "zones": zones,
            })

    def zone_at(self, px, py):
        """Return the target work-rect under the pointer, or None."""
        for ci, card in enumerate(self.cards):
            for zi, zone in enumerate(card["zones"]):
                zx, zy, zw, zh = zone["screen"]
                if zx <= px <= zx + zw and zy <= py <= zy + zh:
                    return (ci, zi), zone["target"]
        return None, None

    def set_hover(self, hover, target=None):
        if hover != self.hover:
            self.hover = hover
            self.hover_target = target
            self.queue_draw()


class LayoutEditor(Gtk.Window):
    """Full-screen visual editor for the snap layouts.

    Interaction:
      * Hover a zone; Ctrl + move shows a vertical split guide, Shift + move a
        horizontal one. Left-click pins the split (cuts only the hovered zone).
      * Left-drag an existing divider to resize.
      * Right-click a divider to remove it (merges the two zones back).
      * Pick / add / delete layouts from the toolbar; name it and Save.
    """

    EPS = 0.006        # tolerance for "same edge" in fraction space
    MIN = 0.05         # smallest allowed zone dimension
    SNAP = 0.05        # grid the guides snap to
    EDGE_PX = 7        # px proximity to grab/remove a divider

    def __init__(self, work, cfg):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.work = work
        self.cfg = cfg
        self.layouts = [dict(name=l.get("name", "Layout"),
                             zones=[list(z) for z in l["zones"]])
                        for l in cfg["layouts"]] or [
            dict(name="New", zones=[[0, 0, 1, 1]])]
        self.index = 0
        self.zones = [list(z) for z in self.layouts[0]["zones"]]
        self.canvas_rect = (0, 0, 1, 1)
        self.cursor = None
        self.state = 0
        self.drag = None       # ('v'|'h', edge_value) while dragging a divider

        self.set_title("11snap — layout editor")
        self.set_default_size(1000, 700)
        self.connect("destroy", lambda *_: Gtk.main_quit())

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(box)
        box.pack_start(self._build_toolbar(), False, False, 0)

        self.canvas = Gtk.DrawingArea()
        self.canvas.add_events(
            Gdk.EventMask.POINTER_MOTION_MASK
            | Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        self.canvas.connect("draw", self._on_draw)
        self.canvas.connect("motion-notify-event", self._on_motion)
        self.canvas.connect("button-press-event", self._on_press)
        self.canvas.connect("button-release-event", self._on_release)
        self.canvas.connect("leave-notify-event", self._on_leave)
        box.pack_start(self.canvas, True, True, 0)

        self.connect("key-press-event", self._on_key)
        self._refresh_combo()

    # --- toolbar ---------------------------------------------------------
    def _build_toolbar(self):
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        bar.set_margin_top(6)
        bar.set_margin_bottom(6)
        bar.set_margin_start(8)
        bar.set_margin_end(8)

        self.combo = Gtk.ComboBoxText()
        self.combo.connect("changed", self._on_pick)
        bar.pack_start(self.combo, False, False, 0)

        new = Gtk.Button(label="+ New")
        new.connect("clicked", self._on_new)
        bar.pack_start(new, False, False, 0)

        self.name_entry = Gtk.Entry()
        self.name_entry.set_placeholder_text("layout name")
        bar.pack_start(self.name_entry, False, False, 0)

        save = Gtk.Button(label="Save")
        save.connect("clicked", lambda *_: self._save())
        bar.pack_start(save, False, False, 0)

        delete = Gtk.Button(label="Delete")
        delete.connect("clicked", self._on_delete)
        bar.pack_start(delete, False, False, 0)

        reset = Gtk.Button(label="Clear")
        reset.connect("clicked", self._on_clear)
        bar.pack_start(reset, False, False, 0)

        reset_def = Gtk.Button(label="Reset to defaults")
        reset_def.set_tooltip_text("Restore the original 5 layouts")
        reset_def.connect("clicked", self._on_reset_defaults)
        bar.pack_start(reset_def, False, False, 12)

        self.assist_chk = Gtk.CheckButton(label="Snap Assist")
        self.assist_chk.set_tooltip_text(
            "After snapping, offer to fill the empty zones with your open windows")
        self.assist_chk.set_active(bool(self.cfg.get("snap_assist", True)))
        self.assist_chk.connect("toggled", self._on_assist_toggle)
        bar.pack_start(self.assist_chk, False, False, 6)

        help_lbl = Gtk.Label()
        help_lbl.set_markup(
            "<small>Ctrl+drag = vertical split · Shift+drag = horizontal · "
            "left-drag a line to resize · right-click a line to remove · "
            "Esc to close</small>")
        help_lbl.set_xalign(1.0)
        bar.pack_end(help_lbl, True, True, 0)
        return bar

    def _refresh_combo(self):
        self.combo.handler_block_by_func(self._on_pick)
        self.combo.remove_all()
        for l in self.layouts:
            self.combo.append_text(l["name"])
        self.combo.set_active(self.index)
        self.combo.handler_unblock_by_func(self._on_pick)
        self.name_entry.set_text(self.layouts[self.index]["name"])

    # --- toolbar callbacks ----------------------------------------------
    def _commit_working(self):
        """Push the working zones back into the current layout entry."""
        self.layouts[self.index]["zones"] = [list(z) for z in self.zones]

    def _on_pick(self, combo):
        i = combo.get_active()
        if i < 0 or i == self.index:
            return
        self._commit_working()
        self.index = i
        self.zones = [list(z) for z in self.layouts[i]["zones"]]
        self.name_entry.set_text(self.layouts[i]["name"])
        self.canvas.queue_draw()

    def _on_new(self, _b):
        self._commit_working()
        at = self.index + 1
        self.layouts.insert(at, dict(name="New %d" % (len(self.layouts) + 1),
                                     zones=[[0, 0, 1, 1]]))
        self.index = at
        self.zones = [[0, 0, 1, 1]]
        self._refresh_combo()
        self.canvas.queue_draw()

    def _on_delete(self, _b):
        if len(self.layouts) <= 1:
            return
        del self.layouts[self.index]
        self.index = max(0, self.index - 1)
        self.zones = [list(z) for z in self.layouts[self.index]["zones"]]
        self._refresh_combo()
        self.canvas.queue_draw()

    def _on_clear(self, _b):
        self.zones = [[0, 0, 1, 1]]
        self.canvas.queue_draw()

    def _on_reset_defaults(self, _b):
        dlg = Gtk.MessageDialog(
            transient_for=self, modal=True,
            message_type=Gtk.MessageType.WARNING,
            buttons=Gtk.ButtonsType.OK_CANCEL,
            text="Reset all layouts to the originals?")
        dlg.format_secondary_text(
            "Your custom layouts will be replaced by the 5 default layouts. "
            "This can't be undone.")
        resp = dlg.run()
        dlg.destroy()
        if resp != Gtk.ResponseType.OK:
            return
        self.layouts = [dict(name=lay["name"],
                             zones=[list(z) for z in lay["zones"]])
                        for lay in DEFAULT_CONFIG["layouts"]]
        self.index = 0
        self.zones = [list(z) for z in self.layouts[0]["zones"]]
        self.cfg["layouts"] = [
            dict(name=lay["name"],
                 zones=[[round(v, 4) for v in z] for z in lay["zones"]])
            for lay in self.layouts]
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w") as f:
            json.dump(self.cfg, f, indent=2)
        self._refresh_combo()
        self.canvas.queue_draw()
        self._flash("Reset to defaults")

    def _on_assist_toggle(self, btn):
        # persist just this flag, without touching unsaved layout edits on disk
        self.cfg["snap_assist"] = btn.get_active()
        try:
            disk = json.load(open(CONFIG_PATH))
        except Exception:
            disk = dict(self.cfg)
        disk["snap_assist"] = btn.get_active()
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w") as f:
            json.dump(disk, f, indent=2)
        self._flash("Snap Assist " + ("on" if btn.get_active() else "off"))

    def _save(self):
        name = self.name_entry.get_text().strip() or "Layout"
        self.layouts[self.index]["name"] = name
        self._commit_working()
        self.cfg["layouts"] = [
            dict(name=l["name"],
                 zones=[[round(v, 4) for v in z] for z in l["zones"]])
            for l in self.layouts]
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w") as f:
            json.dump(self.cfg, f, indent=2)
        self._refresh_combo()
        self._flash("Saved ✓")

    def _flash(self, msg):
        self.set_title("11snap — layout editor   (%s)" % msg)
        GLib.timeout_add(1500, lambda: self.set_title("11snap — layout editor"))

    def _on_key(self, _w, ev):
        if ev.keyval == Gdk.KEY_Escape:
            self.destroy()
        elif ev.keyval in (Gdk.KEY_s, Gdk.KEY_S) and \
                ev.state & Gdk.ModifierType.CONTROL_MASK:
            self._save()
        return False

    # --- geometry mapping ------------------------------------------------
    def _compute_canvas(self):
        a = self.canvas.get_allocation()
        margin = 24
        aw, ah = a.width - 2 * margin, a.height - 2 * margin
        ratio = self.work[2] / self.work[3]
        if aw / ah > ratio:
            ch = ah
            cw = ch * ratio
        else:
            cw = aw
            ch = cw / ratio
        cx = margin + (aw - cw) / 2
        cy = margin + (ah - ch) / 2
        self.canvas_rect = (cx, cy, cw, ch)

    def _f2s(self, fx, fy, fw, fh):
        cx, cy, cw, ch = self.canvas_rect
        return (cx + fx * cw, cy + fy * ch, fw * cw, fh * ch)

    def _s2f(self, px, py):
        cx, cy, cw, ch = self.canvas_rect
        return ((px - cx) / cw, (py - cy) / ch)

    def _zone_at(self, fx, fy):
        for i, (zx, zy, zw, zh) in enumerate(self.zones):
            if zx <= fx <= zx + zw and zy <= fy <= zy + zh:
                return i
        return None

    def _snap_frac(self, v, others=()):
        for o in others:
            if abs(v - o) < 0.025:
                return o
        return round(v / self.SNAP) * self.SNAP

    # --- drawing ---------------------------------------------------------
    def _on_draw(self, _w, cr):
        self._compute_canvas()
        a = self.canvas.get_allocation()
        cr.set_source_rgba(*CANVAS_BG, 1)
        cr.rectangle(0, 0, a.width, a.height)
        cr.fill()

        hov = None
        if self.cursor and not self.drag:
            fx, fy = self._s2f(*self.cursor)
            hov = self._zone_at(fx, fy)

        for i, z in enumerate(self.zones):
            sx, sy, sw, sh = self._f2s(*z)
            rounded_rect(cr, sx + 3, sy + 3, sw - 6, sh - 6, 6)
            if i == hov:
                cr.set_source_rgba(*ACCENT, 0.30)
            else:
                cr.set_source_rgba(*ZONE_BG)
            cr.fill_preserve()
            cr.set_source_rgba(*ZONE_BORDER)
            cr.set_line_width(1)
            cr.stroke()
            # size label
            cr.set_source_rgba(*TEXT_COLOR, 0.7)
            cr.set_font_size(13)
            txt = "%d%% × %d%%" % (round(z[2] * 100), round(z[3] * 100))
            ext = cr.text_extents(txt)
            cr.move_to(sx + sw / 2 - ext.width / 2, sy + sh / 2 + ext.height / 2)
            cr.show_text(txt)

        # split guide (ghost line) following the cursor
        if self.cursor and not self.drag and hov is not None:
            ctrl = self.state & Gdk.ModifierType.CONTROL_MASK
            shift = self.state & Gdk.ModifierType.SHIFT_MASK
            if ctrl or shift:
                self._draw_guide(cr, hov, vertical=bool(ctrl))

        # active drag guide
        if self.drag:
            self._draw_drag(cr)

    def _draw_guide(self, cr, zi, vertical):
        zx, zy, zw, zh = self.zones[zi]
        fx, fy = self._s2f(*self.cursor)
        cr.set_source_rgba(*ACCENT, 0.95)
        cr.set_line_width(2)
        if vertical:
            sx, sy, _, sh = self._f2s(fx, zy, 0, zh)
            cr.move_to(sx, sy)
            cr.line_to(sx, sy + sh)
        else:
            sx, sy, sw, _ = self._f2s(zx, fy, zw, 0)
            cr.move_to(sx, sy)
            cr.line_to(sx + sw, sy)
        cr.stroke()

    def _draw_drag(self, cr):
        orient, val = self.drag
        cr.set_source_rgba(*ACCENT, 0.95)
        cr.set_line_width(2)
        if orient == "v":
            sx, sy, _, _ = self._f2s(val, 0, 0, 0)
            cy, ch = self.canvas_rect[1], self.canvas_rect[3]
            cr.move_to(sx, cy)
            cr.line_to(sx, cy + ch)
        else:
            sx, sy, _, _ = self._f2s(0, val, 0, 0)
            cx, cw = self.canvas_rect[0], self.canvas_rect[2]
            cr.move_to(cx, sy)
            cr.line_to(cx + cw, sy)
        cr.stroke()

    # --- mouse -----------------------------------------------------------
    def _on_motion(self, _w, ev):
        self.cursor = (ev.x, ev.y)
        self.state = ev.state
        if self.drag:
            self._update_drag(ev.x, ev.y)
        self.canvas.queue_draw()
        return False

    def _on_leave(self, *_):
        self.cursor = None
        self.canvas.queue_draw()
        return False

    def _on_press(self, _w, ev):
        self.state = ev.state
        fx, fy = self._s2f(ev.x, ev.y)
        if ev.button == 3:
            self._remove_edge(fx, fy)
            self.canvas.queue_draw()
            return False
        if ev.button != 1:
            return False
        ctrl = ev.state & Gdk.ModifierType.CONTROL_MASK
        shift = ev.state & Gdk.ModifierType.SHIFT_MASK
        zi = self._zone_at(fx, fy)
        if ctrl and zi is not None:
            self._split(zi, fx, fy, vertical=True)
        elif shift and zi is not None:
            self._split(zi, fx, fy, vertical=False)
        else:
            self._start_edge_drag(ev.x, ev.y)
        self.canvas.queue_draw()
        return False

    def _on_release(self, _w, ev):
        if self.drag:
            self.drag = None
            self.canvas.queue_draw()
        return False

    # --- editing operations ---------------------------------------------
    def _split(self, zi, fx, fy, vertical):
        zx, zy, zw, zh = self.zones[zi]
        if vertical:
            edges = {z[0] for z in self.zones} | {z[0] + z[2] for z in self.zones}
            cut = self._snap_frac(fx, edges)
            cut = min(max(cut, zx + self.MIN), zx + zw - self.MIN)
            self.zones[zi] = [zx, zy, cut - zx, zh]
            self.zones.insert(zi + 1, [cut, zy, zx + zw - cut, zh])
        else:
            edges = {z[1] for z in self.zones} | {z[1] + z[3] for z in self.zones}
            cut = self._snap_frac(fy, edges)
            cut = min(max(cut, zy + self.MIN), zy + zh - self.MIN)
            self.zones[zi] = [zx, zy, zw, cut - zy]
            self.zones.insert(zi + 1, [zx, cut, zw, zy + zh - cut])

    def _remove_edge(self, fx, fy):
        """Merge the two zones straddling the divider nearest the cursor."""
        best = None  # (distance, i, j, merged_rect)
        for i, A in enumerate(self.zones):
            for j, B in enumerate(self.zones):
                if i >= j:
                    continue
                m = self._merge_rect(A, B)
                if not m:
                    continue
                # distance from cursor to the shared edge
                if abs(A[1] - B[1]) < self.EPS and abs(A[3] - B[3]) < self.EPS:
                    edge = A[0] + A[2] if A[0] < B[0] else B[0] + B[2]
                    d = abs(fx - edge)
                    inside = m[1] <= fy <= m[1] + m[3]
                else:
                    edge = A[1] + A[3] if A[1] < B[1] else B[1] + B[3]
                    d = abs(fy - edge)
                    inside = m[0] <= fx <= m[0] + m[2]
                if inside and (best is None or d < best[0]):
                    best = (d, i, j, m)
        if best and best[0] < 0.05:
            _, i, j, m = best
            self.zones[i] = m
            del self.zones[j]

    def _merge_rect(self, A, B):
        """Return the union rect if A and B are flush neighbours forming a
        rectangle, else None."""
        ax, ay, aw, ah = A
        bx, by, bw, bh = B
        # side-by-side (share a vertical edge, same y extent)
        if abs(ay - by) < self.EPS and abs(ah - bh) < self.EPS:
            if abs((ax + aw) - bx) < self.EPS:
                return [ax, ay, aw + bw, ah]
            if abs((bx + bw) - ax) < self.EPS:
                return [bx, by, aw + bw, ah]
        # stacked (share a horizontal edge, same x extent)
        if abs(ax - bx) < self.EPS and abs(aw - bw) < self.EPS:
            if abs((ay + ah) - by) < self.EPS:
                return [ax, ay, aw, ah + bh]
            if abs((by + bh) - ay) < self.EPS:
                return [bx, by, aw, ah + bh]
        return None

    # --- divider dragging (resize) --------------------------------------
    def _start_edge_drag(self, px, py):
        fx, fy = self._s2f(px, py)
        cw, ch = self.canvas_rect[2], self.canvas_rect[3]
        tol_x = self.EDGE_PX / cw
        tol_y = self.EDGE_PX / ch
        # vertical edges under the cursor's y
        for z in self.zones:
            for e in (z[0], z[0] + z[2]):
                if 1e-3 < e < 1 - 1e-3 and abs(fx - e) < tol_x \
                        and z[1] - self.EPS <= fy <= z[1] + z[3] + self.EPS:
                    self.drag = ("v", e)
                    return
        for z in self.zones:
            for e in (z[1], z[1] + z[3]):
                if 1e-3 < e < 1 - 1e-3 and abs(fy - e) < tol_y \
                        and z[0] - self.EPS <= fx <= z[0] + z[2] + self.EPS:
                    self.drag = ("h", e)
                    return

    def _update_drag(self, px, py):
        orient, old = self.drag
        fx, fy = self._s2f(px, py)
        if orient == "v":
            new = self._snap_frac(fx)
            lo = max(z[0] + self.MIN for z in self.zones
                     if abs(z[0] + z[2] - old) < self.EPS)
            hi = min(z[0] + z[2] - self.MIN for z in self.zones
                     if abs(z[0] - old) < self.EPS)
            new = min(max(new, lo), hi)
            for z in self.zones:
                if abs(z[0] + z[2] - old) < self.EPS:
                    z[2] = new - z[0]
                if abs(z[0] - old) < self.EPS:
                    z[2] = z[0] + z[2] - new
                    z[0] = new
        else:
            new = self._snap_frac(fy)
            lo = max(z[1] + self.MIN for z in self.zones
                     if abs(z[1] + z[3] - old) < self.EPS)
            hi = min(z[1] + z[3] - self.MIN for z in self.zones
                     if abs(z[1] - old) < self.EPS)
            new = min(max(new, lo), hi)
            for z in self.zones:
                if abs(z[1] + z[3] - old) < self.EPS:
                    z[3] = new - z[1]
                if abs(z[1] - old) < self.EPS:
                    z[3] = z[1] + z[3] - new
                    z[1] = new
        self.drag = (orient, new)


class SnapAssist(Gtk.Window):
    """After a snap, shows the layout's still-empty zones filled with the icons
    of the other open windows. Click an icon to snap that window into the zone."""

    ICON = 64
    PAD = 18
    LABEL_H = 16

    def __init__(self, screen_w, screen_h, on_pick, on_close):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.screen_w = screen_w
        self.screen_h = screen_h
        self.on_pick = on_pick      # (win_id, target_rect) -> None
        self.on_close = on_close
        self.slots = []             # [{target, icons:[{wid,pixbuf,rect,title}]}]

        self.set_app_paintable(True)
        self.set_decorated(False)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_keep_above(True)
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        self.set_default_size(screen_w, screen_h)
        self.move(0, 0)
        scr = self.get_screen()
        vis = scr.get_rgba_visual()
        if vis is not None:
            self.set_visual(vis)
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK)
        self.connect("draw", self._on_draw)
        self.connect("button-press-event", self._on_press)
        self.connect("key-press-event", self._on_key)

    def build(self, targets, candidates):
        """targets: list of (x,y,w,h) screen rects; candidates: [(wid,pixbuf,title)]"""
        self.slots = []
        for tgt in targets:
            tx, ty, tw, th = tgt
            n = len(candidates)
            if n == 0:
                continue
            cell = self.ICON + self.PAD
            cols = max(1, min(n, int((tw - self.PAD) // cell)))
            rows = (n + cols - 1) // cols
            grid_w = cols * cell - self.PAD
            grid_h = rows * (self.ICON + self.LABEL_H + self.PAD) - self.PAD
            ox = tx + (tw - grid_w) / 2
            oy = ty + (th - grid_h) / 2
            icons = []
            for k, (wid, pb, title) in enumerate(candidates):
                r, c = divmod(k, cols)
                ix = ox + c * cell
                iy = oy + r * (self.ICON + self.LABEL_H + self.PAD)
                icons.append({"wid": wid, "pixbuf": pb, "title": title,
                              "rect": (ix, iy, self.ICON, self.ICON)})
            self.slots.append({"target": tgt, "icons": icons})
        self.queue_draw()

    def _on_draw(self, _w, cr):
        cr.set_operator(cairo.Operator.SOURCE)
        cr.set_source_rgba(0, 0, 0, 0)
        cr.paint()
        cr.set_operator(cairo.Operator.OVER)
        # dim the whole screen a touch to focus attention
        cr.set_source_rgba(0, 0, 0, 0.35)
        cr.paint()
        cr.select_font_face("Sans", cairo.FONT_SLANT_NORMAL,
                            cairo.FONT_WEIGHT_NORMAL)
        for slot in self.slots:
            tx, ty, tw, th = slot["target"]
            rounded_rect(cr, tx, ty, tw, th, 10)
            cr.set_source_rgba(*PANEL_BG)
            cr.fill_preserve()
            cr.set_source_rgba(*ACCENT, 0.8)
            cr.set_line_width(2)
            cr.stroke()
            for ic in slot["icons"]:
                ix, iy, iw, ih = ic["rect"]
                pb = ic["pixbuf"]
                if pb is not None:
                    Gdk.cairo_set_source_pixbuf(cr, pb, ix, iy)
                    cr.paint()
                else:
                    rounded_rect(cr, ix, iy, iw, ih, 8)
                    cr.set_source_rgba(*ACCENT, 0.5)
                    cr.fill()
                    cr.set_source_rgba(*TEXT_COLOR, 0.9)
                    cr.set_font_size(26)
                    ch = (ic["title"] or "?")[0].upper()
                    ext = cr.text_extents(ch)
                    cr.move_to(ix + iw / 2 - ext.width / 2 - ext.x_bearing,
                               iy + ih / 2 - ext.y_bearing - ext.height / 2)
                    cr.show_text(ch)
                # title
                title = (ic["title"] or "")[:18]
                cr.set_font_size(11)
                cr.set_source_rgba(*TEXT_COLOR, 0.85)
                ext = cr.text_extents(title)
                cr.move_to(ix + iw / 2 - ext.width / 2,
                           iy + ih + self.LABEL_H - 3)
                cr.show_text(title)
        return False

    def _on_press(self, _w, ev):
        for slot in self.slots:
            for ic in slot["icons"]:
                ix, iy, iw, ih = ic["rect"]
                if ix <= ev.x <= ix + iw and iy <= ev.y <= iy + ih + self.LABEL_H:
                    self.on_pick(ic["wid"], slot["target"])
                    return False
        # click on empty space dismisses
        self.on_close()
        return False

    def _on_key(self, _w, ev):
        if ev.keyval == Gdk.KEY_Escape:
            self.on_close()
        return False


class SnapDaemon:
    POLL_MS = 25
    MOVE_THRESHOLD = 6  # px the window must move before we call it a drag

    def __init__(self):
        self.dpy = display.Display()
        self.root = self.dpy.screen().root
        self.NET_ACTIVE = self.dpy.intern_atom("_NET_ACTIVE_WINDOW")
        self.NET_WORKAREA = self.dpy.intern_atom("_NET_WORKAREA")
        self.NET_WM_TYPE = self.dpy.intern_atom("_NET_WM_WINDOW_TYPE")
        self.TYPE_NORMAL = self.dpy.intern_atom("_NET_WM_WINDOW_TYPE_NORMAL")
        self.NET_FRAME = self.dpy.intern_atom("_NET_FRAME_EXTENTS")
        self.GTK_FRAME = self.dpy.intern_atom("_GTK_FRAME_EXTENTS")
        self.NET_CLIENT_LIST = self.dpy.intern_atom("_NET_CLIENT_LIST")
        self.NET_WM_ICON = self.dpy.intern_atom("_NET_WM_ICON")
        self.NET_WM_NAME = self.dpy.intern_atom("_NET_WM_NAME")
        self.UTF8 = self.dpy.intern_atom("UTF8_STRING")

        geo = self.root.get_geometry()
        self.overlay = SnapOverlay(geo.width, geo.height)
        self.assist = SnapAssist(geo.width, geo.height,
                                 self._assist_pick, self._assist_close)

        self.cfg = load_config()
        self.work = self._workarea()

        # drag state machine
        self.btn_was_down = False
        self.dragging = False
        self.target_win = None
        self.target_id = None
        self.press_pos = None
        self.overlay_shown = False

        # snap-assist state
        self.assist_shown = False
        self.assist_targets = []   # remaining empty zone rects
        self.placed = set()        # window ids already placed this round

    # --- X helpers -------------------------------------------------------
    def _workarea(self):
        r = self.root.get_full_property(self.NET_WORKAREA, X.AnyPropertyType)
        if r and len(r.value) >= 4:
            return tuple(int(v) for v in r.value[0:4])
        geo = self.root.get_geometry()
        return (0, 0, geo.width, geo.height)

    def _active_window(self):
        r = self.root.get_full_property(self.NET_ACTIVE, X.AnyPropertyType)
        if not r or not r.value:
            return None
        try:
            return self.dpy.create_resource_object("window", r.value[0])
        except Exception:
            return None

    def _is_normal(self, win):
        try:
            r = win.get_full_property(self.NET_WM_TYPE, X.AnyPropertyType)
        except Exception:
            return True
        if not r or not r.value:
            return True  # untyped: assume a normal window
        return self.TYPE_NORMAL in r.value

    def _abs_pos(self, win):
        try:
            t = self.root.translate_coords(win, 0, 0)
            return (t.x, t.y)
        except Exception:
            return None

    # --- window enumeration for snap-assist ------------------------------
    def _win_title(self, win):
        try:
            r = win.get_full_property(self.NET_WM_NAME, self.UTF8)
            if r and r.value:
                v = r.value
                return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
            r = win.get_full_property(self.dpy.intern_atom("WM_NAME"),
                                      X.AnyPropertyType)
            if r and r.value:
                v = r.value
                return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
        except Exception:
            pass
        return ""

    def _win_icon(self, win, want=64):
        """Build a GdkPixbuf from _NET_WM_ICON, choosing the best-sized image."""
        try:
            r = win.get_full_property(self.NET_WM_ICON, X.AnyPropertyType)
        except Exception:
            return None
        if not r or not r.value:
            return None
        data = r.value
        n = len(data)
        i = 0
        best = None  # (score, w, h, start_index)
        while i + 2 <= n:
            w, h = int(data[i]), int(data[i + 1])
            i += 2
            if w <= 0 or h <= 0 or i + w * h > n:
                break
            # prefer the smallest image that is still >= want, else the largest
            ge = w >= want
            score = (1 if ge else 0, -abs(w - want) if ge else w)
            if best is None or score > best[0]:
                best = (score, w, h, i)
            i += w * h
        if best is None:
            return None
        _, w, h, start = best
        buf = bytearray(w * h * 4)
        for j in range(w * h):
            p = int(data[start + j])
            buf[j * 4] = (p >> 16) & 0xFF
            buf[j * 4 + 1] = (p >> 8) & 0xFF
            buf[j * 4 + 2] = p & 0xFF
            buf[j * 4 + 3] = (p >> 24) & 0xFF
        try:
            pb = GdkPixbuf.Pixbuf.new_from_bytes(
                GLib.Bytes.new(bytes(buf)), GdkPixbuf.Colorspace.RGB,
                True, 8, w, h, w * 4)
            if w != want or h != want:
                pb = pb.scale_simple(want, want, GdkPixbuf.InterpType.BILINEAR)
            return pb
        except Exception:
            return None

    def _candidates(self, exclude_ids):
        r = self.root.get_full_property(self.NET_CLIENT_LIST, X.AnyPropertyType)
        if not r or not r.value:
            return []
        out = []
        for wid in r.value:
            if wid in exclude_ids:
                continue
            try:
                win = self.dpy.create_resource_object("window", wid)
            except Exception:
                continue
            if not self._is_normal(win):
                continue
            out.append((wid, self._win_icon(win, SnapAssist.ICON),
                        self._win_title(win)))
        return out

    # --- snapping --------------------------------------------------------
    def _extents(self, win, atom):
        """Return (left, right, top, bottom) for a frame-extents property."""
        try:
            r = win.get_full_property(atom, X.AnyPropertyType)
        except Exception:
            return (0, 0, 0, 0)
        if r and len(r.value) >= 4:
            return tuple(int(v) for v in r.value[0:4])
        return (0, 0, 0, 0)

    def _visible_rect(self, win):
        """The on-screen rectangle the user actually sees, accounting for both
        server-side decorations (_NET_FRAME_EXTENTS) and the invisible GTK
        shadow margin (_GTK_FRAME_EXTENTS)."""
        try:
            g = win.get_geometry()
            t = self.root.translate_coords(win, 0, 0)
            cx, cy, cw, ch = t.x, t.y, g.width, g.height
        except Exception:
            return None
        nl, nr, nt, nb = self._extents(win, self.NET_FRAME)
        gl, gr, gt, gb = self._extents(win, self.GTK_FRAME)
        return (cx - nl + gl, cy - nt + gt,
                cw + nl + nr - gl - gr, ch + nt + nb - gt - gb)

    def _move(self, hexid, rect):
        x, y, w, h = (int(round(v)) for v in rect)
        try:
            subprocess.run(["wmctrl", "-i", "-r", hexid, "-e",
                            "0,%d,%d,%d,%d" % (x, y, w, h)], check=False)
        except FileNotFoundError:
            sys.stderr.write("11snap: wmctrl not installed\n")
            return False
        return True

    def _snap(self, win_id, rect):
        hexid = "0x%08x" % win_id
        try:
            subprocess.run(["wmctrl", "-i", "-r", hexid, "-b",
                            "remove,maximized_vert,maximized_horz"],
                           check=False)
        except FileNotFoundError:
            sys.stderr.write("11snap: wmctrl not installed\n")
            return
        if not self._move(hexid, rect):
            return
        if self.cfg.get("shadow_correct", True):
            win = self.dpy.create_resource_object("window", win_id)
            GLib.timeout_add(110, self._correct, win, hexid, tuple(rect), 0)

    def _correct(self, win, hexid, target, attempt):
        """One Newton step toward visible == target; handles GTK4 shadows and
        wmctrl client/frame sizing quirks. Idempotent for already-correct apps."""
        tol = 2
        v = self._visible_rect(win)
        if v is None:
            return False
        err = max(abs(target[i] - v[i]) for i in range(4))
        if err <= tol or attempt >= 2:
            if attempt > 0:
                dbg("correct done: visible=%s target=%s err=%d" % (v, target, err))
            return False
        adj = tuple(2 * target[i] - v[i] for i in range(4))
        dbg("correct #%d: visible=%s err=%d -> request %s"
            % (attempt + 1, v, err, adj))
        self._move(hexid, adj)
        GLib.timeout_add(90, self._correct, win, hexid, target, attempt + 1)
        return False

    # --- main loop -------------------------------------------------------
    def _show_overlay(self):
        if not self.overlay_shown:
            self.work = self._workarea()
            self.cfg = load_config()  # hot-reload edits
            apply_theme()             # follow live theme/accent changes
            self.overlay.build(self.work, self.cfg)
            self.overlay.show_all()
            self.overlay_shown = True

    def _hide_overlay(self):
        if self.overlay_shown:
            self.overlay.set_hover(None)
            self.overlay.hide()
            self.overlay_shown = False

    def _reset(self):
        self.dragging = False
        self.target_win = None
        self.target_id = None
        self.press_pos = None
        self._hide_overlay()

    # --- snap assist -----------------------------------------------------
    def _begin_assist(self, card_index, filled_zone, just_snapped_id):
        """After a snap, offer the layout's other zones, filled with app icons."""
        try:
            zones = self.overlay.cards[card_index]["zones"]
        except (IndexError, KeyError):
            return
        self.assist_targets = [z["target"] for k, z in enumerate(zones)
                               if k != filled_zone]
        if not self.assist_targets:
            return
        self.placed = {just_snapped_id}
        # let the snap settle, then show
        GLib.timeout_add(160, self._refresh_assist)

    def _refresh_assist(self):
        cands = self._candidates(self.placed)
        if not self.assist_targets or not cands:
            self._assist_close()
            return False
        self.assist.build(self.assist_targets, cands)
        if not self.assist_shown:
            self.assist.show_all()
            self.assist.present()
            self.assist_shown = True
        return False

    def _assist_pick(self, win_id, target):
        dbg("assist pick 0x%08x -> %s" % (win_id, target))
        try:
            subprocess.run(["wmctrl", "-i", "-a", "0x%08x" % win_id], check=False)
        except FileNotFoundError:
            pass
        self._snap(win_id, target)
        self.placed.add(win_id)
        self.assist_targets = [t for t in self.assist_targets if t != target]
        if self.assist_targets:
            GLib.timeout_add(160, self._refresh_assist)
        else:
            self._assist_close()

    def _assist_close(self):
        if self.assist_shown:
            self.assist.hide()
            self.assist_shown = False
        self.assist_targets = []
        self.placed = set()

    def tick(self):
        p = self.root.query_pointer()
        px, py, mask = p.root_x, p.root_y, p.mask
        btn_down = bool(mask & X.Button1Mask)

        if btn_down and not self.btn_was_down:
            # press: record candidate window + start position
            win = self._active_window()
            if win is not None and self._is_normal(win):
                self.target_win = win
                self.target_id = win.id
                self.press_pos = self._abs_pos(win)
                dbg("press: id=0x%08x pos=%s ptr=(%d,%d)"
                    % (win.id, self.press_pos, px, py))
            else:
                self.target_win = None
                dbg("press: no normal target window")
            self.dragging = False

        elif btn_down and self.btn_was_down:
            # held: promote to a drag once the window has actually moved
            if self.target_win is not None and not self.dragging:
                cur = self._abs_pos(self.target_win)
                if cur and self.press_pos:
                    if (abs(cur[0] - self.press_pos[0]) > self.MOVE_THRESHOLD or
                            abs(cur[1] - self.press_pos[1]) > self.MOVE_THRESHOLD):
                        self.dragging = True
                        dbg("drag start: window moved to", cur,
                            "workarea=", self.work)
                        if self.assist_shown:
                            self._assist_close()
            if self.dragging:
                wy = self.work[1]
                if py <= wy + self.cfg["trigger_px"]:
                    if not self.overlay_shown:
                        dbg("trigger: ptr_y=%d <= %d -> show overlay"
                            % (py, wy + self.cfg["trigger_px"]))
                    self._show_overlay()
                if self.overlay_shown:
                    hover, target = self.overlay.zone_at(px, py)
                    self.overlay.set_hover(hover, target)

        elif (not btn_down) and self.btn_was_down:
            # release: snap if dropped on a zone
            if self.overlay_shown and self.target_id is not None:
                idx, target = self.overlay.zone_at(px, py)
                dbg("release: ptr=(%d,%d) hover_target=%s" % (px, py, target))
                if target is not None:
                    dbg("SNAP 0x%08x -> %s" % (self.target_id, target))
                    self._snap(self.target_id, target)
                    if self.cfg.get("snap_assist", True) and idx is not None:
                        self._begin_assist(idx[0], idx[1], self.target_id)
            elif self.dragging:
                dbg("release: drag ended, overlay not shown (no snap)")
            self._reset()

        self.btn_was_down = btn_down
        return True

    def run(self):
        GLib.timeout_add(self.POLL_MS, self.tick)
        Gtk.main()


HOTKEY_LABEL = "11snap-editor"
HOTKEY_BASE = "org.cinnamon.desktop.keybindings"
HOTKEY_CHILD = "org.cinnamon.desktop.keybindings.custom-keybinding"
HOTKEY_PATH = "/org/cinnamon/desktop/keybindings/custom-keybindings/%s/"


def _hotkey_root():
    from gi.repository import Gio
    src = Gio.SettingsSchemaSource.get_default()
    if src is None or src.lookup(HOTKEY_BASE, True) is None:
        return None
    return Gio.Settings.new(HOTKEY_BASE)


def install_hotkey(command, accel="<Control><Alt>grave"):
    """Register a Cinnamon custom keybinding -> command (idempotent)."""
    from gi.repository import Gio
    root = _hotkey_root()
    if root is None:
        print("11snap: Cinnamon keybinding schema not found; "
              "bind it manually to:  %s" % command)
        return
    slots = list(root.get_strv("custom-list"))
    slot = None
    for name in slots:
        cs = Gio.Settings.new_with_path(HOTKEY_CHILD, HOTKEY_PATH % name)
        if cs.get_string("name") == HOTKEY_LABEL:
            slot = name
            break
    if slot is None:
        i = 0
        while ("custom%d" % i) in slots:
            i += 1
        slot = "custom%d" % i
        slots.append(slot)
        root.set_strv("custom-list", slots)
    cs = Gio.Settings.new_with_path(HOTKEY_CHILD, HOTKEY_PATH % slot)
    cs.set_string("name", HOTKEY_LABEL)
    cs.set_string("command", command)
    cs.set_strv("binding", [accel])
    Gio.Settings.sync()
    print("11snap: bound %s -> %s" % (accel, command))


def remove_hotkey():
    from gi.repository import Gio
    root = _hotkey_root()
    if root is None:
        return
    slots = list(root.get_strv("custom-list"))
    keep = []
    for name in slots:
        cs = Gio.Settings.new_with_path(HOTKEY_CHILD, HOTKEY_PATH % name)
        if cs.get_string("name") == HOTKEY_LABEL:
            for key in ("name", "command", "binding"):
                cs.reset(key)
        else:
            keep.append(name)
    root.set_strv("custom-list", keep)
    Gio.Settings.sync()
    print("11snap: removed editor hotkey")


def open_in_editor(path):
    for cmd in (os.environ.get("EDITOR"), "xdg-open"):
        if cmd and shutil.which(cmd.split()[0]):
            subprocess.Popen(cmd.split() + [path])
            return
    print(path)


def main():
    args = sys.argv[1:]
    if args and args[0] in ("-h", "--help"):
        print(__doc__)
        print("Options:\n"
              "  (no args)        run the snap daemon\n"
              "  --editor         open the visual layout editor\n"
              "  --edit           open layouts.json in a text editor\n"
              "  --reset          restore the default layouts\n"
              "  --demo           show the picker for 4s (preview layouts)\n"
              "  --print          print the resolved config and exit\n"
              "  --install-hotkey [cmd]  bind Ctrl+Alt+~ to the editor\n"
              "  --remove-hotkey  remove that keybinding")
        return
    if args and args[0] == "--install-hotkey":
        cmd = args[1] if len(args) > 1 else \
            (os.path.abspath(sys.argv[0]) + " --editor")
        install_hotkey(cmd)
        return
    if args and args[0] == "--remove-hotkey":
        remove_hotkey()
        return
    if args and args[0] == "--editor":
        apply_theme()
        cfg = load_config()
        dpy = display.Display()
        root = dpy.screen().root
        geo = root.get_geometry()
        r = root.get_full_property(
            dpy.intern_atom("_NET_WORKAREA"), X.AnyPropertyType)
        work = tuple(int(v) for v in r.value[0:4]) if r \
            else (0, 0, geo.width, geo.height)
        dpy.close()
        ed = LayoutEditor(work, cfg)
        ed.show_all()
        Gtk.main()
        return
    if args and args[0] == "--edit":
        load_config()
        open_in_editor(CONFIG_PATH)
        return
    if args and args[0] == "--reset":
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_PATH, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=2)
        print(f"Reset {CONFIG_PATH}")
        return
    if args and args[0] == "--print":
        print(json.dumps(load_config(), indent=2))
        return
    if args and args[0] == "--demo":
        apply_theme()
        cfg = load_config()
        dpy = display.Display()
        root = dpy.screen().root
        geo = root.get_geometry()
        r = root.get_full_property(
            dpy.intern_atom("_NET_WORKAREA"), X.AnyPropertyType)
        work = tuple(int(v) for v in r.value[0:4]) if r else (0, 0, geo.width, geo.height)
        ov = SnapOverlay(geo.width, geo.height)
        ov.build(work, cfg)
        # highlight a zone so the accent + preview are visible
        if ov.cards and ov.cards[0]["zones"]:
            ov.hover = (0, 0)
            ov.hover_target = ov.cards[0]["zones"][0]["target"]
        ov.show_all()
        GLib.timeout_add(4000, Gtk.main_quit)
        Gtk.main()
        return

    apply_theme()
    SnapDaemon().run()


if __name__ == "__main__":
    main()
