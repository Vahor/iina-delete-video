const { core, event, input, menu, utils, file, playlist, mpv, overlay } = iina;

let overlayReady = false;
let lastOverlayTitle = null;
let lastOverlayPath = null;
let lastVideoStats = null;
let activeView = null;
let databaseReady = false;
let databaseDisabled = false;
/** @type {Promise<string | null>} */
let databaseQueue = Promise.resolve(null);

const databasePath = utils.resolvePath("@data/video-library.sqlite3");
const sqlite3Path = "/usr/bin/sqlite3";
const databaseSchema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS videos (
    path TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    like_count INTEGER NOT NULL DEFAULT 0,
    cataloged_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS views (
    id INTEGER PRIMARY KEY,
    session_token TEXT NOT NULL UNIQUE,
    video_path TEXT NOT NULL REFERENCES videos(path),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds REAL,
    final_position_seconds REAL,
    watched_percent REAL
  );
  CREATE INDEX IF NOT EXISTS views_video_path_idx ON views(video_path);
`;
const duplicateViewCleanup = `
  DELETE FROM views
  WHERE ended_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM views completed
      WHERE completed.video_path = views.video_path
        AND completed.ended_at IS NOT NULL
        AND julianday(completed.started_at) - julianday(views.started_at) BETWEEN 0 AND 2.0 / 86400.0
    );
