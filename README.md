# Varkitekt

Desktop tree editor for sketching file and folder architectures. Drag-and-drop
nodes, annotate with notes, preview the result as an ASCII tree / indented
outline / slash-path list, copy to clipboard, done.

Built with [Tauri v2](https://v2.tauri.app/) + vanilla JS/HTML/CSS. No build
pipeline, no framework. The Rust side is minimal and exposes no IPC — the
entire app runs inside the webview.

Website: [varkitekt.com](https://varkitekt.com)

---

## Prerequisites

You need **two** toolchains installed before you can build Varkitekt: **Rust**
and **Node.js**. You also need platform-specific system dependencies required
by Tauri v2.

### 1. Rust (stable)

Install via [rustup](https://rustup.rs/):

**macOS / Linux:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

**Windows:**

Download and run the [rustup-init.exe installer](https://rustup.rs/).

After install, verify:
```bash
rustc --version
cargo --version
```

### 2. Node.js (v20 or later)

Download from [nodejs.org](https://nodejs.org/) (LTS recommended) or use a
version manager like `nvm` (macOS/Linux) or `nvm-windows` (Windows).

After install, verify:
```bash
node --version
npm --version
```

### 3. Platform-specific system dependencies

Tauri v2 requires OS-level libraries and toolchains to compile the native
shell. Install these **before** running any build commands.

**macOS:**
```bash
xcode-select --install
```
This installs the Xcode Command Line Tools (includes clang and macOS SDK).

**Windows:**

Install [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/).
During installation, select the **"Desktop development with C++"** workload.
WebView2 is pre-installed on Windows 10 (version 1803+) and Windows 11.

**Linux (Debian/Ubuntu):**
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

For other Linux distributions, see the
[Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/).

---

## Installation

### Step 1 — Clone the repository

```bash
git clone https://github.com/HammerCreativeLLC/varkitekt.git
cd varkitekt
```

### Step 2 — Install Node dependencies

```bash
npm install
```

This installs `@tauri-apps/cli` (the only Node dependency), which provides the
`tauri` command used by the npm scripts.

### Step 3 — Run in development mode

```bash
npm run tauri dev
```

This compiles the Rust backend and opens the app window with hot-reload enabled
for the frontend files in `src/`. On the first run, Cargo will download and
compile all Rust crates — expect 3-5 minutes. Subsequent runs are incremental
and much faster.

### Step 4 — Build for production (optional)

```bash
npm run tauri build
```

This produces a platform-specific installer in
`src-tauri/target/release/bundle/`. The exact output depends on your OS:
- **macOS:** `.dmg` and `.app` bundle
- **Windows:** `.msi` and/or `.exe` (NSIS) installer
- **Linux:** `.deb` and `.AppImage`

---

## Project structure

```
varkitekt/
├── src/                    # Frontend (vanilla JS/HTML/CSS, served by the webview)
│   ├── assets/             #   Static assets (SVG icons)
│   ├── index.html          #   App shell and layout
│   ├── main.js             #   All application logic (tree, drag-drop, output, etc.)
│   └── styles.css          #   Styles
├── src-tauri/              # Tauri / Rust native shell
│   ├── build.rs            #   Tauri build script
│   ├── Cargo.toml          #   Rust dependencies (tauri, serde, serde_json, tauri-plugin-opener)
│   ├── tauri.conf.json     #   Tauri app config (window size, bundle targets, etc.)
│   ├── src/
│   │   ├── main.rs         #   Entry point — calls lib::run()
│   │   └── lib.rs          #   Tauri builder setup (~10 lines, no IPC commands)
│   ├── capabilities/       #   Tauri v2 security permissions
│   └── icons/              #   App icons for all platforms
├── site/                   # Marketing website (deployed to Firebase Hosting)
│   └── index.html
├── package.json            #   Node config — only dependency is @tauri-apps/cli
├── firebase.json           #   Firebase Hosting config (serves site/ directory)
└── LICENSE                 #   MIT
```

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
  colors (JS/TS/React/Vue/Svelte/Python/Rust/Go/Swift/Kotlin/... plus configs,
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

## License

MIT — see [LICENSE](LICENSE).
