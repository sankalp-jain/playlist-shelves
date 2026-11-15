/**
 * Playlist Shelves YouTube DOM Adapter
 *
 * Isolates all YouTube-specific selectors, SPA route checks, theme detection,
 * and playlist/homepage DOM access behind a clean interface.
 * If YouTube changes its DOM structure, updates are localized to this file.
 */
((globalScope) => {
  'use strict';

  const Storage = globalScope.PlaylistShelvesStorage;
  const YOUTUBE_ORIGIN = 'https://www.youtube.com';
  const HOME_URL = 'https://www.youtube.com/';

  const UNAVAILABLE_TITLE_PATTERN =
    /^\[(deleted|private|unavailable) video\]$/i;

  /**
   * Returns true if the current URL is the YouTube homepage.
   */
  function isHomepageUrl(href = globalScope.location?.href) {
    try {
      const url = new URL(href);
      if (url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') {
        return false;
      }
      return url.pathname === '/' || url.pathname === '';
    } catch {
      return false;
    }
  }

  function getPlaylistId(href = globalScope.location?.href) {
    try {
      const url = new URL(href);
      if ((url.hostname !== 'www.youtube.com' && url.hostname !== 'youtube.com') || url.pathname !== '/playlist') return '';
      return url.searchParams.get('list') || '';
    } catch { return ''; }
  }

  function isPlaylistUrl(href = globalScope.location?.href) {
    return Boolean(getPlaylistId(href));
  }

  /**
   * Returns true if YouTube is currently in dark mode.
   */
  function isDarkMode() {
    return document.documentElement.hasAttribute('dark');
  }

  /**
   * Returns the currently visible (non-hidden) browse container for a subtype.
   */
  function getActiveBrowse(pageSubtype) {
    const candidates = document.querySelectorAll(
      `ytd-browse[page-subtype="${pageSubtype}"]`
    );
    let fallback = null;
    for (const el of candidates) {
      if (el.hasAttribute('hidden') || el.hidden) continue;
      if (!fallback) fallback = el;
      const style = globalScope.getComputedStyle?.(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
    }
    // During initial navigation the active browse can exist before it has a
    // layout box. Keep that candidate as a fallback until YouTube paints it.
    return fallback;
  }

  /**
   * Finds the homepage mount target: { browse, grid, contents } or null.
   */
  function getHomepageMountTarget() {
    const browse = getActiveBrowse('home');
    if (!browse) {
      return null;
    }

    const grid = browse.querySelector('ytd-rich-grid-renderer');
    if (!grid) {
      return null;
    }

    const contents =
      grid.querySelector(':scope > #contents') || grid.querySelector('#contents');
    if (!contents) {
      return null;
    }

    return { browse, grid, contents };
  }

  /**
   * Finds the active playlist browse & list container.
   */
  function getPlaylistContainers() {
    const app = document.querySelector('ytd-app') || document;
    const listRenderer = app.querySelector('ytd-playlist-video-list-renderer');
    const panelRenderer = app.querySelector('ytd-playlist-panel-renderer');
    const videoRenderer = app.querySelector(
      'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer'
    );
    const browse = getActiveBrowse('playlist') ||
      listRenderer?.closest('ytd-browse') ||
      panelRenderer?.closest('ytd-browse') ||
      videoRenderer?.closest('ytd-browse') ||
      (listRenderer || panelRenderer || videoRenderer ? app : null);
    if (!browse) {
      return null;
    }

    const activeListRenderer = browse.querySelector('ytd-playlist-video-list-renderer') ||
      (browse === app ? listRenderer : null);
    const activePanelRenderer = browse.querySelector('ytd-playlist-panel-renderer') ||
      (browse === app ? panelRenderer : null);
    const contents =
      activeListRenderer?.querySelector(':scope > #contents') ||
      activeListRenderer?.querySelector('#contents') ||
      null;
    const continuation = browse.querySelector(
      'ytd-playlist-video-list-renderer ytd-continuation-item-renderer, ytd-playlist-panel-renderer ytd-continuation-item-renderer'
    ) || app.querySelector('ytd-playlist-video-list-renderer ytd-continuation-item-renderer');
    const header = browse.querySelector('ytd-playlist-header-renderer');

    return {
      browse,
      listRenderer: activeListRenderer || activePanelRenderer,
      contents,
      continuation,
      header
    };
  }

  /**
   * Checks whether the user appears to be signed out or blocked from the playlist.
   * Returns { signedOut: boolean, reason: string | null }.
   */
  function checkAccessState() {
    const host = globalScope.location?.hostname || '';
    if (host.includes('accounts.google.com')) {
      return {
        signedOut: true,
        reason: 'Redirected to Google Sign-In. Please sign in to YouTube first.'
      };
    }
    if (host.includes('consent.youtube.com')) {
      return {
        signedOut: true,
        reason:
          'YouTube requires cookie/consent confirmation before loading playlists.'
      };
    }

    const browse = getActiveBrowse('playlist');
    const promoSignIn = browse?.querySelector(
      'ytd-background-promo-renderer a[href*="accounts.google.com/ServiceLogin"]'
    );
    const alertRenderer = browse?.querySelector(
      'ytd-alert-with-button-renderer, yt-player-error-message-renderer'
    );

    // Absence of the avatar or presence of a masthead sign-in link is not
    // reliable during YouTube's SPA hydration; logged-in pages can briefly
    // expose both states. Only treat an explicit playlist sign-in prompt as
    // proof that authentication is required.
    if (promoSignIn) {
      return {
        signedOut: true,
        reason:
          'You are not signed in to YouTube. Sign in to view this playlist.'
      };
    }

    if (alertRenderer && !browse?.querySelector('ytd-playlist-video-renderer')) {
      const msg = alertRenderer.textContent?.replace(/\s+/g, ' ').trim();
      if (msg && /sign in/i.test(msg)) {
        return {
          signedOut: true,
          reason: msg
        };
      }
    }

    return { signedOut: false, reason: null };
  }

  /**
   * Parses the header's reported video count if available (e.g., "142 videos" -> 142).
   * Returns a number or null if unknown.
   */
  function getReportedPlaylistCount() {
    const browse = getActiveBrowse('playlist');
    if (!browse) {
      return null;
    }

    const statNodes = browse.querySelectorAll(
      'ytd-playlist-header-renderer .metadata-stats yt-formatted-string, ' +
        'ytd-playlist-header-renderer .byline-item, ' +
        'ytd-playlist-sidebar-primary-info-renderer #stats yt-formatted-string, ' +
        'yt-page-header-renderer yt-content-metadata-view-model span'
    );

    const counts = [];
    for (const node of statNodes) {
      const text = node.textContent?.replace(/\s+/g, ' ').trim() || '';
      if (/^no\s+videos?$/i.test(text)) {
        counts.push(0);
        continue;
      }
      const match = text.match(/^([\d,]+)\s+videos?$/i);
      if (match) {
        const parsed = parseInt(match[1].replace(/,/g, ''), 10);
        if (!Number.isNaN(parsed)) {
          counts.push(parsed);
        }
      }
    }

    return counts.length ? Math.max(...counts) : null;
  }

  /**
   * Returns true if the playlist explicitly renders an empty-state message.
   */
  function isPlaylistConfirmedEmpty() {
    const reported = getReportedPlaylistCount();
    if (reported === 0) {
      return true;
    }

    const browse = getActiveBrowse('playlist');
    if (!browse) {
      return false;
    }

    const messageEl = browse.querySelector(
      'ytd-playlist-video-list-renderer #message, ' +
        'ytd-message-renderer #message'
    );
    const msgText = messageEl?.textContent?.trim() || '';
    if (/no videos in this playlist/i.test(msgText)) {
      return true;
    }

    const hasListRenderer = Boolean(
      browse.querySelector('ytd-playlist-video-list-renderer')
    );
    const hasHeader = Boolean(browse.querySelector('ytd-playlist-header-renderer'));
    const hasItems = Boolean(browse.querySelector('ytd-playlist-video-renderer'));
    const hasContinuation = Boolean(
      browse.querySelector('ytd-continuation-item-renderer')
    );

    // If header & list container exist with 0 items and no continuation spinner,
    // and user is signed in, treat as empty only when reported === 0 or alert says empty.
    if (hasHeader && hasListRenderer && !hasItems && !hasContinuation && reported === 0) {
      return true;
    }

    return false;
  }

  /**
   * Extracts a YouTube video ID from a watch or shorts URL.
   */
  function extractVideoIdFromHref(href) {
    if (!href || typeof href !== 'string') {
      return '';
    }
    try {
      const parsed = new URL(href, YOUTUBE_ORIGIN);
      const v = parsed.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{6,}$/.test(v)) {
        return v;
      }
      const shortsMatch = parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{6,})/);
      if (shortsMatch) {
        return shortsMatch[1];
      }
      return '';
    } catch {
      return '';
    }
  }

  /**
   * Extracts metadata from a single ytd-playlist-video-renderer DOM node.
   * Returns { video: object | null, unavailable: boolean }.
   */
  function extractVideoFromRenderer(renderer) {
    if (!renderer) {
      return { video: null, unavailable: false };
    }

    const titleEl =
      renderer.querySelector('a#video-title') ||
      renderer.querySelector('a.ytLockupMetadataViewModelTitle') ||
      renderer.querySelector('h3 a') ||
      renderer.querySelector('#video-title');

    const thumbLinkEl =
      renderer.querySelector('a#thumbnail') ||
      renderer.querySelector('ytd-thumbnail a');

    const href =
      titleEl?.getAttribute('href') || thumbLinkEl?.getAttribute('href') || '';
    const videoId = extractVideoIdFromHref(href);

    const rawTitle = (
      titleEl?.getAttribute('title') ||
      titleEl?.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    if (!videoId || UNAVAILABLE_TITLE_PATTERN.test(rawTitle) || !rawTitle) {
      return { video: null, unavailable: true };
    }

    // Channel name (multiple selector fallbacks for Polymer/Lit variations)
    const channelEl =
      renderer.querySelector('ytd-channel-name #text a') ||
      renderer.querySelector('ytd-channel-name yt-formatted-string#text') ||
      renderer.querySelector('#channel-name a') ||
      renderer.querySelector('#byline-container a') ||
      renderer.querySelector('#byline-container #text') ||
      renderer.querySelector('yt-content-metadata-view-model a[href^="/@"], yt-content-metadata-view-model a[href^="/channel/"]');

    const channel = (channelEl?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    const avatarEl = renderer.querySelector(
      'ytd-channel-name #avatar img, #channel-thumbnail img, #avatar img, ytd-channel-name img'
    );
    const channelAvatar = Storage.sanitizeImageUrl(
      avatarEl?.getAttribute('src') || avatarEl?.src || ''
    );
    const channelHref = channelEl?.closest('a')?.getAttribute('href') || '';
    const channelId = channelHref.match(/\/channel\/([^/?]+)/)?.[1] || '';

    // Duration badge (supports both legacy #text and newer badge-shape selectors)
    const durationEl =
      renderer.querySelector(
        'ytd-thumbnail-overlay-time-status-renderer .badge-shape-wiz__text'
      ) ||
      renderer.querySelector(
        'ytd-thumbnail-overlay-time-status-renderer .yt-badge-shape__text'
      ) ||
      renderer.querySelector('ytd-thumbnail-overlay-time-status-renderer #text') ||
      renderer.querySelector('badge-shape .badge-shape-wiz__text') ||
      renderer.querySelector('badge-shape .yt-badge-shape__text');

    const duration = (durationEl?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();

    const metadataNodes = renderer.querySelectorAll(
      '#metadata-line, #video-info, #video-info span, ytd-video-meta-block #metadata, #metadata, [aria-label*="views"]'
    );
    const metadataText = [renderer.textContent, ...Array.from(metadataNodes, (node) => node.getAttribute('aria-label') || node.textContent)]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const views = metadataText.match(/[\d,.]+\s*(?:[KMB]\s*)?views?/i)?.[0] || '';
    const publishedAgo = metadataText.match(/(?:streamed\s+)?\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago/i)?.[0] || '';

    // Thumbnail URL: prefer loaded https image from DOM, fallback to standard i.ytimg.com URL
    const imgEl =
      renderer.querySelector('ytd-thumbnail img#img') ||
      renderer.querySelector('ytd-thumbnail img.yt-core-image') ||
      renderer.querySelector('#thumbnail img');

    const domSrc = imgEl?.getAttribute('src') || imgEl?.src || '';
    const safeThumbnail = Storage.sanitizeImageUrl(domSrc);
    const thumbnail = safeThumbnail && !domSrc.includes('pixel')
      ? safeThumbnail
      : `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;

    const url = `${YOUTUBE_ORIGIN}/watch?v=${encodeURIComponent(videoId)}`;

    return {
      unavailable: false,
      video: {
        videoId,
        title: rawTitle,
        thumbnail,
        channel: channel || 'YouTube',
        channelId,
        channelAvatar,
        duration,
        views,
        publishedAgo,
        url
      }
    };
  }

  /**
   * Collects all currently rendered videos from the active playlist DOM.
   * Deduplicates by videoId while preserving order.
   */
  function extractRenderedPlaylistVideos() {
    const containers = getPlaylistContainers();
    if (!containers?.browse) {
      return {
        videos: [],
        renderedCount: 0,
        skippedUnavailable: 0,
        hasContinuation: false
      };
    }

    const renderRoot = containers.contents || containers.listRenderer || containers.browse;
    const renderers = renderRoot.querySelectorAll(
      'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model:has(a[href*="list="])'
    );

    const byId = new Map();
    let skippedUnavailable = 0;

    for (const renderer of renderers) {
      const { video, unavailable } = extractVideoFromRenderer(renderer);
      if (unavailable) {
        skippedUnavailable += 1;
        continue;
      }
      if (video && !byId.has(video.videoId)) {
        byId.set(video.videoId, video);
      }
    }

    const hasContinuation = Boolean(
      containers.browse.querySelector(
        'ytd-playlist-video-list-renderer ytd-continuation-item-renderer, ytd-playlist-panel-renderer ytd-continuation-item-renderer'
      )
    );

    return {
      videos: Array.from(byId.values()),
      renderedCount: renderers.length,
      skippedUnavailable,
      hasContinuation
    };
  }

  /**
   * Triggers loading of the next continuation batch if present.
   */
  function triggerContinuationLoad() {
    const containers = getPlaylistContainers();
    const continuation = containers?.continuation;
    if (continuation) {
      continuation.scrollIntoView({ behavior: 'auto', block: 'center' });
    }
    const scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    );
    window.scrollTo(0, scrollHeight);
    window.dispatchEvent(new Event('scroll'));
  }

  globalScope.PlaylistShelvesYouTubeAdapter = Object.freeze({
    YOUTUBE_ORIGIN,
    HOME_URL,
    isHomepageUrl,
    getPlaylistId,
    isPlaylistUrl,
    isDarkMode,
    getActiveBrowse,
    getHomepageMountTarget,
    getPlaylistContainers,
    checkAccessState,
    getReportedPlaylistCount,
    isPlaylistConfirmedEmpty,
    extractVideoIdFromHref,
    extractVideoFromRenderer,
    extractRenderedPlaylistVideos,
    triggerContinuationLoad
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
