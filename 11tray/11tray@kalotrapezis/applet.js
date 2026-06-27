// 11tray — a Windows 11-style tray overflow for Cinnamon.
//
// We become the host for XApp status icons (replacing the stock
// xapp-status@cinnamon.org applet) and render them ourselves. Icons the user
// hides are tucked into a drawer behind a small arrow; everything else sits on
// the panel strip. The hide/show choice is per-app and persisted.
//
// Most of the per-icon plumbing (render, click/scroll forwarding, tooltips) is
// lifted from the stock xapp-status applet — the only genuinely new part is the
// strip-vs-drawer split and the arrow toggle. Drag-and-drop to move icons
// between the two is a later phase; for now Ctrl+click toggles hide/show.

const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;
const XApp = imports.gi.XApp;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const Tooltips = imports.ui.tooltips;

const UUID = "11tray@kalotrapezis";

// Icons whose key matches one of these hints are treated as "system" and sorted
// to the front of the strip, next to the other system indicators.
const SYSTEM_HINTS = [
    "update", "mintupdate", "blueman", "bluetooth", "report", "mintreport",
    "warpinator", "power", "battery", "network", "nm-applet", "printer",
    "redshift", "input", "keyboard"
];

const HORIZONTAL_STYLE = 'padding-left: 2px; padding-right: 2px; padding-top: 0; padding-bottom: 0';
const VERTICAL_STYLE = 'padding-left: 0; padding-right: 0; padding-top: 2px; padding-bottom: 2px';

