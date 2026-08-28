function createPathUtils({ mpv, pluginConsole }) {
  function safeGetMpvString(name) {
    try {
      return mpv.getString(name) || null;
    } catch (error) {
      pluginConsole.log(`Failed to read mpv property ${name}: ${error}`);
      return null;
    }
  }

  function pathFromSource(source) {
    if (!source) return null;

    let path = source;
    if (source.startsWith("file://")) {
      path = source.replace(/^file:\/\/(localhost)?/, "");
      try {
        path = decodeURIComponent(path);
      } catch (error) {
        pluginConsole.log(`Failed to decode file URL: ${error}`);
      }
    } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
      return null;
    }

    if (path.startsWith("/")) return path;
    const directory = safeGetMpvString("working-directory");
    return directory ? `${directory}/${path}` : path;
  }

  function titleFromPath(path) {
    const parts = path.split("/").filter(Boolean);
    return parts.length < 2 ? parts[0] || path : `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }

  return { pathFromSource, safeGetMpvString, titleFromPath };
}

module.exports = { createPathUtils };
