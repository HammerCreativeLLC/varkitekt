// Varkitekt — tree editor with drag-and-drop and text output.
//
// Tree model: { id, name, type: 'folder' | 'file', open: bool, children: [] }
// Persistence: localStorage ('varkitekt:tree', 'varkitekt:format')
// No Tauri IPC is used — this is a pure frontend app running inside the webview.
//
// OS-explorer drops: when the user drags files or folders from the OS file
// explorer, we DO NOT touch disk. We read entry metadata via the HTML5
// FileSystemEntry API and create mock nodes, tagging each with origin +
// originalPath so the text output can call them out.

// One-time migration: earlier builds used the "arch-builder:" localStorage
// prefix. On first boot after the rename, copy old keys over to the new
// prefix so saved architectures, preferences, and working state survive.
(function migrateStoragePrefix() {
  const OLD = "arch-builder:";
  const NEW = "varkitekt:";
  if (localStorage.getItem(NEW + "_migrated")) return;
  const oldKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(OLD)) oldKeys.push(k);
  }
  for (const ok of oldKeys) {
    const nk = NEW + ok.slice(OLD.length);
    if (localStorage.getItem(nk) === null) {
      localStorage.setItem(nk, localStorage.getItem(ok));
    }
    localStorage.removeItem(ok);
  }
  localStorage.setItem(NEW + "_migrated", "1");
})();

const STORAGE_KEY = "varkitekt:tree";
const SOURCE_KEY = "varkitekt:source";
const SOURCE_NAME_KEY = "varkitekt:source-name";
const SOURCE_INITIAL_KEY = "varkitekt:source-initial";
const CHILD_THRESHOLD_KEY = "varkitekt:child-threshold";
const PANE_WIDTHS_KEY = "varkitekt:pane-widths";
const DEFAULT_CHILD_THRESHOLD = 500;
const FORMAT_KEY = "varkitekt:format";
const SAVED_KEY = "varkitekt:saved";
const CURRENT_SAVE_KEY = "varkitekt:current-save";
const SVG_NS = "http://www.w3.org/2000/svg";

let tree = loadTree();
let sourceTree = loadPaneFromStorage(SOURCE_KEY);
let sourceFolderName = localStorage.getItem(SOURCE_NAME_KEY) || "";
let sourceInitial = loadSourceInitial(); // { files, folders } captured at load time
let childThreshold = clampChildThreshold(Number(localStorage.getItem(CHILD_THRESHOLD_KEY)) || DEFAULT_CHILD_THRESHOLD);
let paneWidths = loadPaneWidths();

function clampChildThreshold(n) {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHILD_THRESHOLD;
  return Math.min(2000, Math.max(10, Math.round(n)));
}

// Pane widths are persisted as { source, output } in px. Clamps enforce sane
// minimums/maximums so a nasty drag can't leave the app in a broken layout.
function clampSourceWidth(n) {
  return Math.max(220, Math.min(720, Math.round(n)));
}
function clampOutputWidth(n) {
  return Math.max(280, Math.min(720, Math.round(n)));
}
function loadPaneWidths() {
  try {
    const raw = localStorage.getItem(PANE_WIDTHS_KEY);
    if (!raw) return { source: 320, output: 380 };
    const p = JSON.parse(raw);
    return {
      source: clampSourceWidth(Number(p.source) || 320),
      output: clampOutputWidth(Number(p.output) || 380),
    };
  } catch {
    return { source: 320, output: 380 };
  }
}
function savePaneWidths() {
  localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(paneWidths));
}
function applyPaneWidths() {
  const root = document.documentElement;
  root.style.setProperty("--src-w", paneWidths.source + "px");
  root.style.setProperty("--out-w", paneWidths.output + "px");
}
let dragging = null; // { id, fromPane: 'main' | 'source' }
let selectedId = null;
let clipboard = null; // { mode: 'copy' | 'cut', node, originalId? }
let currentSaveId = localStorage.getItem(CURRENT_SAVE_KEY) || null;
let format = localStorage.getItem(FORMAT_KEY) || "ascii";

// Undo/redo. We snapshot whole-tree state before every mutation. This is
// simple and fast for architecture-sized trees (thousands of nodes at most),
// and avoids the bookkeeping a command-pattern implementation would need.
const UNDO_LIMIT = 100;
const undoStack = [];
const redoStack = [];

function snapshotState() {
  return {
    tree: JSON.parse(JSON.stringify(tree)),
    sourceTree: JSON.parse(JSON.stringify(sourceTree)),
    sourceFolderName,
    sourceInitial: { ...sourceInitial },
    selectedId,
  };
}

function applyState(s) {
  tree = s.tree;
  sourceTree = s.sourceTree;
  sourceFolderName = s.sourceFolderName;
  sourceInitial = { ...s.sourceInitial };
  selectedId = s.selectedId;
}

// Call BEFORE mutating tree/sourceTree. Records the pre-mutation state so
// Ctrl+Z restores it.
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  if (undoStack.length === 0) {
    flashStatus("Nothing to undo");
    return;
  }
  redoStack.push(snapshotState());
  applyState(undoStack.pop());
  render();
  flashStatus("Undo");
}

function redo() {
  if (redoStack.length === 0) {
    flashStatus("Nothing to redo");
    return;
  }
  undoStack.push(snapshotState());
  applyState(redoStack.pop());
  render();
  flashStatus("Redo");
}

// ---------------- Tree model helpers ----------------

function uid() {
  return "n" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function makeNode(type, name) {
  return {
    id: uid(),
    type,
    name: name || (type === "folder" ? "new-folder" : "new-file.txt"),
    open: true,
    children: type === "folder" ? [] : undefined,
  };
}

function loadPaneFromStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadTree() {
  return loadPaneFromStorage(STORAGE_KEY);
}

function saveTree() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tree));
}

function saveSourceTree() {
  localStorage.setItem(SOURCE_KEY, JSON.stringify(sourceTree));
  if (sourceFolderName) {
    localStorage.setItem(SOURCE_NAME_KEY, sourceFolderName);
  } else {
    localStorage.removeItem(SOURCE_NAME_KEY);
  }
  localStorage.setItem(SOURCE_INITIAL_KEY, JSON.stringify(sourceInitial));
}

function loadSourceInitial() {
  try {
    const raw = localStorage.getItem(SOURCE_INITIAL_KEY);
    if (!raw) return { files: 0, folders: 0 };
    const parsed = JSON.parse(raw);
    return {
      files: Number(parsed.files) || 0,
      folders: Number(parsed.folders) || 0,
    };
  } catch {
    return { files: 0, folders: 0 };
  }
}

// Count folders + files contained in an array of nodes (recursive).
function countNodes(nodes) {
  let folders = 0;
  let files = 0;
  const walk = (arr) =>
    arr.forEach((n) => {
      if (n.type === "folder") {
        folders++;
        if (n.children) walk(n.children);
      } else {
        files++;
      }
    });
  walk(nodes);
  return { folders, files };
}

// Find a node and its parent array. Returns { node, parentArr, index, parentId }.
function findNode(id, nodes = tree, parentArr = tree, parentId = null) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parentArr: nodes, index: i, parentId };
    if (n.children) {
      const found = findNode(id, n.children, n.children, n.id);
      if (found) return found;
    }
  }
  return null;
}

function removeNode(id) {
  const loc = findNodeAnywhere(id);
  if (!loc) return null;
  loc.parentArr.splice(loc.index, 1);
  return loc.node;
}

// Deep clone a node, assigning fresh IDs everywhere so the clone can coexist
// with the original in the tree.
function deepClone(node) {
  const copy = {
    id: uid(),
    type: node.type,
    name: node.name,
    open: node.open,
  };
  if (node.origin) copy.origin = node.origin;
  if (node.originalPath !== undefined) copy.originalPath = node.originalPath;
  if (node.note) copy.note = node.note;
  if (node.fileType) copy.fileType = node.fileType;
  if (node.type === "folder") {
    copy.children = node.children.map(deepClone);
  }
  return copy;
}

// ---------------- File type registry ----------------
//
// Each entry maps a logical type to an icon tint and the extensions we use to
// auto-detect that type. `id` is stored on the node when the user manually
// overrides the auto-detection (via the picker).

