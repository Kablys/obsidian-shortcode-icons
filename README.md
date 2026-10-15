# Shortcode Icons

Render `:shortcode:` icons inline in your notes — your own SVG logos, the full Lucide set built into Obsidian, and emoji — in both Live Preview and Reading view.


## Features

- **Custom SVG logos** — drop any `.svg` into an `icons/` folder in your vault; the filename becomes the shortcode. `icons/vespa.svg` → `:vespa:`. Full color is preserved.
- **Lucide** — every built-in Obsidian icon works: `:search:`, `:rocket:`, `:git-branch:`.
- **Emoji** — GitHub-style shortcodes as a fallback: `:tada:` 🎉, `:white_check_mark:` ✅.
- **Autocomplete** — type `:` + 2 characters for a searchable list of all three sources, with previews.
- **Dark-theme aware** — near-black / single-color logos automatically follow your theme's text color (via `currentColor`); full-color logos are left untouched.
- **Icons link to notes** — if a note's title (or alias) matches a shortcode, the icon becomes a clickable internal link that opens it. `:vespa:` opens your `Vespa` note.
- **Hover tooltip** — mousing over any icon shows the `:shortcode:` you'd type.
- **Settings gallery** — browse every custom icon and its shortcode; click to copy.

## Usage

Type a shortcode anywhere in a note:

```
Migrated from :elasticsearch: to :vespa: — data lives in :mongodb:.
Done :white_check_mark:  Ship it :rocket:
```

Resolution order is **custom icon → Lucide → emoji**, so `:rocket:` is the Lucide icon and emoji-only names like `:joy:` render as emoji. Unknown shortcodes are left as plain text.

### Adding your own icons

1. Create a folder named `icons/` in your vault (configurable in settings).
2. Put `.svg` files in it — `github.svg`, `my-team-logo.svg`, etc.
3. Use them as `:github:`, `:my-team-logo:`. New/changed files hot-reload; no restart needed.

Tips for clean SVGs: keep a `viewBox`, drop fixed `width`/`height` (or the plugin will), inline any `<style>`. `npx svgo` helps.

### Linking icons to pages

Give a note the same title as a shortcode (or add the shortcode as a frontmatter `alias`), and the icon opens it on click — while `[[Note]]` still gives you a normal text link. Aliases let a descriptively-titled note (e.g. "Vespa search engine", alias `vespa`) be reached by the short icon token.

## Settings

- **Custom icon folder** — where your `.svg` files live (default `icons`).
- **Link icons to notes** — toggle the auto-link behavior.
- **Emoji shortcodes** — toggle emoji resolution.
- **Custom icons gallery** — every icon rendered with its shortcode; click to copy.

## Privacy and permissions

The plugin makes no network requests and sends no data anywhere. Two capabilities flagged by the community review, and why they are used:

- **Listing vault files** — only when you rename an icon file inside the icon folder (from within Obsidian) and *Update notes when an icon is renamed* is on. The plugin then scans your notes for the old `:shortcode:` and rewrites it. Turn the setting off and the vault is never enumerated.
- **Clipboard (write only)** — clicking an icon in the settings gallery copies its `:shortcode:`. The plugin never reads the clipboard.

Otherwise it reads only the `.svg` files in your icon folder, and looks up note titles/aliases through Obsidian's link index to make icons link to matching notes.

## Install (manual)

Download `main.js`, `manifest.json`, and `styles.css` from the latest release into `<vault>/.obsidian/plugins/dom-shortcode-icons/`, then enable the plugin in Settings → Community plugins.

## Development

Source lives in `src/`; `npm run build` (esbuild) bundles it — including `src/emoji.json` — into `main.js`, which is gitignored and attached to each release.

## Credits

Emoji shortcode data (`emoji.json`) is derived from [github/gemoji](https://github.com/github/gemoji) (MIT). Brand logos are **not** bundled — you add your own SVGs; their trademarks belong to their respective owners.

## License

[MIT](LICENSE).
