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

// The leading token of a themed icon name, used as a stable app id.
// e.g. "blueman-active-symbolic" -> "blueman",
//      "mintupdate-updates-available-symbolic" -> "mintupdate".
function iconBase(iconName) {
    let s = iconName.split("/").pop().replace(/\.(png|svg|xpm)$/i, "");
    return s.split("-")[0].toLowerCase();
}

// A stable, app-level identity for a status icon — used to remember the
// hide/show choice across restarts. NOTE (P3 finding): proxy.get_name() returns
// the D-Bus sender (":1.66"), shared by all icons from one process and unstable
// across restarts, so it's useless here. We key on the themed icon name's base
// token instead, falling back to the tooltip for pixmap-only icons.
function persistentKey(proxy) {
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
// name plus its identity key (e.g. "blueman-active-symbolic blueman").
function classifyText(proxy) {
    return ((proxy.icon_name || "") + " " + persistentKey(proxy)).toLowerCase();
}

// One rendered status icon. Owns its St actor and forwards input to the proxy.
class TrayIcon {
    constructor(applet, proxy) {
        this.applet = applet;
        this.proxy = proxy;
        this.name = proxy.get_name();
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
        if (!iconName) { this.iconName = null; this.icon_holder.hide(); return; }

        let type = iconName.match(/symbolic/) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
        this.iconName = iconName;
        // Uniform size so colourful app icons match the panel's other icons.
        this.iconSize = this.applet.trayIconSize();
        this.proxy.icon_size = this.iconSize;

        if (iconName.includes("/") && type != St.IconType.SYMBOLIC) {
            this.icon_loader_handle = St.TextureCache.get_default().load_image_from_file_async(
                iconName,
                this.actor.vertical ? this.iconSize : -1,
                this.iconSize,
                (...args) => this._onImageLoaded(...args)
            );
            return;
        }

        let icon = new St.Icon({ "icon-type": type, "icon-size": this.iconSize, "icon-name": iconName });
        this.icon_holder.show();
        this.icon_holder.child = icon;
    }

    _onImageLoaded(cache, handle, actor, data = null) {
        if (handle !== this.icon_loader_handle) return;
        this.icon_holder.child = actor;
        this.icon_holder.show();
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

    onButtonPressEvent(actor, event) {
        // Ctrl+left-click is our interim hide/show toggle (until drag-and-drop).
        if (event.get_button() == Clutter.BUTTON_PRIMARY &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            this.applet.toggleHidden(this);
            return Clutter.EVENT_STOP;
        }

        this._tooltip.hide();
        this._tooltip.preventShow = true;

        if (event.get_button() == Clutter.BUTTON_SECONDARY &&
            event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            return Clutter.EVENT_PROPAGATE;
        }

        let [x, y, o] = this.getEventPositionInfo(actor);
        this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), o, null, null);
        return Clutter.EVENT_STOP;
    }

    onButtonReleaseEvent(actor, event) {
        if (event.get_button() == Clutter.BUTTON_PRIMARY &&
            (event.get_state() & Clutter.ModifierType.CONTROL_MASK)) {
            return Clutter.EVENT_STOP;
        }
        let [x, y, o] = this.getEventPositionInfo(actor);
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

        this.actor.remove_style_class_name('applet-box');
        this.actor.set_important(true);

        this._dark = /dark/i.test(gtkThemeName());

        // Persisted set of hidden app keys.
        this.settings = new Settings.AppletSettings(this, UUID, instance_id);
        this._hidden = new Set(this.settings.getValue("hidden-icons") || []);
        // Icon size comes from the settings dialog; refresh icons when it changes.
        this.settings.bind("icon-size", "iconSizePref", () => this.refreshIcons());

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
        this.arrowIcon = new St.Icon({ icon_size: 12 });
        this.arrowBtn.set_child(this.arrowIcon);
        this.arrowBtn.connect('clicked', () => this.menu.toggle());
        this.actor.add_actor(this.arrowBtn);

        // The drawer (a popup menu anchored to the applet).
        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.drawerBox = new St.BoxLayout({ style_class: "tray11-drawer", vertical: false });
        this.menu.box.add_actor(this.drawerBox);
        this.menu.connect('open-state-changed', (m, open) => this._updateArrowIcon(open));

        // Right-click context menu: a live list of icons with hide/show toggles.
        this._ctxSection = new PopupMenu.PopupMenuSection();
        this._applet_context_menu.addMenuItem(this._ctxSection, 0);
        this._applet_context_menu.connect('open-state-changed',
            (m, open) => { if (open) this._rebuildContextMenu(); });

        this.icons = {};                 // runtime key -> TrayIcon
        this.signalManager = new SignalManager.SignalManager(null);

        this.monitor = new XApp.StatusIconMonitor();
        this.signalManager.connect(this.monitor, "icon-added", this.onIconAdded, this);
        this.signalManager.connect(this.monitor, "icon-removed", this.onIconRemoved, this);
        this.signalManager.connect(Main.systrayManager, "changed", this.onRolesChanged, this);
        this.signalManager.connect(this.panel, "icon-size-changed", this.refreshIcons, this);
        this.signalManager.connect(global.settings, 'changed::panel-edit-mode', this.onEditModeChanged, this);

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

        let icon = new TrayIcon(this, proxy);
        this.icons[key] = icon;
        this.place(icon);
        this._updateArrow();
    }

    onIconRemoved(monitor, proxy) {
        let key = this.runtimeKey(proxy);
        let icon = this.icons[key];
        if (!icon) return;
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

    // Put an icon where it belongs: drawer (hidden), system strip, or app strip.
    place(icon) {
        let target;
        if (this._hidden.has(icon.key())) target = this.drawerBox;
        else if (this.isSystem(icon)) target = this.sysStrip;
        else target = this.appStrip;

        let cur = icon.actor.get_parent();
        if (cur !== target) {
            if (cur) cur.remove_child(icon.actor);
            target.add_child(icon.actor);
        }
        this._reorderStrips();
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
        if (hidden) this._hidden.add(key);
        else this._hidden.delete(key);
        this.settings.setValue("hidden-icons", Array.from(this._hidden));
        this.place(icon);
        this._updateArrow();
    }

    toggleHidden(icon) { this.setHidden(icon, !this._hidden.has(icon.key())); }

    // A readable label for an icon (first line of its tooltip, tags stripped).
    iconLabel(icon) {
        let t = icon.proxy.tooltip_text;
        if (t) {
            let clean = t.replace(/<[^>]+>/g, "").split("\n")[0].trim();
            if (clean) return clean;
        }
        return icon.key();
    }

    // Rebuild the live hide/show toggle list shown in the right-click menu.
    _rebuildContextMenu() {
        this._ctxSection.removeAll();
        this._ctxSection.addMenuItem(
            new PopupMenu.PopupMenuItem("Tuck away into the drawer:", { reactive: false }));

        let icons = Object.keys(this.icons).map(k => this.icons[k]);
        if (!icons.length) {
            this._ctxSection.addMenuItem(
                new PopupMenu.PopupMenuItem("(no tray icons)", { reactive: false }));
        } else {
            icons.sort((a, b) => this.iconLabel(a).localeCompare(this.iconLabel(b)));
            for (let icon of icons) {
                let sw = new PopupMenu.PopupSwitchMenuItem(
                    this.iconLabel(icon), this._hidden.has(icon.key()));
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

    // ---- arrow / drawer -------------------------------------------------------

    _updateArrow() {
        let hasHidden = this.drawerBox.get_n_children() > 0;
        this.arrowBtn.visible = hasHidden;
        if (!hasHidden && this.menu.isOpen) this.menu.close();
        this._updateArrowIcon(this.menu.isOpen);
    }

    _updateArrowIcon(open) {
        // Closed = the classic up chevron; open = down (collapse hint).
        let base = open ? "pointer-Down.svg" : "pointer-up.svg";
        let pfx = this._dark ? "Dark-" : "Light-";
        let p = GLib.build_filenamev([this.metadata.path, "Assets", pfx + base]);
        if (GLib.file_test(p, GLib.FileTest.EXISTS)) {
            this.arrowIcon.gicon = new Gio.FileIcon({ file: Gio.File.new_for_path(p) });
        } else {
            this.arrowIcon.icon_name = open ? "pan-down-symbolic" : "pan-up-symbolic";
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