const FILE_TYPES = [
  // Web
  { id: "js", name: "JavaScript", color: "#f7df1e", exts: ["js", "cjs", "mjs"] },
  { id: "ts", name: "TypeScript", color: "#3178c6", exts: ["ts", "mts", "cts"] },
  { id: "jsx", name: "React (JSX)", color: "#61dafb", exts: ["jsx"] },
  { id: "tsx", name: "React (TSX)", color: "#3178c6", exts: ["tsx"] },
  { id: "vue", name: "Vue", color: "#41b883", exts: ["vue"] },
  { id: "svelte", name: "Svelte", color: "#ff3e00", exts: ["svelte"] },
  { id: "html", name: "HTML", color: "#e34c26", exts: ["html", "htm"] },
  { id: "css", name: "CSS", color: "#1572b6", exts: ["css"] },
  { id: "scss", name: "Sass/SCSS", color: "#cc6699", exts: ["scss", "sass"] },
  { id: "less", name: "Less", color: "#1d365d", exts: ["less"] },
  { id: "json", name: "JSON", color: "#e8b339", exts: ["json", "jsonc", "json5"] },
  { id: "graphql", name: "GraphQL", color: "#e535ab", exts: ["graphql", "gql"] },
  // Languages
  { id: "python", name: "Python", color: "#3776ab", exts: ["py", "pyw", "pyi"] },
  { id: "ruby", name: "Ruby", color: "#cc342d", exts: ["rb", "erb"] },
  { id: "go", name: "Go", color: "#00add8", exts: ["go"] },
  { id: "rust", name: "Rust", color: "#dea584", exts: ["rs"] },
  { id: "java", name: "Java", color: "#b07219", exts: ["java"] },
  { id: "kotlin", name: "Kotlin", color: "#a97bff", exts: ["kt", "kts"] },
  { id: "swift", name: "Swift", color: "#fa7343", exts: ["swift"] },
  { id: "c", name: "C", color: "#a8b9cc", exts: ["c", "h"] },
  { id: "cpp", name: "C++", color: "#f34b7d", exts: ["cpp", "cxx", "cc", "hpp", "hxx"] },
  { id: "csharp", name: "C#", color: "#68217a", exts: ["cs", "csx"] },
  { id: "php", name: "PHP", color: "#777bb4", exts: ["php", "phtml"] },
  { id: "shell", name: "Shell script", color: "#89e051", exts: ["sh", "bash", "zsh", "fish"] },
  { id: "powershell", name: "PowerShell", color: "#5391fe", exts: ["ps1", "psm1", "psd1"] },
  { id: "batch", name: "Batch", color: "#c1f12e", exts: ["bat", "cmd"] },
  { id: "lua", name: "Lua", color: "#4a6bbd", exts: ["lua"] },
  { id: "r", name: "R", color: "#198ce7", exts: ["r"] },
  { id: "sql", name: "SQL", color: "#e38c00", exts: ["sql"] },
  { id: "perl", name: "Perl", color: "#0298c3", exts: ["pl", "pm"] },
  { id: "dart", name: "Dart", color: "#00b4ab", exts: ["dart"] },
  { id: "scala", name: "Scala", color: "#c22d40", exts: ["scala", "sc"] },
  { id: "elixir", name: "Elixir", color: "#6e4a7e", exts: ["ex", "exs"] },
  { id: "erlang", name: "Erlang", color: "#b83998", exts: ["erl", "hrl"] },
  { id: "haskell", name: "Haskell", color: "#5e5086", exts: ["hs", "lhs"] },
  { id: "ocaml", name: "OCaml", color: "#3be133", exts: ["ml", "mli"] },
  { id: "clojure", name: "Clojure", color: "#db5855", exts: ["clj", "cljs", "cljc", "edn"] },
  { id: "elm", name: "Elm", color: "#60b5cc", exts: ["elm"] },
  { id: "zig", name: "Zig", color: "#ec915c", exts: ["zig"] },
  { id: "nim", name: "Nim", color: "#ffc200", exts: ["nim", "nims"] },
  { id: "crystal", name: "Crystal", color: "#cacaca", exts: ["cr"] },
  { id: "julia", name: "Julia", color: "#a270ba", exts: ["jl"] },
  { id: "fsharp", name: "F#", color: "#b845fc", exts: ["fs", "fsx", "fsi"] },
  { id: "objc", name: "Objective-C", color: "#438eff", exts: ["m", "mm"] },
  // Data / Config
  { id: "yaml", name: "YAML", color: "#cb171e", exts: ["yml", "yaml"] },
  { id: "toml", name: "TOML", color: "#9c4221", exts: ["toml"] },
  { id: "xml", name: "XML", color: "#0060ac", exts: ["xml", "xsd", "xsl", "xslt"] },
  { id: "csv", name: "CSV / TSV", color: "#237346", exts: ["csv", "tsv"] },
  { id: "ini", name: "INI / Config", color: "#8b949e", exts: ["ini", "cfg", "conf", "properties"] },
  { id: "env", name: "Environment", color: "#ecd53f", exts: ["env"] },
  { id: "dockerfile", name: "Dockerfile", color: "#2496ed", exts: ["dockerfile"] },
  { id: "makefile", name: "Makefile", color: "#427819", exts: ["makefile", "mk", "mak"] },
  { id: "gitignore", name: "Git config", color: "#f05032", exts: ["gitignore", "gitattributes", "gitmodules"] },
  { id: "editorconfig", name: "EditorConfig", color: "#8b949e", exts: ["editorconfig"] },
  // Docs
  { id: "markdown", name: "Markdown", color: "#ffffff", exts: ["md", "markdown", "mdx"] },
  { id: "text", name: "Plain text", color: "#8b949e", exts: ["txt"] },
  { id: "readme", name: "README", color: "#67d26a", exts: ["readme"] },
  { id: "license", name: "License", color: "#67d26a", exts: ["license", "copying"] },
  { id: "pdf", name: "PDF", color: "#ee3c37", exts: ["pdf"] },
  { id: "doc", name: "Word document", color: "#185abd", exts: ["doc", "docx", "odt", "rtf"] },
  { id: "xls", name: "Spreadsheet", color: "#217346", exts: ["xls", "xlsx", "ods"] },
  { id: "ppt", name: "Presentation", color: "#d24726", exts: ["ppt", "pptx", "odp"] },
  // Images
  { id: "image", name: "Image", color: "#67d26a", exts: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "tiff"] },
  { id: "svg", name: "SVG", color: "#ff9e1f", exts: ["svg"] },
  { id: "psd", name: "Photoshop / design", color: "#31a8ff", exts: ["psd", "ai", "sketch", "fig", "xd"] },
  // Media
  { id: "video", name: "Video", color: "#e5484d", exts: ["mp4", "mov", "avi", "mkv", "webm", "m4v"] },
  { id: "audio", name: "Audio", color: "#a855f7", exts: ["mp3", "wav", "flac", "ogg", "m4a", "aac"] },
  // Archives
  { id: "archive", name: "Archive", color: "#b08460", exts: ["zip", "tar", "gz", "bz2", "7z", "rar", "xz"] },
  // Fonts
  { id: "font", name: "Font", color: "#e8b339", exts: ["ttf", "otf", "woff", "woff2", "eot"] },
  // Binary / Executable
  { id: "executable", name: "Executable / binary", color: "#8b949e", exts: ["exe", "dll", "so", "dylib", "app", "bin"] },
  // Log
  { id: "log", name: "Log", color: "#8b949e", exts: ["log"] },
  // Lock files
  { id: "lock", name: "Lock file", color: "#8b949e", exts: ["lock"] },
];

const FILE_TYPE_BY_ID = Object.fromEntries(FILE_TYPES.map((t) => [t.id, t]));

// Auto-detect the type from a filename. Returns a type id or null.
function detectFileType(name) {
  const lower = name.toLowerCase();

  // Exact / prefix matches by full filename (things that have no extension)
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile" || lower === "bsdmakefile") return "makefile";
  if (lower.startsWith("readme")) return "readme";
  if (lower.startsWith("license") || lower.startsWith("copying")) return "license";
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") return "gitignore";
  if (lower === ".editorconfig") return "editorconfig";
  if (lower === ".env" || lower.startsWith(".env.")) return "env";

  // Well-known lock files
  if (lower.endsWith(".lock") || lower === "package-lock.json" || lower === "yarn.lock" || lower === "cargo.lock" || lower === "pnpm-lock.yaml" || lower === "bun.lockb") return "lock";

  // Extension lookup
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = lower.slice(dot + 1);
  for (const t of FILE_TYPES) {
    if (t.exts.includes(ext)) return t.id;
  }
  return null;
}

function getFileTypeMeta(node) {
  if (!node || node.type !== "file") return null;
  const id = node.fileType || detectFileType(node.name);
  return id ? FILE_TYPE_BY_ID[id] || null : null;
}

// Search both panes. Returns loc with added `paneId` field, or null.
function findNodeAnywhere(id) {
  let loc = findNode(id, tree, tree);
  if (loc) return Object.assign(loc, { paneId: "main" });
  loc = findNode(id, sourceTree, sourceTree);
  if (loc) return Object.assign(loc, { paneId: "source" });
  return null;
}

function isDescendantOf(childId, ancestorId) {
  if (childId === ancestorId) return true;
  const loc = findNode(ancestorId);
  if (!loc || !loc.node.children) return false;
  const stack = [...loc.node.children];
  while (stack.length) {
    const n = stack.pop();
    if (n.id === childId) return true;
    if (n.children) stack.push(...n.children);
  }
  return false;
}

// ---------------- DOM helpers ----------------

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.title) node.title = opts.title;
  if (opts.dataset) {
    for (const k in opts.dataset) node.dataset[k] = opts.dataset[k];
  }
  if (opts.attrs) {
    for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
  }
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) node.setAttribute(k, attrs[k]);
  return node;
}