// The active GTK theme name, so we can pick dark/light arrow assets.
function gtkThemeName() {
    try { return new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" }).get_string("gtk-theme"); }
    catch (e) { return ""; }
}

// The active theme's accent colour (@theme_selected_bg_color), e.g. "#ff7139",
// read from its GTK CSS — used for the drawer's border.
function readAccent(themeName) {
    if (!themeName) return null;
    let dirs = ["/usr/share/themes", GLib.build_filenamev([GLib.get_home_dir(), ".themes"]),
        GLib.build_filenamev([GLib.get_user_data_dir(), "themes"])];
    for (let d of dirs) {
        for (let sub of ["gtk-3.0/gtk.css", "gtk-3.0/gtk-dark.css"]) {
            let css = readText(GLib.build_filenamev([d, themeName, sub]));
            if (!css) continue;
            let m = css.match(/@define-color\s+(?:theme_)?selected_bg_color\s+(#[0-9a-fA-F]{6})/);
            if (m) return m[1];
        }
    }
    return null;
}

// Per-app exceptions for misbehaving tray icons. Matched against the icon's
// declared name (proxy.name). `base` names a themed icon pair in the applet's
// exceptions/ folder (Dark-<base>.png / Light-<base>.png) used instead of the
// app's own (broken) icon. `collapse` shows only one icon for the match, even
// if the app registers several.
//
// Claude's Linux desktop port (after a 2026 update) reports its tray icon as
// "image-missing" with dead menus and sometimes registers twice — so we draw
// our own Claude logo and keep just one.
// Per-app exceptions for misbehaving tray icons, loaded from standalone
// `*.exeption` files in the applet's exceptions/ folder — one JSON file per app,
// so they can be added/removed without touching this code. Each file:
//   { "match": "claude", "base": "claude", "collapse": true }
//   match    – substring tested against the icon's declared name (proxy.name)
//   base     – name of the themed override icon pair Dark-<base>.png / Light-<base>.png
//   collapse – show only one icon for this match, even if the app registers several
let EXCEPTIONS = [];

function readText(path) {
    try {
        let [ok, bytes] = GLib.file_get_contents(path);
        if (!ok) return null;
        return (typeof bytes === "string") ? bytes : new TextDecoder().decode(bytes);
    } catch (e) { return null; }
}

function loadExceptions(dir) {
    EXCEPTIONS = [];
    let iter;
    try {
        iter = Gio.File.new_for_path(dir).enumerate_children(
            "standard::name", Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) { return; }
    let info;
    while ((info = iter.next_file(null)) !== null) {
        let name = info.get_name();
        if (!/\.exe?ption$/i.test(name)) continue;   // .exeption or .exception
        let txt = readText(GLib.build_filenamev([dir, name]));
        if (!txt) continue;
        try {
            let obj = JSON.parse(txt);
            if (obj && obj.match) EXCEPTIONS.push(obj);
        } catch (e) {
            global.logError("11tray: bad exception file " + name + ": " + e);
        }
    }
    iter.close(null);
}

function exceptionFor(proxy) {
    let name = (proxy.name || "").toLowerCase();
    if (!name) return null;
    return EXCEPTIONS.find(e => name.indexOf((e.match || "").toLowerCase()) !== -1) || null;
}

// The leading token of a themed icon name, used as a stable app id.
// e.g. "blueman-active-symbolic" -> "blueman".
function iconBase(iconName) {
    let s = iconName.split("/").pop().replace(/\.(png|svg|xpm)$/i, "");
    return s.split("-")[0].toLowerCase();
}

// A stable, app-level identity for a status icon — used to remember the
// hide/show choice across restarts and to group/collapse. The reliable source
// is proxy.name (the app's declared name, e.g. "claude_status_icon_1",
// "blueman", "megasync"); proxy.get_name() is just the shared D-Bus sender.
function persistentKey(proxy) {
    let exc = exceptionFor(proxy);
    if (exc) return "exc:" + exc.base;                 // all matches share one key

    let name = (proxy.name || "").trim().toLowerCase();
    if (name) return name;

    let icon = (proxy.icon_name || "").trim();
    if (icon && icon !== " " && !icon.startsWith("/") && !icon.startsWith("xapp-tmp")) {
        return iconBase(icon);
    }
    let tip = (proxy.tooltip_text || "").replace(/<[^>]+>/g, "").split("\n")[0].trim();
    if (tip) return "tip:" + tip.toLowerCase();
    let path = (proxy.get_object_path && proxy.get_object_path()) || "";
    return "path:" + path;
}

// Text used to decide whether an icon is a system indicator: its themed icon
// name plus its declared name (e.g. "blueman-active-symbolic blueman").
function classifyText(proxy) {
    return ((proxy.icon_name || "") + " " + (proxy.name || "")).toLowerCase();
}

// One rendered status icon. Owns its St actor and forwards input to the proxy.
class TrayIcon {
    constructor(applet, proxy) {
        this.applet = applet;
        this.proxy = proxy;
        this.name = proxy.name || proxy.get_name();
        this.exception = exceptionFor(proxy);
        this.iconName = null;

        this.actor = new St.BoxLayout({
            style_class: "applet-box",
            reactive: !global.settings.get_boolean('panel-edit-mode'),
            track_hover: true,
            x_expand: true,
            y_expand: true
        });

        this.icon_holder = new St.Bin();
        this.iconSize = this.applet.trayIconSize();
        this.proxy.icon_size = this.iconSize;

        this.label = new St.Label({ 'y-align': St.Align.END });

        this.actor.add_actor(this.icon_holder);
        this.actor.add_actor(this.label);

        this._tooltip = new Tooltips.PanelItemTooltip(this, "", applet.orientation);

        this.actor.connect('button-press-event', Lang.bind(this, this.onButtonPressEvent));
        this.actor.connect('button-release-event', Lang.bind(this, this.onButtonReleaseEvent));
        this.actor.connect('scroll-event', (...args) => this.onScrollEvent(...args));
        this.actor.connect('enter-event', Lang.bind(this, this.onEnterEvent));

        this._proxy_prop_change_id =
            this.proxy.connect('g-properties-changed', Lang.bind(this, this.on_properties_changed));

        this.refresh();
    }

    key() { return persistentKey(this.proxy); }

    on_properties_changed(proxy, changed_props, invalidated_props) {
        let prop_names = changed_props.deep_unpack();
        if ('IconName' in prop_names) this.setIconName(proxy.icon_name);
        if ('TooltipText' in prop_names) this.setTooltipText(proxy.tooltip_text);
        if ('Label' in prop_names) this.setLabel(proxy.label);
        if ('Visible' in prop_names) this.setVisible(proxy.visible);
        // Apps (notably Claude) often set their Name *after* registering — so
        // re-evaluate the exception (icon + collapse) when the name lands.
        if ('Name' in prop_names) this.applet.onProxyNameChanged(this);
        // When an icon popped out for its menu, slide it back once that menu closes.
        if (('SecondaryMenuIsOpen' in prop_names || 'PrimaryMenuIsOpen' in prop_names) &&
            this._tempOut && !proxy.secondary_menu_is_open && !proxy.primary_menu_is_open) {
            this.applet.returnIconToDrawer(this);
        }
    }

    refresh() {
        this.setIconName(this.proxy.icon_name);
        this.setLabel(this.proxy.label);
        this.setTooltipText(this.proxy.tooltip_text);
        this.setVisible(this.proxy.visible);
        this.setOrientation(this.applet.orientation);
        this.actor.queue_relayout();
    }

    setOrientation(orientation) {
        let vertical = (orientation == St.Side.LEFT || orientation == St.Side.RIGHT);
        this.actor.vertical = vertical;
        if (vertical) this.actor.add_style_class_name("vertical");
        else this.actor.remove_style_class_name("vertical");
    }

    setIconName(iconName) {
        this.iconName = iconName || null;
        // Uniform size so colourful app icons match the panel's other icons.
        this.iconSize = this.applet.trayIconSize();
        this.proxy.icon_size = this.iconSize;

        // Per-app exception: draw our own themed icon (from exceptions/) instead
        // of the app's broken one — e.g. Claude's "image-missing".
        if (this.exception) {
            let ep = this.applet.exceptionIconPath(this.exception.base);
            if (ep) {
                this.icon_loader_handle = St.TextureCache.get_default().load_image_from_file_async(
                    ep,
                    this.actor.vertical ? this.iconSize : -1,
                    this.iconSize,
                    (...args) => this._onImageLoaded(...args)
                );
                return;
            }
        }

        let name = (iconName || "").trim();

        // No usable icon — some apps (e.g. Claude after an update) report an
        // empty name or the literal "image-missing". Show a neutral generic
        // icon instead of a broken-image glyph or an empty box.
        if (!name || name === "image-missing") {
            this._showFallbackIcon();
            return;
        }

        let type = name.match(/symbolic/) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;

        // A file-path icon (pixmap in /dev/shm, etc.): load it, but fall back if
        // the file is gone (stale path left over from an app restart/update).
        if (name.includes("/") && type != St.IconType.SYMBOLIC) {
            if (!GLib.file_test(name, GLib.FileTest.EXISTS)) {
                this._showFallbackIcon();
                return;
            }
            this.icon_loader_handle = St.TextureCache.get_default().load_image_from_file_async(
                name,
                this.actor.vertical ? this.iconSize : -1,
                this.iconSize,
                (...args) => this._onImageLoaded(...args)
            );
            return;
        }

        this._setIconChild(new St.Icon({ "icon-type": type, "icon-size": this.iconSize, "icon-name": name }));
    }

    _setIconChild(actor) {
        this.icon_holder.child = actor;
        this.icon_holder.show();
    }

    // A clean stand-in when an app gives us no usable icon.
    _showFallbackIcon() {
        this._setIconChild(new St.Icon({
            icon_type: St.IconType.FULLCOLOR,
            icon_size: this.iconSize,
            icon_name: "application-x-executable"
        }));
    }

    _onImageLoaded(cache, handle, actor, data = null) {
        if (handle !== this.icon_loader_handle) return;
        if (!actor) { this._showFallbackIcon(); return; }
        this._setIconChild(actor);
    }

    setTooltipText(tooltipText) {
        if (tooltipText) {
            this._tooltip.preventShow = false;
        } else {
            tooltipText = "";
            this._tooltip.preventShow = true;
        }
        this._tooltip.set_markup(tooltipText);
        if (this._tooltip.visible) { this._tooltip.hide(); this._tooltip.show(); }
    }

    setLabel(label) {
        this.label.set_text(label || "");
        let horizontal = (this.applet.orientation == St.Side.TOP || this.applet.orientation == St.Side.BOTTOM);
        this.label.visible = horizontal && this.proxy.label.length > 0;
    }

    setVisible(visible) {
        this._appVisible = visible;
        // The applet decides final placement/visibility; respect the app's wish
        // only when the icon is on the strip (the drawer governs its own).
        this.actor.visible = visible;
    }

    onEnterEvent(actor, event) { this._tooltip.preventShow = false; }

    // Copied verbatim from the stock applet — maps the actor's on-screen rect to
    // the (x, y, orientation) the proxy expects for its own menus.
    getEventPositionInfo(actor) {
        let allocation = Cinnamon.util_get_transformed_allocation(actor);
        let x = Math.round(allocation.x1 / global.ui_scale);
        let y = Math.round(allocation.y1 / global.ui_scale);
        let w = Math.round((allocation.x2 - allocation.x1) / global.ui_scale);
        let h = Math.round((allocation.y2 - allocation.y1) / global.ui_scale);

        switch (this.applet.orientation) {
            case St.Side.TOP:    return [x, y + h, Gtk.PositionType.TOP];
            case St.Side.LEFT:   return [x + w, y, Gtk.PositionType.LEFT];
            case St.Side.RIGHT:  return [x, y, Gtk.PositionType.RIGHT];
            case St.Side.BOTTOM:
            default:             return [x, y, Gtk.PositionType.BOTTOM];
        }
    }

    // True if this icon's actor currently sits inside the drawer grid
    // (icon -> row -> drawerBox).
    isInDrawer() {
        let p = this.actor.get_parent();
        return !!(p && p.get_parent() === this.applet.drawerBox);
    }

    onButtonPressEvent(actor, event) {
        // Ctrl+left-click is our interim hide/show toggle (until drag-and-drop).
        if (event.get_button() == Clutter.BUTTON_PRIMARY &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            this.applet.toggleHidden(this);
            return Clutter.EVENT_STOP;
        }

        this._tooltip.hide();
        this._tooltip.preventShow = true;

        // Compute the position while the icon is still allocated. Left-click keeps
        // the drawer open; only right-click closes it (below) so the app's own
        // menu can take the pointer grab.
        this._pressXYO = this.getEventPositionInfo(actor);
        let inDrawer = (this.applet.menu.isOpen && this.isInDrawer());

        // Exception icons (e.g. Claude): the app's right-click menu works via
        // forwarding, but it has no left-click action — so synthesise one
        // (raise/show the app window). Right-click still forwards below.
        if (this.exception && event.get_button() == Clutter.BUTTON_PRIMARY) {
            this.applet.raiseApp(this.exception);
            return Clutter.EVENT_STOP;
        }

        if (event.get_button() == Clutter.BUTTON_SECONDARY &&
            event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            return Clutter.EVENT_PROPAGATE;
        }

        // Right-click inside the drawer: pop the icon onto the panel so its own
        // menu can grab the pointer and appear (the drawer's grab would block it),
        // then return it to the drawer when the menu closes.
        if (event.get_button() == Clutter.BUTTON_SECONDARY && inDrawer) {
            this.applet.popOutForMenu(this);
            return Clutter.EVENT_STOP;
        }

        let [x, y, o] = this._pressXYO;
        this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), o, null, null);
        return Clutter.EVENT_STOP;
    }

    onButtonReleaseEvent(actor, event) {
        if (event.get_button() == Clutter.BUTTON_PRIMARY &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            return Clutter.EVENT_STOP;
        }
        // Left-click on an exception was fully handled on press (raise window).
        if (this.exception && event.get_button() == Clutter.BUTTON_PRIMARY) {
            return Clutter.EVENT_STOP;
        }
        // Reuse the press position (the icon may have moved when the drawer closed).
        let [x, y, o] = this._pressXYO || this.getEventPositionInfo(actor);
        this.proxy.call_button_release(x, y, event.get_button(), event.get_time(), o, null, null);
        return Clutter.EVENT_STOP;
    }

    onScrollEvent(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.SMOOTH) return Clutter.EVENT_STOP;

        let x_dir = XApp.ScrollDirection.UP, delta = 0;
        if (direction == Clutter.ScrollDirection.UP) { x_dir = XApp.ScrollDirection.UP; delta = -1; }
        else if (direction == Clutter.ScrollDirection.DOWN) { x_dir = XApp.ScrollDirection.DOWN; delta = 1; }
        else if (direction == Clutter.ScrollDirection.LEFT) { x_dir = XApp.ScrollDirection.LEFT; delta = -1; }
        else if (direction == Clutter.ScrollDirection.RIGHT) { x_dir = XApp.ScrollDirection.RIGHT; delta = 1; }

        this.proxy.call_scroll(delta, x_dir, event.get_time(), null, null);
        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (this._proxy_prop_change_id) {
            this.proxy.disconnect(this._proxy_prop_change_id);
            this._proxy_prop_change_id = 0;
        }
        this._tooltip.destroy();
        this.actor.destroy();
    }
}

class Tray11Applet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.metadata = metadata;
        this.orientation = orientation;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        // Load per-app exceptions from exceptions/*.exeption before any icons
        // arrive, so matching/collapse is in effect from the first icon.
        loadExceptions(GLib.build_filenamev([metadata.path, "exceptions"]));

        this.actor.remove_style_class_name('applet-box');
        this.actor.set_important(true);

        this._dark = /dark/i.test(gtkThemeName());

        // Persisted set of hidden app keys.
        this.settings = new Settings.AppletSettings(this, UUID, instance_id);
        // Icons are hidden (in the drawer) BY DEFAULT; this is the allowlist of
        // the ones the user has chosen to show on the panel. Empty on first run,
        // so a fresh install tucks everything under the arrow.
        this._shown = new Set(this.settings.getValue("shown-icons") || []);
        // Icon size comes from the settings dialog; refresh icons when it changes.
        this.settings.bind("icon-size", "iconSizePref", () => this.refreshIcons());
        // Drawer grid width.
        this.settings.bind("icons-per-row", "perRowPref", () => this._layoutDrawer());

        // Layout (left -> right): app icons, then system icons, then the arrow.
        let vertical = (orientation == St.Side.LEFT || orientation == St.Side.RIGHT);
        let stripStyle = vertical ? VERTICAL_STYLE : HORIZONTAL_STYLE;

        // Regular app icons.
        this.appStrip = new St.BoxLayout({ vertical: vertical, style: stripStyle });
        this.actor.add_actor(this.appStrip);

        // System icons (update manager, bluetooth, …), nearest the system tray.
        this.sysStrip = new St.BoxLayout({ vertical: vertical, style: stripStyle });
        this.actor.add_actor(this.sysStrip);

        // The arrow that reveals the drawer (only shown when something is hidden).
        this.arrowBtn = new St.Button({ style_class: "tray11-arrow", reactive: true, can_focus: false });
        this.arrowIcon = new St.Icon({ icon_size: 16 });
        this.arrowBtn.set_child(this.arrowIcon);
        this.arrowBtn.connect('clicked', () => this.menu.toggle());
        this.actor.add_actor(this.arrowBtn);

        // The drawer is a normal modal applet popup — the modal grab is what makes
        // it clickable on top of app windows (without it, clicks fall through to
        // the window underneath). It stays open while you click icons inside it
        // (the grab only dismisses on clicks *outside*); right-clicking an icon
        // closes it on purpose so the app's own menu can take the pointer grab.
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        // The drawer holds a grid of rows (vertical box of horizontal rows).
        this.drawerBox = new St.BoxLayout({ style_class: "tray11-drawer", vertical: true });
        this.menu.box.add_actor(this.drawerBox);
        this._applyDrawerStyle();
        this.menu.connect('open-state-changed', (m, open) => this._updateArrowIcon(open));

        // Right-click context menu: a live list of icons with hide/show toggles.
        this._ctxSection = new PopupMenu.PopupMenuSection();
        this._applet_context_menu.addMenuItem(this._ctxSection, 0);
        this._applet_context_menu.connect('open-state-changed',
            (m, open) => { if (open) this._rebuildContextMenu(); });

        this.icons = {};                 // runtime key -> TrayIcon
        this._collapsed = {};            // exception base -> runtime key currently shown
        this.signalManager = new SignalManager.SignalManager(null);

        this.monitor = new XApp.StatusIconMonitor();
        this.signalManager.connect(this.monitor, "icon-added", this.onIconAdded, this);
        this.signalManager.connect(this.monitor, "icon-removed", this.onIconRemoved, this);
        this.signalManager.connect(Main.systrayManager, "changed", this.onRolesChanged, this);
        this.signalManager.connect(this.panel, "icon-size-changed", this.refreshIcons, this);
        this.signalManager.connect(global.settings, 'changed::panel-edit-mode', this.onEditModeChanged, this);

        // Re-pick the dark/light arrow asset when the GTK theme changes.
        this._ifaceSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
        this.signalManager.connect(this._ifaceSettings, "changed::gtk-theme", this._onThemeChanged, this);

        this._updateArrow();
    }

    // ---- identity / placement -------------------------------------------------

    runtimeKey(proxy) {
        return (proxy.get_name() || "") + (proxy.get_object_path ? proxy.get_object_path() : "");
    }

    // Icons that already have a dedicated native applet (network, sound, power…)
    // are skipped, exactly like the stock applet — keeps us to app icons.
    shouldIgnore(proxy) {
        let roles = Main.systrayManager.getRoles();
        let name = (proxy.name || "").toLowerCase();
        return roles.indexOf(name) != -1;
    }

    onIconAdded(monitor, proxy) {
        let key = this.runtimeKey(proxy);
        if (this.icons[key]) return;
        if (this.shouldIgnore(proxy)) return;

        // Collapse: for an exception with `collapse`, keep only the first icon
        // (Claude registers a dead duplicate — show one, drop the rest).
        let exc = exceptionFor(proxy);
        if (exc && exc.collapse && this._collapsed[exc.base]) return;

        let icon = new TrayIcon(this, proxy);
        this.icons[key] = icon;
        if (exc && exc.collapse) this._collapsed[exc.base] = key;
        this.place(icon);
        this._updateArrow();
    }

    onIconRemoved(monitor, proxy) {
        let key = this.runtimeKey(proxy);
        let icon = this.icons[key];
        if (!icon) return;
        if (icon.exception && icon.exception.collapse &&
            this._collapsed[icon.exception.base] === key) {
            delete this._collapsed[icon.exception.base];
        }
        icon.destroy();
        delete this.icons[key];
        this._updateArrow();
    }

    onRolesChanged() {
        for (let key in this.icons) {
            if (this.shouldIgnore(this.icons[key].proxy)) {
                this.icons[key].destroy();
                delete this.icons[key];
            }
        }
        this._updateArrow();
    }

    // An icon's declared name changed (Claude names itself late). Re-evaluate
    // its exception, re-render, and re-run collapse to drop late duplicates.
    onProxyNameChanged(icon) {
        let exc = exceptionFor(icon.proxy);
        let changed = (exc !== icon.exception);
        icon.exception = exc;
        icon.name = icon.proxy.name || icon.name;
        if (changed) icon.refresh();      // swap to/from the override icon
        this._reapplyCollapse();
        this._reorderStrips();
        this._updateArrow();
    }

    // Keep only one icon per collapsing exception; drop the rest. Safe to call
    // any time (rebuilds the _collapsed map from the current icon set).
    _reapplyCollapse() {
        this._collapsed = {};
        for (let key of Object.keys(this.icons)) {
            let ic = this.icons[key];
            let exc = ic.exception;
            if (!exc || !exc.collapse) continue;
            if (this._collapsed[exc.base]) {
                ic.destroy();
                delete this.icons[key];   // a duplicate — remove it
            } else {
                this._collapsed[exc.base] = key;
            }
        }
    }

    // True unless the user has explicitly chosen to show this icon.
    isHidden(icon) {
        return !this._shown.has(icon.key());
    }

    // Put an icon where it belongs: drawer (hidden), system strip, or app strip.
    place(icon) {
        if (icon._tempOut) return;   // temporarily on the panel for its menu

        if (this.isHidden(icon)) {
            // Lives in the drawer grid — (re)built by _layoutDrawer.
            this._layoutDrawer();
            return;
        }

        let target = this.isSystem(icon) ? this.sysStrip : this.appStrip;
        icon.actor.x_expand = true;   // fill the panel cell (off in the drawer)
        let cur = icon.actor.get_parent();
        if (cur !== target) {
            if (cur) cur.remove_child(icon.actor);
            target.add_child(icon.actor);
        }
        this._reorderStrips();
        this._layoutDrawer();   // it may have just left the drawer; rebuild rows
    }

    // Arrange the hidden icons into a grid of rows (icons-per-row wide).
    _layoutDrawer() {
        let perRow = Math.max(1, this.perRowPref || 5);
        let hidden = Object.keys(this.icons).map(k => this.icons[k])
            .filter(ic => this.isHidden(ic) && !ic._tempOut);
        hidden.sort((a, b) => this.iconLabel(a).localeCompare(this.iconLabel(b)));

        // Detach the hidden icons from wherever they currently live (a panel
        // strip when freshly hidden, or an old row) — otherwise add_child below
        // is a no-op on an actor that still has a parent, and the icon never
        // moves. Then drop the old (now-empty) rows.
        for (let ic of hidden) {
            let p = ic.actor.get_parent();
            if (p) p.remove_child(ic.actor);
        }
        this.drawerBox.destroy_all_children();

        for (let i = 0; i < hidden.length; i += perRow) {
            let row = new St.BoxLayout({ vertical: false, style_class: "tray11-row",
                                         x_align: Clutter.ActorAlign.START });
            for (let j = i; j < Math.min(i + perRow, hidden.length); j++) {
                // Don't stretch icons in the drawer — pack them to the left so a
                // short last row stays left-aligned instead of spreading out.
                hidden[j].actor.x_expand = false;
                row.add_child(hidden[j].actor);
            }
            this.drawerBox.add_child(row);
        }
    }

    // Accent-coloured border around the drawer, following the active theme.
    _applyDrawerStyle() {
        let accent = readAccent(gtkThemeName()) || "#888888";
        // No margin here: St margins can offset the input region from the paint
        // box, which would make the icons unclickable.
        this.drawerBox.style =
            "border: 2px solid " + accent + ";" +
            "border-radius: 12px;" +
            "padding: 8px; spacing: 8px;";
    }

    // True if the icon looks like a system indicator (see SYSTEM_HINTS).
    isSystem(icon) {
        let hay = classifyText(icon.proxy);
        return SYSTEM_HINTS.some(h => hay.indexOf(h) !== -1);
    }

    // Keep each visible group ordered A→Z.
    _sortStrip(box) {
        let icons = Object.keys(this.icons)
            .map(k => this.icons[k])
            .filter(ic => ic.actor.get_parent() === box);
        icons.sort((a, b) => this.iconLabel(a).localeCompare(this.iconLabel(b)));
        icons.forEach((ic, i) => box.set_child_at_index(ic.actor, i));
    }

    _reorderStrips() {
        this._sortStrip(this.appStrip);
        this._sortStrip(this.sysStrip);
    }

    // Move an icon to the drawer (hidden) or strip, and remember the choice.
    setHidden(icon, hidden) {
        let key = icon.key();
        if (hidden) this._shown.delete(key);
        else this._shown.add(key);
        this.settings.setValue("shown-icons", Array.from(this._shown));
        this.place(icon);
        this._updateArrow();
    }

    toggleHidden(icon) { this.setHidden(icon, !this.isHidden(icon)); }

    // A readable label for an icon (first line of its tooltip, tags stripped).
    iconLabel(icon) {
        // Matched exceptions get a clean capitalised name (e.g. "Claude").
        if (icon.exception) {
            let b = icon.exception.base;
            return b.charAt(0).toUpperCase() + b.slice(1);
        }
        let t = icon.proxy.tooltip_text;
        if (t) {
            let clean = t.replace(/<[^>]+>/g, "").split("\n")[0].trim();
            if (clean) return clean;
        }
        // Last resort: the declared name, never a raw key prefix.
        let n = (icon.proxy.name || "").trim();
        if (n) return n;
        return icon.key().replace(/^(tip:|path:|exc:)/, "");
    }

    // Rebuild the live hide/show toggle list shown in the right-click menu.
    _rebuildContextMenu() {
        this._ctxSection.removeAll();
        this._ctxSection.addMenuItem(
            new PopupMenu.PopupMenuItem("In the drawer (off = show on panel):", { reactive: false }));

        let icons = Object.keys(this.icons).map(k => this.icons[k]);
        if (!icons.length) {
            this._ctxSection.addMenuItem(
                new PopupMenu.PopupMenuItem("(no tray icons)", { reactive: false }));
        } else {
            icons.sort((a, b) => this.iconLabel(a).localeCompare(this.iconLabel(b)));
            for (let icon of icons) {
                let sw = new PopupMenu.PopupSwitchMenuItem(
                    this.iconLabel(icon), this.isHidden(icon));
                sw.connect('toggled', (it, val) => this.setHidden(icon, val));
                this._ctxSection.addMenuItem(sw);
            }
        }
        this._ctxSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    // Tray-icon size, taken from this applet's settings (the gear dialog).
    // Falls back to the panel's configured size if unset.
    trayIconSize() {
        return this.iconSizePref || this.getPanelIconSize(St.IconType.FULLCOLOR);
    }

    // Raise/focus an app's window by WM_CLASS — used to give exception icons a
    // working left-click ("show the app") when the app itself ignores it.
    // Uses Cinnamon's own window list, so no external tools are needed.
    raiseApp(exc) {
        if (!exc || !exc.wmclass) return;
        let target = exc.wmclass.toLowerCase();
        for (let a of global.get_window_actors()) {
            let w = a.meta_window;
            let cls = ((w.get_wm_class && w.get_wm_class()) || "").toLowerCase();
            if (cls.indexOf(target) !== -1) {
                w.activate(global.get_current_time());
                return;
            }
        }
    }

    // Themed override icon for a matched exception (exceptions/Dark-<base>.png
    // or Light-<base>.png), or null if the user hasn't supplied one.
    exceptionIconPath(base) {
        let pfx = this._dark ? "Dark-" : "Light-";
        for (let ext of [".png", ".svg"]) {
            let p = GLib.build_filenamev([this.metadata.path, "exceptions", pfx + base + ext]);
            if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
        }
        return null;
    }

    // ---- arrow / drawer -------------------------------------------------------

    _updateArrow() {
        let hasHidden = Object.keys(this.icons)
            .some(k => this.isHidden(this.icons[k]) && !this.icons[k]._tempOut);
        this.arrowBtn.visible = hasHidden;
        if (!hasHidden && this.menu.isOpen) this.menu.close();
        this._updateArrowIcon(this.menu.isOpen);
    }

    _onThemeChanged() {
        this._dark = /dark/i.test(gtkThemeName());
        this._updateArrowIcon(this.menu.isOpen);
        this._applyDrawerStyle();   // re-read the accent colour
        this.refreshIcons();        // re-pick themed exception icons (e.g. Claude)
    }

    // Right-click on a drawer icon: pop it onto the panel so its own menu can
    // appear (Xorg needs the pointer grab the drawer holds), then slide it back
    // into the drawer once the menu closes.
    popOutForMenu(icon) {
        icon._tempOut = true;
        let target = this.isSystem(icon) ? this.sysStrip : this.appStrip;
        icon.actor.x_expand = true;
        let p = icon.actor.get_parent(); if (p) p.remove_child(icon.actor);
        target.add_child(icon.actor);
        this._reorderStrips();
        this.menu.close();        // release the drawer's grab
        this._layoutDrawer();
        this._updateArrow();

        // Forward the right-click once the grab is released and layout settles.
        Mainloop.timeout_add(90, () => {
            try {
                let [x, y, o] = icon.getEventPositionInfo(icon.actor);
                let t = global.get_current_time();
                icon.proxy.call_button_press(x, y, 3, t, o, null, null);
                icon.proxy.call_button_release(x, y, 3, t, o, null, null);
            } catch (e) {}
            return false;
        });
        // Safety: if no menu ever opens, return the icon after a short wait.
        Mainloop.timeout_add(2000, () => {
            if (icon._tempOut && !icon.proxy.secondary_menu_is_open &&
                !icon.proxy.primary_menu_is_open) {
                this.returnIconToDrawer(icon);
            }
            return false;
        });
    }

    returnIconToDrawer(icon) {
        if (!icon._tempOut) return;
        icon._tempOut = false;
        let p = icon.actor.get_parent(); if (p) p.remove_child(icon.actor);
        this._reorderStrips();
        this._layoutDrawer();   // back into the grid (still hidden)
        this._updateArrow();
    }

    _updateArrowIcon(open) {
        // Closed = down chevron (expand the drawer below); open = up (collapse).
        let base = open ? "pointer-up.svg" : "pointer-Down.svg";
        let pfx = this._dark ? "Dark-" : "Light-";
        let p = GLib.build_filenamev([this.metadata.path, "Assets", pfx + base]);
        if (GLib.file_test(p, GLib.FileTest.EXISTS)) {
            this.arrowIcon.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(p) });
        } else {
            this.arrowIcon.icon_name = open ? "pan-up-symbolic" : "pan-down-symbolic";
        }
    }

    // ---- misc lifecycle -------------------------------------------------------

    refreshIcons() {
        for (let key in this.icons) this.icons[key].refresh();
    }

    onEditModeChanged() {
        let reactive = !global.settings.get_boolean('panel-edit-mode');
        for (let key in this.icons) this.icons[key].actor.reactive = reactive;
    }

    on_orientation_changed(newOrientation) {
        this.orientation = newOrientation;
        let vertical = (newOrientation == St.Side.LEFT || newOrientation == St.Side.RIGHT);
        let stripStyle = vertical ? VERTICAL_STYLE : HORIZONTAL_STYLE;
        for (let box of [this.appStrip, this.sysStrip]) {
            box.vertical = vertical;
            box.style = stripStyle;
        }
        this.refreshIcons();
    }

    on_applet_removed_from_panel() {
        this.signalManager.disconnectAllSignals();
        for (let key in this.icons) { this.icons[key].destroy(); delete this.icons[key]; }
        this.monitor = null;
        if (this.settings) this.settings.finalize();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new Tray11Applet(metadata, orientation, panel_height, instance_id);
}
