function createVideoLibrary({ core, utils, playlist, mpv, pathFromSource, titleFromPath, onStats, pluginConsole }) {
  let activeView = null;
  let databaseReady = false;
  let databaseDisabled = false;
  let databaseQueue = Promise.resolve(null);
  const databasePath = utils.resolvePath("@data/video-library.sqlite3");
  const sqlite3Path = "/usr/bin/sqlite3";
  const schema = `
    CREATE TABLE IF NOT EXISTS videos (
      path TEXT PRIMARY KEY, title TEXT NOT NULL,
      like_count INTEGER NOT NULL DEFAULT 0,
      cataloged_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS views (
      id INTEGER PRIMARY KEY, session_token TEXT NOT NULL UNIQUE,
      video_path TEXT NOT NULL REFERENCES videos(path), started_at TEXT NOT NULL,
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
      const hasLikeCount = columns.stdout.split("\n").some((column) => column.split("|")[1] === "like_count");
      if (!hasLikeCount) {
        const migration = await utils.exec(sqlite3Path, [databasePath,
          "ALTER TABLE videos ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0; UPDATE videos SET like_count = CASE WHEN rating = 'like' THEN 1 ELSE 0 END, rating = NULL;",
        ]);
        if (migration.status !== 0) {
          reportError(migration.stderr || "failed to migrate the database");
          return null;
        }
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

  function catalogVideo(path) {
    if (!path) return;
    const now = new Date().toISOString();
    enqueue(`INSERT INTO videos (path, title, cataloged_at, updated_at)
      VALUES (${sqlString(path)}, ${sqlString(titleFromPath(path))}, ${sqlString(now)}, ${sqlString(now)})
      ON CONFLICT(path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at;`);
  }

  function catalogPlaylist() {
    const paths = [...new Set(playlist.list().map((entry) => pathFromSource(entry.filename)).filter(Boolean))];
    if (paths.length === 0) return;
    const now = new Date().toISOString();
    const values = paths.map((path) =>
      `(${sqlString(path)}, ${sqlString(titleFromPath(path))}, ${sqlString(now)}, ${sqlString(now)})`,
    ).join(",");
    enqueue(`INSERT INTO videos (path, title, cataloged_at, updated_at) VALUES ${values}
      ON CONFLICT(path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at;`);
  }

  async function loadStats(path) {
    if (!path) return;
    const output = await enqueue(`SELECT v.like_count, COUNT(views.id), COALESCE(ROUND(AVG(views.watched_percent)), '')
      FROM videos v LEFT JOIN views ON views.video_path = v.path
      WHERE v.path = ${sqlString(path)} GROUP BY v.path;`);
    if (output === null) return;
    const [likeCount, viewCount, averageWatchedPercent] = output.trim().split("|");
    onStats(path, {
      likeCount: Number(likeCount) || 0,
      viewCount: Number(viewCount) || 0,
      averageWatchedPercent: averageWatchedPercent === "" ? null : Number(averageWatchedPercent),
    });
  }

  function startView(path) {
    if (!path || (activeView && activeView.path === path)) return;
    activeView = { path, token: `${Date.now()}-${Math.random().toString(36).slice(2)}`, highestPosition: 0, duration: null };
    catalogVideo(path);
    enqueue(`INSERT INTO views (session_token, video_path, started_at)
      VALUES (${sqlString(activeView.token)}, ${sqlString(path)}, ${sqlString(new Date().toISOString())});`)
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

  function addLike(path) {
    if (!path) return;
    catalogVideo(path);
    enqueue(`UPDATE videos SET like_count = like_count + 1, updated_at = ${sqlString(new Date().toISOString())}
      WHERE path = ${sqlString(path)};`).then(() => loadStats(path));
  }

  return { addLike, catalogPlaylist, finishView, loadStats, startView, trackProgress };
}

module.exports = { createVideoLibrary };
