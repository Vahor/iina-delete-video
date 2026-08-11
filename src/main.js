const { core, event, input, menu, utils, file, playlist, mpv, overlay } = iina;
const { createTitleOverlay } = require("./overlay.js");
const { createPathUtils } = require("./path-utils.js");
const { createVideoLibrary } = require("./sqlite.js");

const { pathFromSource, safeGetMpvString, titleFromPath } = createPathUtils({ mpv, pluginConsole: iina.console });

const titleOverlay = createTitleOverlay({ core, overlay, mpv, pathFromSource, titleFromPath, pluginConsole: iina.console });
const library = createVideoLibrary({
  core, utils, playlist, mpv, pathFromSource, titleFromPath, pluginConsole: iina.console,
  onStats: (path, stats) => titleOverlay.setStats(path, stats),
});

function updateOverlay(source, shouldRender = true) {
  const path = titleOverlay.update(source, shouldRender);
  if (path) library.loadStats(path);
}

function scheduleOverlayUpdate(source) {
  setTimeout(() => updateOverlay(source), 100);
}

function deleteCurrentVideo() {
  const path = titleOverlay.getPath() || pathFromSource(core.status.url);
  if (!path) return utils.ask("No local file is currently playing.");
  if (!utils.ask(`Move to Trash?\n\n${path}`)) return;
  try { playlist.playNext(); file.trash(path); } catch (error) { utils.ask(`Failed to delete file:\n${error}`); }
}

mpv.addHook("on_load", 50, () => updateOverlay(safeGetMpvString("stream-open-filename"), false));
event.on("iina.window-loaded", () => { titleOverlay.reset(); scheduleOverlayUpdate(); });
event.on("iina.plugin-overlay-loaded", () => scheduleOverlayUpdate());
event.on("iina.file-loaded", (url) => scheduleOverlayUpdate(url));
event.on("iina.file-started", () => {
  scheduleOverlayUpdate();
  setTimeout(() => library.startView(titleOverlay.getPath() || pathFromSource(core.status.url)), 100);
  setTimeout(() => library.catalogPlaylist(), 0);
});
event.on("mpv.time-pos.changed", () => library.trackProgress());
event.on("mpv.end-file", () => {
  library.finishView();
  setTimeout(() => { if (core.status.idle) titleOverlay.clear(); }, 300);
});

scheduleOverlayUpdate();
menu.addItem(menu.item("Refresh Folder/Filename Overlay", () => { titleOverlay.reset(); updateOverlay(); }));
menu.addItem(menu.item("Move Current Video to Trash", deleteCurrentVideo, { keyBinding: "Meta+BS" }));
menu.addItem(menu.item("Refresh Video Library Playlist Catalog", () => {
  setTimeout(() => library.catalogPlaylist(), 0);
  core.osd("Playlist catalog refresh scheduled");
}));
menu.addItem(menu.item("Like Current Video", () => library.addLike(titleOverlay.getPath()), { keyBinding: "l" }));
input.onKeyDown("l", () => { library.addLike(titleOverlay.getPath()); return true; });
