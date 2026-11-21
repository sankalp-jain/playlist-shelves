/**
 * Playlist Shelves homepage injector
 *
 * Mounts native-feeling, horizontally scrollable playlist shelves at the
 * top of the YouTube homepage (https://www.youtube.com/) using cached videos
 * from chrome.storage.local.
 */
(() => {
  'use strict';

  const Storage = globalThis.PlaylistShelvesStorage;
  const Adapter = globalThis.PlaylistShelvesYouTubeAdapter;

  if (!Storage || !Adapter) {
    console.error('[Playlist Shelves] Missing storage or playlist DOM adapter dependency.');
    return;
  }

  const SHELF_ID = 'playlist-shelf';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MOUNT_DEBOUNCE_MS = 50;
  const CARD_BATCH_SIZE = 12;
  // One random seed per page load: stable through rerenders, fresh on reload.
  const pageShuffleSeed = Math.floor(Math.random() * 0x100000000);

  let configuredPlaylists = Storage.DEFAULT_PLAYLISTS.map((item) => ({ ...item }));
  const playlistCaches = new Map();
  const renderedSignatures = new Map();
  let cacheLoadSequence = 0;
  let mountObserver = null;
  let themeObserver = null;
  let mountDebounceTimer = null;
  const viewLookupStarted = new Set();

  function enrichMissingViews(videos, playlistId = 'WL') {
    const missing = videos
      .filter((video) => (!video.views || !video.publishedAgo) && !viewLookupStarted.has(`${playlistId}:${video.videoId}`))
      .slice(0, CARD_BATCH_SIZE);
    if (!missing.length) return;
    for (const video of missing) viewLookupStarted.add(`${playlistId}:${video.videoId}`);

    Promise.all(missing.map(async (video) => {
      try {
        const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}&hl=en`, { credentials: 'include' });
        if (!response.ok) return null;
        const html = await response.text();
        const match = html.match(/\"viewCount\"\s*:\s*\"?(\d+)\"?/);
        const dateMatch = html.match(/\"publishDate\"\s*:\s*\"(\d{4}-\d{2}-\d{2})\"/);
        const views = match
          ? `${new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(match[1]))} views`
          : '';
        const publishedAgo = dateMatch ? formatPublishedAgo(dateMatch[1]) : '';
        if (!views && !publishedAgo) return null;
        return { videoId: video.videoId, views, publishedAgo };
      } catch (error) {
        console.debug('[Playlist Shelves] View count lookup unavailable:', error);
        return null;
      }
    })).then(async (updates) => {
      for (const update of updates.filter(Boolean)) {
        await Storage.updateVideoMetadata(update.videoId, {
          ...(update.views ? { views: update.views } : {}),
          ...(update.publishedAgo ? { publishedAgo: update.publishedAgo } : {})
        }, playlistId);
      }
    });
  }

  function formatPublishedAgo(dateValue) {
    const elapsedDays = Math.floor((Date.now() - new Date(dateValue).getTime()) / 86400000);
    if (!Number.isFinite(elapsedDays) || elapsedDays < 0) return '';
    if (elapsedDays < 30) return `${Math.max(1, elapsedDays)} ${elapsedDays === 1 ? 'day' : 'days'} ago`;
    const months = Math.floor(elapsedDays / 30);
    if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
    const years = Math.floor(elapsedDays / 365);
    return `${years} ${years === 1 ? 'year' : 'years'} ago`;
  }

  function createSvgIcon(pathD, viewBox = '0 0 24 24', className = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) {
      svg.setAttribute('class', className);
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function createPlaylistIcon() {
    // Playlist rows icon shared by every shelf.
    return createSvgIcon(
      'M4 5h2v2H4V5zm4 0h12v2H8V5zM4 11h2v2H4v-2zm4 0h12v2H8v-2zM4 17h2v2H4v-2zm4 0h12v2H8v-2z',
      '0 0 24 24',
      'ps-header-icon'
    );
  }

  function createChevronIcon(direction) {
    const d =
      direction === 'left'
        ? 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z'
        : 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z';
    return createSvgIcon(d, '0 0 24 24', 'ps-chevron-icon');
  }

  function computeSignature(cache) {
    const ids = cache.videos
      .map((v) => `${v.videoId}:${v.title}:${v.duration}:${v.views}:${v.publishedAgo}:${v.channelAvatar}`)
      .join('|');
    return `${cache.syncStatus}::${cache.videos.length}::${ids}::${cache.seenVideoIds.join(',')}::${cache.hiddenVideoIds.join(',')}::${JSON.stringify(cache.settings)}`;
  }

  function durationSeconds(value) {
    if (typeof value !== 'string' || !/^\d+(?::\d{1,2}){1,2}$/.test(value.trim())) return null;
    return value.trim().split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
  }

  function shuffleHash(videoId, seed) {
    let hash = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < videoId.length; i += 1) {
      hash ^= videoId.charCodeAt(i);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  }

  function formatTotalWatchTime(videos) {
    const durations = videos.map((video) => durationSeconds(video.duration)).filter(Number.isFinite);
    if (!durations.length) return null;
    const totalSeconds = durations.reduce((sum, duration) => sum + duration, 0);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const formatted = hours ? `${hours}h ${minutes}m` : `${minutes}m`;
    return {
      label: durations.length === videos.length ? `Total ${formatted}` : `At least ${formatted}`,
      title: `Based on durations for ${durations.length} of ${videos.length} cached videos`
    };
  }

  function applyTheme(shelfEl, cache = Storage.DEFAULT_STATE) {
    if (!shelfEl) {
      return;
    }
    shelfEl.setAttribute('data-ps-theme', Adapter.isDarkMode() ? 'dark' : 'light');
  }

  function updateScrollButtons(trackEl, prevBtn, nextBtn) {
    if (!trackEl || !prevBtn || !nextBtn) {
      return;
    }
    const maxScroll = Math.max(0, trackEl.scrollWidth - trackEl.clientWidth);
    const current = trackEl.scrollLeft;
    prevBtn.disabled = current <= 2;
    nextBtn.disabled = current >= maxScroll - 2 || maxScroll <= 2;
    prevBtn.classList.toggle('ps-nav-hidden', maxScroll <= 4);
    nextBtn.classList.toggle('ps-nav-hidden', maxScroll <= 4);
  }

  function appendVideoCards(track, videos, playlistId, settings, startIndex, endIndex) {
    const batch = videos.slice(startIndex, endIndex);
    const fragment = document.createDocumentFragment();
    for (const video of batch) {
      const card = buildVideoCard(video, playlistId, settings);
      card.setAttribute('role', 'listitem');
      fragment.appendChild(card);
    }
    track.appendChild(fragment);
    enrichMissingViews(batch, playlistId);
  }

  function buildVideoCard(video, playlistId, settings) {
    const card = document.createElement('article');
    card.className = 'ps-card';
    card.title = video.title;
    card.setAttribute('data-video-id', video.videoId);

    // Thumbnail container
    const link = document.createElement('a');
    link.className = 'ps-thumb-wrap ps-card-link';
    link.href = video.url;
    link.addEventListener('click', () => Storage.markSeen(video.videoId, playlistId));
    const img = document.createElement('img');
    img.className = 'ps-thumb';
    img.src = video.thumbnail;
    img.alt = video.title;
    img.loading = 'lazy';
    img.decoding = 'async';

    // Graceful thumbnail fallback if cached URL fails
    img.addEventListener(
      'error',
      () => {
        const fallback = `https://i.ytimg.com/vi/${encodeURIComponent(
          video.videoId
        )}/mqdefault.jpg`;
        if (img.src !== fallback) {
          img.src = fallback;
        } else {
          img.classList.add('ps-thumb-broken');
        }
      },
      { once: true }
    );

    link.appendChild(img);

    if (video.duration) {
      const badge = document.createElement('span');
      badge.className = 'ps-duration';
      badge.textContent = video.duration;
      link.appendChild(badge);
    }

    // Metadata
    const meta = document.createElement('div');
    meta.className = 'ps-meta';

    const title = document.createElement('h3');
    title.className = 'ps-video-title';
    title.textContent = video.title;

    const avatar = document.createElement('span');
    avatar.className = 'ps-channel-avatar';
    if (video.channelAvatar) {
      const avatarImage = document.createElement('img');
      avatarImage.alt = '';
      avatarImage.loading = 'lazy';
      avatarImage.src = video.channelAvatar;
      avatarImage.addEventListener('error', () => {
        avatar.textContent = (video.channel || 'Y').slice(0, 1).toUpperCase();
      }, { once: true });
      avatar.appendChild(avatarImage);
    } else {
      avatar.classList.add('ps-avatar-fallback');
      avatar.textContent = (video.channel || 'Y').slice(0, 1).toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'ps-card-info';
    info.appendChild(title);
    if (settings.showChannel) {
      const channel = document.createElement('p');
      channel.className = 'ps-channel';
      channel.textContent = [video.channel, video.views, video.publishedAgo].filter(Boolean).join(' · ');
      info.appendChild(channel);
    }
    meta.appendChild(avatar);
    meta.appendChild(info);
    const hideButton = document.createElement('button');
    hideButton.type = 'button';
    hideButton.className = 'ps-card-menu-button';
    hideButton.setAttribute('aria-label', `More actions for ${video.title}`);
    hideButton.title = 'More actions';
    hideButton.textContent = '⋮';
    hideButton.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div');
    menu.className = 'ps-card-menu';
    menu.hidden = true;
    const addMenuAction = (label, handler) => {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'ps-card-menu-action';
      action.textContent = label;
      action.addEventListener('click', () => {
        menu.remove();
        hideButton.setAttribute('aria-expanded', 'false');
        handler();
      });
      menu.appendChild(action);
    };
    addMenuAction('Hide from shelf', () => Storage.hideVideo(video.videoId, playlistId));
    hideButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!menu.hidden) {
        menu.hidden = true;
        menu.remove();
      } else {
        const bounds = hideButton.getBoundingClientRect();
        const menuWidth = 190;
        menu.style.left = `${Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8))}px`;
        menu.style.top = `${Math.min(bounds.bottom + 4, window.innerHeight - 90)}px`;
        document.body.appendChild(menu);
        menu.hidden = false;
        const dismissMenu = (outsideEvent) => {
          if (outsideEvent.type === 'keydown' && outsideEvent.key !== 'Escape') return;
          if (outsideEvent.type === 'pointerdown' && (menu.contains(outsideEvent.target) || hideButton.contains(outsideEvent.target))) return;
          menu.hidden = true;
          menu.remove();
          hideButton.setAttribute('aria-expanded', 'false');
          document.removeEventListener('pointerdown', dismissMenu, true);
          document.removeEventListener('keydown', dismissMenu, true);
        };
        document.addEventListener('pointerdown', dismissMenu, true);
        document.addEventListener('keydown', dismissMenu, true);
      }
      hideButton.setAttribute('aria-expanded', String(!menu.hidden));
    });
    meta.appendChild(hideButton);
    card.appendChild(link);
    card.appendChild(meta);

    return card;
  }

  function buildEmptyState(cache, playlist = { id: 'WL', title: 'Watch Later' }) {
    const box = document.createElement('div');
    box.className = 'ps-empty';

    const msg = document.createElement('p');
    msg.className = 'ps-empty-text';

    if (cache.syncStatus === Storage.SYNC_STATUS.SYNCING) {
      msg.textContent = `Syncing ${playlist.title}...`;
    } else if (cache.syncStatus === Storage.SYNC_STATUS.NOT_LOGGED_IN) {
      msg.textContent =
        `Sign in to YouTube to display videos from ${playlist.title}.`;
    } else if (cache.videos.length > 0) {
      msg.textContent = `You have seen every cached video in ${playlist.title}. Sync or open the playlist to find more.`;
    } else if (cache.syncStatus === Storage.SYNC_STATUS.SYNCED) {
      msg.textContent =
        `This playlist is empty. Add videos to ${playlist.title} and sync to see them here.`;
    } else {
      msg.textContent =
        `Sync ${playlist.title} to initialize its shelf on the homepage.`;
    }

    const actions = document.createElement('div');
    actions.className = 'ps-empty-actions';

    const openLink = document.createElement('a');
    openLink.className = 'ps-btn ps-btn-primary';
    openLink.href = `${Adapter.YOUTUBE_ORIGIN}/playlist?list=${encodeURIComponent(playlist.id)}`;
    openLink.textContent = `Open ${playlist.title}`;
    actions.appendChild(openLink);

    if (cache.syncStatus !== Storage.SYNC_STATUS.SYNCING) {
      const syncBtn = document.createElement('button');
      syncBtn.type = 'button';
      syncBtn.className = 'ps-btn ps-btn-secondary';
      syncBtn.textContent = 'Sync now';
      syncBtn.addEventListener('click', () => {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
        chrome.runtime.sendMessage({ type: 'PLAYLIST_SHELVES_START_SYNC', playlistId: playlist.id }, () => {
          if (chrome.runtime.lastError) {
            console.warn(
              '[Playlist Shelves] Refresh trigger warning:',
              chrome.runtime.lastError.message
            );
          }
        });
      });
      actions.appendChild(syncBtn);
    }

    box.appendChild(msg);
    box.appendChild(actions);
    return box;
  }

  /**
   * Populates or updates a playlist shelf.
   */
  function renderShelfContents(shelfEl, cache, playlist = { id: 'WL', title: 'Watch Later' }) {
    const previousTrack = shelfEl.querySelector('.ps-track');
    const previousScrollLeft = previousTrack?.scrollLeft || 0;
    const previousRenderedCount = Number(shelfEl.dataset.renderedCount) || CARD_BATCH_SIZE;
    while (shelfEl.firstChild) {
      shelfEl.removeChild(shelfEl.firstChild);
    }

    const header = document.createElement('div');
    header.className = 'ps-header';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'ps-title-group';
    titleGroup.appendChild(createPlaylistIcon());

    const heading = document.createElement('h2');
    heading.className = 'ps-heading';
    heading.textContent = playlist.title;
    titleGroup.appendChild(heading);

    const seenIds = new Set(cache.seenVideoIds);
    const hiddenIds = new Set(cache.hiddenVideoIds);
    const visibleVideos = cache.videos.filter((video) => !seenIds.has(video.videoId) && !hiddenIds.has(video.videoId));
    const orderedVideos = cache.settings.sort === 'title'
      ? [...visibleVideos].sort((a, b) => a.title.localeCompare(b.title))
      : cache.settings.sort === 'shuffle'
        ? [...visibleVideos].sort((a, b) =>
            shuffleHash(a.videoId, pageShuffleSeed) -
              shuffleHash(b.videoId, pageShuffleSeed) ||
            a.videoId.localeCompare(b.videoId)
          )
        : visibleVideos;
    const videos = orderedVideos;
    if (videos.length > 0) {
      const count = document.createElement('span');
      count.className = 'ps-count';
      count.textContent = `${videos.length} of ${cache.videos.length} ${
        cache.videos.length === 1 ? 'video' : 'videos'
      }`;
      titleGroup.appendChild(count);
    }
    const watchTime = formatTotalWatchTime(cache.videos);
    if (watchTime) {
      const total = document.createElement('span');
      total.className = 'ps-total-time';
      total.textContent = watchTime.label;
      total.title = watchTime.title;
      titleGroup.appendChild(total);
    }

    const headerActions = document.createElement('div');
    headerActions.className = 'ps-header-actions';

    const viewAll = document.createElement('a');
    viewAll.className = 'ps-view-all';
    viewAll.href = `${Adapter.YOUTUBE_ORIGIN}/playlist?list=${encodeURIComponent(playlist.id)}`;
    viewAll.textContent = 'View all';
    headerActions.appendChild(viewAll);

    let prevBtn = null;
    let nextBtn = null;

    if (videos.length > 0) {
      const navGroup = document.createElement('div');
      navGroup.className = 'ps-nav-group';

      prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'ps-nav-btn';
      prevBtn.setAttribute('aria-label', `Scroll ${playlist.title} left`);
      prevBtn.appendChild(createChevronIcon('left'));

      nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'ps-nav-btn';
      nextBtn.setAttribute('aria-label', `Scroll ${playlist.title} right`);
      nextBtn.appendChild(createChevronIcon('right'));

      navGroup.appendChild(prevBtn);
      navGroup.appendChild(nextBtn);
      headerActions.appendChild(navGroup);
    }

    header.appendChild(titleGroup);
    header.appendChild(headerActions);
    shelfEl.appendChild(header);

    if (videos.length === 0) {
      shelfEl.appendChild(buildEmptyState(cache, playlist));
      return;
    }

    const track = document.createElement('div');
    track.className = 'ps-track';
    track.setAttribute('role', 'list');

    let renderedCount = Math.min(Math.max(CARD_BATCH_SIZE, previousRenderedCount), videos.length);
    appendVideoCards(track, videos, playlist.id, cache.settings, 0, renderedCount);
    shelfEl.dataset.renderedCount = String(renderedCount);
    shelfEl.appendChild(track);

    const loadMoreIfNeeded = () => {
      if (renderedCount >= videos.length) return;
      const distanceToEnd = track.scrollWidth - track.clientWidth - track.scrollLeft;
      if (distanceToEnd > Math.max(320, track.clientWidth * 0.65)) return;
      const nextCount = Math.min(renderedCount + CARD_BATCH_SIZE, videos.length);
      appendVideoCards(track, videos, playlist.id, cache.settings, renderedCount, nextCount);
      renderedCount = nextCount;
      shelfEl.dataset.renderedCount = String(renderedCount);
      requestAnimationFrame(() => updateScrollButtons(track, prevBtn, nextBtn));
    };

    const scrollStep = () => Math.max(280, Math.floor(track.clientWidth * 0.78));

    prevBtn.addEventListener('click', () => {
      track.scrollBy({ left: -scrollStep(), behavior: 'smooth' });
    });

    nextBtn.addEventListener('click', () => {
      track.scrollBy({ left: scrollStep(), behavior: 'smooth' });
    });

    track.addEventListener(
      'scroll',
      () => {
        updateScrollButtons(track, prevBtn, nextBtn);
        loadMoreIfNeeded();
      },
      { passive: true }
    );

    requestAnimationFrame(() => {
      track.scrollLeft = previousScrollLeft;
      updateScrollButtons(track, prevBtn, nextBtn);
      loadMoreIfNeeded();
    });
  }

  /**
   * Removes any mounted shelf from the DOM (e.g., when navigating away from /).
   */
  function removeShelf() {
    const existing = document.querySelectorAll('.ps-shelf[id^="playlist-shelf"]');
    for (const node of existing) {
      node.remove();
    }
    renderedSignatures.clear();
  }

  /**
   * Ensures configured shelves are mounted cleanly on the YouTube homepage.
   */
  function ensureShelfMounted() {
    if (!Adapter.isHomepageUrl()) {
      removeShelf();
      return;
    }

    const target = Adapter.getHomepageMountTarget();
    if (!target) {
      return;
    }

    const playlists = configuredPlaylists.filter((playlist) => playlist.enabled !== false);
    const shelfIds = new Set(playlists.map((playlist) => playlist.id === 'WL' ? SHELF_ID : `playlist-shelf-${playlist.id}`));
    const shelvesById = new Map();

    for (const candidate of document.querySelectorAll('.ps-shelf[id^="playlist-shelf"]')) {
      if (!shelfIds.has(candidate.id)) {
        candidate.remove();
        continue;
      }
      const existing = shelvesById.get(candidate.id);
      if (!existing || (existing.parentElement !== target.grid && candidate.parentElement === target.grid)) {
        existing?.remove();
        shelvesById.set(candidate.id, candidate);
      } else {
        candidate.remove();
      }
    }

    for (const playlist of playlists) {
      const shelfId = playlist.id === 'WL' ? SHELF_ID : `playlist-shelf-${playlist.id}`;
      const cache = playlistCaches.get(playlist.id) || Storage.DEFAULT_STATE;
      let shelf = shelvesById.get(shelfId);
      const isNew = !shelf;
      if (!shelf) {
        shelf = document.createElement('section');
        shelf.id = shelfId;
        shelf.className = 'ps-shelf';
      }

      const signature = `${computeSignature(cache)}::${playlist.title}`;
      if (isNew || renderedSignatures.get(playlist.id) !== signature) {
        shelf.setAttribute('aria-label', playlist.title);
        applyTheme(shelf, cache);
        renderShelfContents(shelf, cache, playlist);
        renderedSignatures.set(playlist.id, signature);
      }
      if (shelf.parentElement !== target.grid) target.grid.insertBefore(shelf, target.contents);
    }

    for (const playlistId of renderedSignatures.keys()) {
      if (!playlists.some((playlist) => playlist.id === playlistId)) renderedSignatures.delete(playlistId);
    }
  }

  function scheduleMount() {
    clearTimeout(mountDebounceTimer);
    mountDebounceTimer = setTimeout(() => {
      ensureShelfMounted();
    }, MOUNT_DEBOUNCE_MS);
  }

  function areShelvesMounted() {
    const target = Adapter.getHomepageMountTarget();
    if (!target) return true;
    return configuredPlaylists.filter((playlist) => playlist.enabled !== false).every((playlist) => {
      const shelfId = playlist.id === 'WL' ? SHELF_ID : `playlist-shelf-${playlist.id}`;
      const shelf = document.getElementById(shelfId);
      if (!shelf || shelf.parentElement !== target.grid) return false;
      return true;
    });
  }

  function startMountObserver() {
    if (mountObserver) {
      return;
    }

    const root =
      document.querySelector('ytd-app') ||
      document.querySelector('ytd-page-manager') ||
      document.body;
    if (!root) {
      return;
    }

    mountObserver = new MutationObserver((mutations) => {
      if (!Adapter.isHomepageUrl()) {
        return;
      }

      // Ignore mutations inside our own shelf to prevent observer feedback loops
      const hasExternalMutation = mutations.some((m) => {
        const targetEl = m.target instanceof Element ? m.target : null;
        return !targetEl?.closest('.ps-shelf');
      });

      if (!hasExternalMutation) return;

      // YouTube virtualizes Home and may detach a shelf during a feed render.
      // Reconcile after structural changes so missing shelves are restored.
      scheduleMount();
    });

    mountObserver.observe(root, {
      childList: true,
      subtree: true
    });

    window.addEventListener('scroll', () => {
      if (!Adapter.isHomepageUrl() || areShelvesMounted()) return;
      scheduleMount();
    }, { passive: true });
    window.addEventListener('resize', scheduleMount, { passive: true });
  }

  function startThemeObserver() {
    if (themeObserver) {
      return;
    }

    themeObserver = new MutationObserver(() => {
      document.querySelectorAll('.ps-shelf').forEach((shelf) => {
        const playlistId = shelf.id === SHELF_ID ? 'WL' : shelf.id.slice('playlist-shelf-'.length);
        applyTheme(shelf, playlistCaches.get(playlistId) || Storage.DEFAULT_STATE);
      });
    });

    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['dark']
    });
  }

  async function init() {
    try {
      await loadConfiguredCaches();
    } catch (error) {
      console.error('[Playlist Shelves] Failed to load initial cache:', error);
    }

    chrome.storage.onChanged.addListener(async (_changes, area) => {
      if (area !== 'local') return;
      await loadConfiguredCaches();
      if (Adapter.isHomepageUrl()) ensureShelfMounted();
    });

    startThemeObserver();
    startMountObserver();

    if (Adapter.isHomepageUrl()) {
      ensureShelfMounted();
    }
  }

  async function loadConfiguredCaches() {
    const sequence = ++cacheLoadSequence;
    const playlists = await Storage.getPlaylists();
    const entries = await Promise.all(playlists.map(async (playlist) => [playlist.id, await Storage.getCache(playlist.id)]));
    if (sequence !== cacheLoadSequence) return;
    configuredPlaylists = playlists;
    playlistCaches.clear();
    for (const [id, cache] of entries) playlistCaches.set(id, cache);
  }

  // React to YouTube SPA navigation events
  document.addEventListener('yt-navigate-start', () => {
    if (!Adapter.isHomepageUrl()) {
      removeShelf();
    }
  });

  document.addEventListener('yt-navigate-finish', () => {
    if (Adapter.isHomepageUrl()) {
      scheduleMount();
    } else {
      removeShelf();
    }
  });

  document.addEventListener('yt-page-data-updated', () => {
    if (Adapter.isHomepageUrl()) {
      scheduleMount();
    }
  });

  window.addEventListener('popstate', () => {
    if (Adapter.isHomepageUrl()) {
      scheduleMount();
    } else {
      removeShelf();
    }
  });

  init();
})();
