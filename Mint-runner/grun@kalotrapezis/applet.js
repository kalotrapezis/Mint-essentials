/*
 * grun — a keyboard-driven launcher, as a Cinnamon applet.
 *
 * The standalone grun is a GTK4/X11 window the WM had to place — the source of
 * the open-time flicker. This draws its UI as a Cinnamon popup (a Clutter/St
 * actor owned by the compositor), so there is no separate window to position and
 * nothing to flicker.
 *
 * It mirrors grun's UX: a search box on top, a home dashboard below (clipboard,
 * apps, files), and a settings page. It reads and writes grun's own files —
 * ~/.config/grun/config and ~/.local/share/grun/history.json — so state is
 * shared with the standalone app.
 */

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const Util = imports.misc.util;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const Lang = imports.lang;
const ByteArray = imports.byteArray;

/* ================================================================== *
 *  Matching — ported from grun's src/text.rs                          *
 * ================================================================== */

const LAT2GR = {
    a: "α", b: "β", c: "ψ", d: "δ", e: "ε", f: "φ", g: "γ", h: "η",
    i: "ι", j: "ξ", k: "κ", l: "λ", m: "μ", n: "ν", o: "ο", p: "π",
    r: "ρ", s: "σ", t: "τ", u: "θ", v: "ω", w: "ς", x: "χ", y: "υ", z: "ζ"
};
const GR2LAT = (function () {
    let m = {};
    for (let k in LAT2GR) m[LAT2GR[k]] = k;
    m["ς"] = "s";
    return m;
})();
const ACCENTS = {
    "ά": "α", "έ": "ε", "ή": "η", "ί": "ι", "ϊ": "ι", "ΐ": "ι",
    "ό": "ο", "ύ": "υ", "ϋ": "υ", "ΰ": "υ", "ώ": "ω"
};

