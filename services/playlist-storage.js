/**
 * Playlist Shelves Local Storage Service
 *
 * Isolates all chrome.storage.local read/write operations from DOM extraction
 * and UI rendering. Designed to run in service worker (importScripts),
 * extension popup (<script>), and content scripts.
 */
((globalScope) => {
  'use strict';

  const STORAGE_KEYS = Object.freeze({
    VIDEOS: 'videos',
    LAST_SYNCED_AT: 'lastSyncedAt',
    SYNC_STATUS: 'syncStatus',
    LAST_ERROR: 'lastError',
    SYNC_PROGRESS: 'syncProgress',
    SEEN_VIDEO_IDS: 'seenVideoIds',
    HIDDEN_VIDEO_IDS: 'hiddenVideoIds',
    SETTINGS: 'settings',
    PLAYLISTS: 'configuredPlaylists',
    PLAYLIST_CACHES: 'playlistCaches'
  });

  const SYNC_STATUS = Object.freeze({
    NEVER_SYNCED: 'never_synced',
    SYNCING: 'syncing',
    SYNCED: 'synced',
    ERROR: 'error',
    NOT_LOGGED_IN: 'not_logged_in'
  });

  const DEFAULT_STATE = Object.freeze({
    videos: [],
    seenVideoIds: [],
    hiddenVideoIds: [],
    settings: { sort: 'playlist', showChannel: true },
    lastSyncedAt: null,
    syncStatus: SYNC_STATUS.NEVER_SYNCED,
    lastError: null,
    syncProgress: null
  });

  const DEFAULT_PLAYLISTS = Object.freeze([
    { id: 'WL', title: 'Watch Later', enabled: true }
  ]);

  function normalizeSettings(settings = {}) {
    if (!settings || typeof settings !== 'object') settings = {};
    return {
      sort: ['title', 'shuffle'].includes(settings.sort) ? settings.sort : 'playlist',
      showChannel: settings.showChannel !== false
    };
  }

  function sanitizePlaylistId(value) {
    if (typeof value !== 'string') return '';
    const id = value.trim();
    const unsafeObjectKeys = new Set([
      '__proto__', 'prototype', 'constructor', 'toString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
      '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
    ]);
    return /^[A-Za-z0-9_-]{2,100}$/.test(id) && !unsafeObjectKeys.has(id)
      ? id
      : '';
  }

  function sanitizeImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return '';
    try {
      const url = new URL(value.trim());
      const allowedHosts = new Set([
        'i.ytimg.com',
        'yt3.ggpht.com',
        'yt3.googleusercontent.com'
      ]);
      return url.protocol === 'https:' && allowedHosts.has(url.hostname)
        ? url.href
        : '';
    } catch {
      return '';
    }
  }

  async function getPlaylists() {
    const data = await chrome.storage.local.get(STORAGE_KEYS.PLAYLISTS);
    if (!Array.isArray(data[STORAGE_KEYS.PLAYLISTS])) {
      await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLISTS]: DEFAULT_PLAYLISTS });
      return DEFAULT_PLAYLISTS.map((playlist) => ({ ...playlist }));
    }
    const seen = new Set();
    const playlists = data[STORAGE_KEYS.PLAYLISTS].map((item) => {
      const id = sanitizePlaylistId(item?.id);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 100) : id,
        enabled: item.enabled !== false
      };
    }).filter(Boolean);
    if (!seen.has('WL')) playlists.unshift({ ...DEFAULT_PLAYLISTS[0] });
    if (JSON.stringify(playlists) !== JSON.stringify(data[STORAGE_KEYS.PLAYLISTS])) {
      await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLISTS]: playlists });
    }
    return playlists;
  }

  async function savePlaylists(playlists) {
    const clean = [];
    const seen = new Set();
    for (const item of Array.isArray(playlists) ? playlists : []) {
      const id = sanitizePlaylistId(item?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      clean.push({
        id,
        title: typeof item.title === 'string' && item.title.trim() ? item.title.trim().slice(0, 100) : id,
        enabled: item.enabled !== false
      });
    }
    if (!seen.has('WL')) clean.unshift({ ...DEFAULT_PLAYLISTS[0] });
    await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLISTS]: clean });
    return clean;
  }

  /**
   * Normalizes and validates a single video entry.
   * Returns null if videoId or url is invalid.
   */
  function sanitizeVideo(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const videoId = typeof raw.videoId === 'string' ? raw.videoId.trim() : '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return null;
    }

    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const channel = typeof raw.channel === 'string' ? raw.channel.trim() : '';
    const duration = typeof raw.duration === 'string' ? raw.duration.trim() : '';
    const thumbnail = sanitizeImageUrl(raw.thumbnail) ||
      `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    // Build links from the validated ID instead of trusting cached URL strings.
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

    return {
      videoId,
      title: title || 'Untitled video',
      thumbnail,
      channel: channel || 'Unknown channel',
      channelId: typeof raw.channelId === 'string' ? raw.channelId.trim() : '',
      channelAvatar: sanitizeImageUrl(raw.channelAvatar),
      duration,
      views: typeof raw.views === 'string' ? raw.views.trim() : '',
      publishedAgo: typeof raw.publishedAgo === 'string' ? raw.publishedAgo.trim() : '',
      url
    };
  }

  /**
   * Deduplicates an array of videos by videoId while preserving order.
   */
  function deduplicateVideos(rawVideos) {
    if (!Array.isArray(rawVideos)) {
      return [];
    }

    const seen = new Set();
    const result = [];

    for (const item of rawVideos) {
      const clean = sanitizeVideo(item);
      if (!clean || seen.has(clean.videoId)) {
        continue;
      }
      seen.add(clean.videoId);
      result.push(clean);
    }

    return result;
  }

  /**
   * Reads the full Playlist Shelves cache from chrome.storage.local.
   */
  async function getCache(playlistId = 'WL') {
    if (playlistId !== 'WL') {
      const data = await chrome.storage.local.get([STORAGE_KEYS.PLAYLIST_CACHES, STORAGE_KEYS.SETTINGS]);
      const state = data[STORAGE_KEYS.PLAYLIST_CACHES]?.[playlistId] || {};
      return {
        ...DEFAULT_STATE,
        ...state,
        videos: deduplicateVideos(state.videos),
        seenVideoIds: Array.isArray(state.seenVideoIds) ? state.seenVideoIds : [],
        hiddenVideoIds: Array.isArray(state.hiddenVideoIds) ? state.hiddenVideoIds : [],
        settings: normalizeSettings(data[STORAGE_KEYS.SETTINGS])
      };
    }
    const data = await chrome.storage.local.get([
      STORAGE_KEYS.VIDEOS,
      STORAGE_KEYS.LAST_SYNCED_AT,
      STORAGE_KEYS.SYNC_STATUS,
      STORAGE_KEYS.LAST_ERROR,
      STORAGE_KEYS.SYNC_PROGRESS,
      STORAGE_KEYS.SEEN_VIDEO_IDS,
      STORAGE_KEYS.HIDDEN_VIDEO_IDS,
      STORAGE_KEYS.SETTINGS
    ]);

    return {
      videos: deduplicateVideos(data[STORAGE_KEYS.VIDEOS]),
      seenVideoIds: Array.isArray(data[STORAGE_KEYS.SEEN_VIDEO_IDS])
        ? data[STORAGE_KEYS.SEEN_VIDEO_IDS].filter((id) => typeof id === 'string')
        : [],
      hiddenVideoIds: Array.isArray(data[STORAGE_KEYS.HIDDEN_VIDEO_IDS])
        ? data[STORAGE_KEYS.HIDDEN_VIDEO_IDS].filter((id) => typeof id === 'string')
        : [],
      settings: normalizeSettings(data[STORAGE_KEYS.SETTINGS]),
      lastSyncedAt:
        typeof data[STORAGE_KEYS.LAST_SYNCED_AT] === 'number'
          ? data[STORAGE_KEYS.LAST_SYNCED_AT]
          : DEFAULT_STATE.lastSyncedAt,
      syncStatus:
        typeof data[STORAGE_KEYS.SYNC_STATUS] === 'string'
          ? data[STORAGE_KEYS.SYNC_STATUS]
          : DEFAULT_STATE.syncStatus,
      lastError:
        typeof data[STORAGE_KEYS.LAST_ERROR] === 'string'
          ? data[STORAGE_KEYS.LAST_ERROR]
          : DEFAULT_STATE.lastError,
      syncProgress: data[STORAGE_KEYS.SYNC_PROGRESS] && typeof data[STORAGE_KEYS.SYNC_PROGRESS] === 'object'
        ? data[STORAGE_KEYS.SYNC_PROGRESS]
        : null
    };
  }

  /**
   * Atomically replaces the cached videos after a verified extraction.
   * Never call this with partial or failed extraction results.
   */
  async function saveSyncedVideos(rawVideos, playlistId = 'WL') {
    const videos = deduplicateVideos(rawVideos);
    const payload = {
      [STORAGE_KEYS.VIDEOS]: videos,
      [STORAGE_KEYS.LAST_SYNCED_AT]: Date.now(),
      [STORAGE_KEYS.SYNC_STATUS]: SYNC_STATUS.SYNCED,
      [STORAGE_KEYS.LAST_ERROR]: null,
      [STORAGE_KEYS.SYNC_PROGRESS]: null
    };

    if (playlistId === 'WL') {
      await chrome.storage.local.set(payload);
    } else {
      const data = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_CACHES);
      const caches = data[STORAGE_KEYS.PLAYLIST_CACHES] || {};
      caches[playlistId] = { ...(caches[playlistId] || {}), videos, lastSyncedAt: payload[STORAGE_KEYS.LAST_SYNCED_AT], syncStatus: SYNC_STATUS.SYNCED, lastError: null, syncProgress: null };
      await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLIST_CACHES]: caches });
    }
    return {
      videos,
      lastSyncedAt: payload[STORAGE_KEYS.LAST_SYNCED_AT],
      syncStatus: payload[STORAGE_KEYS.SYNC_STATUS],
      lastError: null
    };
  }

  /**
   * Updates only syncStatus and lastError without touching cached videos or lastSyncedAt.
   */
  async function setSyncStatus(syncStatus, lastError = null, playlistId = 'WL') {
    const payload = {
      [STORAGE_KEYS.SYNC_STATUS]: syncStatus,
      [STORAGE_KEYS.LAST_ERROR]: lastError ? String(lastError) : null
    };
    if (playlistId === 'WL') return chrome.storage.local.set(payload);
    const data = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_CACHES);
    const caches = data[STORAGE_KEYS.PLAYLIST_CACHES] || {};
    caches[playlistId] = { ...(caches[playlistId] || {}), syncStatus, lastError: lastError ? String(lastError) : null };
    return chrome.storage.local.set({ [STORAGE_KEYS.PLAYLIST_CACHES]: caches });
  }

  async function setSyncProgress(progress, playlistId = 'WL') {
    if (playlistId !== 'WL') {
      const data = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_CACHES);
      const caches = data[STORAGE_KEYS.PLAYLIST_CACHES] || {};
      const previous = caches[playlistId]?.syncProgress;
      const now = Date.now();
      caches[playlistId] = { ...(caches[playlistId] || {}), syncProgress: progress ? { ...progress, startedAt: progress.reset ? now : Number(previous?.startedAt) || now, updatedAt: now } : null };
      await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLIST_CACHES]: caches });
      return caches[playlistId].syncProgress;
    }
    const previous = (await chrome.storage.local.get(STORAGE_KEYS.SYNC_PROGRESS))[STORAGE_KEYS.SYNC_PROGRESS];
    const now = Date.now();
    const value = progress && typeof progress === 'object'
      ? {
          loaded: Math.max(0, Number(progress.loaded) || 0),
          total: Number.isFinite(Number(progress.total)) && Number(progress.total) > 0 ? Number(progress.total) : null,
          phase: typeof progress.phase === 'string' ? progress.phase.slice(0, 120) : 'Loading playlist',
          startedAt: progress.reset ? now : Number(previous?.startedAt) || now,
          updatedAt: now
        }
      : null;
    await chrome.storage.local.set({ [STORAGE_KEYS.SYNC_PROGRESS]: value });
    return value;
  }

  async function setSettings(settings) {
    const current = await getCache();
    const next = normalizeSettings({ ...current.settings, ...settings });
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
    return next;
  }

  async function markSeen(videoId, playlistId = 'WL') {
    if (!videoId) return;
    const current = await getCache(playlistId);
    if (!current.seenVideoIds.includes(videoId)) {
      if (playlistId === 'WL') await chrome.storage.local.set({ [STORAGE_KEYS.SEEN_VIDEO_IDS]: [...current.seenVideoIds, videoId] });
      else await updatePlaylistCache(playlistId, { seenVideoIds: [...current.seenVideoIds, videoId] });
    }
  }

  async function updatePlaylistCache(playlistId, patch) {
    const data = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_CACHES);
    const caches = data[STORAGE_KEYS.PLAYLIST_CACHES] || {};
    caches[playlistId] = { ...(caches[playlistId] || {}), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLIST_CACHES]: caches });
  }

  async function removePlaylistCache(playlistId) {
    if (!sanitizePlaylistId(playlistId) || playlistId === 'WL') return;
    const data = await chrome.storage.local.get(STORAGE_KEYS.PLAYLIST_CACHES);
    const caches = data[STORAGE_KEYS.PLAYLIST_CACHES] || {};
    delete caches[playlistId];
    await chrome.storage.local.set({ [STORAGE_KEYS.PLAYLIST_CACHES]: caches });
  }

  async function hideVideo(videoId, playlistId = 'WL') {
    const current = await getCache(playlistId);
    if (!current.hiddenVideoIds.includes(videoId)) {
      if (playlistId === 'WL') await chrome.storage.local.set({ [STORAGE_KEYS.HIDDEN_VIDEO_IDS]: [...current.hiddenVideoIds, videoId] });
      else await updatePlaylistCache(playlistId, { hiddenVideoIds: [...current.hiddenVideoIds, videoId] });
    }
  }

  async function restoreHiddenVideos(playlistId = 'WL') {
    if (playlistId === 'WL') await chrome.storage.local.set({ [STORAGE_KEYS.HIDDEN_VIDEO_IDS]: [] });
    else await updatePlaylistCache(playlistId, { hiddenVideoIds: [] });
  }

  async function updateVideoMetadata(videoId, metadata, playlistId = 'WL') {
    const current = await getCache(playlistId);
    const videos = current.videos.map((video) =>
      video.videoId === videoId ? { ...video, ...metadata } : video
    );
    if (playlistId === 'WL') await chrome.storage.local.set({ [STORAGE_KEYS.VIDEOS]: videos });
    else await updatePlaylistCache(playlistId, { videos });
  }

  globalScope.PlaylistShelvesStorage = Object.freeze({
    STORAGE_KEYS,
    SYNC_STATUS,
    DEFAULT_STATE,
    DEFAULT_PLAYLISTS,
    sanitizePlaylistId,
    sanitizeImageUrl,
    getPlaylists,
    savePlaylists,
    getCache,
    saveSyncedVideos,
    setSyncStatus,
    setSyncProgress,
    setSettings,
    markSeen,
    removePlaylistCache,
    hideVideo,
    restoreHiddenVideos,
    updateVideoMetadata
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
