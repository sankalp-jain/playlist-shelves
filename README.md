# Playlist Shelves

**Playlist Shelves** is a local-first Chrome extension for adding your YouTube playlists to the top of the YouTube homepage as horizontal shelves. Add a playlist link, choose a shelf name, then sync its videos into a cache in your Chrome profile.

## Features

- Add accessible YouTube playlists, including Watch Later, with an optional custom shelf name.
- Render all enabled playlist shelves together at the top of Home.
- Show YouTube-style video cards with thumbnails, duration, channel, and view metadata when available.
- Track seen and hidden videos separately for each playlist. Open the three-dot menu to hide a video; hiding it does not change the YouTube playlist.
- Load more cached cards as you scroll horizontally; arrange videos by playlist order, title, or a shuffle order that changes on each page load, and configure channel/view metadata across shelves.
- View each playlist's cached video count and estimated total watch time.
- Sync each playlist independently. Complete extractions update only that playlist's cache; failed or incomplete refreshes preserve its previous cache.
- Keep playlist configuration, cached metadata, and preferences in `chrome.storage.local`. No external account or service is used by the extension.

## Project structure

```text
playlist-shelves/
├── manifest.json
├── service-worker.js
├── content/
│   ├── youtube-dom-adapter.js
│   ├── playlist-reader.js
│   └── playlist-shelf-injector.js
├── services/
│   └── playlist-storage.js
├── popup/
│   ├── manager.html
│   ├── manager.css
│   └── manager.js
├── styles/
│   └── playlist-shelves.css
├── icons/
└── README.md
```

## Install in Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `playlist-shelves` directory containing `manifest.json`.
3. Pin **Playlist Shelves** from the extensions menu if desired.
4. Refresh open YouTube tabs so Chrome loads the extension's content scripts.

Renaming the unpacked extension directory can cause Chrome to assign a new extension ID. If that happens, the previous local cache remains in Chrome under the old extension ID and may not appear in this installation.

## Use

1. Open the Playlist Shelves popup.
2. Paste a YouTube playlist link, optionally enter a shelf name, and select **Add playlist**.
3. Select **Sync** for each playlist you want cached.
4. Open YouTube Home. Each shelf shows its cached videos, playlist count, and estimated total watch time.

Sync opens the selected playlist in a temporary YouTube tab to read its rendered items, then closes that tab. You need to be signed in to YouTube for private playlists and Watch Later.

## Data and privacy

Playlist IDs, shelf names, cached video metadata, seen/hidden IDs, and display preferences are stored in the current Chrome profile using `chrome.storage.local`. The extension has no backend and does not send playlist data to an external server. YouTube is contacted to load playlist pages and video metadata.

## Notes

- Playlist reading depends on YouTube's page structure and may need updates if YouTube changes its playlist or homepage elements.
- Total watch time is estimated from durations available in the cache. It is labeled “At least” when some durations are missing.
- `chrome.storage.local` has a finite quota; very large collections can use more storage.
