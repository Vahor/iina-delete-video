const { core, event, menu, utils, file, playlist, mpv, overlay } = iina;

let overlayReady = false;
let lastOverlayTitle = null;
let lastOverlayPath = null;

function safeGetMpvString(name) {
  try {
    return mpv.getString(name) || null;
  } catch (e) {
    iina.console.log(`Failed to read mpv property ${name}: ${e}`);
    return null;
  }
}

function decodeFileUrl(url) {
  if (!url || !url.startsWith("file://")) return null;

  const path = url.replace(/^file:\/\/(localhost)?/, "");

  try {
    return decodeURIComponent(path);
  } catch (e) {
    iina.console.log(`Failed to decode file URL: ${e}`);
    return path;
  }
}

function normalizeLocalPath(path) {
  if (!path || path.startsWith("/")) return path;

  const workingDirectory = safeGetMpvString("working-directory");
  return workingDirectory ? `${workingDirectory}/${path}` : path;
}

function pathFromSource(source) {
  if (!source) return null;
  if (source.startsWith("file://")) return normalizeLocalPath(decodeFileUrl(source));
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) return null;

  return normalizeLocalPath(source);
}

function titleFromPath(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return parts[0] || path;

  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;")
    .replace(/\$/g, "&#36;");
}

function setupTitleOverlay() {
  if (!core.window.loaded) return false;

  try {
    overlay.simpleMode();
    overlay.setClickable(false);
    overlay.setOpacity(1);
    overlay.setStyle(`
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
        pointer-events: none;
      }

      #content {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding-top: 8px;
        pointer-events: none;
        box-sizing: border-box;
      }

      .title {
        max-width: calc(100vw - 96px);
        padding: 5px 12px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.58);
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
        font-size: 13px;
        line-height: 18px;
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      }
    `);
    overlayReady = true;
    return true;
  } catch (e) {
    overlayReady = false;
    iina.console.log(`Failed to setup title overlay: ${e}`);
    return false;
  }
}

function renderTitleOverlay() {
  if (!overlayReady && !setupTitleOverlay()) return;

  try {
    if (!lastOverlayTitle) {
      overlay.hide();
      return;
    }

    overlay.setContent(`<div class="title">${escapeHtml(lastOverlayTitle)}</div>`);
    overlay.show();
  } catch (e) {
    overlayReady = false;
    iina.console.log(`Failed to render title overlay: ${e}`);
  }
}

function updateFileTitle(source = core.status.url, shouldRender = true) {
  try {
    const path = pathFromSource(source);
    if (!path) {
      lastOverlayTitle = null;
      lastOverlayPath = null;
      if (shouldRender) renderTitleOverlay();
      return;
    }

    const title = titleFromPath(path);
    if (!title) return;

    lastOverlayTitle = title;
    lastOverlayPath = path;

    try {
      // IINA ignores these for the native titlebar of local files, but they can
      // still help mpv/OSD/playlist title consumers.
      mpv.set("force-media-title", title);
      mpv.set("title", title);
    } catch (e) {
      iina.console.log(`Failed to set mpv title: ${e}`);
    }

    if (shouldRender) renderTitleOverlay();
  } catch (e) {
    iina.console.log(`Failed to update folder/filename overlay: ${e}`);
  }
}

function scheduleUpdateFileTitle(source) {
  setTimeout(() => updateFileTitle(source), 100);
}

function deleteCurrentVideo() {
  const path = lastOverlayPath || pathFromSource(core.status.url);

  if (!path) {
    utils.ask("No local file is currently playing.");
    return;
  }

  iina.console.log(`Deleting ${path}...`);

  const confirmed = utils.ask(`Move to Trash?\n\n${path}`);
  if (!confirmed) return;

  try {
    playlist.playNext();
    file.trash(path);
  } catch (e) {
    utils.ask(`Failed to delete file:\n${e}`);
  }
}

mpv.addHook("on_load", 50, () => {
  // Do not touch the overlay from mpv's load hook; IINA may be switching
  // windows/files at this point. Just prepare title state and wait for IINA
  // file/window events to render it.
  updateFileTitle(safeGetMpvString("stream-open-filename"), false);
});

event.on("iina.window-loaded", () => {
  overlayReady = false;
  scheduleUpdateFileTitle();
});

event.on("iina.plugin-overlay-loaded", () => {
  scheduleUpdateFileTitle();
});

event.on("iina.file-loaded", (url) => {
  scheduleUpdateFileTitle(url);
});

event.on("iina.file-started", () => {
  scheduleUpdateFileTitle();
});

event.on("mpv.end-file", () => {
  setTimeout(() => {
    if (!core.status.idle) return;
    lastOverlayTitle = null;
    lastOverlayPath = null;
    renderTitleOverlay();
  }, 300);
});

scheduleUpdateFileTitle();

menu.addItem(
  menu.item("Refresh Folder/Filename Overlay", () => {
    overlayReady = false;
    updateFileTitle();
  }),
);

menu.addItem(
  menu.item("Move Current Video to Trash", deleteCurrentVideo, {
    keyBinding: "Meta+BS",
  }),
);