function folderIcon() {
  const svg = svgEl("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 16 16",
    fill: "currentColor",
    "aria-hidden": "true",
  });
  svg.appendChild(
    svgEl("path", {
      d: "M1.75 3a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h12.5a.75.75 0 0 0 .75-.75v-7a.75.75 0 0 0-.75-.75H7.81a.75.75 0 0 1-.53-.22L6.03 3.22A.75.75 0 0 0 5.5 3H1.75Z",
    })
  );
  return svg;
}

function fileIcon() {
  const svg = svgEl("svg", {
    width: "14",
    height: "14",
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.2",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  });
  svg.appendChild(
    svgEl("path", {
      d: "M3.75 1.75h5.5L13 5.5v7.25A1.75 1.75 0 0 1 11.25 14.5h-7.5A1.75 1.75 0 0 1 2 12.75v-9.25c0-.966.784-1.75 1.75-1.75Z",
    })
  );
  svg.appendChild(svgEl("path", { d: "M9.25 1.75V5.5H13" }));
  return svg;
}

// ---------------- Render ----------------

const $root = document.getElementById("tree-root");
const $empty = document.getElementById("empty-state");
const $sourceRoot = document.getElementById("source-root");
const $sourceEmpty = document.getElementById("source-empty");
const $sourceFolderName = document.getElementById("source-folder-name");
const $output = document.getElementById("output");
const $copyStatus = document.getElementById("copy-status");

// Map paneId → root element, empty-state element, and tree accessor.
function paneInfo(paneId) {
  if (paneId === "source") {
    return {
      getTree: () => sourceTree,
      setTree: (t) => {
        sourceTree = t;
      },
      rootEl: $sourceRoot,
      emptyEl: $sourceEmpty,
    };
  }
  return {
    getTree: () => tree,
    setTree: (t) => {
      tree = t;
    },
    rootEl: $root,
    emptyEl: $empty,
  };
}

function render() {
  renderPane("main");
  renderPane("source");
  updateOutput();
  saveTree();
  saveSourceTree();
  updateToggleAllLabel();
  updateSourceHeader();
}

function renderPane(paneId) {
  const info = paneInfo(paneId);
  const treeArr = info.getTree();
  const rootEl = info.rootEl;
  const emptyEl = info.emptyEl;

  rootEl.replaceChildren();
  if (treeArr.length === 0) {
    emptyEl.classList.add("show");
  } else {
    emptyEl.classList.remove("show");
    treeArr.forEach((node) => rootEl.appendChild(renderNode(node, paneId)));
  }
  const rootDrop = el("div", {
    className: "root-drop",
    dataset: { dropTarget: "root-end", pane: paneId },
  });
  rootEl.appendChild(rootDrop);
}

function updateToggleAllLabel() {
  const treeBtn = document.getElementById("tree-toggle-all");
  const srcBtn = document.getElementById("source-toggle-all");
  if (treeBtn) {
    treeBtn.textContent = allFoldersOpen(tree) ? "Collapse all" : "Expand all";
    treeBtn.disabled = tree.length === 0;
  }
  if (srcBtn) {
    srcBtn.textContent = allFoldersOpen(sourceTree) ? "Collapse all" : "Expand all";
    srcBtn.disabled = sourceTree.length === 0;
  }
}

function renderNode(node, paneId) {
  const wrap = el("div", { className: "node", dataset: { id: node.id } });

  const row = el("div", {
    className: "node-row",
    dataset: { id: node.id, type: node.type, pane: paneId },
  });
  row.draggable = true;
  if (node.id === selectedId) row.classList.add("selected");
  if (clipboard && clipboard.mode === "cut" && clipboard.originalId === node.id) {
    row.classList.add("cut");
  }
  if (node.origin) row.classList.add("from-disk");

  row.addEventListener("click", (e) => {
    if (e.target.closest(".icon-btn") || e.target.classList.contains("chevron")) return;
    // Update selection IN PLACE — a full render() between mousedowns kills
    // the dblclick target and breaks double-click-to-rename.
    document
      .querySelectorAll(".node-row.selected")
      .forEach((r) => r.classList.remove("selected"));
    selectedId = node.id;
    row.classList.add("selected");
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    // stopPropagation so the document-level closer doesn't nuke the menu we're
    // about to open below.
    e.stopPropagation();
    document
      .querySelectorAll(".node-row.selected")
      .forEach((r) => r.classList.remove("selected"));
    selectedId = node.id;
    row.classList.add("selected");
    showContextMenu(e.clientX, e.clientY, node, paneId);
  });

  const chev = el("span", { className: "chevron" });
  if (node.type === "folder") {
    chev.textContent = "▶";
    if (node.open) chev.classList.add("open");
    chev.addEventListener("click", (e) => {
      e.stopPropagation();
      node.open = !node.open;
      render();
    });
  } else {
    chev.classList.add("empty");
  }
  row.appendChild(chev);

  const icon = el("span", { className: "icon " + node.type });
  icon.appendChild(node.type === "folder" ? folderIcon() : fileIcon());
  // File-type coloring: inline style wins over the default .icon.file rule
  // AND over the from-disk accent tint, so a detected type is always shown.
  if (node.type === "file") {
    const meta = getFileTypeMeta(node);
    if (meta && meta.color) icon.style.color = meta.color;
  }
  row.appendChild(icon);

  const name = el("span", { className: "name", text: node.name });
  name.title = node.originalPath ? `From: ${node.originalPath}` : "";
  if (paneId === "main") {
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      beginRename(name, node);
    });
  }
  row.appendChild(name);

  const actions = el("span", { className: "node-actions" });
  if (paneId === "main") {
    if (node.type === "folder") {
      actions.appendChild(
        iconBtn("+F", "Add folder", (e) => {
          e.stopPropagation();
          addChild(node, "folder");
        })
      );
      actions.appendChild(
        iconBtn("+f", "Add file", (e) => {
          e.stopPropagation();
          addChild(node, "file");
        })
      );
    }
    actions.appendChild(
      iconBtn("⧉", "Copy (Ctrl+C)", (e) => {
        e.stopPropagation();
        copyNode(node.id);
      })
    );
    actions.appendChild(
      iconBtn("✎", "Rename", (e) => {
        e.stopPropagation();
        beginRename(name, node);
      })
    );
    actions.appendChild(
      iconBtn("📝", node.note ? "Edit note" : "Add note", (e) => {
        e.stopPropagation();
        beginEditNote(wrap, node);
      })
    );
  }
  const del = iconBtn("✕", "Delete", (e) => {
    e.stopPropagation();
    pushUndo();
    removeNode(node.id);
    render();
  });
  del.classList.add("delete");
  actions.appendChild(del);
  row.appendChild(actions);

  wireDrag(row, node, paneId);
  wrap.appendChild(row);

  if (node.note) {
    const noteEl = el("div", { className: "note", text: node.note });
    if (paneId === "main") {
      noteEl.title = "Double-click to edit";
      noteEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        beginEditNote(wrap, node, noteEl);
      });
    }
    wrap.appendChild(noteEl);
  }

  if (node.type === "folder") {
    const kids = el("div", { className: "children" });
    if (!node.open) kids.classList.add("hidden");
    node.children.forEach((c) => kids.appendChild(renderNode(c, paneId)));
    wrap.appendChild(kids);
  }

  return wrap;
}

function iconBtn(label, title, onClick) {
  const b = el("button", { className: "icon-btn", text: label, title });
  b.addEventListener("click", onClick);
  return b;
}

// ---------------- Rename ----------------

function beginRename(elm, node) {
  elm.setAttribute("contenteditable", "true");
  elm.focus();
  const range = document.createRange();
  range.selectNodeContents(elm);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    elm.removeAttribute("contenteditable");
    elm.removeEventListener("keydown", onKey);
    elm.removeEventListener("blur", onBlur);
    if (commit) {
      const next = elm.textContent.trim();
      if (next && next !== node.name) {
        pushUndo();
        node.name = next;
      }
    }
    render();
  };
  const onKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      elm.textContent = node.name;
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  elm.addEventListener("keydown", onKey);
  elm.addEventListener("blur", onBlur);
}

// ---------------- Note editing ----------------

