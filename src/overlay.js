function createTitleOverlay({ core, overlay, mpv, pathFromSource, titleFromPath, pluginConsole }) {
  let ready = false;
  let title = null;
  let path = null;
  let stats = null;
  const escapeHtml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function setup() {
    if (!core.window.loaded) return false;
    try {
      overlay.simpleMode();
      overlay.setClickable(false);
      overlay.setOpacity(1);
      overlay.setStyle(`
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; pointer-events: none; }
        #content { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: center; padding-top: 8px; pointer-events: none; }
        .video-info { display: flex; max-width: calc(100vw - 96px); align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; background: rgba(0, 0, 0, 0.58); color: white; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; font-size: 13px; line-height: 18px; font-weight: 500; text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); }
        .title { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .stats { flex: none; color: rgba(255, 255, 255, 0.76); white-space: nowrap; }
        .separator { color: rgba(255, 255, 255, 0.3); }
        @media (max-width: 700px) { .stats { display: none; } }
      `);
      ready = true;
      return true;
    } catch (error) {
      ready = false;
      pluginConsole.log(`Failed to setup title overlay: ${error}`);
      return false;
    }
  }

  function render() {
    if (!ready && !setup()) return;
    try {
      if (!title) return overlay.hide();
      const currentStats = stats || { likeCount: 0, viewCount: 0, averageWatchedPercent: null };
      const average = currentStats.averageWatchedPercent === null ? "-" : `${Math.round(currentStats.averageWatchedPercent)}% avg`;
      overlay.setContent(`<div class="video-info"><div class="title">${escapeHtml(title)}</div><span class="separator">|</span><span class="stats">${currentStats.viewCount} views, ${average}, ${currentStats.likeCount} likes</span></div>`);
      overlay.show();
    } catch (error) {
      ready = false;
      pluginConsole.log(`Failed to render title overlay: ${error}`);
    }
  }

  function update(source = core.status.url, shouldRender = true) {
    const nextPath = pathFromSource(source);
    if (!nextPath) {
      title = null;
      path = null;
      stats = null;
      if (shouldRender) render();
      return null;
    }
    title = titleFromPath(nextPath);
    path = nextPath;
    stats = null;
    try {
      mpv.set("force-media-title", title);
      mpv.set("title", title);
    } catch (error) {
      pluginConsole.log(`Failed to set mpv title: ${error}`);
    }
    if (shouldRender) render();
    return path;
  }

  return {
    clear: () => { title = null; path = null; stats = null; render(); },
    getPath: () => path,
    reset: () => { ready = false; },
    render,
    setStats: (statsPath, nextStats) => { if (statsPath === path) { stats = nextStats; render(); } },
    update,
  };
}

module.exports = { createTitleOverlay };
