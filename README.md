# Video Library IINA Plugin

Tracks local videos in the active IINA playlist and stores the catalog in a standard SQLite database. It also keeps the existing folder/filename overlay and move-to-Trash command.

## Install

Run `bun run link`, then restart IINA or reload its plugins. The plugin requires the `sqlite3` command-line tool; macOS provides it at `/usr/bin/sqlite3` on this machine.

## Use

- The overlay shows the current `folder/filename`, view count, average watched percentage, and like count.
- Press `L` to increment the video's like count.
- Every local playback start creates a view session. When playback ends, its watched percentage is the furthest playback position reached divided by duration. Seeking forward therefore counts skipped sections as watched.
- Each playback start schedules a non-blocking catalog of all local files in the active IINA playlist. Files added this way with no sessions are the unwatched videos.
- `Cmd+Delete` moves the current local video to Trash.
- Right-click any playlist entry and use `Sort Playlist` to sort the current playlist by likes or view count, in ascending or descending order. Untracked local files sort as zero; non-local entries stay in place.
- The Plugin menu includes `Refresh Video Library Playlist Catalog` and `Show Video Library Database in Finder`.

## Database

The database is `video-library.sqlite3` in IINA's data directory for this plugin. Use `Show Video Library Database in Finder` to open its location, then inspect it with any SQLite browser or the command line:

```sh
sqlite3 "/path/revealed-in-Finder/video-library.sqlite3"
```

Tables:

- `videos`: one row per cataloged local path, including its `like_count`.
- `views`: one row per playback session, with timestamps, duration, final position, and `watched_percent`.

Useful queries:

```sql
-- Playlist videos that have never been played.
SELECT path, title
FROM videos
WHERE NOT EXISTS (SELECT 1 FROM views WHERE views.video_path = videos.path)
ORDER BY path;

-- Videos you liked most.
SELECT path, title, like_count
FROM videos
WHERE like_count > 0
ORDER BY like_count DESC, updated_at DESC;

-- Per-video viewing summary.
SELECT v.path, v.like_count, COUNT(w.id) AS view_count,
       ROUND(AVG(w.watched_percent), 1) AS average_watched_percent
FROM videos v
LEFT JOIN views w ON w.video_path = v.path
GROUP BY v.path
ORDER BY view_count, v.path;
```