// Insert or replace a multi-line note under a node. If `existingEl` is given,
// edit that element in place. Otherwise create a fresh note block under the
// node's row.
function beginEditNote(wrap, node, existingEl) {
  let noteEl = existingEl;
  if (!noteEl) {
    noteEl = wrap.querySelector(":scope > .note");
  }
  if (!noteEl) {
    noteEl = el("div", { className: "note" });
    // Insert after the row, before children container
    const row = wrap.querySelector(":scope > .node-row");
    row.insertAdjacentElement("afterend", noteEl);
  }
  noteEl.textContent = node.note || "";
  noteEl.setAttribute("contenteditable", "true");
  noteEl.focus();
  // Place caret at end
  const range = document.createRange();
  range.selectNodeContents(noteEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    noteEl.removeAttribute("contenteditable");
    noteEl.removeEventListener("keydown", onKey);
    noteEl.removeEventListener("blur", onBlur);
    if (commit) {
      const next = noteEl.textContent.trim();
      const prev = node.note || "";
      if (next !== prev) {
        pushUndo();
        if (next) node.note = next;
        else delete node.note;
      }
    }
    render();
  };
  const onKey = (e) => {
    // Enter commits; Shift+Enter inserts a newline inside the note.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  noteEl.addEventListener("keydown", onKey);
  noteEl.addEventListener("blur", onBlur);
}

// ---------------- Add / clear ----------------

function addRoot(type) {
  pushUndo();
  const node = makeNode(type);
  tree.push(node);
  selectedId = node.id;
  render();
  focusNewName(node.id);
}

function addChild(parent, type) {
  pushUndo();
  const node = makeNode(type);
  parent.open = true;
  parent.children.push(node);
  selectedId = node.id;
  render();
  focusNewName(node.id);
}

function focusNewName(id) {
  requestAnimationFrame(() => {
    const row = $root.querySelector(`.node-row[data-id="${id}"]`);
    if (!row) return;
    const name = row.querySelector(".name");
    const loc = findNode(id);
    if (name && loc) beginRename(name, loc.node);
  });
}

// ---------------- Drag & drop (in-app) ----------------

function dtHasFiles(e) {
  if (!e.dataTransfer) return false;
  const types = e.dataTransfer.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === "Files") return true;
  }
  return false;
}

function wireDrag(row, node, paneId) {
  row.addEventListener("dragstart", (e) => {
    dragging = { id: node.id, fromPane: paneId };
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", node.id);
  });
  row.addEventListener("dragend", () => {
    dragging = null;
    row.classList.remove("dragging");
    clearDropFX();
  });

  row.addEventListener("dragover", (e) => {
    const fromOS = dtHasFiles(e);
    if (!fromOS) {
      if (!dragging || dragging.id === node.id) return;
      // Only check descendant if dragging inside the same pane — cross-pane drags
      // can't be descendants of their target since they're in different trees.
      if (dragging.fromPane === paneId && isDescendantOf(node.id, dragging.id)) return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = fromOS ? "copy" : "move";
    clearDropFX();

    const rect = row.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;

    if (node.type === "folder" && y > h * 0.25 && y < h * 0.75) {
      row.classList.add("drop-inside");
      row.dataset.dropZone = "inside";
    } else if (y < h * 0.5) {
      showIndicator(row.parentElement, "before");
      row.dataset.dropZone = "before";
    } else {
      showIndicator(row.parentElement, "after");
      row.dataset.dropZone = "after";
    }
  });

  row.addEventListener("dragleave", () => {
    row.classList.remove("drop-inside");
    delete row.dataset.dropZone;
  });

  row.addEventListener("drop", async (e) => {
    const fromOS = dtHasFiles(e);
    if (!fromOS) {
      if (!dragging || dragging.id === node.id) return;
      if (dragging.fromPane === paneId && isDescendantOf(node.id, dragging.id)) return;
    }
    e.preventDefault();
    e.stopPropagation();
    const zone = row.dataset.dropZone || "after";
    if (fromOS) {
      const imported = await importFromDataTransfer(e.dataTransfer, paneId);
      insertImportedRelativeTo(imported, node.id, zone, paneId);
    } else {
      performDrop(dragging.id, dragging.fromPane, node.id, paneId, zone);
    }
    clearDropFX();
  });
}

function showIndicator(nodeEl, where) {
  const ind = el("div", {
    className: "drop-indicator",
    dataset: { ephemeral: "1" },
  });
  if (where === "before") {
    nodeEl.parentElement.insertBefore(ind, nodeEl);
  } else {
    nodeEl.parentElement.insertBefore(ind, nodeEl.nextSibling);
  }
}

function clearDropFX() {
  document
    .querySelectorAll(".tree-root .drop-indicator[data-ephemeral='1']")
    .forEach((e) => e.remove());
  document.querySelectorAll(".tree-root .drop-inside").forEach((e) => {
    e.classList.remove("drop-inside");
    delete e.dataset.dropZone;
  });
  document
    .querySelectorAll(".tree-root .root-drop.active")
    .forEach((e) => e.classList.remove("active"));
}

// Move a node between or within panes. Removes from source pane's tree, then
// inserts into destination pane's tree at the drop location. Origin metadata
// rides along untouched on the node itself.
function performDrop(draggedId, fromPane, targetId, toPane, zone) {
  const fromTree = paneInfo(fromPane).getTree();
  const loc = findNode(draggedId, fromTree, fromTree);
  if (!loc) return;
  pushUndo();
  const dragged = loc.node;
  loc.parentArr.splice(loc.index, 1);

  const toTree = paneInfo(toPane).getTree();
  const target = findNode(targetId, toTree, toTree);
  if (!target) {
    toTree.push(dragged);
    render();
    return;
  }
  if (zone === "inside" && target.node.type === "folder") {
    target.node.open = true;
    target.node.children.push(dragged);
  } else if (zone === "before") {
    target.parentArr.splice(target.index, 0, dragged);
  } else {
    target.parentArr.splice(target.index + 1, 0, dragged);
  }
  render();
}

function insertImportedRelativeTo(nodes, targetId, zone, paneId) {
  if (!nodes.length) {
    render();
    return;
  }
  pushUndo();
  const toTree = paneInfo(paneId).getTree();
  const target = findNode(targetId, toTree, toTree);
  if (!target) {
    toTree.push(...nodes);
    render();
    return;
  }
  if (zone === "inside" && target.node.type === "folder") {
    target.node.open = true;
    target.node.children.push(...nodes);
  } else if (zone === "before") {
    target.parentArr.splice(target.index, 0, ...nodes);
  } else {
    target.parentArr.splice(target.index + 1, 0, ...nodes);
  }
  render();
}

// ---------------- Root-area drop (catch-all) ----------------

function wireRootDrop(rootEl, paneId) {
  rootEl.addEventListener("dragover", (e) => {
    const fromOS = dtHasFiles(e);
    if (!dragging && !fromOS) return;
    const rootDrop = e.target.closest(".root-drop");
    if (!rootDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = fromOS ? "copy" : "move";
    rootDrop.classList.add("active");
  });
  rootEl.addEventListener("dragleave", (e) => {
    const rootDrop = e.target.closest(".root-drop");
    if (rootDrop) rootDrop.classList.remove("active");
  });
  rootEl.addEventListener("drop", async (e) => {
    const fromOS = dtHasFiles(e);
    const rootDrop = e.target.closest(".root-drop");
    if (!rootDrop && !fromOS) return;
    e.preventDefault();
    if (fromOS) {
      pushUndo();
      const imported = await importFromDataTransfer(e.dataTransfer, paneId);
      paneInfo(paneId).getTree().push(...imported);
    } else if (dragging) {
      const fromTree = paneInfo(dragging.fromPane).getTree();
      const loc = findNode(dragging.id, fromTree, fromTree);
      if (loc) {
        pushUndo();
        loc.parentArr.splice(loc.index, 1);
        paneInfo(paneId).getTree().push(loc.node);
      }
    }
    clearDropFX();
    render();
  });
}

wireRootDrop($root, "main");
wireRootDrop($sourceRoot, "source");

// The browser defaults to "navigate to file:// URL" when files are dropped
// anywhere outside a handler. Prevent that at the window level so a slightly
// off-target drop doesn't blow away the app.
window.addEventListener("dragover", (e) => {
  if (dtHasFiles(e)) e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (dtHasFiles(e) && !e.defaultPrevented) e.preventDefault();
});

// ---------------- OS → mock node import ----------------
//
// DataTransferItem.webkitGetAsEntry() gives a FileSystemEntry we can walk
// WITHOUT reading file contents — perfect for building mock nodes. We tag
// every imported node with origin + originalPath so the output can note where
// it came from. Name stays clean; the text output is where the annotation
// appears.

async function importFromDataTransfer(dt, paneId) {
  const origin = paneId === "source" ? "source" : "os-drop";
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (entries.length) {
    const nodes = [];
    for (const entry of entries) {
      const n = await entryToNode(entry, origin, "");
      if (n) nodes.push(n);
    }
    return nodes;
  }
  // Fallback: DataTransfer items without entry API → flat files only, no tree.
  const files = dt.files ? Array.from(dt.files) : [];
  return files.map((f) => {
    const n = makeNode("file", f.name);
    n.origin = origin;
    n.originalPath = f.webkitRelativePath || f.name;
    return n;
  });
}

async function entryToNode(entry, origin, basePath) {
  const path = basePath ? basePath + "/" + entry.name : entry.name;
  if (entry.isFile) {
    const n = makeNode("file", entry.name);
    n.origin = origin;
    n.originalPath = path;
    return n;
  }
  const children = await readAllEntries(entry);
  // Skip folders that exceed the direct-child threshold — generated dirs like
  // node_modules and .git usually dwarf anything meaningful.
  if (children.length >= childThreshold) return null;
  const node = makeNode("folder", entry.name);
  node.origin = origin;
  node.originalPath = path;
  for (const child of children) {
    const childNode = await entryToNode(child, origin, path);
    if (childNode) node.children.push(childNode);
  }
  return node;
}

function readAllEntries(dirEntry) {
  return new Promise((resolve, reject) => {
    const reader = dirEntry.createReader();
    const all = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) resolve(all);
          else {
            all.push(...batch);
            readBatch();
          }
        },
        (err) => reject(err)
      );
    };
    readBatch();
  });
}

