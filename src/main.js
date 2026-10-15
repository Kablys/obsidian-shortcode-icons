import {
  Plugin, PluginSettingTab, Setting, EditorSuggest, Keymap, Notice,
  setIcon, getIcon, getIconIds, addIcon, removeIcon, prepareFuzzySearch, arrayBufferToBase64, TFile, TFolder, Vault,
} from "obsidian";
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// :dog: (Lucide) · :vespa: (custom SVG in the icon folder) · :tada: (emoji)
// underscores allowed for emoji shortcodes like :white_check_mark:
const RE = /:([a-z0-9][a-z0-9_-]*[a-z0-9]):/g;
const DEFAULT_SETTINGS = { iconFolder: "icons", autoLink: true, emoji: true, renameSweep: true };
// Raster icons are embedded as a data URI inside a small SVG, so they go through addIcon like SVGs.
const RASTER = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", ico: "image/x-icon" };
const isIconPath = (p) => typeof p === "string" && p.startsWith(settings.iconFolder + "/") && /\.(svg|png|jpe?g|ico)$/i.test(p);
const customId = (basename) => basename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// module-level shared state (functions below close over these)
// Obsidian installs only main.js/manifest.json/styles.css, so esbuild inlines this into main.js
import emoji from "./emoji.json";           // shortcode -> unicode char (from github/gemoji)
const editorViews = new Set();
let settings = { ...DEFAULT_SETTINGS };     // kept in sync by the plugin instance
let iconsVersion = 0;                       // bumped on every icon reload so rendered icons refresh

// ---------- dark-theme adaptation ----------
function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  const f = (c) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const norm = (c) => { c = (c || "").trim().toLowerCase(); return c === "black" ? "#000000" : c === "white" ? "#ffffff" : c; };
const DRAWABLE = "path,circle,rect,polygon,ellipse,line,polyline";

// Make near-black / implicit-black custom logos follow the theme's text color so they stay legible
// on dark themes. Conservative: only a single very-dark fill or an all-implicit-black icon is touched.
// ponytail: luminance on hex/named only; rgb()/hsl()/url(gradient) fall through as "keep".
function themeAdapt(svg) {
  const els = [svg, ...svg.querySelectorAll("*")];
  const colors = new Set();
  for (const el of els) {
    for (const a of ["fill", "stroke"]) { const v = norm(el.getAttribute(a)); if (v) colors.add(v); }
    for (const m of (el.getAttribute("style") || "").matchAll(/(fill|stroke)\s*:\s*([^;]+)/gi)) colors.add(norm(m[2]));
  }
  colors.delete(""); colors.delete("none"); colors.delete("transparent"); colors.delete("currentcolor");
  for (const c of [...colors]) if (c.startsWith("url(")) colors.delete(c);

  const fillless = [svg, ...svg.querySelectorAll(DRAWABLE)].some(
    (el) => !el.getAttribute("fill") && !/fill\s*:/i.test(el.getAttribute("style") || "")
  );
  if (colors.size === 0) {
    if (fillless && !svg.getAttribute("fill")) svg.setAttribute("fill", "currentColor");
    return;
  }
  if (colors.size !== 1) return;
  const only = [...colors][0];
  const L = luminance(only);
  if (L === null || L >= 0.1) return;
  for (const el of els) {
    for (const a of ["fill", "stroke"]) if (norm(el.getAttribute(a)) === only) el.setAttribute(a, "currentColor");
    const style = el.getAttribute("style");
    if (style) el.setAttribute("style", style.replace(/(fill|stroke)\s*:\s*([^;]+)/gi, (m, a, v) => (norm(v) === only ? `${a}:currentColor` : m)));
  }
  if (!svg.getAttribute("fill")) svg.setAttribute("fill", "currentColor");
}