function normalize(s) {
    s = s.toLowerCase();
    let out = "";
    for (let ch of s) out += (ACCENTS[ch] || ch);
    return out;
}
function mapStr(s, table) {
    let out = "";
    for (let ch of s) out += (table[ch] || ch);
    return out;
}
function variants(input) {
    let v = [input];
    let g2l = mapStr(input, GR2LAT); if (g2l !== input) v.push(g2l);
    let l2g = mapStr(input, LAT2GR); if (l2g !== input) v.push(l2g);
    return v;
}
function isSubsequence(needle, haystack) {
    let i = 0;
    for (let h of haystack) { if (i >= needle.length) break; if (h === needle[i]) i++; }
    return i >= needle.length;
}
function prefixDistance(q, text) {
    let qn = q.length, tn = text.length;
    if (qn === 0) return 0;
    let prev = new Array(tn + 1).fill(0), cur = new Array(tn + 1).fill(0);
    for (let i = 0; i < qn; i++) {
        cur[0] = i + 1;
        for (let j = 0; j < tn; j++) {
            let cost = q[i] === text[j] ? 0 : 1;
            cur[j + 1] = Math.min(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
        }
        let t = prev; prev = cur; cur = t;
    }
    return Math.min.apply(null, prev);
}
function tokenize(s) { return s.split(/[^\p{L}\p{N}]+/u).filter(t => t.length); }
function scoreOne(q, cand) {
    if (cand.startsWith(q)) return 1.0;
    let best = 0.0;
    if (cand.indexOf(q) !== -1) best = Math.max(best, 0.85);
    let qLen = Math.max(q.length, 1);
    for (let tok of tokenize(cand)) {
        if (tok === q) best = Math.max(best, 0.95);
        else if (tok.startsWith(q)) best = Math.max(best, 0.9);
        else if (tok.indexOf(q) !== -1) best = Math.max(best, 0.72);
        let sim = 1.0 - prefixDistance(q, tok) / qLen;
        if (sim >= 0.66) best = Math.max(best, sim * 0.85);
        if (isSubsequence(q, tok)) best = Math.max(best, 0.5);
    }
    if (isSubsequence(q, cand)) best = Math.max(best, 0.45);
    return best > 0 ? best : null;
}
function relevance(query, candidate) {
    let cand = normalize(candidate), best = 0.0;
    for (let v of variants(query)) {
        let q = normalize(v); if (!q.length) continue;
        let s = scoreOne(q, cand); if (s !== null && s > best) best = s;
    }
    return best >= 0.30 ? best : null;
}
function keywordMatch(query, text) {
    let best = 0.0;
    for (let v of variants(query)) {
        let q = normalize(v); if (q.length < 2) continue;
        for (let word of tokenize(text)) {
            let w = normalize(word), s = 0;
            if (w === q) s = 1.0;
            else if (w.startsWith(q)) s = 0.9;
            else if (q.length >= 3 && w.indexOf(q) !== -1) s = 0.75;
            if (s > best) best = s;
        }
    }
    return best >= 0.7 ? best : null;
}

/* ================================================================== *
 *  Files on disk — grun config + history                              *
 * ================================================================== */

function readText(path) {
    try {
        let [ok, data] = GLib.file_get_contents(path);
        if (!ok) return null;
        return (data instanceof Uint8Array) ? ByteArray.toString(data) : String(data);
    } catch (e) { return null; }
}
function writeText(path, text) {
    try {
        let dir = GLib.path_get_dirname(path);
        GLib.mkdir_with_parents(dir, 0o755);
        GLib.file_set_contents(path, text);
        return true;
    } catch (e) { global.logError("grun: write failed " + path + ": " + e); return false; }
}
function configPath() { return GLib.build_filenamev([GLib.get_user_config_dir(), "grun", "config"]); }
function historyPath() { return GLib.build_filenamev([GLib.get_user_data_dir(), "grun", "history.json"]); }

// The active GTK theme name (so we can read its accent and pick dark/light icons).
function gtkThemeName() {
    try { return new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" }).get_string("gtk-theme"); }
    catch (e) { return ""; }
}
// Read the theme's accent (@theme_selected_bg_color) from its GTK CSS, e.g. #ff7139.
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
function hexToRgb(hex) {
    let m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

const KNOWN_PROVIDERS = [
    ["calc", true], ["apps", true], ["files", true],
    ["search", true], ["ai", true], ["power", true], ["command", false]
];
const PROVIDER_LABELS = {
    calc: "Calculator", apps: "Apps", files: "Files", search: "Web search",
    ai: "AI chat", power: "System power", command: "Command execution"
};

function defaultConfig() {
    return {
        providers: KNOWN_PROVIDERS.map(p => ({ id: p[0], enabled: p[1] })),
        home_clipboard: true,
        home_apps: true,
        home_files: true,
        home_apps_mode: "used",
        home_files_mode: "recent",
        search_descriptions: false,
        engines: ["google", "duckduckgo", "swisscows"].map(id => ({ id: id, enabled: true })),
        assistants: ["claude", "chatgpt", "deepseek", "mistral"].map(id => ({ id: id, enabled: true }))
    };
}

function loadConfig() {
    let cfg = defaultConfig();
    let text = readText(configPath());
    if (!text) return cfg;
    let providers = [];
    for (let raw of text.split("\n")) {
        let line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        let eq = line.indexOf("=");
        if (eq < 0) continue;
        let key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        let on = (v) => (v === "on" || v === "true" || v === "1" || v === "yes");
        if (key === "home_clipboard") { cfg.home_clipboard = on(val); continue; }
        if (key === "home_apps") { cfg.home_apps = on(val); continue; }
        if (key === "home_files") { cfg.home_files = on(val); continue; }
        if (key === "home_apps_mode") { if (val === "used" || val === "recent") cfg.home_apps_mode = val; continue; }
        if (key === "home_files_mode") { if (val === "used" || val === "recent") cfg.home_files_mode = val; continue; }
        if (key === "search_descriptions") { cfg.search_descriptions = on(val); continue; }
        if (key === "position" || key === "focus_delay_ms" || key === "fullscreen" ||
            key === "lock_settings" || key === "follow_pointer") continue;
        if (key === "actions.Search") { cfg.engines = parseActionOrder(val, ["google", "duckduckgo", "swisscows"]); continue; }
        if (key === "actions.AI") { cfg.assistants = parseActionOrder(val, ["claude", "chatgpt", "deepseek", "mistral"]); continue; }
        if (key.startsWith("actions.")) continue;
        if (KNOWN_PROVIDERS.some(p => p[0] === key) && !providers.some(p => p.id === key))
            providers.push({ id: key, enabled: on(val) });
    }
    for (let p of KNOWN_PROVIDERS)
        if (!providers.some(x => x.id === p[0])) providers.push({ id: p[0], enabled: p[1] });
    if (providers.length) cfg.providers = providers;
    return cfg;
}

// "id:on,id:off" -> ordered [{id, enabled}], keeping all known ids (first = default).
function parseActionOrder(val, known) {
    let seen = {}, order = [];
    for (let tok of val.split(",")) {
        let c = tok.indexOf(":");
        if (c < 0) continue;
        let id = tok.slice(0, c).trim();
        let on = tok.slice(c + 1).trim();
        if (known.indexOf(id) === -1 || seen[id]) continue;
        seen[id] = true;
        order.push({ id: id, enabled: (on === "on" || on === "true" || on === "1" || on === "yes") });
    }
    for (let k of known) if (!seen[k]) order.push({ id: k, enabled: true });
    return order;
}

function saveConfig(cfg) {
    let body = "# grun functions, in priority order\n";
    for (let p of cfg.providers) body += p.id + "=" + (p.enabled ? "on" : "off") + "\n";
    body += "home_clipboard=" + (cfg.home_clipboard ? "on" : "off") + "\n";
    body += "home_apps=" + (cfg.home_apps ? "on" : "off") + "\n";
    body += "home_files=" + (cfg.home_files ? "on" : "off") + "\n";
    body += "home_apps_mode=" + cfg.home_apps_mode + "\n";
    body += "home_files_mode=" + cfg.home_files_mode + "\n";
    body += "search_descriptions=" + (cfg.search_descriptions ? "on" : "off") + "\n";
    body += "actions.Search=" + cfg.engines.map(e => e.id + ":" + (e.enabled ? "on" : "off")).join(",") + "\n";
    body += "actions.AI=" + cfg.assistants.map(e => e.id + ":" + (e.enabled ? "on" : "off")).join(",") + "\n";
    writeText(configPath(), body);
}

/* -------- history.json (clips / app usage / files) ---------------- */

function loadHistory() {
    let h = { clips: [], apps: [], files: [], file_uses: [],
              hidden_files: [], hidden_apps: [], hidden_power: [],
              home_hidden_apps: [], home_hidden_files: [] };
    let text = readText(historyPath());
    if (!text) return h;
    try {
        let j = JSON.parse(text);
        for (let k in h) if (Array.isArray(j[k])) h[k] = j[k];
    } catch (e) {}
    return h;
}
function saveHistory(h) { writeText(historyPath(), JSON.stringify(h, null, 2)); }
function nowSecs() { return Math.floor(GLib.get_real_time() / 1000000); }

function topApps(h, n) {
    let a = h.apps.slice();
    a.sort((x, y) => (y.count - x.count) || (y.last - x.last));
    return a.slice(0, n).map(x => x.id);
}
function recentApps(h, n) {
    let a = h.apps.slice();
    a.sort((x, y) => y.last - x.last);
    return a.slice(0, n).map(x => x.id);
}
function mostUsedFiles(h, n) {
    let a = h.file_uses.slice();
    a.sort((x, y) => (y.count - x.count) || (y.last - x.last));
    return a.slice(0, n).map(x => x.id);
}
function visibleClips(h) {
    let pinned = h.clips.filter(c => c.pinned && !c.hidden).sort((a, b) => b.ts - a.ts);
    let rest = h.clips.filter(c => !c.pinned && !c.hidden).sort((a, b) => b.ts - a.ts);
    return pinned.concat(rest);
}
function recordAppLaunch(h, id) {
    let a = h.apps.find(x => x.id === id);
    if (a) { a.count++; a.last = nowSecs(); }
    else h.apps.push({ id: id, count: 1, last: nowSecs() });
}
function recordFile(h, path) {
    h.files = h.files.filter(p => p !== path);
    h.files.unshift(path);
    if (h.files.length > 40) h.files.length = 40;
    let f = h.file_uses.find(x => x.id === path);
    if (f) { f.count++; f.last = nowSecs(); }
    else h.file_uses.push({ id: path, count: 1, last: nowSecs() });
}
// Read the freedesktop recent list so "recent files" is populated immediately.
function systemRecentFiles(n) {
    let text = readText(GLib.build_filenamev([GLib.get_user_data_dir(), "recently-used.xbel"]));
    if (!text) return [];
    let out = [], seen = {};
    let re = /href="file:\/\/([^"]+)"/g, m;
    while ((m = re.exec(text)) !== null) {
        let p; try { p = decodeURIComponent(m[1]); } catch (e) { p = m[1]; }
        if (!seen[p]) { seen[p] = true; out.push(p); }
    }
    out.reverse();
    return out.slice(0, n);
}

/* ================================================================== *
 *  Calculator / power / web / AI                                      *
 * ================================================================== */

function formatNumber(n) {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
function queryCalc(q) {
    let s = q.trim();
    if (!/[0-9]/.test(s)) return [];
    if (!/^[0-9+\-*/(). %]+$/.test(s)) return [];
    let val; try { val = Function('"use strict"; return (' + s + ');')(); } catch (e) { return []; }
    if (typeof val !== "number" || !isFinite(val)) return [];
    let out = formatNumber(val);
    return [{ title: out, subtitle: "Press Enter to copy", iconName: "accessories-calculator",
        score: 2.0, category: "Calculator",
        run: function () { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, out); } }];
}

const POWER = [
    { label: "Power off", aliases: ["shutdown", "power off", "poweroff", "turn off"], icon: "system-shutdown", cmd: "systemctl poweroff" },
    { label: "Restart", aliases: ["restart", "reboot"], icon: "system-reboot", cmd: "systemctl reboot" },
    { label: "Sleep", aliases: ["sleep", "suspend"], icon: "system-suspend", cmd: "systemctl suspend" },
    { label: "Hibernate", aliases: ["hibernate"], icon: "system-hibernate", cmd: "systemctl hibernate" },
    { label: "Lock screen", aliases: ["lock", "lock screen"], icon: "system-lock-screen", cmd: "loginctl lock-session" },
    { label: "Log out", aliases: ["log out", "logout", "sign out"], icon: "system-log-out", cmd: "loginctl terminate-session \"$XDG_SESSION_ID\"" }
];
function powerLabel(cmd) {
    let p = POWER.find(x => x.cmd === cmd);
    return p ? p.label : null;
}
function queryPower(q) {
    if (q.trim().length < 2) return [];
    let out = [];
    for (let a of POWER) {
        let best = 0.0;
        for (let alias of a.aliases) { let r = relevance(q.trim(), alias); if (r !== null && r > best) best = r; }
        if (best >= 0.6)
            out.push({ title: a.label, subtitle: a.cmd, iconName: a.icon, score: best, category: "System",
                run: (function (cmd) { return function () { Util.spawnCommandLine("bash -c " + GLib.shell_quote(cmd)); }; })(a.cmd) });
    }
    return out;
}

function openUrl(url) {
    try { Gio.app_info_launch_default_for_uri(url, null); }
    catch (e) { Util.spawnCommandLine("xdg-open " + GLib.shell_quote(url)); }
}
const ENGINES = {
    google: { label: "Google", url: q => "https://www.google.com/search?q=" + q },
    duckduckgo: { label: "DuckDuckGo", url: q => "https://duckduckgo.com/?q=" + q },
    swisscows: { label: "Swisscows", url: q => "https://swisscows.com/en/web?query=" + q }
};
const ASSISTANTS = {
    claude: { label: "Claude", url: q => "https://claude.ai/new?q=" + q },
    chatgpt: { label: "ChatGPT", url: q => "https://chatgpt.com/?q=" + q },
    deepseek: { label: "DeepSeek", url: q => "https://chat.deepseek.com/?q=" + q },
    mistral: { label: "Mistral", url: q => "https://chat.mistral.ai/chat?q=" + q }
};
function buildPicker(map, order, q, title, baseScore, category, iconName) {
    if (q.trim().length < 2) return [];
    let enc = encodeURIComponent(q.trim());
    let keys = order.filter(k => map[k]);
    if (!keys.length) keys = Object.keys(map);
    let primary = map[keys[0]];
    let actions = keys.map(k => ({ label: map[k].label,
        run: (function (u) { return function () { openUrl(u); }; })(map[k].url(enc)) }));
    return [{ title: title, subtitle: "Press Enter to use " + primary.label, iconName: iconName,
        score: baseScore, category: category, actions: actions,
        run: (function (u) { return function () { openUrl(u); }; })(primary.url(enc)) }];
}

// Result category -> provider id, so results can be ordered by the configured
// function priority (settings order), not just by score.
const CAT_PROVIDER = {
    "Apps": "apps", "Calculator": "calc", "Files": "files",
    "Search": "search", "AI": "ai", "System": "power", "Run command": "command"
};

function classifyApp(a) {
    let cmd = "";
    try { cmd = (a.get_commandline() || "").toLowerCase(); } catch (e) {}
    if (cmd.indexOf("flatpak") !== -1) return "Flatpak";
    if (cmd.indexOf("/snap/") !== -1 || cmd.indexOf("snap run") !== -1) return "Snap";
    if (cmd.indexOf(".appimage") !== -1) return "AppImage";
    return "System";
}
function basename(p) { let i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function isImagePath(p) { return /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i.test(p); }
function tagClass(tag) {
    switch (tag) {
        case "System": return "grun-tag-system";
        case "Flatpak": return "grun-tag-flatpak";
        case "Snap": return "grun-tag-snap";
        case "AppImage": return "grun-tag-appimage";
        default: return "";
    }
}
function fileGicon(path) {
    try {
        let f = Gio.File.new_for_path(path);
        let info = f.query_info("standard::icon", Gio.FileQueryInfoFlags.NONE, null);
        return info.get_icon();
    } catch (e) { return null; }
}

/* ================================================================== *
 *  Applet                                                            *
 * ================================================================== */

function MyApplet(metadata, orientation, panel_height, instance_id) {
    this._init(metadata, orientation, panel_height, instance_id);
}

MyApplet.prototype = {
    __proto__: Applet.IconApplet.prototype,

    _init: function (metadata, orientation, panel_height, instance_id) {
        Applet.IconApplet.prototype._init.call(this, orientation, panel_height, instance_id);

        this.metadata = metadata;
        this.set_applet_tooltip("grun — click or press the shortcut to search");

        // Follow the GTK theme live: the panel icon (and popup colours) switch
        // between the dark and light variants when the theme changes.
        this._ifaceSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
        this._themeWatchId = this._ifaceSettings.connect("changed::gtk-theme",
            Lang.bind(this, this._onThemeChanged));

        this.aSettings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this.aSettings.bind("max-results", "maxResults");
        this.aSettings.bind("hotkey", "hotkey", this._bindHotkey);

        this.cfg = loadConfig();
        this.history = loadHistory();
        this._historyDirty = false;
        this._buildAppIndex();

        this._refreshTheme();
        this._perRow = 3;
        // Chosen layout values.
        this._showTuner = false;
        this._tune = { cardW: 300, h: 640, cardH: 150, leftW: 88 };

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._buildUI();

        this._results = [];
        this._rows = [];
        this._selected = -1;
        this._generation = 0;
        this._filesTimer = 0;
        this._mode = "home";   // "home" | "search" | "settings"

        this.menu.connect("open-state-changed", Lang.bind(this, this._onOpenStateChanged));
        this._bindHotkey();
        this._startClipboardWatch();
    },

    _buildAppIndex: function () {
        this._appIndex = {};   // id -> AppInfo
        this._apps = [];
        let all = Gio.AppInfo.get_all();
        for (let i = 0; i < all.length; i++) {
            let a = all[i];
            if (!a.should_show()) continue;
            this._apps.push(a);
            let id = a.get_id();
            if (id) this._appIndex[id] = a;
        }
    },

    _refreshTheme: function () {
        let name = gtkThemeName();
        this._dark = /dark/i.test(name);
        this._accentHex = readAccent(name) || "#888888";
        this._accentRgb = hexToRgb(this._accentHex) || { r: 136, g: 136, b: 136 };
        // Dual-tone: a grey-blue popup with darker blue-grey cards, hover a touch
        // brighter than the card (like the Cinnamon menu).
        if (this._dark) {
            this._bg = "#2d3038"; this._cardBg = "#23262e"; this._cardHover = "#313640";
        } else {
            this._bg = "#edeff3"; this._cardBg = "#e2e5eb"; this._cardHover = "#d6dae2";
        }
        this._applyAppletIcon();
    },
    // Pick the panel icon variant that matches the current theme.
    _applyAppletIcon: function () {
        let variant = this._dark ? "icon-dark.png" : "icon-light.png";
        let p = GLib.build_filenamev([this.metadata.path, variant]);
        if (!GLib.file_test(p, GLib.FileTest.EXISTS))
            p = GLib.build_filenamev([this.metadata.path, "icon.png"]);
        this.set_applet_icon_path(p);
    },
    // React to a live GTK theme switch (light <-> dark).
    _onThemeChanged: function () {
        this._refreshTheme();
    },
    _accentRGBA: function (a) {
        let c = this._accentRgb;
        return "rgba(" + c.r + "," + c.g + "," + c.b + "," + a + ")";
    },
    // Path to a themed SVG asset (dark/light variant), or null if missing.
    _asset: function (base) {
        let pfx = this._dark ? "Dark-" : "Light-";
        let p = GLib.build_filenamev([this.metadata.path, "Assets", pfx + base]);
        return GLib.file_test(p, GLib.FileTest.EXISTS) ? p : null;
    },
    _assetGicon: function (base) {
        let p = this._asset(base);
        if (!p) return null;
        try { return new Gio.FileIcon({ file: Gio.File.new_for_path(p) }); } catch (e) { return null; }
    },

    // Size the popup. Normal = fixed grun-like box; big = near-fullscreen "start
    // menu" with 6 cards per row and larger search/result text.
    _applySize: function () {
        let mon = Main.layoutManager.primaryMonitor || { width: 1280, height: 800 };
        this._perRow = 3;
        const ROOT_PAD = 10, ROW_SPACING = 8, GRID_PAD = 4;
        let gaps = (this._perRow - 1) * ROW_SPACING;

        // The cards (fixed width) define the layout width. The container hugs the
        // card grid, and the search bar / headers x_expand to that same width, so
        // everything lines up with only the symmetric root padding.
        let cardW = this._tune.cardW;
        this._cardW = cardW;
        this._cardH = this._tune.cardH;
        this._contentW = this._perRow * cardW + gaps + GRID_PAD;
        this._maxH = Math.min(this._tune.h, mon.height - 140);

        // Fixed box: pin the popup to one stable size so neither home nor search
        // content can resize it (this is how the Cinnamon menu avoids resizing —
        // explicit width/height, scroll inside). The width is the home card grid
        // width; the height is the design height capped to the monitor.
        this._boxH = this._maxH;
        // Each card adds padding + border the column math above doesn't count, so
        // the background falls short of the actual card-grid width. This empirical
        // correction widens the box to cover the cards fully.
        const BG_CORRECTION = 107;
        if (this._root) {
            this._root.style = "padding:" + ROOT_PAD + "px; background-color:" + this._bg + ";";
            this._root.set_width(this._contentW + 2 * ROOT_PAD + BG_CORRECTION);
        }
        this._fitHeight();
        this._setBarFocused(this._barFocused !== false);
    },

    // Fixed-box height: the scroll area is always the same height regardless of
    // how much content there is, so the popup never grows/shrinks as you type or
    // switch between home and search. Overflow scrolls inside.
    _fitHeight: function () {
        if (!this._scroll) return;
        this._scroll.set_height(this._boxH || this._maxH || 720);
    },

    _setBarFocused: function (on) {
        this._barFocused = on;
        if (!this._bar) return;
        // The bar x_expands to the content width; only the glow is toggled here.
        this._bar.style = on ? ("border-color:" + this._accentHex +
            "; box-shadow: 0 0 6px " + this._accentRGBA(0.55) + ";") : "";
    },

    _bindHotkey: function () {
        try { Main.keybindingManager.addHotKey("grun-open", this.hotkey, Lang.bind(this, this._toggle)); }
        catch (e) { global.logError("grun: hotkey bind failed: " + e); }
    },
    _toggle: function () { this.menu.toggle(); },
    on_applet_clicked: function () { this.menu.toggle(); },

    /* ---------------- UI skeleton ---------------- */

    _buildUI: function () {
        let root = new St.BoxLayout({ vertical: true, style_class: "grun-root" });
        this._root = root;

        // One bordered search bar holding the entry plus the fullscreen and gear
        // buttons (like grun), so the icons sit inside the search box.
        let bar = new St.BoxLayout({ style_class: "grun-searchbar", x_expand: true });
        this._bar = bar;
        this._search = new St.Entry({
            style_class: "grun-search",
            hint_text: "Search apps, files, the web…  (try 12*3, 'shutdown', '*.pdf')",
            can_focus: true, track_hover: true, x_expand: true
        });
        this._search.set_y_align(Clutter.ActorAlign.CENTER);
        this._search.clutter_text.connect("text-changed", Lang.bind(this, this._onTextChanged));
        this._search.clutter_text.connect("key-press-event", Lang.bind(this, this._onKeyPress));
        bar.add_child(this._search);

        this._gear = new St.Button({ style_class: "grun-iconbtn", child:
            new St.Icon({ icon_name: "emblem-system-symbolic", icon_size: 18 }) });
        this._gear.set_y_align(Clutter.ActorAlign.CENTER);
        this._gear.connect("clicked", Lang.bind(this, this._toggleSettings));
        bar.add_child(this._gear);
        root.add_child(bar);

        this._scroll = new St.ScrollView({ style_class: "grun-scroll", x_expand: true, y_expand: true });
        this._scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._list = new St.BoxLayout({ vertical: true, style_class: "grun-list" });
        this._scroll.add_actor(this._list);
        root.add_child(this._scroll);

        root.x_expand = true;
        this.menu.box.add_child(root);
        // Let the root fill the menu container edge-to-edge so its background
        // covers all content (the themed popup padding otherwise leaves an
        // uncovered strip the cards can extend into).
        try { this.menu.box.style = "padding: 0px; margin: 0px;"; } catch (e) {}
        this._applySize();
    },

    _onOpenStateChanged: function (menu, open) {
        if (!open) { this._flushHistory(); return; }
        this._refreshTheme();
        this._applySize();
        this.cfg = loadConfig();
        this.history = loadHistory();
        this._mode = "home";
        this._homeNav = false;
        this._cardSel = -1;
        this._search.set_text("");
        this._setBarFocused(true);
        this._generation++;
        this._renderHome();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, Lang.bind(this, function () {
            global.stage.set_key_focus(this._search.clutter_text);
            return GLib.SOURCE_REMOVE;
        }));
    },

    /* ---------------- search ---------------- */

    _onTextChanged: function () {
        if (this._mode === "settings") return;
        let q = this._search.get_text();
        this._generation++;
        let gen = this._generation;

        if (!q || !q.trim().length) { this._mode = "home"; this._homeNav = false; this._setBarFocused(true); this._renderHome(); return; }
        this._mode = "search";
        this._homeNav = false;
        this._setBarFocused(true);
        this._render(this._build(q));

        if (this._filesTimer) { GLib.source_remove(this._filesTimer); this._filesTimer = 0; }
        if (this._providerEnabled("files") && q.trim().length >= 3) {
            this._filesTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, Lang.bind(this, function () {
                this._filesTimer = 0;
                this._queryFiles(q.trim(), gen);
                return GLib.SOURCE_REMOVE;
            }));
        }
    },

    _providerEnabled: function (id) {
        let p = this.cfg.providers.find(x => x.id === id);
        return p ? p.enabled : true;
    },

    _build: function (q) {
        let r = [];
        if (this._providerEnabled("apps")) r = r.concat(this._queryApps(q));
        if (this._providerEnabled("calc")) r = r.concat(queryCalc(q));
        if (this._providerEnabled("power")) {
            // Power actions share the apps' hidden list (one list, not three).
            let pw = queryPower(q).filter(m => this.history.hidden_apps.indexOf(m.subtitle) === -1);
            pw.forEach(Lang.bind(this, function (m) {
                m.actions = [{ label: "Hide", keepOpen: true,
                    run: (function (self, cmd) { return function () { self._hideAppFromSearch(cmd); }; })(this, m.subtitle) }];
            }));
            r = r.concat(pw);
        }
        if (this._providerEnabled("search")) {
            let order = this.cfg.engines.filter(e => e.enabled).map(e => e.id);
            if (order.length) {
                let s = buildPicker(ENGINES, order, q,
                    "Search the web for “" + q.trim() + "”", 0.5, "Search", "system-search");
                if (s[0]) { let g = this._assetGicon("search.svg"); if (g) s[0].gicon = g; }
                r = r.concat(s);
            }
        }
        if (this._providerEnabled("ai")) {
            let order = this.cfg.assistants.filter(e => e.enabled).map(e => e.id);
            if (order.length) {
                let s = buildPicker(ASSISTANTS, order, q,
                    "Ask AI: “" + q.trim() + "”", 0.48, "AI", "dialog-question");
                if (s[0]) { let g = this._assetGicon(this._dark ? "Ai.svg" : "AI.svg"); if (g) s[0].gicon = g; }
                r = r.concat(s);
            }
        }
        if (this._providerEnabled("command")) {
            r.push({ title: "Run: " + q.trim(), subtitle: "Execute as a shell command",
                iconName: "utilities-terminal", score: 0.4, category: "Run command",
                run: (function (cmd) { return function () { Util.spawnCommandLine("bash -c " + GLib.shell_quote(cmd)); }; })(q.trim()) });
        }
        return this._sortResults(r).slice(0, this.maxResults);
    },

    // Order by the configured function priority (settings), then by score within
    // the same function.
    _sortResults: function (arr) {
        let order = this.cfg.providers.map(p => p.id);
        let prio = function (m) {
            let i = order.indexOf(CAT_PROVIDER[m.category]);
            return i < 0 ? 999 : i;
        };
        arr.sort(function (a, b) { return (prio(a) - prio(b)) || (b.score - a.score); });
        return arr;
    },

    _queryApps: function (q) {
        let out = [];
        for (let a of this._apps) {
            let id = a.get_id();
            if (id && this.history.hidden_apps.indexOf(id) !== -1) continue;
            let name = a.get_display_name() || "";
            let score = relevance(q, name);
            if (this.cfg.search_descriptions) {
                let extra = a.get_description() || "";
                try {
                    if (typeof a.get_generic_name === "function" && a.get_generic_name())
                        extra += " " + a.get_generic_name();
                    if (typeof a.get_keywords === "function") {
                        let kw = a.get_keywords(); if (kw && kw.length) extra += " " + kw.join(" ");
                    }
                } catch (e) {}
                let km = keywordMatch(q, extra);
                if (km !== null) { let s = Math.min(km * 0.7, 0.6); score = (score === null) ? s : Math.max(score, s); }
            }
            if (score === null) continue;
            let count = 0; let st = this.history.apps.find(x => x.id === id); if (st) count = st.count;
            out.push({ title: name, subtitle: a.get_description() || "", gicon: a.get_icon(),
                score: score + Math.min(count * 0.02, 0.15), category: "Apps", tag: classifyApp(a),
                actions: id ? [{ label: "Hide", keepOpen: true,
                    run: (function (self, key) { return function () { self._hideAppFromSearch(key); }; })(this, id) }] : [],
                run: Lang.bind(this, function () { this._launchApp(a); }) });
        }
        return out;
    },

    _launchApp: function (a) {
        try { a.launch([], null); } catch (e) { global.logError("grun: launch failed: " + e); }
        let id = a.get_id();
        if (id) { recordAppLaunch(this.history, id); this._historyDirty = true; }
    },
    _openFile: function (path) {
        openUrl("file://" + encodeURI(path));
        recordFile(this.history, path); this._historyDirty = true;
    },

    _queryFiles: function (q, gen) {
        let safe = q.replace(/["'`$\\\n]/g, "");
        if (!safe.length) return;
        let cmd = 'find "$HOME" -maxdepth 6 -iname "*' + safe + '*" -not -path "*/.*" 2>/dev/null | head -n 20';
        let proc;
        try { proc = Gio.Subprocess.new(["bash", "-c", cmd], Gio.SubprocessFlags.STDOUT_PIPE); }
        catch (e) { return; }
        proc.communicate_utf8_async(null, null, Lang.bind(this, function (p, res) {
            if (gen !== this._generation) return;
            let ok, stdout; try { [ok, stdout] = p.communicate_utf8_finish(res); } catch (e) { return; }
            if (!stdout) return;
            let lines = stdout.split("\n").filter(l => l.length);
            let fres = lines.filter(path => this.history.hidden_files.indexOf(path) === -1).map(Lang.bind(this, function (path) {
                return { title: basename(path), subtitle: path, gicon: fileGicon(path), iconName: "text-x-generic",
                    score: 0.35, category: "Files",
                    actions: [
                        { label: "Copy path", keepOpen: true, run: Lang.bind(this, function () { this._copyPath(path); }) },
                        { label: "Open in folder", run: Lang.bind(this, function () { this._openFolder(path); }) },
                        { label: "Hide", keepOpen: true, run: Lang.bind(this, function () { this._hideFileFromSearch(path); }) }
                    ],
                    run: Lang.bind(this, function () { this._openFile(path); }) };
            }));
            this._appendResults(fres);
        }));
    },
    _appendResults: function (extra) {
        let merged = this._sortResults(this._results.concat(extra));
        this._render(merged.slice(0, this.maxResults));
    },

    /* ---------------- result list rendering ---------------- */

    _render: function (results) {
        this._list.destroy_all_children();
        this._results = results;
        this._rows = [];
        this._selected = -1;
        if (!results.length) {
            if (this._search.get_text().trim().length)
                this._list.add_child(new St.Label({ text: "No results", style_class: "grun-empty" }));
            return;
        }
        for (let i = 0; i < results.length; i++) {
            let row = this._makeRow(results[i], i);
            this._rows.push(row);
            this._list.add_child(row);
        }
        this._setSelected(0);
        this._fitHeight();
    },

    _makeRow: function (r, index) {
        let row = new St.BoxLayout({ style_class: "grun-row", reactive: true, track_hover: true, x_expand: true });
        let isz = 32;
        let icon;
        if (r.gicon) icon = new St.Icon({ gicon: r.gicon, icon_size: isz });
        else icon = new St.Icon({ icon_name: r.iconName || "application-x-executable", icon_size: isz });
        icon.set_y_align(Clutter.ActorAlign.CENTER);
        row.add_child(icon);

        let textBox = new St.BoxLayout({ vertical: true, style_class: "grun-row-text", x_expand: true });
        textBox.set_y_align(Clutter.ActorAlign.CENTER);
        textBox.add_child(new St.Label({ text: r.title, style_class: "grun-title" }));
        if (r.subtitle) {
            let sub = new St.Label({ text: r.subtitle, style_class: "grun-subtitle" });
            sub.clutter_text.set_line_wrap(false);
            sub.clutter_text.ellipsize = 3;
            textBox.add_child(sub);
        }
        row.add_child(textBox);

        if (r.tag) {
            let tag = new St.Label({ text: r.tag, style_class: "grun-tag" });
            tag.set_y_align(Clutter.ActorAlign.CENTER);
            row.add_child(tag);
        }
        if (r.actions && r.actions.length) {
            let chips = new St.BoxLayout({ style_class: "grun-chips" });
            chips.set_y_align(Clutter.ActorAlign.CENTER);
            for (let a of r.actions) {
                let chip = new St.Button({ label: a.label, style_class: "grun-chip" });
                chip.connect("clicked", (function (self, act) {
                    return function () { act.run(); if (!act.keepOpen) self.menu.close(); };
                })(this, a));
                chips.add_child(chip);
            }
            row.add_child(chips);
        }
        let click = new Clutter.ClickAction();
        click.connect("clicked", Lang.bind(this, function () { this._activate(index); }));
        row.add_action(click);
        row.connect("enter-event", Lang.bind(this, function () { this._setSelected(index); }));
        return row;
    },

    _setSelected: function (index) {
        if (index < 0 || index >= this._rows.length) return;
        if (this._selected >= 0 && this._rows[this._selected])
            this._rows[this._selected].style = "";
        this._selected = index;
        let row = this._rows[index];
        row.style = "background-color:" + this._accentRGBA(0.22) + ";";
        this._ensureVisible(row);
    },
    _move: function (delta) {
        if (!this._rows.length) return;
        let n = this._rows.length;
        let i = this._selected < 0 ? 0 : (this._selected + delta + n) % n;
        this._setSelected(i);
    },
    _ensureVisible: function (row) {
        let vbar = this._scroll.get_vscroll_bar(); if (!vbar) return;
        let adj = vbar.get_adjustment(); let box = row.get_allocation_box();
        if (box.y1 < adj.value) adj.set_value(box.y1);
        else if (box.y2 > adj.value + adj.page_size) adj.set_value(box.y2 - adj.page_size);
    },
    _activate: function (index) {
        if (index < 0 || index >= this._results.length) return;
        let r = this._results[index];
        this.menu.close();
        try { r.run(); } catch (e) { global.logError("grun: run failed: " + e); }
    },

    /* ---------------- home dashboard ---------------- */

    _renderHome: function () {
        let prevSel = this._cardSel;
        this._list.destroy_all_children();
        this._results = []; this._rows = []; this._selected = -1;
        this._cards = []; this._cardSel = -1;
        this._sectionGrids = {};
        if (!this._expanded) this._expanded = { Clipboard: false, Apps: false, Files: false };

        if (this._showTuner) this._list.add_child(this._tunerPanel());

        let h = this.history, c = this.cfg, any = false, letterIdx = 0;
        let nextLetter = function () { return letterIdx < 26 ? String.fromCharCode(65 + letterIdx++) : null; };
        let per = this._perRow;
        let cap = Lang.bind(this, function (key) { return this._expanded[key] ? per * 2 : per; });

        if (c.home_clipboard) {
            let clips = visibleClips(h);
            let shown = clips.slice(0, cap("Clipboard"));
            if (shown.length) {
                any = true;
                this._list.add_child(this._sectionHeaderExpand("Clipboard", "Clipboard", clips.length > per));
                this._addSectionGrid("Clipboard", shown.map(Lang.bind(this, function (clip) {
                    let isImg = clip.kind === "image";
                    let ctext = clip.text.replace(/\s+/g, " ").trim();
                    if (ctext.length > 95) ctext = ctext.slice(0, 95) + "…";
                    return this._bigCard(nextLetter(), {
                        section: "Clipboard",
                        kind: isImg ? "clipimg" : "cliptext",
                        title: isImg ? "" : ctext,
                        imagePath: isImg ? clip.path : null, iconName: "edit-paste",
                        actions: [
                            { label: clip.pinned ? "Unpin" : "Pin", run: Lang.bind(this, function () { this._togglePin(clip); }) },
                            { label: "Remove", run: Lang.bind(this, function () { this._removeClip(clip); }) }
                        ],
                        primary: Lang.bind(this, function () {
                            this.menu.close();
                            if (!isImg) St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, clip.text);
                        })
                    });
                })));
            }
        }

        let appAll = c.home_apps ? (c.home_apps_mode === "recent" ? recentApps(h, 24) : topApps(h, 24))
            .filter(id => this._appIndex[id] && h.home_hidden_apps.indexOf(id) === -1) : [];
        let appIds = appAll.slice(0, cap("Apps"));
        if (appIds.length) {
            any = true;
            this._list.add_child(this._sectionHeaderExpand("Apps", "Apps", appAll.length > per));
            this._addSectionGrid("Apps", appIds.map(Lang.bind(this, function (id) {
                let a = this._appIndex[id], tag = classifyApp(a);
                let actions = [{ label: "Show details", run: Lang.bind(this, function () { this._showDetails(a); }) }];
                if (tag === "Flatpak") actions.push({ label: "Uninstall", run: Lang.bind(this, function () { this._uninstall(a); }) });
                actions.push({ label: "Hide", run: Lang.bind(this, function () { this._hideHomeApp(id); }) });
                return this._bigCard(nextLetter(), {
                    section: "Apps",
                    kind: "app", title: a.get_display_name(), gicon: a.get_icon(), tag: tag, actions: actions,
                    primary: Lang.bind(this, function () { this.menu.close(); this._launchApp(a); })
                });
            })));
        }

        let fileAll = c.home_files ? (c.home_files_mode === "used" ? mostUsedFiles(h, 24) : systemRecentFiles(24))
            .filter(p => h.home_hidden_files.indexOf(p) === -1 && h.hidden_files.indexOf(p) === -1
                && GLib.file_test(p, GLib.FileTest.EXISTS)) : [];
        let files = fileAll.slice(0, cap("Files"));
        if (files.length) {
            any = true;
            this._list.add_child(this._sectionHeaderExpand("Files", "Files", fileAll.length > per));
            this._addSectionGrid("Files", files.map(Lang.bind(this, function (p) {
                return this._bigCard(nextLetter(), {
                    section: "Files",
                    kind: "file", title: basename(p), sub: p, imagePath: p,
                    gicon: fileGicon(p), iconName: "text-x-generic",
                    actions: [
                        { label: "Copy path", run: Lang.bind(this, function () { this._copyPath(p); }) },
                        { label: "Open in folder", run: Lang.bind(this, function () { this._openFolder(p); }) },
                        { label: "Hide", run: Lang.bind(this, function () { this._hideHomeFile(p); }) }
                    ],
                    primary: Lang.bind(this, function () { this.menu.close(); this._openFile(p); })
                });
            })));
        }

        if (!any)
            this._list.add_child(new St.Label({
                text: "Type to search apps, files, the web, or do maths.\nYour most-used apps and recent files will appear here.",
                style_class: "grun-empty" }));

        // Keep the keyboard selection across re-renders (e.g. after Pin/Hide).
        if (this._homeNav && this._cards.length)
            this._selectCard(Math.min(prevSel < 0 ? 0 : prevSel, this._cards.length - 1));
        this._pendingAnim = null;
        this._fitHeight();
    },

    /* card keyboard navigation */
    _selectCard: function (i) {
        if (this._cardSel >= 0 && this._cards[this._cardSel])
            this._cards[this._cardSel].actor.style = this._cards[this._cardSel].baseStyle;
        this._cardSel = i;
        if (i >= 0 && this._cards[i]) {
            this._cards[i].actor.style = this._cards[i].baseStyle +
                "border-color:" + this._accentHex + "; background-color:" + this._accentRGBA(0.16) + ";";
            this._ensureVisible(this._cards[i].actor);
        }
    },
    _selectCardByLetter: function (L) {
        for (let i = 0; i < this._cards.length; i++)
            if (this._cards[i].letter === L) { this._selectCard(i); return; }
    },
    _moveCard: function (d) {
        if (!this._cards.length) return;
        let i = this._cardSel < 0 ? 0 : Math.max(0, Math.min(this._cards.length - 1, this._cardSel + d));
        this._selectCard(i);
    },
    _runCardPrimary: function () {
        if (this._cardSel >= 0 && this._cards[this._cardSel] && this._cards[this._cardSel].primary)
            this._cards[this._cardSel].primary();
    },
    // Space toggles the expand/collapse of the selected card's section.
    _expandSelectedSection: function () {
        if (this._cardSel < 0 || !this._cards[this._cardSel]) return;
        let key = this._cards[this._cardSel].section;
        if (key) this._toggleSection(key);
    },
    _runCardAction: function (n) {
        if (this._cardSel < 0 || !this._cards[this._cardSel]) return;
        let acts = this._cards[this._cardSel].actions;
        if (n >= 0 && n < acts.length) acts[n]();
    },

    _sectionHeader: function (text) { return new St.Label({ text: text, style_class: "grun-section" }); },

    // TEMP layout tuner: live +/- steppers for the key numbers.
    _tunerPanel: function () {
        let panel = new St.BoxLayout({ style_class: "grun-cardrow", style: "spacing: 14px; padding: 4px 6px;" });
        let specs = [["cardW", 10], ["h", 10], ["cardH", 4], ["leftW", 4]];
        for (let s of specs) panel.add_child(this._tunerRow(s[0], s[1]));
        return panel;
    },
    _tunerRow: function (key, step) {
        let row = new St.BoxLayout({ style: "spacing: 4px;" });
        let lbl = new St.Label({ text: key + ":", style_class: "grun-section" });
        lbl.set_y_align(Clutter.ActorAlign.CENTER);
        let minus = new St.Button({ label: "−", style_class: "grun-chip" });
        let val = new St.Label({ text: String(this._tune[key]) });
        val.set_y_align(Clutter.ActorAlign.CENTER);
        let plus = new St.Button({ label: "+", style_class: "grun-chip" });
        let apply = Lang.bind(this, function (d) {
            this._tune[key] = Math.max(0, this._tune[key] + d);
            this._applySize(); this._renderHome();
        });
        minus.connect("clicked", function () { apply(-step); });
        plus.connect("clicked", function () { apply(step); });
        row.add_child(lbl); row.add_child(minus); row.add_child(val); row.add_child(plus);
        return row;
    },

    _sectionHeaderExpand: function (text, key, hasMore) {
        let hdr = new St.BoxLayout({ style_class: "grun-secthead", x_expand: true });
        let assetMap = { Clipboard: "Clipboard.svg", Apps: "apps.svg", Files: "Files.svg" };
        let g = this._assetGicon(assetMap[key]);
        if (g) {
            let ic = new St.Icon({ gicon: g, icon_size: 16, style_class: "grun-secticon" });
            ic.set_y_align(Clutter.ActorAlign.CENTER);
            hdr.add_child(ic);
        }
        let lbl = new St.Label({ text: text, style_class: "grun-section", x_expand: true });
        lbl.set_y_align(Clutter.ActorAlign.CENTER);
        hdr.add_child(lbl);
        if (hasMore) {
            let expanded = this._expanded[key];
            let exp = new St.Button({ style_class: "grun-chip" });
            let ebox = new St.BoxLayout({ style_class: "grun-expand" });
            let arrow = this._assetGicon(expanded ? "pointer-up.svg" : "pointer-Down.svg");
            if (arrow) {
                let ai = new St.Icon({ gicon: arrow, icon_size: 12 });
                ai.set_y_align(Clutter.ActorAlign.CENTER);
                ebox.add_child(ai);
            }
            let el = new St.Label({ text: expanded ? "collapse" : "expand" });
            el.set_y_align(Clutter.ActorAlign.CENTER);
            ebox.add_child(el);
            exp.set_child(ebox);
            exp.set_y_align(Clutter.ActorAlign.CENTER);
            exp.connect("clicked", Lang.bind(this, function () { this._toggleSection(key); }));
            hdr.add_child(exp);
        }
        return hdr;
    },

    // Expand/collapse a section, fading the extra card rows in/out.
    _toggleSection: function (key) {
        if (this._animating) return;
        if (this._expanded[key]) {
            // Collapsing: fade out the extra rows, then re-render collapsed.
            let grid = this._sectionGrids && this._sectionGrids[key];
            let extra = grid ? grid.get_children().slice(1) : [];
            if (!extra.length) { this._expanded[key] = false; this._renderHome(); return; }
            this._animating = true;
            let left = extra.length;
            extra.forEach(Lang.bind(this, function (r) {
                this._fade(r, 0, 140, Lang.bind(this, function () {
                    if (--left === 0) { this._animating = false; this._expanded[key] = false; this._renderHome(); }
                }));
            }));
        } else {
            // Expanding: re-render, then fade the new rows in.
            this._expanded[key] = true;
            this._pendingAnim = key;
            this._renderHome();
        }
    },

    // Implicit Clutter opacity animation (works without Tweener/ease()).
    _fade: function (actor, to, duration, onDone) {
        actor.set_easing_duration(duration);
        actor.opacity = to;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, duration + 30, function () {
            try { actor.set_easing_duration(0); } catch (e) {}
            if (onDone) onDone();
            return GLib.SOURCE_REMOVE;
        });
    },

    _cardGrid: function (cards) {
        let per = this._perRow || 3;
        let grid = new St.BoxLayout({ vertical: true, style_class: "grun-cardgrid" });
        for (let i = 0; i < cards.length; i += per) {
            let row = new St.BoxLayout({ style_class: "grun-cardrow" });
            for (let j = i; j < Math.min(i + per, cards.length); j++) row.add_child(cards[j]);
            grid.add_child(row);
        }
        return grid;
    },

    // Build a section's card grid, track it, and fade in new rows after expand.
    _addSectionGrid: function (key, cards) {
        let grid = this._cardGrid(cards);
        if (!this._sectionGrids) this._sectionGrids = {};
        this._sectionGrids[key] = grid;
        this._list.add_child(grid);
        if (this._pendingAnim === key) {
            let rows = grid.get_children();
            for (let i = 1; i < rows.length; i++) {
                rows[i].opacity = 0;
                this._fade(rows[i], 255, 180, null);
            }
        }
        return grid;
    },

    _iconActor: function (item, size) {
        if (item.imagePath && isImagePath(item.imagePath) && GLib.file_test(item.imagePath, GLib.FileTest.EXISTS)) {
            try {
                let g = new Gio.FileIcon({ file: Gio.File.new_for_path(item.imagePath) });
                return new St.Icon({ gicon: g, icon_size: 64 });
            } catch (e) {}
        }
        if (item.gicon) return new St.Icon({ gicon: item.gicon, icon_size: size });
        return new St.Icon({ icon_name: item.iconName || "application-x-executable", icon_size: size });
    },

    _bigCard: function (letter, item) {
        let idx = this._cards ? this._cards.length : 0;
        let card = new St.BoxLayout({ style_class: "grun-bigcard", reactive: true, track_hover: true });
        let baseStyle = "width:" + this._cardW + "px; height:" + this._cardH +
            "px; background-color:" + this._cardBg + ";";
        card.style = baseStyle;
        let hoverStyle = baseStyle + "background-color:" + this._cardHover + ";";
        card.connect("enter-event", Lang.bind(this, function () {
            if (this._cardSel !== idx) card.style = hoverStyle;
        }));
        card.connect("leave-event", Lang.bind(this, function () {
            if (this._cardSel !== idx) card.style = baseStyle;
        }));

        let left = new St.BoxLayout({ vertical: true, style_class: "grun-bigcard-left" });
        left.set_y_align(Clutter.ActorAlign.START);
        if (this._tune) left.style = "width:" + this._tune.leftW + "px;";
        if (letter) {
            let badge = new St.Label({ text: letter, style_class: "grun-card-letter" });
            badge.style = "background-color:" + this._accentRGBA(0.32) + ";";
            left.add_child(badge);
        }
        for (let a of (item.actions || [])) {
            let b = new St.Button({ label: a.label, style_class: "grun-side" });
            b.connect("clicked", (function (run) { return function () { run(); }; })(a.run));
            left.add_child(b);
        }
        card.add_child(left);

        let main = new St.BoxLayout({ vertical: true, style_class: "grun-bigcard-main", x_expand: true });
        main.set_y_align(Clutter.ActorAlign.CENTER);   // center icon/title vertically
        if (item.kind === "cliptext") {
            let t = new St.Label({ text: item.title, style_class: "grun-clip", x_expand: true });
            t.clutter_text.set_single_line_mode(false);
            t.clutter_text.set_line_wrap(true);
            t.clutter_text.line_wrap_mode = 2;   // WORD_CHAR
            t.clutter_text.ellipsize = 0;        // NONE — ellipsize would force one line
            main.add_child(t);
        } else {
            let icon = this._iconActor(item, 52);
            icon.set_x_align(Clutter.ActorAlign.CENTER);
            main.add_child(icon);
            if (item.tag) {
                let tag = new St.Label({ text: item.tag, style_class: "grun-tag " + tagClass(item.tag) });
                tag.set_x_align(Clutter.ActorAlign.CENTER);
                main.add_child(tag);
            }
            if (item.title) {
                let title = new St.Label({ text: item.title, style_class: "grun-card-title" });
                title.clutter_text.ellipsize = 3;
                title.set_x_align(Clutter.ActorAlign.CENTER);
                main.add_child(title);
            }
            if (item.sub) {
                let sub = new St.Label({ text: item.sub, style_class: "grun-sub" });
                sub.clutter_text.ellipsize = 1; // START
                sub.set_x_align(Clutter.ActorAlign.CENTER);
                main.add_child(sub);
            }
        }
        card.add_child(main);

        if (item.primary) {
            let click = new Clutter.ClickAction();
            click.connect("clicked", (function (run) { return function () { run(); }; })(item.primary));
            card.add_action(click);
        }

        if (!this._cards) this._cards = [];
        this._cards.push({ letter: letter, actor: card, baseStyle: baseStyle, section: item.section,
            primary: item.primary, actions: (item.actions || []).map(a => a.run) });
        return card;
    },

    /* per-card actions */
    _togglePin: function (clip) {
        let c = this.history.clips.find(x => x.id === clip.id);
        if (c) c.pinned = !c.pinned;
        this._historyDirty = true; this._flushHistory(); this._renderHome();
    },
    _removeClip: function (clip) {
        this.history.clips = this.history.clips.filter(x => x.id !== clip.id);
        this._historyDirty = true; this._flushHistory(); this._renderHome();
    },
    _hideHomeApp: function (id) {
        if (this.history.home_hidden_apps.indexOf(id) === -1) this.history.home_hidden_apps.push(id);
        this._historyDirty = true; this._flushHistory(); this._renderHome();
    },
    _hideHomeFile: function (p) {
        if (this.history.home_hidden_files.indexOf(p) === -1) this.history.home_hidden_files.push(p);
        this._historyDirty = true; this._flushHistory(); this._renderHome();
    },
    _copyPath: function (p) { St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, p); },

    // Re-run the current view after a change (hide from search, etc.).
    _refreshCurrent: function () {
        let q = this._search.get_text();
        if (q && q.trim().length) this._render(this._build(q));
        else this._renderHome();
    },
    // Hide an app (or power action) from search — stored in the shared apps list.
    _hideAppFromSearch: function (key) {
        if (this.history.hidden_apps.indexOf(key) === -1) this.history.hidden_apps.push(key);
        this._historyDirty = true; this._flushHistory(); this._refreshCurrent();
    },
    _hideFileFromSearch: function (p) {
        if (this.history.hidden_files.indexOf(p) === -1) this.history.hidden_files.push(p);
        this._historyDirty = true; this._flushHistory(); this._refreshCurrent();
    },
    _restoreApp: function (key) {
        this.history.hidden_apps = this.history.hidden_apps.filter(x => x !== key);
        this.history.home_hidden_apps = this.history.home_hidden_apps.filter(x => x !== key);
        this._historyDirty = true; this._flushHistory(); this._renderSettings();
    },
    _restoreFile: function (p) {
        this.history.hidden_files = this.history.hidden_files.filter(x => x !== p);
        this.history.home_hidden_files = this.history.home_hidden_files.filter(x => x !== p);
        this._historyDirty = true; this._flushHistory(); this._renderSettings();
    },
    _openFolder: function (p) { this.menu.close(); openUrl("file://" + encodeURI(GLib.path_get_dirname(p))); },
    _showDetails: function (a) {
        this.menu.close();
        let id = (a.get_id() || "").replace(/\.desktop$/, "");
        Util.spawnCommandLine("xdg-open " + GLib.shell_quote("appstream://" + id));
    },
    _uninstall: function (a) {
        this.menu.close();
        let id = (a.get_id() || "").replace(/\.desktop$/, "");
        Util.spawnCommandLine("x-terminal-emulator -e bash -c " +
            GLib.shell_quote("flatpak uninstall " + id + "; echo; read -p 'Done — press Enter…' _"));
    },

    /* ---------------- settings page ---------------- */

    _toggleSettings: function () {
        if (this._mode === "settings") { this._mode = "home"; this._renderHome(); }
        else { this._mode = "settings"; this._renderSettings(); }
    },

    _renderSettings: function () {
        this._list.destroy_all_children();
        this._rows = []; this._results = []; this._selected = -1;
        let c = this.cfg;

        this._list.add_child(this._sectionHeader("Functions (drag-free reorder = priority)"));
        for (let i = 0; i < c.providers.length; i++) {
            let p = c.providers[i];
            this._list.add_child(this._reorderRow(PROVIDER_LABELS[p.id] || p.id, p.enabled,
                i > 0, i < c.providers.length - 1,
                Lang.bind(this, function () { this._moveProvider(i, -1); }),
                Lang.bind(this, function () { this._moveProvider(i, 1); }),
                Lang.bind(this, function (on) { c.providers[i].enabled = on; saveConfig(c); })));
        }

        this._list.add_child(this._sectionHeader("Web search order (top = default)"));
        for (let i = 0; i < c.engines.length; i++) {
            let e = c.engines[i];
            this._list.add_child(this._reorderRow(ENGINES[e.id] ? ENGINES[e.id].label : e.id, e.enabled,
                i > 0, i < c.engines.length - 1,
                Lang.bind(this, function () { this._moveList(c.engines, i, -1); }),
                Lang.bind(this, function () { this._moveList(c.engines, i, 1); }),
                (function (eng) { return function (on) { eng.enabled = on; saveConfig(c); }; })(e)));
        }
        this._list.add_child(this._sectionHeader("AI assistant order (top = default)"));
        for (let i = 0; i < c.assistants.length; i++) {
            let e = c.assistants[i];
            this._list.add_child(this._reorderRow(ASSISTANTS[e.id] ? ASSISTANTS[e.id].label : e.id, e.enabled,
                i > 0, i < c.assistants.length - 1,
                Lang.bind(this, function () { this._moveList(c.assistants, i, -1); }),
                Lang.bind(this, function () { this._moveList(c.assistants, i, 1); }),
                (function (ai) { return function (on) { ai.enabled = on; saveConfig(c); }; })(e)));
        }

        this._list.add_child(this._sectionHeader("Home dashboard"));
        this._list.add_child(this._switchRow("Show clipboard", c.home_clipboard,
            Lang.bind(this, function (on) { c.home_clipboard = on; saveConfig(c); })));
        this._list.add_child(this._switchRow("Show apps", c.home_apps,
            Lang.bind(this, function (on) { c.home_apps = on; saveConfig(c); })));
        this._list.add_child(this._switchRow("Show files", c.home_files,
            Lang.bind(this, function (on) { c.home_files = on; saveConfig(c); })));
        this._list.add_child(this._choiceRow("Apps shown by", c.home_apps_mode,
            [["used", "Most used"], ["recent", "Recent"]],
            Lang.bind(this, function (v) { c.home_apps_mode = v; saveConfig(c); this._renderSettings(); })));
        this._list.add_child(this._choiceRow("Files shown by", c.home_files_mode,
            [["recent", "Recent"], ["used", "Most used"]],
            Lang.bind(this, function (v) { c.home_files_mode = v; saveConfig(c); this._renderSettings(); })));
        this._list.add_child(this._switchRow("Search app descriptions & keywords", c.search_descriptions,
            Lang.bind(this, function (on) { c.search_descriptions = on; saveConfig(c); })));

        // Restore items hidden from search / home (apps + power actions, and files).
        let h = this.history;
        let hiddenApps = [];
        h.hidden_apps.concat(h.home_hidden_apps).forEach(x => { if (hiddenApps.indexOf(x) < 0) hiddenApps.push(x); });
        let hiddenFiles = [];
        h.hidden_files.concat(h.home_hidden_files).forEach(x => { if (hiddenFiles.indexOf(x) < 0) hiddenFiles.push(x); });
        if (hiddenApps.length) {
            this._list.add_child(this._sectionHeader("Hidden apps & actions"));
            for (let key of hiddenApps) {
                let label = this._appIndex[key] ? this._appIndex[key].get_display_name() : (powerLabel(key) || key);
                this._list.add_child(this._restoreRow(label,
                    (function (self, k) { return function () { self._restoreApp(k); }; })(this, key)));
            }
        }
        if (hiddenFiles.length) {
            this._list.add_child(this._sectionHeader("Hidden files"));
            for (let p of hiddenFiles)
                this._list.add_child(this._restoreRow(basename(p),
                    (function (self, path) { return function () { self._restoreFile(path); }; })(this, p)));
        }

        let done = new St.Button({ label: "Done", style_class: "grun-done" });
        done.connect("clicked", Lang.bind(this, function () { this._mode = "home"; this._renderHome();
            global.stage.set_key_focus(this._search.clutter_text); }));
        this._list.add_child(done);
    },

    _restoreRow: function (label, onRestore) {
        let row = new St.BoxLayout({ style_class: "grun-setrow", x_expand: true });
        let lbl = new St.Label({ text: label, style_class: "grun-title", x_expand: true });
        lbl.set_y_align(Clutter.ActorAlign.CENTER);
        lbl.clutter_text.ellipsize = 3;
        row.add_child(lbl);
        let b = new St.Button({ label: "Restore", style_class: "grun-chip" });
        b.set_y_align(Clutter.ActorAlign.CENTER);
        b.connect("clicked", onRestore);
        row.add_child(b);
        return row;
    },

    _moveProvider: function (i, d) {
        let arr = this.cfg.providers, j = i + d;
        if (j < 0 || j >= arr.length) return;
        let t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        saveConfig(this.cfg); this._renderSettings();
    },
    _moveList: function (arr, i, d) {
        let j = i + d; if (j < 0 || j >= arr.length) return;
        let t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        saveConfig(this.cfg); this._renderSettings();
    },

    _reorderRow: function (label, enabled, canUp, canDown, onUp, onDown, onToggle) {
        let row = new St.BoxLayout({ style_class: "grun-setrow", x_expand: true });
        let up = new St.Button({ style_class: "grun-iconbtn", child: new St.Icon({ icon_name: "go-up-symbolic", icon_size: 16 }) });
        up.reactive = canUp; up.opacity = canUp ? 255 : 60; up.connect("clicked", onUp);
        let down = new St.Button({ style_class: "grun-iconbtn", child: new St.Icon({ icon_name: "go-down-symbolic", icon_size: 16 }) });
        down.reactive = canDown; down.opacity = canDown ? 255 : 60; down.connect("clicked", onDown);
        row.add_child(up); row.add_child(down);
        let lbl = new St.Label({ text: label, style_class: "grun-title", x_expand: true });
        lbl.set_y_align(Clutter.ActorAlign.CENTER);
        row.add_child(lbl);
        if (onToggle !== null && enabled !== null) {
            let on = this._accentRGBA(0.55);
            let sw = new St.Button({ label: enabled ? "On" : "Off", style_class: "grun-chip" });
            if (enabled) sw.style = "background-color:" + on + ";";
            sw.connect("clicked", Lang.bind(this, function () {
                let now = sw.get_label() !== "On"; sw.set_label(now ? "On" : "Off");
                sw.style = now ? ("background-color:" + on + ";") : "";
                onToggle(now);
            }));
            sw.set_y_align(Clutter.ActorAlign.CENTER);
            row.add_child(sw);
        }
        return row;
    },
    _switchRow: function (label, on, onToggle) {
        return this._reorderRow(label, on, false, false, function () {}, function () {}, onToggle);
    },
    _choiceRow: function (label, value, options, onPick) {
        let row = new St.BoxLayout({ style_class: "grun-setrow", x_expand: true });
        let lbl = new St.Label({ text: label, style_class: "grun-title", x_expand: true });
        lbl.set_y_align(Clutter.ActorAlign.CENTER);
        row.add_child(lbl);
        for (let opt of options) {
            let sel = opt[0] === value;
            let b = new St.Button({ label: opt[1], style_class: "grun-chip" });
            if (sel) b.style = "background-color:" + this._accentRGBA(0.55) + ";";
            b.connect("clicked", (function (v) { return function () { onPick(v); }; })(opt[0]));
            b.set_y_align(Clutter.ActorAlign.CENTER);
            row.add_child(b);
        }
        return row;
    },

    /* ---------------- clipboard watch ---------------- */

    _startClipboardWatch: function () {
        this._lastClip = null;
        this._clipTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, Lang.bind(this, function () {
            if (!this.cfg.home_clipboard) return GLib.SOURCE_CONTINUE;
            St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, Lang.bind(this, function (cb, text) {
                if (!text || !text.length) return;
                if (text === this._lastClip) return;
                this._lastClip = text;
                this._addClip(text);
            }));
            return GLib.SOURCE_CONTINUE;
        }));
    },
    _addClip: function (text) {
        let h = this.history;
        let id = String(text.length) + ":" + text.slice(0, 24);
        let existing = h.clips.find(c => c.kind !== "image" && c.text === text);
        if (existing) { existing.ts = nowSecs(); }
        else {
            h.clips.push({ id: id, kind: "text", text: text, path: "", pinned: false, hidden: false, ts: nowSecs() });
            let unpinned = h.clips.filter(c => !c.pinned).sort((a, b) => b.ts - a.ts);
            if (unpinned.length > 60) {
                let drop = unpinned.slice(60).map(c => c.id);
                h.clips = h.clips.filter(c => c.pinned || drop.indexOf(c.id) === -1);
            }
        }
        this._historyDirty = true;
        this._flushHistory();
    },
    _flushHistory: function () {
        if (!this._historyDirty) return;
        saveHistory(this.history);
        this._historyDirty = false;
    },

    /* ---------------- keyboard ---------------- */

    _onKeyPress: function (actor, event) {
        let sym = event.get_key_symbol();

        if (this._mode === "settings") {
            if (sym === Clutter.KEY_Escape) { this._mode = "home"; this._renderHome(); }
            return sym === Clutter.KEY_Escape;
        }

        // ---- Home dashboard ----
        if (this._mode === "home") {
            if (!this._homeNav) {
                // Typing mode: Tab/Down jumps into the cards; everything else types.
                if ((sym === Clutter.KEY_Tab || sym === Clutter.KEY_Down) && this._cards && this._cards.length) {
                    this._homeNav = true; this._setBarFocused(false); this._selectCard(0); return true;
                }
                if (sym === Clutter.KEY_Escape) {
                    if (this._search.get_text().length) this._search.set_text("");
                    else this.menu.close();
                    return true;
                }
                return false; // let the entry receive the key
            }
            // Card-nav mode: keys drive the selected card, never the entry.
            if (sym === Clutter.KEY_Escape) {
                this._homeNav = false; this._selectCard(-1); this._setBarFocused(true);
                global.stage.set_key_focus(this._search.clutter_text); return true;
            }
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) { this._runCardPrimary(); return true; }
            if (sym === Clutter.KEY_space) { this._expandSelectedSection(); return true; }
            if (sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) { this._runCardAction(sym - Clutter.KEY_1); return true; }
            if (sym >= Clutter.KEY_KP_1 && sym <= Clutter.KEY_KP_9) { this._runCardAction(sym - Clutter.KEY_KP_1); return true; }
            if (sym >= Clutter.KEY_a && sym <= Clutter.KEY_z) { this._selectCardByLetter(String.fromCharCode(65 + (sym - Clutter.KEY_a))); return true; }
            if (sym >= Clutter.KEY_A && sym <= Clutter.KEY_Z) { this._selectCardByLetter(String.fromCharCode(65 + (sym - Clutter.KEY_A))); return true; }
            if (sym === Clutter.KEY_Right || sym === Clutter.KEY_Tab) { this._moveCard(1); return true; }
            if (sym === Clutter.KEY_Left || sym === Clutter.KEY_ISO_Left_Tab) { this._moveCard(-1); return true; }
            if (sym === Clutter.KEY_Down) { this._moveCard(3); return true; }
            if (sym === Clutter.KEY_Up) { this._moveCard(-3); return true; }
            return true; // swallow stray keys while navigating
        }

        // ---- Search results ----
        if (sym === Clutter.KEY_Escape) {
            if (this._search.get_text().length) this._search.set_text("");
            else this.menu.close();
            return true;
        }
        if (sym === Clutter.KEY_Down || sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            this._move(sym === Clutter.KEY_ISO_Left_Tab ? -1 : 1); return true;
        }
        if (sym === Clutter.KEY_Up) { this._move(-1); return true; }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            if (this._results.length) this._activate(this._selected < 0 ? 0 : this._selected);
            return true;
        }
        return false;
    },

    on_applet_removed_from_panel: function () {
        try { Main.keybindingManager.removeHotKey("grun-open"); } catch (e) {}
        if (this._filesTimer) { GLib.source_remove(this._filesTimer); this._filesTimer = 0; }
        if (this._clipTimer) { GLib.source_remove(this._clipTimer); this._clipTimer = 0; }
        this._flushHistory();
        if (this.aSettings) this.aSettings.finalize();
        if (this._ifaceSettings && this._themeWatchId) {
            this._ifaceSettings.disconnect(this._themeWatchId);
            this._themeWatchId = 0;
        }
    }
};

function main(metadata, orientation, panel_height, instance_id) {
    return new MyApplet(metadata, orientation, panel_height, instance_id);
}