// ---------------- Clipboard (copy / cut / paste) ----------------

function copyNode(id) {
  const loc = findNode(id);
  if (!loc) return;
  clipboard = { mode: "copy", node: deepClone(loc.node), originalId: id };
  flashStatus("Copied " + loc.node.name);
  render();
}

function cutNode(id) {
  const loc = findNode(id);
  if (!loc) return;
  clipboard = { mode: "cut", node: deepClone(loc.node), originalId: id };
  flashStatus("Cut " + loc.node.name);
  render();
}

// Paste relative to the currently selected node, mirroring typical file managers:
//   - folder selected → paste inside
//   - file selected   → paste as sibling after it
//   - nothing selected → paste at root end
function pasteFromClipboard() {
  if (!clipboard) return;
  // Guard check happens BEFORE pushUndo so we don't record a no-op.
  if (clipboard.mode === "cut" && clipboard.originalId) {
    if (selectedId && isDescendantOf(selectedId, clipboard.originalId)) {
      flashStatus("Can't paste into itself", true);
      return;
    }
  }
  pushUndo();
  const clone = deepClone(clipboard.node);

  if (clipboard.mode === "cut" && clipboard.originalId) {
    removeNode(clipboard.originalId);
    if (selectedId === clipboard.originalId) selectedId = null;
  }

  const target = selectedId ? findNode(selectedId) : null;
  if (!target) {
    tree.push(clone);
  } else if (target.node.type === "folder") {
    target.node.open = true;
    target.node.children.push(clone);
  } else {
    target.parentArr.splice(target.index + 1, 0, clone);
  }

  selectedId = clone.id;
  if (clipboard.mode === "cut") clipboard = null;
  render();
  flashStatus("Pasted");
}

// ---------------- Context menu ----------------

let activeMenu = null;

function closeContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}

function showContextMenu(x, y, node, paneId) {
  closeContextMenu();
  const menu = el("div", { className: "context-menu" });

  const item = (label, shortcut, onClick, opts = {}) => {
    const row = el("div", {
      className: "context-menu-item" + (opts.danger ? " danger" : "") + (opts.disabled ? " disabled" : ""),
    });
    row.appendChild(el("span", { text: label }));
    if (shortcut) row.appendChild(el("span", { className: "shortcut", text: shortcut }));
    if (!opts.disabled) {
      row.addEventListener("click", () => {
        closeContextMenu();
        onClick();
      });
    }
    return row;
  };

  const sep = () => el("div", { className: "context-menu-separator" });
  const isMain = paneId === "main";

  if (isMain && node.type === "folder") {
    menu.appendChild(item("Add folder", "", () => addChild(node, "folder")));
    menu.appendChild(item("Add file", "", () => addChild(node, "file")));
    menu.appendChild(sep());
  }
  if (isMain) {
    menu.appendChild(item("Copy", "Ctrl+C", () => copyNode(node.id)));
    menu.appendChild(item("Cut", "Ctrl+X", () => cutNode(node.id)));
    menu.appendChild(
      item("Paste" + (node.type === "folder" ? " into" : " after"), "Ctrl+V", () => pasteFromClipboard(), {
        disabled: !clipboard,
      })
    );
    menu.appendChild(sep());
    menu.appendChild(item("Rename", "F2", () => {
      const row = document.querySelector(`.node-row[data-id="${node.id}"][data-pane="main"]`);
      const name = row && row.querySelector(".name");
      const loc = findNode(node.id);
      if (name && loc) beginRename(name, loc.node);
    }));
    menu.appendChild(item(node.note ? "Edit note" : "Add note", "", () => {
      const wrap = document.querySelector(`.node-row[data-id="${node.id}"][data-pane="main"]`)?.closest(".node");
      const loc = findNode(node.id);
      if (wrap && loc) beginEditNote(wrap, loc.node);
    }));
    if (node.note) {
      menu.appendChild(item("Remove note", "", () => {
        const loc = findNode(node.id);
        if (loc) {
          pushUndo();
          delete loc.node.note;
          render();
        }
      }));
    }
    if (node.type === "file") {
      const meta = getFileTypeMeta(node);
      const label = meta ? `File type: ${meta.name}…` : "Set file type…";
      menu.appendChild(item(label, "", () => {
        const loc = findNode(node.id);
        if (loc) showFileTypePicker(loc.node);
      }));
    }
  }
  menu.appendChild(item("Delete", "Del", () => {
    pushUndo();
    removeNode(node.id);
    if (selectedId === node.id) selectedId = null;
    render();
  }, { danger: true }));

  document.body.appendChild(menu);
  activeMenu = menu;

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 4;
  const maxY = window.innerHeight - rect.height - 4;
  menu.style.left = Math.min(x, maxX) + "px";
  menu.style.top = Math.min(y, maxY) + "px";
}

document.addEventListener("click", (e) => {
  if (activeMenu && !e.target.closest(".context-menu")) closeContextMenu();
});
document.addEventListener("contextmenu", (e) => {
  // If right-click lands outside any node, close any open menu and let the event proceed
  if (activeMenu && !e.target.closest(".context-menu")) closeContextMenu();
});

// ---------------- File type picker ----------------
//
// Popup command-palette over the tree. Type to filter, Up/Down to navigate,
// Enter to apply, Esc to close. "Auto" at the top clears any manual override
// so the type falls back to extension-based detection.

let activeFileTypePicker = null;

function closeFileTypePicker() {
  if (activeFileTypePicker) {
    activeFileTypePicker.remove();
    activeFileTypePicker = null;
  }
}

function showFileTypePicker(node) {
  closeContextMenu();
  closeFileTypePicker();

  const overlay = el("div", { className: "type-picker-overlay" });
  const picker = el("div", { className: "type-picker" });
  overlay.appendChild(picker);

  const header = el("div", { className: "type-picker-header" });
  header.appendChild(el("span", { text: `Set file type for `, className: "type-picker-muted" }));
  header.appendChild(el("span", { text: node.name, className: "type-picker-file" }));
  picker.appendChild(header);

  const search = el("input", {
    className: "type-picker-search",
    attrs: { placeholder: "Search by name or extension…", autocomplete: "off", spellcheck: "false" },
  });
  picker.appendChild(search);

  const list = el("div", { className: "type-picker-list" });
  picker.appendChild(list);

  const entries = [
    { id: null, name: "Auto (detect from extension)", color: null, exts: [] },
    ...FILE_TYPES,
  ];
  let focusedIdx = 0;
  let filtered = entries;

  const apply = (entry) => {
    const currentId = node.fileType || null;
    const nextId = entry.id || null;
    if (currentId !== nextId) {
      pushUndo();
      if (nextId === null) delete node.fileType;
      else node.fileType = nextId;
    }
    closeFileTypePicker();
    render();
    flashStatus(entry.id ? `Set type: ${entry.name}` : "File type cleared");
  };

  const renderList = () => {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    filtered = entries.filter((t) => {
      if (!q) return true;
      if (t.name.toLowerCase().includes(q)) return true;
      if (t.id && t.id.includes(q)) return true;
      return t.exts.some((e) => e.includes(q));
    });
    if (filtered.length === 0) {
      list.appendChild(el("div", { className: "type-picker-empty", text: "No matches." }));
      return;
    }
    const currentId = node.fileType || null;
    focusedIdx = Math.min(focusedIdx, filtered.length - 1);
    if (focusedIdx < 0) focusedIdx = 0;
    filtered.forEach((t, i) => {
      const item = el("div", {
        className:
          "type-picker-item" +
          (i === focusedIdx ? " focused" : "") +
          (t.id === currentId ? " current" : ""),
      });

      const iconEl = el("span", { className: "type-picker-icon" });
      if (t.id) {
        iconEl.appendChild(fileIcon());
        if (t.color) iconEl.style.color = t.color;
      } else {
        iconEl.textContent = "—";
        iconEl.style.color = "var(--text-faint)";
      }
      item.appendChild(iconEl);

      item.appendChild(el("span", { className: "type-picker-name", text: t.name }));

      if (t.exts.length) {
        const extsText = t.exts.map((e) => "." + e).join(" ");
        item.appendChild(el("span", { className: "type-picker-exts", text: extsText }));
      }

      item.addEventListener("mouseenter", () => {
        focusedIdx = i;
        updateFocusClass();
      });
      item.addEventListener("click", () => apply(t));
      list.appendChild(item);
    });
    scrollFocusedIntoView();
  };

  const updateFocusClass = () => {
    list.querySelectorAll(".type-picker-item").forEach((el, i) => {
      el.classList.toggle("focused", i === focusedIdx);
    });
  };

  const scrollFocusedIntoView = () => {
    const focusedEl = list.querySelector(".type-picker-item.focused");
    if (focusedEl) focusedEl.scrollIntoView({ block: "nearest" });
  };

  search.addEventListener("input", () => {
    focusedIdx = 0;
    renderList();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusedIdx = Math.min(focusedIdx + 1, filtered.length - 1);
      updateFocusClass();
      scrollFocusedIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusedIdx = Math.max(focusedIdx - 1, 0);
      updateFocusClass();
      scrollFocusedIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[focusedIdx]) apply(filtered[focusedIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFileTypePicker();
    }
  });

  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closeFileTypePicker();
  });

  document.body.appendChild(overlay);
  activeFileTypePicker = overlay;

  renderList();
  setTimeout(() => search.focus(), 10);
}

