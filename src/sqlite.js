function createVideoLibrary({ core, utils, file, playlist, mpv, pathFromSource, titleFromPath, onStats, pluginConsole }) {
  let activeView = null;
  let startingPath = null;
  let databaseReady = false;
  let databaseDisabled = false;
  let databaseQueue = Promise.resolve(null);
  const databasePath = utils.resolvePath("@data/video-library.sqlite3");
  const sqlite3Path = "/usr/bin/sqlite3";
  const schema = `
    CREATE TABLE IF NOT EXISTS videos (
      path TEXT PRIMARY KEY, file_identity TEXT UNIQUE, title TEXT NOT NULL,
      like_count INTEGER NOT NULL DEFAULT 0,
      cataloged_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS views (
      id INTEGER PRIMARY KEY, session_token TEXT NOT NULL UNIQUE,
      video_path TEXT, video_identity TEXT, started_at TEXT NOT NULL,
      ended_at TEXT, duration_seconds REAL, final_position_seconds REAL, watched_percent REAL
    );
    CREATE INDEX IF NOT EXISTS views_video_path_idx ON views(video_path);
  `;

  const sqlString = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const reportError = (message) => {
    if (databaseDisabled) return;
    databaseDisabled = true;
    pluginConsole.log(`Video library database disabled: ${message}`);
    core.osd("Video library tracking disabled: sqlite3 is unavailable");
  };

  async function execute(sql) {
    if (databaseDisabled) return null;
    if (!databaseReady) {
      if (!utils.fileInPath(sqlite3Path)) {
        reportError(`${sqlite3Path} was not found`);
        return null;
      }
      const initialized = await utils.exec(sqlite3Path, [databasePath, schema]);
      if (initialized.status !== 0) {
        reportError(initialized.stderr || "failed to initialize the database");
        return null;
      }
      const columns = await utils.exec(sqlite3Path, [databasePath, "PRAGMA table_info(videos);"]);
      const columnNames = columns.stdout.split("\n").map((column) => column.split("|")[1]);
      const hasLikeCount = columnNames.includes("like_count");
      if (!hasLikeCount) {
        const migration = await utils.exec(sqlite3Path, [databasePath,
          "ALTER TABLE videos ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0; UPDATE videos SET like_count = CASE WHEN rating = 'like' THEN 1 ELSE 0 END, rating = NULL;",
        ]);
        if (migration.status !== 0) {
          reportError(migration.stderr || "failed to migrate the database");
          return null;
        }
      }
      if (!columnNames.includes("file_identity")) {
        const migration = await utils.exec(sqlite3Path, [databasePath, `
          ALTER TABLE videos ADD COLUMN file_identity TEXT;
          ALTER TABLE views ADD COLUMN video_identity TEXT;
          UPDATE videos SET file_identity = 'legacy:' || path;
          UPDATE views SET video_identity = 'legacy:' || video_path;
        `]);
        if (migration.status !== 0) {
          reportError(migration.stderr || "failed to migrate video identities");
          return null;
        }
      }
      const identityIndex = await utils.exec(sqlite3Path, [databasePath,
        "CREATE UNIQUE INDEX IF NOT EXISTS videos_file_identity_idx ON videos(file_identity);",
      ]);
      if (identityIndex.status !== 0) {
        reportError(identityIndex.stderr || "failed to index video identities");
        return null;
      }
      const cleanup = await utils.exec(sqlite3Path, [databasePath, `
        DELETE FROM views WHERE ended_at IS NULL AND EXISTS (
          SELECT 1 FROM views completed
          WHERE completed.video_path = views.video_path AND completed.ended_at IS NOT NULL
          AND julianday(completed.started_at) - julianday(views.started_at) BETWEEN 0 AND 2.0 / 86400.0
        );
      `]);
      if (cleanup.status !== 0) {
        reportError(cleanup.stderr || "failed to clean up duplicate views");
        return null;
      }
      databaseReady = true;
    }
    const result = await utils.exec(sqlite3Path, [databasePath, sql]);
    if (result.status !== 0) {
      reportError(result.stderr || "database command failed");
      return null;
    }
    return result.stdout;
  }

  function enqueue(sql) {
    databaseQueue = databaseQueue.then(() => execute(sql)).catch((error) => {
      reportError(error);
      return null;
    });
    return databaseQueue;
  }

  async function getFileIdentity(path) {
    const result = await utils.exec("/usr/bin/stat", ["-f", "%z:%m", path]);
    if (result.status !== 0) {
      pluginConsole.log(`Failed to identify ${path}: ${result.stderr}`);
      return null;
    }
    return result.stdout.trim() || null;
  }

  function upsertVideo(path, identity) {
    const now = new Date().toISOString();
    enqueue(`
      BEGIN;
      DELETE FROM videos WHERE path = ${sqlString(path)} AND file_identity <> ${sqlString(identity)};
      UPDATE videos SET file_identity = ${sqlString(identity)}, title = ${sqlString(titleFromPath(path))}, updated_at = ${sqlString(now)}
        WHERE path = ${sqlString(path)} AND file_identity = ${sqlString(`legacy:${path}`)};
      UPDATE views SET video_identity = ${sqlString(identity)} WHERE video_identity = ${sqlString(`legacy:${path}`)};
      INSERT INTO videos (path, file_identity, title, cataloged_at, updated_at)
      VALUES (${sqlString(path)}, ${sqlString(identity)}, ${sqlString(titleFromPath(path))}, ${sqlString(now)}, ${sqlString(now)})
      ON CONFLICT(file_identity) DO UPDATE SET path = excluded.path, title = excluded.title, updated_at = excluded.updated_at;
      COMMIT;
    `);
  }

  async function catalogVideo(path) {
    if (!path) return null;
    const identity = await getFileIdentity(path);
    if (!identity) return null;
    upsertVideo(path, identity);
    return identity;
  }

  async function catalogPlaylist() {
    const paths = [...new Set(playlist.list().map((entry) => pathFromSource(entry.filename)).filter(Boolean))];
    for (const path of paths) await catalogVideo(path);
  }

  async function loadStats(path) {
    if (!path) return;
    const identity = await catalogVideo(path);
    if (!identity) return;
    const output = await enqueue(`SELECT v.like_count,
      COUNT(CASE WHEN views.watched_percent >= 30 THEN 1 END),
      COALESCE(ROUND(AVG(views.watched_percent)), '')
      FROM videos v LEFT JOIN views ON views.video_identity = v.file_identity
      WHERE v.file_identity = ${sqlString(identity)} GROUP BY v.file_identity;`);
    if (output === null) return;
    const [likeCount, viewCount, averageWatchedPercent] = output.trim().split("|");
    onStats(path, {
      likeCount: Number(likeCount) || 0,
      viewCount: Number(viewCount) || 0,
      averageWatchedPercent: averageWatchedPercent === "" ? null : Number(averageWatchedPercent),
    });
  }

  async function startView(path) {
    if (!path || startingPath === path || (activeView && activeView.path === path)) return;
    startingPath = path;
    const identity = await catalogVideo(path);
    startingPath = null;
    if (!identity || (activeView && activeView.path === path)) return;
    activeView = { path, identity, token: `${Date.now()}-${Math.random().toString(36).slice(2)}`, highestPosition: 0, duration: null };
    enqueue(`INSERT INTO views (session_token, video_path, video_identity, started_at)
      VALUES (${sqlString(activeView.token)}, ${sqlString(path)}, ${sqlString(identity)}, ${sqlString(new Date().toISOString())});`)
      .then(() => loadStats(path));
  }

  function trackProgress() {
    if (!activeView) return;
    try {
      const position = mpv.getNumber("time-pos");
      const duration = mpv.getNumber("duration");
      if (Number.isFinite(position)) activeView.highestPosition = Math.max(activeView.highestPosition, position);
      if (Number.isFinite(duration) && duration > 0) activeView.duration = duration;
    } catch (error) {
      pluginConsole.log(`Failed to track video progress: ${error}`);
    }
  }

  function finishView() {
    if (!activeView) return;
    const session = activeView;
    activeView = null;
    const duration = Number.isFinite(session.duration) ? session.duration : core.status.duration;
    const position = Math.max(session.highestPosition, Number.isFinite(core.status.position) ? core.status.position : 0);
    const watchedPercent = Number.isFinite(duration) && duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : null;
    const number = (value) => (Number.isFinite(value) ? value : "NULL");
    enqueue(`UPDATE views SET ended_at = ${sqlString(new Date().toISOString())}, duration_seconds = ${number(duration)},
      final_position_seconds = ${number(position)}, watched_percent = ${number(watchedPercent)}
      WHERE session_token = ${sqlString(session.token)};`);
  }

  async function addLike(path) {
    if (!path) return;
    const identity = await catalogVideo(path);
    if (!identity) return;
    enqueue(`UPDATE videos SET like_count = like_count + 1, updated_at = ${sqlString(new Date().toISOString())}
      WHERE file_identity = ${sqlString(identity)};`).then(() => loadStats(path));
  }

  function revealDatabase() {
    enqueue("SELECT 1;").then(() => {
      if (!databaseDisabled) file.showInFinder(databasePath);
    });
  }

  async function playLeastWatched() {
    const output = await enqueue(`SELECT hex(v.path)
      FROM videos v LEFT JOIN views w ON w.video_identity = v.file_identity
      GROUP BY v.file_identity
      ORDER BY COUNT(CASE WHEN w.watched_percent >= 30 THEN 1 END) ASC, v.like_count ASC, v.path;`);
    if (output === null) return;

    const paths = [];
    for (const line of output.trim().split("\n")) {
      if (!line) continue;
      try {
        paths.push(decodeURIComponent(line.replace(/../g, "%$&")));
      } catch (error) {
        pluginConsole.log(`Failed to decode database path: ${error}`);
      }
    }
    if (paths.length === 0) {
      core.osd("No cataloged videos to play");
      return;
    }

    const playlistPath = utils.resolvePath("@tmp/least-watched.m3u8");
    file.write(playlistPath, `#EXTM3U\n${paths.join("\n")}\n`);
    core.open(playlistPath);
  }

  return { addLike, catalogPlaylist, finishView, loadStats, playLeastWatched, revealDatabase, startView, trackProgress };
}

module.exports = { createVideoLibrary };