`;

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function reportDatabaseError(message) {
  if (databaseDisabled) return;

  databaseDisabled = true;
  iina.console.log(`Video library database disabled: ${message}`);
  core.osd("Video library tracking disabled: sqlite3 is unavailable");
}

async function executeSql(sql) {
  if (databaseDisabled) return null;

  if (!databaseReady) {
    if (!utils.fileInPath(sqlite3Path)) {
      reportDatabaseError(`${sqlite3Path} was not found`);
      return null;
    }

    const initialization = await utils.exec(sqlite3Path, [databasePath, databaseSchema]);
    if (initialization.status !== 0) {
      reportDatabaseError(initialization.stderr || "failed to initialize the database");
      return null;
    }

    const columns = await utils.exec(sqlite3Path, [databasePath, "PRAGMA table_info(videos);"]);
    const hasLikeCount = columns.stdout.split("\n").some((column) => column.split("|")[1] === "like_count");
    if (!hasLikeCount) {
      const migration = await utils.exec(sqlite3Path, [
        databasePath,
        "ALTER TABLE videos ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0; UPDATE videos SET like_count = CASE WHEN rating = 'like' THEN 1 ELSE 0 END, rating = NULL;",
      ]);
      if (migration.status !== 0) {
        reportDatabaseError(migration.stderr || "failed to migrate the database");
        return null;
      }
    }

    const cleanup = await utils.exec(sqlite3Path, [databasePath, duplicateViewCleanup]);
    if (cleanup.status !== 0) {
      reportDatabaseError(cleanup.stderr || "failed to clean up duplicate views");
      return null;
    }

    databaseReady = true;
  }

  const result = await utils.exec(sqlite3Path, [databasePath, sql]);
  if (result.status !== 0) {
    reportDatabaseError(result.stderr || "database command failed");
    return null;
  }

  return result.stdout;
}

function enqueueSql(sql) {
  databaseQueue = databaseQueue
    .then(() => executeSql(sql))
    .catch((error) => {
      reportDatabaseError(error);
      return null;
    });
  return databaseQueue;
}

function catalogVideo(path) {
  if (!path) return;

  const now = new Date().toISOString();
  enqueueSql(`
    INSERT INTO videos (path, title, cataloged_at, updated_at)
    VALUES (${sqlString(path)}, ${sqlString(titleFromPath(path))}, ${sqlString(now)}, ${sqlString(now)})
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at;
  `);
}

function catalogPlaylist() {
  const paths = [...new Set(
    playlist
      .list()
      .map((entry) => pathFromSource(entry.filename))
      .filter(Boolean),
  )];
  if (paths.length === 0) return;

  const now = new Date().toISOString();
  const values = paths
    .map(
      (path) =>
        `(${sqlString(path)}, ${sqlString(titleFromPath(path))}, ${sqlString(now)}, ${sqlString(now)})`,
    )
    .join(",");
  enqueueSql(`
    INSERT INTO videos (path, title, cataloged_at, updated_at)
    VALUES ${values}
    ON CONFLICT(path) DO UPDATE SET
      title = excluded.title,
      updated_at = excluded.updated_at;
  `);
}

function startView() {
  const path = lastOverlayPath || pathFromSource(core.status.url);
  if (!path) return;
  if (activeView && activeView.path === path) return;

  const session = {
    path,
    token: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    highestPosition: 0,
    duration: null,
  };
  activeView = session;
  catalogVideo(path);
  enqueueSql(`
    INSERT INTO views (session_token, video_path, started_at)
    VALUES (${sqlString(session.token)}, ${sqlString(path)}, ${sqlString(new Date().toISOString())});
  `).then(() => loadVideoStats(path));
}

function finishActiveView() {
  if (!activeView) return;

  const session = activeView;
  activeView = null;

  const duration = Number.isFinite(session.duration) ? session.duration : core.status.duration;
  const position = Math.max(
    session.highestPosition,
    Number.isFinite(core.status.position) ? core.status.position : 0,
  );
  const watchedPercent =
    typeof duration === "number" && duration > 0 && typeof position === "number"
      ? Math.max(0, Math.min(100, (position / duration) * 100))
      : null;
  const numericValue = (value) => (Number.isFinite(value) ? value : "NULL");

  enqueueSql(`
    UPDATE views
    SET ended_at = ${sqlString(new Date().toISOString())},
        duration_seconds = ${numericValue(duration)},
        final_position_seconds = ${numericValue(position)},
        watched_percent = ${numericValue(watchedPercent)}
    WHERE session_token = ${sqlString(session.token)};
  `);
}

function schedulePlaylistCatalog() {
  setTimeout(catalogPlaylist, 0);
}

async function loadVideoStats(path) {
  if (!path) return;

  const output = await enqueueSql(`
    SELECT
      v.like_count,
      COUNT(views.id),
      COALESCE(ROUND(AVG(views.watched_percent)), '')
    FROM videos v
    LEFT JOIN views ON views.video_path = v.path
    WHERE v.path = ${sqlString(path)}
    GROUP BY v.path;
  `);
  if (path !== lastOverlayPath || output === null) return;

  const [likeCount, viewCount, averageWatchedPercent] = output.trim().split("|");
  lastVideoStats = {
    likeCount: Number(likeCount) || 0,
    viewCount: Number(viewCount) || 0,
    averageWatchedPercent:
      averageWatchedPercent === "" ? null : Number(averageWatchedPercent),
  };
  renderTitleOverlay();
}

function addLike() {
  const path = lastOverlayPath;
  if (!path) return;

  const stats = lastVideoStats || { likeCount: 0, viewCount: 0, averageWatchedPercent: null };
  lastVideoStats = { ...stats, likeCount: stats.likeCount + 1 };
  renderTitleOverlay();
  core.osd(`Likes: ${lastVideoStats.likeCount}`);

  catalogVideo(path);
  enqueueSql(`
    UPDATE videos
    SET like_count = like_count + 1,
        updated_at = ${sqlString(new Date().toISOString())}
    WHERE path = ${sqlString(path)};
  `).then(() => loadVideoStats(path));
}

function refreshPlaylistCatalog() {
  schedulePlaylistCatalog();
  core.osd("Playlist catalog refresh scheduled");
}

function revealDatabase() {
  enqueueSql("SELECT 1;").then(() => {
    if (!databaseDisabled) file.showInFinder(databasePath);
  });
}

function decodeSqlHex(value) {
  try {
    return decodeURIComponent(value.replace(/../g, "%$&"));
  } catch (e) {
    iina.console.log(`Failed to decode database path: ${e}`);
    return null;
  }
}

async function sortPlaylist(metric, direction) {
  const output = await enqueueSql(`
    SELECT hex(v.path), v.like_count, COUNT(views.id)
    FROM videos v
    LEFT JOIN views ON views.video_path = v.path
    GROUP BY v.path;
  `);
  if (output === null) return;

  const stats = new Map();
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    const [encodedPath, likes, views] = line.split("|");
    const path = decodeSqlHex(encodedPath);
    if (!path) continue;
    stats.set(path, { likes: Number(likes) || 0, views: Number(views) || 0 });
  }

  const entries = playlist.list().map((entry, id) => ({
    id,
    path: pathFromSource(entry.filename),
  }));
  const localEntries = entries.filter((entry) => entry.path);
  const sortedLocalEntries = [...localEntries].sort((left, right) => {
    const difference =
      (stats.get(left.path)?.[metric] || 0) - (stats.get(right.path)?.[metric] || 0);
    return difference === 0 ? left.id - right.id : direction * difference;
  });
  const desiredEntries = [...entries];
  for (let index = 0; index < localEntries.length; index += 1) {
    desiredEntries[localEntries[index].id] = sortedLocalEntries[index];
  }

  const currentEntries = [...entries];
  for (let targetIndex = 0; targetIndex < desiredEntries.length; targetIndex += 1) {
    const currentIndex = currentEntries.findIndex((entry) => entry.id === desiredEntries[targetIndex].id);
    if (currentIndex === targetIndex) continue;

    playlist.move(currentIndex, targetIndex);
    const [entry] = currentEntries.splice(currentIndex, 1);
    currentEntries.splice(targetIndex, 0, entry);
  }

  core.osd(`Playlist sorted by ${metric} (${direction > 0 ? "ascending" : "descending"})`);
}

function safeGetMpvString(name) {
  try {
    return mpv.getString(name) || null;
  } catch (e) {
    iina.console.log(`Failed to read mpv property ${name}: ${e}`);
    return null;
  }
}

function safeGetMpvNumber(name) {
  try {
    return mpv.getNumber(name);
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

      .video-info {
        display: flex;
        max-width: calc(100vw - 96px);
        align-items: center;
        gap: 6px;
        padding: 5px 12px;
        border-radius: 999px;
        background: rgba(0, 0, 0, 0.58);
        color: white;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
        font-size: 13px;
        line-height: 18px;
        font-weight: 500;
        text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      }

      .title {
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .stats {
        flex: none;
        color: rgba(255, 255, 255, 0.76);
        white-space: nowrap;
      }

      .separator { color: rgba(255, 255, 255, 0.3); }
      @media (max-width: 700px) {
        .stats { display: none; }
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

    const stats = lastVideoStats || { likeCount: 0, viewCount: 0, averageWatchedPercent: null };
    const average =
      stats.averageWatchedPercent === null ? "-" : `${Math.round(stats.averageWatchedPercent)}% avg`;
    overlay.setContent(`
      <div class="video-info">
        <div class="title">${escapeHtml(lastOverlayTitle)}</div>
        <span class="separator">|</span>
        <span class="stats">${stats.viewCount} views, ${average}, ${stats.likeCount} likes</span>
      </div>
    `);
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
      lastVideoStats = null;
      if (shouldRender) renderTitleOverlay();
      return;
    }

    const title = titleFromPath(path);
    if (!title) return;

    lastOverlayTitle = title;
    lastOverlayPath = path;
    lastVideoStats = null;

    try {
      // IINA ignores these for the native titlebar of local files, but they can
      // still help mpv/OSD/playlist title consumers.
      mpv.set("force-media-title", title);
      mpv.set("title", title);
    } catch (e) {
      iina.console.log(`Failed to set mpv title: ${e}`);
    }

    if (shouldRender) renderTitleOverlay();
    loadVideoStats(path);
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

function playlistSortMenu() {
  const sortMenu = menu.item("Sort Playlist");
  sortMenu.addSubMenuItem(menu.item("Likes (Ascending)", () => sortPlaylist("likes", 1)));
  sortMenu.addSubMenuItem(menu.item("Likes (Descending)", () => sortPlaylist("likes", -1)));
  sortMenu.addSubMenuItem(menu.item("Views (Ascending)", () => sortPlaylist("views", 1)));
  sortMenu.addSubMenuItem(menu.item("Views (Descending)", () => sortPlaylist("views", -1)));
  return sortMenu;
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
  setTimeout(startView, 100);
  schedulePlaylistCatalog();
});

event.on("mpv.time-pos.changed", () => {
  if (!activeView) return;

  const position = safeGetMpvNumber("time-pos");
  const duration = safeGetMpvNumber("duration");
  if (Number.isFinite(position)) activeView.highestPosition = Math.max(activeView.highestPosition, position);
  if (Number.isFinite(duration) && duration > 0) activeView.duration = duration;
});

event.on("mpv.end-file", () => {
  finishActiveView();
  setTimeout(() => {
    if (!core.status.idle) return;
    lastOverlayTitle = null;
    lastOverlayPath = null;
    lastVideoStats = null;
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

menu.addItem(menu.item("Refresh Video Library Playlist Catalog", refreshPlaylistCatalog));
menu.addItem(menu.item("Show Video Library Database in Finder", revealDatabase));
menu.addItem(menu.item("Like Current Video", addLike, { keyBinding: "l" }));
menu.addItem(menu.item("Sort Playlist by Likes (Ascending)", () => sortPlaylist("likes", 1)));
menu.addItem(menu.item("Sort Playlist by Likes (Descending)", () => sortPlaylist("likes", -1)));
menu.addItem(menu.item("Sort Playlist by Views (Ascending)", () => sortPlaylist("views", 1)));
menu.addItem(menu.item("Sort Playlist by Views (Descending)", () => sortPlaylist("views", -1)));

input.onKeyDown("l", () => {
  addLike();
  return true;
});

playlist.registerMenuBuilder(() => [playlistSortMenu()]);