// Inline simple `<style>` class rules (.cls-1{fill:#61d790}) onto elements as attributes, then drop
// the <style> — otherwise those fills are lost (sanitizer) or leak as global CSS across icons.
// ponytail: only single-class selectors; multi-selector rules (.a,.b{}) aren't split
function inlineStyles(svg) {
  const rules = new Map();
  for (const style of svg.querySelectorAll("style")) {
    for (const m of style.textContent.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const decls = rules.get(m[1]) || {};
      for (const d of m[2].split(";")) { const i = d.indexOf(":"); if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
      rules.set(m[1], decls);
    }
    style.remove();
  }
  if (!rules.size) return;
  for (const el of svg.querySelectorAll("[class]")) {
    for (const cls of el.getAttribute("class").split(/\s+/)) {
      for (const [k, v] of Object.entries(rules.get(cls) || {})) if (!el.hasAttribute(k)) el.setAttribute(k, v);
    }
    el.removeAttribute("class");
  }
}

// Fallback sanitizer used only when window.DOMPurify is unavailable. Icons come from the user's own
// folder (trusted), but never inject <script>, event handlers, or javascript: URLs regardless.
function basicSanitize(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, "");
}

// Normalize any SVG so it scales (keep viewBox, drop fixed size), adapt dark logos to the theme,
// then sanitize before it reaches the live DOM. Full-color fills survive.
function prepareSvg(text) {
  if (!text) return "";
  const svg = new DOMParser().parseFromString(text, "image/svg+xml").querySelector("svg");
  if (!svg) return "";
  inlineStyles(svg);
  for (const t of svg.querySelectorAll("title, desc")) t.remove(); // else they add a native SVG tooltip
  if (!svg.getAttribute("viewBox")) {
    const w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
    if (w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  themeAdapt(svg);
  const out = svg.outerHTML;
  return window.DOMPurify
    ? window.DOMPurify.sanitize(out, { USE_PROFILES: { svg: true, svgFilters: true } })
    : basicSanitize(out);
}

// A token maps to an icon (custom or Lucide), an emoji character, or nothing.
function resolve(token) {
  if (getIcon(token)) return { icon: token };
  const luc = "lucide-" + token;
  if (getIcon(luc)) return { icon: luc };
  if (settings.emoji && emoji[token]) return { char: emoji[token] };
  return null;
}

const refreshEffect = StateEffect.define();

// Build the inline element for a resolved token: an icon/emoji span whose aria-label is the
// `:shortcode:` (Obsidian shows it as the hover tooltip; doubles as the screen-reader label), wrapped
// in a clickable internal-link when auto-link is on and a note (by name OR alias) exists.
// insideLink=true means we're already inside a wikilink's <a> — don't nest anchors.
function buildTokenEl(app, r, token, insideLink) {
  const tip = `:${token}:`;
  const glyph = r.char
    ? createSpan({ cls: "sci-emoji", text: r.char, attr: { "aria-label": tip } })
    : createSpan({ cls: "sci-icon", attr: { "aria-label": tip, role: "img" } });
  if (r.icon) setIcon(glyph, r.icon);
  if (insideLink || !settings.autoLink) return glyph;
  const dest = app.metadataCache.getFirstLinkpathDest(token, ""); // resolves via aliases too
  if (!dest) return glyph;
  const a = createEl("a", { cls: "internal-link sci-icon-link", attr: { href: dest.path, "data-href": dest.path } });
  a.append(glyph);
  a.addEventListener("click", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    app.workspace.openLinkText(dest.path, "", Keymap.isModEvent(evt));
  });
  return a;
}

class TokenWidget extends WidgetType {
  constructor(r, app, token) { super(); this.r = r; this.app = app; this.token = token; this.v = iconsVersion; }
  // version check: an edited icon file keeps its id, so without it CM6 would reuse the stale DOM
  eq(other) { return other.r.icon === this.r.icon && other.r.char === this.r.char && other.token === this.token && other.v === this.v; }
  toDOM() { return buildTokenEl(this.app, this.r, this.token, false); }
}

// True if pos sits inside a code block or inline code (Obsidian LP node names contain "code").
function inCodeContext(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (/code/i.test(node.type.name)) return true;
  }
  return false;
}

