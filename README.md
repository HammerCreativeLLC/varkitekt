# Varkitekt

Desktop tree editor for sketching file and folder architectures. Drag-and-drop
nodes, annotate with notes, preview the result as an ASCII tree / indented
outline / slash-path list, copy to clipboard, done.

Built with [Tauri v2](https://v2.tauri.app/) + vanilla JS/HTML/CSS. No build
pipeline, no framework. The Rust side is ~10 lines and exposes no IPC — the
entire app runs inside the webview.

Website: [varkitekt.com](https://varkitekt.com)

## Features

- Drag-and-drop tree with inline rename, copy/cut/paste, and multi-level
  nesting.
- **Source pane**: mock-import a folder from disk to draft how you'd re-organize
  it. Nothing on disk is ever modified — Varkitekt only reads directory
  structure to build an in-memory tree, then marks items as "existing" so the
  text output can annotate where each file came from.
- **Moved / remaining counter** tracks how many imported files still need a
  home in your new architecture.
- **~70 file types** with extension-based auto-detection and distinct icon
  colors (JS/TS/React/Vue/Svelte/Python/Rust/Go/Swift/Kotlin/… plus configs,
  docs, images, media, archives, etc). Right-click a file to pick manually
  from a searchable picker.
- **Notes on any node** exported as trailing comments in the text output.
- **Saved architectures** — named snapshots you can duplicate, rename, and
  reload from a dropdown in the toolbar.
- **100-step undo/redo** (Ctrl+Z / Ctrl+Y).
- **Fully keyboard-navigable**: arrow keys, Home/End, Tab to switch panes,
  Space to collapse, Enter/F2 to rename, Del to delete, Ctrl+C/X/V, `N` for
  note, `T` for file-type picker, `Ctrl+Shift+F`/`Ctrl+Shift+A` to add a child
  folder/file.
- **Large-folder filter** — slider to skip any folder whose direct-child count
  exceeds a threshold (defaults to 500), so `node_modules` / `.git` / `dist`
  style directories get pruned on import.

## Output formats

Three preview modes in the right pane, each copyable in one click:

**ASCII tree**
```
my-project/
├── src/
│   ├── index.js
│   └── utils.js
├── README.md
└── package.json
```

**Indented**
```
my-project/
  src/
    index.js
    utils.js
  README.md
  package.json
```

**Paths**
```
my-project/
my-project/src/
my-project/src/index.js
my-project/src/utils.js
my-project/README.md
my-project/package.json
```

From-disk nodes get an ` - EXISTS - MOVED FROM {original/path}` annotation.
Notes get appended as ` # note text`.

## Build from source

Requirements: [Rust](https://rustup.rs/) (stable) and
[Node.js](https://nodejs.org/) 20+.

```bash
git clone https://github.com/HammerCreativeLLC/varkitekt.git
cd varkitekt
npm install
npm run tauri dev      # dev mode with hot reload
npm run tauri build    # produces a signed-ready installer in src-tauri/target/release/bundle
```

On Windows the first build downloads WebView2 and the MSI/NSIS toolchains, so
expect 3–5 minutes. Subsequent builds are incremental and much faster.

## License

MIT — see [LICENSE](LICENSE).
