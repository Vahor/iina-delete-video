const { core, menu, utils, file, playlist } = iina;

function deleteCurrentVideo() {
  const path = decodeURIComponent(core.status.url.replace(/^file:\/\//, ""));
  iina.console.log(`Deleting ${path}...`);

  if (!path) {
    utils.ask("No file is currently playing.");
    return;
  }

  const confirmed = utils.ask(`Move to Trash?\n\n${path}`);
  if (!confirmed) return;

  try {
    playlist.playNext();
    file.trash(path);
  } catch (e) {
    utils.ask(`Failed to delete file:\n${e}`);
  }
}

menu.addItem(
  menu.item("Move Current Video to Trash", deleteCurrentVideo, {
    keyBinding: "Meta+BS",
  }),
);