// ---------------- Keyboard navigation helpers ----------------

function paneOf(id) {
  if (!id) return "main";
  const loc = findNodeAnywhere(id);
  return loc ? loc.paneId : "main";
}

// Flat, visible (respects collapsed folders) node list for a pane.
function getFlatVisible(paneId) {
  const treeArr = paneId === "source" ? sourceTree : tree;
  const flat = [];
  const walk = (arr) => {
    for (const n of arr) {
      flat.push(n);
      if (n.type === "folder" && n.open && n.children.length) walk(n.children);
    }
  };
  walk(treeArr);
  return flat;
}

function findParent(id, paneId) {
  const paneTree = paneId === "source" ? sourceTree : tree;
  const walk = (arr, parent) => {
    for (const n of arr) {
      if (n.id === id) return parent;
      if (n.children) {
        const found = walk(n.children, n);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(paneTree, null);
}

function selectById(id) {
  selectedId = id;
  render();
  requestAnimationFrame(() => {
    const row = document.querySelector(`.node-row[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  });
}

function moveSelectionInPane(delta) {
  const paneId = paneOf(selectedId);
  const flat = getFlatVisible(paneId);
  if (flat.length === 0) return;
  let idx = selectedId ? flat.findIndex((n) => n.id === selectedId) : -1;
  if (idx < 0) idx = delta > 0 ? 0 : flat.length - 1;
  else idx = Math.max(0, Math.min(flat.length - 1, idx + delta));
  selectById(flat[idx].id);
}

function selectFirstOrLast(first) {
  const paneId = paneOf(selectedId);
  const flat = getFlatVisible(paneId);
  if (flat.length === 0) return;
  selectById(flat[first ? 0 : flat.length - 1].id);
}

function horizontalNav(direction) {
  if (!selectedId) {
    moveSelectionInPane(direction === "right" ? 1 : -1);
    return;
  }
  const loc = findNodeAnywhere(selectedId);
  if (!loc) return;
  const n = loc.node;
  if (direction === "right") {
    if (n.type === "folder") {
      if (!n.open) {
        n.open = true;
        render();
        return;
      }
      if (n.children.length) {
        selectById(n.children[0].id);
      }
    }
    // File or empty open folder: no-op
  } else {
    if (n.type === "folder" && n.open) {
      n.open = false;
      render();
      return;
    }
    const parent = findParent(selectedId, loc.paneId);
    if (parent) selectById(parent.id);
  }
}

function switchPane() {
  const currentPane = paneOf(selectedId);
  const nextPane = currentPane === "main" ? "source" : "main";
  const flat = getFlatVisible(nextPane);
  if (flat.length === 0) {
    flashStatus(nextPane === "source" ? "Source pane is empty" : "Main tree is empty");
    return;
  }
  selectById(flat[0].id);
}

// ---------------- Keyboard shortcuts ----------------

window.addEventListener("keydown", (e) => {
  // Don't intercept while typing into inputs, textareas, or contenteditable.
  // Those elements handle their own Escape/Enter semantics.
  const active = document.activeElement;
  if (active && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    if (e.key === "Escape") closeContextMenu();
    return;
  }

  const mod = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  // --- Undo / redo ---
  if (mod && !shift && lower === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if ((mod && lower === "y") || (mod && shift && lower === "z")) {
    e.preventDefault();
    redo();
    return;
  }

  // --- Escape: close popovers, deselect ---
  if (key === "Escape") {
    closeContextMenu();
    closeFileTypePicker();
    selectedId = null;
    render();
    return;
  }

  // --- Pane switch ---
  if (key === "Tab") {
    e.preventDefault();
    switchPane();
    return;
  }

  // --- Navigation ---
  if (key === "ArrowDown") { e.preventDefault(); moveSelectionInPane(1); return; }
  if (key === "ArrowUp") { e.preventDefault(); moveSelectionInPane(-1); return; }
  if (key === "ArrowRight") { e.preventDefault(); horizontalNav("right"); return; }
  if (key === "ArrowLeft") { e.preventDefault(); horizontalNav("left"); return; }
  if (key === "Home") { e.preventDefault(); selectFirstOrLast(true); return; }
  if (key === "End") { e.preventDefault(); selectFirstOrLast(false); return; }

  // --- Space: toggle folder open ---
  if (key === " " && selectedId) {
    const loc = findNodeAnywhere(selectedId);
    if (loc && loc.node.type === "folder") {
      e.preventDefault();
      loc.node.open = !loc.node.open;
      render();
    }
    return;
  }

  // Everything below requires a selected node.
  if (!selectedId) return;
  const loc = findNodeAnywhere(selectedId);
  if (!loc) return;
  const node = loc.node;
  const inMain = loc.paneId === "main";

  // --- Rename: F2 anywhere, Enter in main ---
  if ((key === "F2" || (key === "Enter" && !shift && !mod)) && inMain) {
    e.preventDefault();
    const row = document.querySelector(`.node-row[data-id="${selectedId}"][data-pane="main"]`);
    const name = row && row.querySelector(".name");
    if (name) beginRename(name, node);
    return;
  }

  // --- Delete ---
  if (key === "Delete" || key === "Backspace") {
    e.preventDefault();
    pushUndo();
    removeNode(selectedId);
    selectedId = null;
    render();
    return;
  }

  // --- Clipboard (main only) ---
  if (mod && lower === "c" && inMain) { e.preventDefault(); copyNode(selectedId); return; }
  if (mod && lower === "x" && inMain) { e.preventDefault(); cutNode(selectedId); return; }
  if (mod && lower === "v" && clipboard && inMain) { e.preventDefault(); pasteFromClipboard(); return; }

  // --- Notes (N) — main only ---
  if (lower === "n" && !mod && inMain) {
    e.preventDefault();
    const wrap = document
      .querySelector(`.node-row[data-id="${selectedId}"][data-pane="main"]`)
      ?.closest(".node");
    if (wrap) beginEditNote(wrap, node);
    return;
  }

  // --- File type picker (T) — main files only ---
  if (lower === "t" && !mod && inMain && node.type === "file") {
    e.preventDefault();
    showFileTypePicker(node);
    return;
  }

  // --- Add child (Ctrl+Shift+F / Ctrl+Shift+A) on folders in main ---
  if (mod && shift && lower === "f" && inMain && node.type === "folder") {
    e.preventDefault();
    addChild(node, "folder");
    return;
  }
  if (mod && shift && lower === "a" && inMain && node.type === "folder") {
    e.preventDefault();
    addChild(node, "file");
    return;
  }
});

// Click on empty tree background deselects
$root.addEventListener("click", (e) => {
  if (e.target === $root || e.target.classList.contains("root-drop")) {
    selectedId = null;
    render();
  }
});

// ---------------- Status flash ----------------

function flashStatus(msg, isError) {
  $copyStatus.textContent = msg;
  $copyStatus.classList.toggle("ok", !isError);
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => {
    $copyStatus.textContent = "";
    $copyStatus.classList.remove("ok");
  }, 1500);
}

// ---------------- Saved architectures (save / load / duplicate) ----------------
//
// Each saved architecture is a named snapshot of `tree`. The unsaved working
// tree is still autosaved to STORAGE_KEY so the app resumes where you left off.

function loadSavedList() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedList(list) {
  localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

function setCurrentSave(id) {
  currentSaveId = id;
  if (id) localStorage.setItem(CURRENT_SAVE_KEY, id);
  else localStorage.removeItem(CURRENT_SAVE_KEY);
}

// Snapshot the tree — stringify+parse is a deep structural copy that preserves
// IDs. Fresh IDs are only generated on *load* (see `loadArchitecture`).
function snapshotTree() {
  return JSON.parse(JSON.stringify(tree));
}

function saveCurrentAs(name) {
  name = (name || "").trim();
  if (!name) return null;
  const list = loadSavedList();
  const existing = list.find(
    (e) => e.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    existing.tree = snapshotTree();
    existing.updatedAt = Date.now();
    persistSavedList(list);
    setCurrentSave(existing.id);
    return existing;
  }
  const entry = {
    id: uid(),
    name,
    tree: snapshotTree(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(entry);
  persistSavedList(list);
  setCurrentSave(entry.id);
  return entry;
}

function loadArchitecture(id) {
  const entry = loadSavedList().find((e) => e.id === id);
  if (!entry) return;
  pushUndo();
  // deepClone regenerates IDs so any references to old IDs are cleaned.
  tree = entry.tree.map(deepClone);
  selectedId = null;
  clipboard = null;
  setCurrentSave(id);
  render();
  renderSavedPanel();
  flashStatus(`Loaded "${entry.name}"`);
}

function duplicateArchitecture(id) {
  const list = loadSavedList();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  const copy = {
    id: uid(),
    name: nextCopyName(list, entry.name),
    tree: JSON.parse(JSON.stringify(entry.tree)),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(copy);
  persistSavedList(list);
  renderSavedPanel();
  flashStatus(`Duplicated as "${copy.name}"`);
}

function nextCopyName(list, base) {
  let name = `${base} (copy)`;
  let i = 2;
  while (list.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    name = `${base} (copy ${i})`;
    i++;
  }
  return name;
}

function deleteArchitecture(id) {
  const list = loadSavedList().filter((e) => e.id !== id);
  persistSavedList(list);
  if (currentSaveId === id) setCurrentSave(null);
  renderSavedPanel();
}

function renameArchitecture(id, newName) {
  newName = (newName || "").trim();
  if (!newName) return;
  const list = loadSavedList();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  entry.name = newName;
  entry.updatedAt = Date.now();
  persistSavedList(list);
  renderSavedPanel();
  updateCurrentSaveLabel();
}

// ---------------- Saved panel UI ----------------

const $savedBtn = document.getElementById("saved-btn");
const $savedPanel = document.getElementById("saved-panel");
const $savedList = document.getElementById("saved-list");
const $saveName = document.getElementById("save-name");
const $saveForm = document.getElementById("save-form");
const $currentSaveLabel = document.getElementById("current-save-label");

function toggleSavedPanel(show) {
  const isHidden = $savedPanel.classList.contains("hidden");
  const next = show === undefined ? isHidden : show;
  if (next) {
    renderSavedPanel();
    $savedPanel.classList.remove("hidden");
    const list = loadSavedList();
    const cur = currentSaveId && list.find((e) => e.id === currentSaveId);
    $saveName.value = cur ? cur.name : "";
    setTimeout(() => $saveName.focus(), 10);
  } else {
    $savedPanel.classList.add("hidden");
  }
}

$savedBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSavedPanel();
});

document.addEventListener("click", (e) => {
  if ($savedPanel.classList.contains("hidden")) return;
  if (e.target.closest(".saved-menu")) return;
  toggleSavedPanel(false);
});

$saveForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $saveName.value.trim();
  if (!name) return;
  const entry = saveCurrentAs(name);
  if (entry) {
    flashStatus(`Saved "${entry.name}"`);
    renderSavedPanel();
    updateCurrentSaveLabel();
  }
});

function renderSavedPanel() {
  $savedList.replaceChildren();
  const list = loadSavedList().sort((a, b) => b.updatedAt - a.updatedAt);
  if (list.length === 0) {
    $savedList.appendChild(
      el("div", {
        className: "saved-empty",
        text: "No saved architectures yet. Name one above and click Save.",
      })
    );
    updateCurrentSaveLabel();
    return;
  }
  list.forEach((entry) => {
    const active = entry.id === currentSaveId;
    const item = el("div", {
      className: "saved-item" + (active ? " active" : ""),
    });

    const info = el("div", { className: "saved-info" });
    const nameEl = el("div", { className: "saved-name", text: entry.name });
    nameEl.title = "Double-click to rename";
    nameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      beginSavedRename(nameEl, entry);
    });
    info.appendChild(nameEl);
    info.appendChild(
      el("div", {
        className: "saved-meta",
        text: `${countSummary(entry.tree)} · ${formatDate(entry.updatedAt)}`,
      })
    );
    item.appendChild(info);

    const actions = el("div", { className: "saved-actions" });
    actions.appendChild(
      iconBtn("↓", "Load", (e) => {
        e.stopPropagation();
        loadArchitecture(entry.id);
      })
    );
    actions.appendChild(
      iconBtn("⧉", "Duplicate", (e) => {
        e.stopPropagation();
        duplicateArchitecture(entry.id);
      })
    );
    actions.appendChild(
      iconBtn("✎", "Rename", (e) => {
        e.stopPropagation();
        beginSavedRename(nameEl, entry);
      })
    );
    const del = iconBtn("✕", "Delete", (e) => {
      e.stopPropagation();
      if (confirm(`Delete saved architecture "${entry.name}"?`)) {
        deleteArchitecture(entry.id);
      }
    });
    del.classList.add("delete");
    actions.appendChild(del);
    item.appendChild(actions);

    // Clicking the row (but not a button) also loads the entry.
    item.addEventListener("click", (e) => {
      if (e.target.closest(".icon-btn")) return;
      if (e.target === nameEl && nameEl.isContentEditable) return;
      loadArchitecture(entry.id);
    });

    $savedList.appendChild(item);
  });
  updateCurrentSaveLabel();
}

function beginSavedRename(elm, entry) {
  elm.setAttribute("contenteditable", "true");
  elm.focus();
  const range = document.createRange();
  range.selectNodeContents(elm);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = (commit) => {
    elm.removeAttribute("contenteditable");
    elm.removeEventListener("keydown", onKey);
    elm.removeEventListener("blur", onBlur);
    if (commit) {
      const next = elm.textContent.trim();
      if (next && next !== entry.name) renameArchitecture(entry.id, next);
      else elm.textContent = entry.name;
    } else {
      elm.textContent = entry.name;
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  elm.addEventListener("keydown", onKey);
  elm.addEventListener("blur", onBlur);
}

function updateCurrentSaveLabel() {
  const list = loadSavedList();
  const cur = currentSaveId && list.find((e) => e.id === currentSaveId);
  $currentSaveLabel.textContent = cur ? cur.name : "";
}

function countSummary(treeNodes) {
  let folders = 0;
  let files = 0;
  const walk = (arr) =>
    arr.forEach((n) => {
      if (n.type === "folder") {
        folders++;
        if (n.children) walk(n.children);
      } else {
        files++;
      }
    });
  walk(treeNodes);
  const parts = [];
  if (folders) parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return parts.join(", ") || "empty";
}

function formatDate(ts) {
  const now = Date.now();
  const diff = now - ts;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return Math.floor(diff / min) + "m ago";
  if (diff < day) return Math.floor(diff / hour) + "h ago";
  if (diff < 7 * day) return Math.floor(diff / day) + "d ago";
  return new Date(ts).toLocaleDateString();
}

// ---------------- Output formats ----------------

function updateOutput() {
  let text = "";
  if (format === "ascii") text = renderAscii(tree);
  else if (format === "indent") text = renderIndent(tree);
  else text = renderPaths(tree);
  $output.value = text;
}

// Build the display label for a node in the text output. Adds the origin
// suffix ("- EXISTS - MOVED FROM ...") and note suffix ("# ...") if present.
function labelFor(n, withSlash) {
  let base = withSlash && n.type === "folder" ? n.name + "/" : n.name;
  if (n.origin) {
    if (n.originalPath) base += ` - EXISTS - MOVED FROM ${n.originalPath}`;
    else base += ` - EXISTS`;
  }
  if (n.note) {
    const one = n.note.replace(/\s+/g, " ").trim();
    if (one) base += `   # ${one}`;
  }
  return base;
}

function renderAscii(nodes) {
  const lines = [];
  const walk = (arr, prefixes) => {
    arr.forEach((n, i) => {
      const last = i === arr.length - 1;
      const branch = last ? "└── " : "├── ";
      lines.push(prefixes.join("") + branch + labelFor(n, true));
      if (n.type === "folder" && n.children.length) {
        walk(n.children, [...prefixes, last ? "    " : "│   "]);
      }
    });
  };
  if (nodes.length === 1 && nodes[0].type === "folder") {
    lines.push(labelFor(nodes[0], true));
    walk(nodes[0].children, []);
  } else {
    walk(nodes, []);
  }
  return lines.join("\n");
}

function renderIndent(nodes) {
  const lines = [];
  const walk = (arr, depth) => {
    arr.forEach((n) => {
      lines.push("  ".repeat(depth) + labelFor(n, true));
      if (n.type === "folder" && n.children.length) walk(n.children, depth + 1);
    });
  };
  walk(nodes, 0);
  return lines.join("\n");
}

function renderPaths(nodes) {
  const lines = [];
  const walk = (arr, prefix) => {
    arr.forEach((n) => {
      const path = prefix + n.name + (n.type === "folder" ? "/" : "");
      let line = path;
      if (n.origin) {
        if (n.originalPath) line += ` - EXISTS - MOVED FROM ${n.originalPath}`;
        else line += ` - EXISTS`;
      }
      if (n.note) {
        const one = n.note.replace(/\s+/g, " ").trim();
        if (one) line += `   # ${one}`;
      }
      lines.push(line);
      if (n.type === "folder" && n.children.length) walk(n.children, path);
    });
  };
  walk(nodes, "");
  return lines.join("\n");
}

// ---------------- Wire toolbar ----------------

document
  .getElementById("add-root-folder")
  .addEventListener("click", () => addRoot("folder"));
document
  .getElementById("add-root-file")
  .addEventListener("click", () => addRoot("file"));

function allFoldersOpen(treeArr) {
  let allOpen = true;
  let hasFolder = false;
  const walk = (arr) => {
    for (const n of arr) {
      if (n.type !== "folder") continue;
      hasFolder = true;
      if (!n.open) {
        allOpen = false;
        return;
      }
      if (n.children.length) walk(n.children);
      if (!allOpen) return;
    }
  };
  walk(treeArr);
  return hasFolder && allOpen;
}

function setAllOpen(treeArr, open) {
  const walk = (arr) =>
    arr.forEach((n) => {
      if (n.type === "folder") {
        n.open = open;
        walk(n.children);
      }
    });
  walk(treeArr);
}

const $treeToggleAll = document.getElementById("tree-toggle-all");
const $sourceToggleAll = document.getElementById("source-toggle-all");

$treeToggleAll.addEventListener("click", () => {
  setAllOpen(tree, !allFoldersOpen(tree));
  render();
});
$sourceToggleAll.addEventListener("click", () => {
  setAllOpen(sourceTree, !allFoldersOpen(sourceTree));
  render();
});

document.getElementById("clear-all").addEventListener("click", () => {
  if (tree.length === 0) return;
  if (!confirm("Clear the whole structure?")) return;
  pushUndo();
  tree = [];
  selectedId = null;
  render();
});

document.querySelectorAll('input[name="format"]').forEach((inp) => {
  if (inp.value === format) inp.checked = true;
  inp.addEventListener("change", (e) => {
    format = e.target.value;
    localStorage.setItem(FORMAT_KEY, format);
    updateOutput();
  });
});

document.getElementById("copy-btn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($output.value);
  } catch {
    $output.select();
    document.execCommand("copy");
  }
  $copyStatus.textContent = "Copied!";
  $copyStatus.classList.add("ok");
  setTimeout(() => {
    $copyStatus.textContent = "";
    $copyStatus.classList.remove("ok");
  }, 1500);
});

// ---------------- Source pane UI ----------------
//
// "Source" is a read-only-ish pane listing files/folders from disk. Users
// drag items from here onto the main tree to indicate where each existing
// item should move to in the new architecture. As items move out, the
// counter in the source pane header updates so the user can see at a glance
// how many real files still need a home.

const $folderInput = document.getElementById("folder-input");
const $loadFolderBtn = document.getElementById("load-folder-btn");
const $clearSourceBtn = document.getElementById("clear-source-btn");
const $thresholdSlider = document.getElementById("child-threshold");
const $thresholdValue = document.getElementById("child-threshold-value");

$thresholdSlider.value = String(childThreshold);
$thresholdValue.textContent = String(childThreshold);
$thresholdSlider.addEventListener("input", (e) => {
  childThreshold = clampChildThreshold(Number(e.target.value));
  $thresholdValue.textContent = String(childThreshold);
});
$thresholdSlider.addEventListener("change", (e) => {
  childThreshold = clampChildThreshold(Number(e.target.value));
  localStorage.setItem(CHILD_THRESHOLD_KEY, String(childThreshold));
});

$loadFolderBtn.addEventListener("click", () => {
  $folderInput.value = "";
  $folderInput.click();
});

$folderInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  pushUndo();
  const { tree: built, rootName, removed } = buildTreeFromFileList(files);
  sourceTree = built;
  sourceFolderName = rootName;
  sourceInitial = countNodes(built);
  selectedId = null;
  render();
  let msg = `Loaded ${sourceInitial.files} files from "${rootName}"`;
  if (removed && removed.length) {
    msg += ` — skipped ${removed.length} large folder${removed.length === 1 ? "" : "s"}`;
  }
  flashStatus(msg);
  e.target.value = "";
});

$clearSourceBtn.addEventListener("click", () => {
  if (sourceTree.length === 0 && !sourceFolderName) return;
  if (!confirm("Clear the source pane?")) return;
  pushUndo();
  sourceTree = [];
  sourceFolderName = "";
  sourceInitial = { files: 0, folders: 0 };
  render();
});

// Prune folders whose direct child count is at or above the current threshold.
// This is how we strip auto-generated noise like node_modules/.git/dist — any
// folder that explodes past the slider value is dropped entirely from the tree.
// Returns the pruned node list plus info about what was removed.
function pruneLargeFolders(nodes, threshold) {
  const pruned = [];
  const removed = []; // { name, count } for each dropped folder
  for (const n of nodes) {
    if (n.type === "folder") {
      const directCount = n.children.length;
      if (directCount >= threshold) {
        removed.push({ name: n.originalPath || n.name, count: directCount });
        continue;
      }
      const inner = pruneLargeFolders(n.children, threshold);
      n.children = inner.pruned;
      removed.push(...inner.removed);
    }
    pruned.push(n);
  }
  return { pruned, removed };
}

// Build a nested tree from a FileList produced by <input webkitdirectory>.
// Each File has webkitRelativePath like "chosenFolder/sub/file.txt". The first
// path segment is the folder the user selected — we use it as the root.
function buildTreeFromFileList(files) {
  const nodesByPath = new Map();
  const rootNodes = [];
  let rootName = "";

  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split("/").filter(Boolean);
    if (!rootName && parts.length) rootName = parts[0];

    let parentChildren = rootNodes;
    let pathSoFar = "";
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      pathSoFar = pathSoFar ? pathSoFar + "/" + name : name;
      const isLeaf = i === parts.length - 1;
      const type = isLeaf ? "file" : "folder";

      let existing = nodesByPath.get(pathSoFar);
      if (!existing) {
        existing = makeNode(type, name);
        existing.origin = "source";
        existing.originalPath = pathSoFar;
        nodesByPath.set(pathSoFar, existing);
        parentChildren.push(existing);
      }
      if (!isLeaf) parentChildren = existing.children;
    }
  }
  const { pruned, removed } = pruneLargeFolders(rootNodes, childThreshold);
  return { tree: pruned, rootName, removed };
}