// Live Preview: replace tokens with icons/emoji, except in code, in wikilink display text, or where
// the selection touches them. refreshEffect rebuilds after the icon folder or settings change.
function livePreviewExt(app) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) { this.view = view; editorViews.add(view); this.deco = this.build(view); }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet ||
            u.transactions.some((t) => t.effects.some((e) => e.is(refreshEffect)))) {
          this.deco = this.build(u.view);
        }
      }
      destroy() { editorViews.delete(this.view); }
      build(view) {
        const b = new RangeSetBuilder();
        for (const { from, to } of view.visibleRanges) {
          for (const m of view.state.doc.sliceString(from, to).matchAll(RE)) {
            const start = from + m.index;
            const end = start + m[0].length;
            const r = resolve(m[1]);
            if (!r) continue;
            // skip wikilink display text ([[Note|:icon:]] / [[:icon:]]) — Obsidian renders those,
            // overlapping our decoration would conflict. Use bare :icon: (it auto-links) instead.
            const before = start > 0 ? view.state.doc.sliceString(start - 1, start) : "";
            if (before === "|" || before === "[") continue;
            if (inCodeContext(view.state, start + 1)) continue;
            if (view.state.selection.ranges.some((s) => s.from <= end && s.to >= start)) continue;
            b.add(start, end, Decoration.replace({ widget: new TokenWidget(r, app, m[1]) }));
          }
        }
        return b.finish();
      }
    },
    {
      decorations: (v) => v.deco,
      provide: (p) => EditorView.atomicRanges.of((v) => v.plugin(p)?.deco ?? Decoration.none),
    }
  );
}

const SOURCE_RANK = { custom: 0, icon: 1, emoji: 2 };
const TOKEN = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

// Every typeable shortcode, resolved exactly as it will render (Lucide ids lose their "lucide-"
// prefix; an emoji shadowed by an icon of the same name resolves to the icon).
function buildCandidates(customIds) {
  const names = new Set(customIds.keys());
  for (const id of getIconIds()) names.add(id.startsWith("lucide-") ? id.slice(7) : id);
  if (settings.emoji) for (const k of Object.keys(emoji)) names.add(k);
  const out = [];
  for (const name of names) {
    const r = TOKEN.test(name) && resolve(name);
    if (r) out.push({ name, r, source: r.char ? "emoji" : customIds.has(r.icon) ? "custom" : "icon" });
  }
  return out;
}

class IconSuggest extends EditorSuggest {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onTrigger(cursor, editor) {
    const line = editor.getLine(cursor.line).slice(0, cursor.ch);
    const m = line.match(/(?:^|[^a-z0-9_-]):([a-z0-9_-]{2,})$/);
    if (!m) return null;
    return { start: { line: cursor.line, ch: cursor.ch - m[1].length - 1 }, end: cursor, query: m[1] };
  }
  // Rank: exact name, then prefix, then your own icons before Lucide before emoji, then fuzzy score.
  getSuggestions(ctx) {
    const q = ctx.query, fuzzy = prepareFuzzySearch(q), hits = [];
    for (const c of this.plugin.candidates()) {
      const m = fuzzy(c.name);
      if (m) hits.push({ c, exact: c.name === q ? 0 : 1, prefix: c.name.startsWith(q) ? 0 : 1, score: m.score });
    }
    hits.sort((a, b) => a.exact - b.exact || a.prefix - b.prefix
      || SOURCE_RANK[a.c.source] - SOURCE_RANK[b.c.source] || b.score - a.score);
    return hits.slice(0, 50).map((h) => h.c);
  }
  renderSuggestion(c, el) {
    el.addClass("sci-suggestion");
    if (c.r.char) el.createSpan({ cls: "sci-emoji", text: c.r.char });
    else setIcon(el.createSpan({ cls: "sci-icon" }), c.r.icon);
    el.createSpan({ text: c.name });
    el.createSpan({ cls: "sci-suggestion-source", text: c.source });
  }
  selectSuggestion(c) {
    const { editor, start, end } = this.context;
    editor.replaceRange(`:${c.name}:`, start, end);
  }
}

export default class ShortcodeIconsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registeredIcons = new Map(); // shortcode id -> file path
    await this.loadCustomIcons();

    // ponytail: reload the whole (small) folder on any change; folder path is read live from settings
    const reload = (f) => {
      if (isIconPath(f?.path)) {
        this.loadCustomIcons().then(() => this.refresh());
      }
    };
    this.registerEvent(this.app.vault.on("create", reload));
    this.registerEvent(this.app.vault.on("modify", reload));
    this.registerEvent(this.app.vault.on("delete", reload));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));

    this.registerEditorExtension(livePreviewExt(this.app));
    this.registerEditorSuggest(new IconSuggest(this.app, this));
    this.registerMarkdownPostProcessor((el) => this.processReading(el));
    this.addSettingTab(new InlineIconsSettingTab(this.app, this));
  }

  onunload() {
    for (const id of this.registeredIcons?.keys() ?? []) removeIcon(id);
  }

  async loadSettings() {
    settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings = settings;
  }
  async saveSettings() {
    await this.saveData(settings);
    await this.loadCustomIcons(); // folder may have changed (also drops the suggestion cache)
    this.refresh();
  }

  // shortcut: rebuilt only when our icons or settings change, so icons other plugins register
  // later won't be suggested until then
  candidates() {
    return (this._candidates ??= buildCandidates(this.registeredIcons));
  }

  async loadCustomIcons() {
    const folder = this.app.vault.getAbstractFileByPath(settings.iconFolder);
    // subfolders are just packs for organizing: icons/brands/nike.svg is still :nike:
    const files = [];
    if (folder instanceof TFolder) Vault.recurseChildren(folder, (f) => { if (f instanceof TFile && isIconPath(f.path)) files.push(f); });
    // SVGs first (vespa.svg beats vespa.png), then by path, so a duplicate name always resolves the same way
    files.sort((a, b) => Number(a.extension.toLowerCase() !== "svg") - Number(b.extension.toLowerCase() !== "svg") || a.path.localeCompare(b.path));
    const loaded = await Promise.all(files.map(async (f) => [f, customId(f.basename), await this.iconMarkup(f)]));
    const next = new Map();
    for (const [f, id, markup] of loaded) {
      if (!id || !markup) continue;
      if (next.has(id)) {
        console.warn(`[${this.manifest.id}] ${f.path} not loaded: :${id}: already comes from ${next.get(id)}`);
        continue;
      }
      addIcon(id, markup);
      next.set(id, f.path);
    }
    // unregister icons whose files were renamed/deleted so stale ids don't linger in the registry
    for (const id of this.registeredIcons.keys()) if (!next.has(id)) removeIcon(id);
    this.registeredIcons = next;
    this._candidates = null;
    iconsVersion++;
  }

  async iconMarkup(f) {
    const ext = f.extension.toLowerCase();
    if (ext === "svg") return prepareSvg(await this.app.vault.cachedRead(f));
    const b64 = arrayBufferToBase64(await this.app.vault.readBinary(f));
    return `<svg viewBox="0 0 100 100"><image href="data:${RASTER[ext]};base64,${b64}" width="100" height="100" preserveAspectRatio="xMidYMid meet"/></svg>`;
  }

  // When an icon file is renamed inside Obsidian, follow it: re-register, and (if enabled) rewrite
  // its :shortcode: across every note — the same idea as Obsidian's "update internal links".
  async onRename(file, oldPath) {
    if (file instanceof TFolder && [oldPath, file.path].some((p) => `${p}/`.startsWith(settings.iconFolder + "/"))) {
      await this.loadCustomIcons(); // a pack folder was renamed or moved: icon paths changed, shortcodes didn't
      this.refresh();
      return;
    }
    const wasIcon = isIconPath(oldPath);
    const isIcon = file instanceof TFile && isIconPath(file.path);
    if (wasIcon || isIcon) { await this.loadCustomIcons(); this.refresh(); }
    if (!settings.renameSweep || !wasIcon || !isIcon) return; // only a true rename within the folder
    const oldId = customId(oldPath.slice(oldPath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, ""));
    const newId = customId(file.basename);
    if (!oldId || !newId || oldId === newId) return;
    const needle = `:${oldId}:`, repl = `:${newId}:`;
    let files = 0, uses = 0;
    for (const md of this.app.vault.getMarkdownFiles()) {
      const data = await this.app.vault.cachedRead(md);
      if (!data.includes(needle)) continue;
      uses += data.split(needle).length - 1;
      files++;
      await this.app.vault.process(md, (d) => d.split(needle).join(repl));
    }
    if (uses) new Notice(`Shortcode Icons: ${needle} → ${repl} in ${files} note${files === 1 ? "" : "s"} (${uses} use${uses === 1 ? "" : "s"})`);
  }

  refresh() {
    for (const v of editorViews) v.dispatch({ effects: refreshEffect.of(null) });
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true);
    }
  }

  processReading(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest("code, pre")) continue;
      const text = node.textContent;
      RE.lastIndex = 0;
      if (!RE.test(text)) continue;
      const frag = createFragment();
      const insideLink = !!node.parentElement?.closest("a"); // e.g. [[Note|:icon:]] display text
      let last = 0;
      RE.lastIndex = 0;
      for (const m of text.matchAll(RE)) {
        const r = resolve(m[1]);
        if (!r) continue;
        frag.append(text.slice(last, m.index));
        frag.append(buildTokenEl(this.app, r, m[1], insideLink));
        last = m.index + m[0].length;
      }
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
}

class InlineIconsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Custom icon folder")
      .setDesc("Vault folder holding your icon files (.svg, .png, .jpg, .ico), in subfolders if you like. The filename is the shortcode: icons/brands/vespa.svg → :vespa:")
      .addText((t) => t.setPlaceholder("Default: icons").setValue(settings.iconFolder).onChange(async (v) => {
        settings.iconFolder = v.trim() || "icons";
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Link icons to notes")
      .setDesc("When a note matches a shortcode (by title or alias), the icon opens it on click.")
      .addToggle((t) => t.setValue(settings.autoLink).onChange(async (v) => { settings.autoLink = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Emoji shortcodes")
      .setDesc("Resolve :tada:, :rocket:, … to emoji (only when no icon matches).")
      .addToggle((t) => t.setValue(settings.emoji).onChange(async (v) => { settings.emoji = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Update notes when an icon is renamed")
      .setDesc("Rename an icon file and its :shortcode: is rewritten across all notes, like Obsidian's link updater. Only catches renames done inside Obsidian.")
      .addToggle((t) => t.setValue(settings.renameSweep).onChange(async (v) => { settings.renameSweep = v; await this.plugin.saveSettings(); }));

    const ids = [...this.plugin.registeredIcons.keys()].sort();
    new Setting(containerEl).setName(`Custom icons (${ids.length})`).setHeading();
    containerEl.createEl("p", { cls: "sci-gallery-hint", text: "Click an icon to copy its shortcode." });
    const grid = containerEl.createDiv({ cls: "sci-gallery-grid" });
    for (const id of ids) {
      const cell = grid.createDiv({ cls: "sci-gallery-cell", attr: { "aria-label": `:${id}:` } });
      setIcon(cell.createSpan({ cls: "sci-icon" }), id);
      cell.createEl("code", { text: `:${id}:` });
      cell.addEventListener("click", () => { navigator.clipboard.writeText(`:${id}:`); new Notice(`Copied :${id}:`); });
    }
    if (!ids.length) containerEl.createEl("p", { cls: "sci-gallery-hint", text: `No icon files found in "${settings.iconFolder}/".` });
  }
}