// Update the "X moved / Y total" indicator in the source pane header.
function updateSourceHeader() {
  // Auto-shrink the source pane when its tree is empty — keeps the main
  // workspace roomy for users who don't use the disk-import flow.
  const pane = document.getElementById("source-pane");
  if (pane) pane.classList.toggle("empty", sourceTree.length === 0);

  if (!$sourceFolderName) return;
  const current = countNodes(sourceTree);
  const movedFiles = Math.max(0, sourceInitial.files - current.files);
  const movedFolders = Math.max(0, sourceInitial.folders - current.folders);
  const hasLoaded = sourceInitial.files + sourceInitial.folders > 0;

  if (!hasLoaded) {
    $sourceFolderName.textContent = "";
    return;
  }

  const parts = [];
  if (sourceFolderName) parts.push(sourceFolderName);
  const stats = [];
  if (sourceInitial.files > 0) {
    stats.push(`${movedFiles}/${sourceInitial.files} files`);
  }
  if (sourceInitial.folders > 0) {
    stats.push(`${movedFolders}/${sourceInitial.folders} folders`);
  }
  const allMoved = current.files + current.folders === 0;
  parts.push("· " + (allMoved ? "all moved ✓" : stats.join(" · ") + " moved"));
  $sourceFolderName.textContent = parts.join(" ");
  $sourceFolderName.style.color = allMoved ? "#67d26a" : "";
}

// ---------------- Boot ----------------

if (tree.length === 0 && !localStorage.getItem("varkitekt:seeded")) {
  localStorage.setItem("varkitekt:seeded", "1");
  const root = makeNode("folder", "my-project");
  const src = makeNode("folder", "src");
  src.children.push(makeNode("file", "index.js"));
  src.children.push(makeNode("file", "utils.js"));
  root.children.push(src);
  root.children.push(makeNode("file", "README.md"));
  root.children.push(makeNode("file", "package.json"));
  tree.push(root);
}

applyPaneWidths();
wireResizers();
render();
updateCurrentSaveLabel();

// ---------------- Pane resizers ----------------
//
// Each .resizer sits between two panes and drives either --src-w or --out-w.
// Dragging the source resizer right grows source (delta is positive); dragging
// the output resizer left grows output (delta is inverted).
function wireResizers() {
  document.querySelectorAll(".resizer").forEach((el) => {
    const which = el.dataset.resize; // "source" | "output"
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const initial = paneWidths[which];
      el.classList.add("dragging");
      document.body.classList.add("resizing");

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const next =
          which === "source"
            ? clampSourceWidth(initial + dx)
            : clampOutputWidth(initial - dx);
        paneWidths[which] = next;
        // Directly update the CSS var during drag — skip the 0.2s transition
        // so the pane follows the cursor 1:1 instead of lagging.
        document.documentElement.style.setProperty(
          which === "source" ? "--src-w" : "--out-w",
          next + "px"
        );
      };
      const onUp = () => {
        el.classList.remove("dragging");
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        savePaneWidths();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    // Double-click resets to default width.
    el.addEventListener("dblclick", () => {
      paneWidths[which] = which === "source" ? 320 : 380;
      applyPaneWidths();
      savePaneWidths();
    });
  });
}
