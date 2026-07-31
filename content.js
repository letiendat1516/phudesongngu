/**
 * content.js - Main content script (ISOLATED world)
 * Manages subtitle data collection, bilingual overlay, and settings.
 */
(function () {
  'use strict';

  // ============ State ============
  const state = {
    enabled: true,
    secondaryLang: '',
    primaryLang: '',
    secondaryPosition: 'above', // 'above' | 'below'
    secondaryColor: '#ffff00',
    secondarySize: '1.5em',
    secondaryOpacity: '0.9',

    // Subtitle data: Map<trackId, Cue[]>
    subtitleTracks: {},
    subtitleTrackNames: {},

    // Active cues for current time
    activeSecondaryCue: null,
    activePrimaryCue: null,

    // Track URL mappings for fetching secondary language
    trackUrlMapping: null, // { primaryTrackId: string, secondaryTrackId: string }

    // Last known URL pattern for fetching secondary
    lastPrimaryUrl: null,
    lastSecondaryUrl: null,

    // Video element reference
    videoElement: null,

    // Observer for DOM changes
    playerObserver: null,

    // Animation frame ID
    animFrameId: null,

    // Debounce for URL change detection
    urlPatternDebounce: null,

    // ===== DEBUG CAPTURE =====
    // Capture ALL interesting network responses for debugging
    capturedNetworkData: [],
    captureEnabled: true,

    // ===== MANIFEST TRACKS =====
    // Map of language code -> { urls: [...], languageDescription, isForced }
    manifestTracks: {},

    // ===== DRAG POSITION =====
    // null = default position (bottom: 24vh, centered)
    // {x, y} = custom pixel position (top/left)
    overlayPosition: null,

    // ===== CACHED NETFLIX FONT SIZE =====
    // Cached so the overlay doesn't shrink between subtitle cues
    // (Netflix's subtitle element disappears between cues).
    cachedNetflixFontSize: null
  };

  // ============ DOM Elements ============
  let secondaryOverlay = null;
  let primaryOverlay = null;

  // ============ Initialization ============

  function init() {
    // Load settings from storage
    loadSettings().then(() => {
      // Set up message listener from inject.js
      setupMessageListener();

      // Set up communication with popup
      setupPopupListener();

      // Start watching for Netflix player
      watchForPlayer();

      // Handle fullscreen changes (move overlay into fullscreen element)
      setupFullscreenHandling();

      // Detect episode changes via URL (Netflix is a SPA)
      setupEpisodeChangeDetection();
    });
  }

  /**
   * Load saved settings from Chrome storage.
   */
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get([
        'enabled',
        'secondaryLang',
        'secondaryPosition',
        'secondaryColor',
        'secondarySize',
        'secondaryOpacity',
        'overlayPosition'
      ]);
      if (result.enabled !== undefined) state.enabled = result.enabled;
      if (result.secondaryLang) state.secondaryLang = result.secondaryLang;
      if (result.secondaryPosition) state.secondaryPosition = result.secondaryPosition;
      if (result.secondaryColor) state.secondaryColor = result.secondaryColor;
      if (result.secondarySize) state.secondarySize = result.secondarySize;
      if (result.secondaryOpacity !== undefined) state.secondaryOpacity = result.secondaryOpacity;
      if (result.overlayPosition) state.overlayPosition = result.overlayPosition;
    } catch (e) {
      console.log('[BilingualSubs] Could not load settings:', e);
    }
  }

  /**
   * Save a setting to Chrome storage.
   */
  async function saveSetting(key, value) {
    state[key] = value;
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      console.log('[BilingualSubs] Could not save setting:', e);
    }
  }

  // ============ Message Handling ============

  /**
   * Listen for subtitle data from inject.js (MAIN world).
   */
  function setupMessageListener() {
    window.addEventListener('message', function (event) {
      if (!event.data) return;
      if (event.data.source !== 'netflix-bilingual-subtitles') return;

      switch (event.data.type) {
        case 'SUBTITLE_DATA':
          handleSubtitleData(event.data.url, event.data.data);
          break;
        case 'NETWORK_RESPONSE':
          handleNetworkResponse(event.data);
          break;
        case 'MANIFEST_TRACKS':
          handleManifestTracks(event.data.tracks);
          break;
        case 'PLAYER_PROBE_RESULT':
          handlePlayerProbeResult(event.data.data);
          break;
        case 'TRACK_SWITCHED':
          console.log('[BilingualSubs] Track switch result:', event.data.data);
          break;
      }
    });
  }

  /**
   * Handle the result of probing Netflix's player API.
   */
  function handlePlayerProbeResult(result) {
    if (result && result.subtitleTracks && result.subtitleTracks.length > 0) {
      console.log('[BilingualSubs] Player probe found tracks:', result.subtitleTracks);
      // Map discovered tracks to our known tracks
      result.subtitleTracks.forEach(function (track) {
        if (track.id && !state.subtitleTracks[track.id]) {
          // Initialize empty track entry
          state.subtitleTracks[track.id] = [];
        }
      });
      notifyTracksUpdated();
    }
  }

  /**
   * Send a command to the inject script (MAIN world).
   */
  function sendToInject(action, data) {
    window.postMessage({
      target: 'netflix-bilingual-inject',
      action: action,
      data: data
    }, '*');
  }

  /**
   * Listen for messages from the popup.
   */
  function setupPopupListener() {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message.action === 'getState') {
        // Build the combined track list: captured tracks + manifest tracks not yet captured
        const trackIds = new Set(Object.keys(state.subtitleTracks));
        Object.keys(state.manifestTracks).forEach(function (lang) {
          trackIds.add(lang);
        });

        const allTracks = Array.from(trackIds).map(function (id) {
          const manifestInfo = state.manifestTracks[id];
          return {
            id: id,
            name: state.subtitleTrackNames[id] ||
                  (manifestInfo ? languageToName(id) : id),
            cueCount: state.subtitleTracks[id] ? state.subtitleTracks[id].length : 0,
            isPrimary: id === state.primaryLang,
            isManifest: !!manifestInfo,
            description: manifestInfo ? manifestInfo.languageDescription : ''
          };
        });

        sendResponse({
          enabled: state.enabled,
          secondaryLang: state.secondaryLang,
          primaryLang: state.primaryLang,
          secondaryPosition: state.secondaryPosition,
          secondaryColor: state.secondaryColor,
          secondarySize: state.secondarySize,
          secondaryOpacity: state.secondaryOpacity,
          availableTracks: allTracks
        });
      } else if (message.action === 'updateSetting') {
        saveSetting(message.key, message.value).then(() => {
          applySettings();
          sendResponse({ success: true });
        });
        return true; // Keep channel open for async response
      } else if (message.action === 'toggleEnabled') {
        state.enabled = !state.enabled;
        saveSetting('enabled', state.enabled);
        updateOverlayVisibility();
        sendResponse({ enabled: state.enabled });
      } else if (message.action === 'setSecondaryTrack') {
        setSecondaryTrack(message.trackId);
        sendResponse({ success: true });
      } else if (message.action === 'refreshSubtitles') {
        // Force re-fetch of subtitle data
        attemptFetchSecondaryLanguage();
        sendResponse({ success: true });
      } else if (message.action === 'getCaptureStats') {
        sendResponse({
          totalCaptured: state.capturedNetworkData.length,
          subtitleCount: Object.keys(state.subtitleTracks).length,
          totalCues: Object.values(state.subtitleTracks).reduce(function (sum, cues) {
            return sum + cues.length;
          }, 0)
        });
      } else if (message.action === 'clearCapture') {
        state.capturedNetworkData = [];
        sendResponse({ success: true });
      } else if (message.action === 'resetPosition') {
        resetOverlayPosition();
        sendResponse({ success: true });
      }
    });
  }

  /**
   * Handle a captured network response (for debugging/capture mode).
   */
  function handleNetworkResponse(data) {
    if (!state.captureEnabled) return;

    const entry = {
      url: data.url,
      isSubtitle: data.isSubtitle,
      dataLength: data.data ? data.data.length : 0,
      dataPreview: data.data ? data.data.substring(0, 2000) : '',
      timestamp: data.timestamp || Date.now()
    };

    state.capturedNetworkData.push(entry);

    // Keep only last 500 entries to avoid memory issues
    if (state.capturedNetworkData.length > 500) {
      state.capturedNetworkData.shift();
    }

    // Log to console for real-time debugging
    if (data.isSubtitle) {
      console.log('[BilingualSubs][CAPTURE] SUBTITLE found:', data.url.substring(0, 120));
    }
  }

  /**
   * Handle subtitle tracks discovered in the Netflix manifest.
   * Stores the language -> URL mapping so we can fetch secondary languages
   * proactively without requiring the user to manually switch.
   */
  function handleManifestTracks(tracks) {
    if (!tracks || !Array.isArray(tracks)) return;

    console.log('[BilingualSubs] Manifest provided ' + tracks.length + ' subtitle tracks');

    tracks.forEach(function (track) {
      if (track.language && track.urls && track.urls.length > 0) {
        state.manifestTracks[track.language] = {
          urls: track.urls,
          languageDescription: track.languageDescription || '',
          isForced: track.isForced || false
        };
      }
    });

    console.log('[BilingualSubs] Available manifest languages:', Object.keys(state.manifestTracks));

    // If the user already selected a secondary language, try to fetch it now
    if (state.secondaryLang && state.manifestTracks[state.secondaryLang]) {
      fetchSecondaryLanguageFromManifest(state.secondaryLang);
    } else if (!state.secondaryLang) {
      // Auto-select a sensible default secondary language:
      // prefer English (if the primary isn't English), otherwise the first
      // non-primary, non-forced track we don't already have.
      autoSelectSecondaryLanguage();
    }

    // Update the popup so the user can pick from all available languages
    notifyTracksUpdated();
  }

  /**
   * Automatically pick a secondary language when none is chosen yet.
   */
  function autoSelectSecondaryLanguage() {
    const available = Object.keys(state.manifestTracks);
    if (available.length === 0) return;

    let chosen = null;
    // PRIORITY: Always prefer Vietnamese ("vi") as the secondary language.
    // This is the default behavior for Vietnamese users.
    if (state.primaryLang !== 'vi' && state.manifestTracks['vi']) {
      chosen = 'vi';
    } else if (state.primaryLang !== 'en' && state.manifestTracks['en']) {
      // Fallback: English if primary is something else
      chosen = 'en';
    } else {
      // Otherwise pick the first non-primary language
      for (const lang of available) {
        if (lang !== state.primaryLang && !state.manifestTracks[lang].isForced) {
          chosen = lang;
          break;
        }
      }
    }

    if (chosen) {
      console.log('[BilingualSubs] Auto-selected secondary language:', chosen);
      setSecondaryTrack(chosen);
    }
  }

  /**
   * Fetch the secondary language subtitle data directly from the manifest URLs.
   * This bypasses the need to manually switch subtitles in Netflix.
   */
  function fetchSecondaryLanguageFromManifest(language) {
    const trackInfo = state.manifestTracks[language];
    if (!trackInfo || !trackInfo.urls || trackInfo.urls.length === 0) {
 console.log('[BilingualSubs] No manifest URL for language:', language);
      return;
    }

    // Avoid duplicate fetches if we already have this language
    if (state.subtitleTracks[language] && state.subtitleTracks[language].length > 0) {
      console.log('[BilingualSubs] Language already captured:', language);
      return;
    }

    console.log('[BilingualSubs] Fetching secondary language from manifest:', language);

    // Try each URL until one works
    const urls = trackInfo.urls.slice(0, 3); // limit attempts
    let index = 0;

    function tryNextUrl() {
      if (index >= urls.length) {
        console.error('[BilingualSubs] FAILED to fetch language', language, 'from all manifest URLs');
        // Show an error on the overlay so the user knows what happened
        showErrorOnOverlay('Không tải được phụ đề ' + languageToName(language) +
          ' từ manifest. Hãy thử chuyển ngôn ngữ phụ đề trong Netflix thủ công.');
        return;
      }
      const url = urls[index++];
      console.log('[BilingualSubs] Trying URL ' + index + '/' + urls.length + ': ' + url.substring(0, 80));
      fetch(url)
        .then(function (resp) {
          console.log('[BilingualSubs] Fetch response:', resp.status, resp.statusText);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          return resp.text();
        })
        .then(function (text) {
          console.log('[BilingualSubs] Got response, length=' + text.length + ', isTTML=' + looksLikeTTML(text));
          if (looksLikeTTML(text)) {
            handleSubtitleData(url, text);
            console.log('[BilingualSubs] ✓ Secondary language loaded:', language);
          } else {
            console.log('[BilingualSubs] Response not TTML, trying next URL...');
            tryNextUrl();
          }
        })
        .catch(function (err) {
          console.error('[BilingualSubs] Fetch error:', err.message);
          tryNextUrl();
        });
    }

    tryNextUrl();
  }

  /**
   * Show a temporary error message on the overlay.
   */
  function showErrorOnOverlay(msg) {
    if (!secondaryOverlay) createOverlays();
    if (!secondaryOverlay) return;
    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (textEl) {
      textEl.textContent = msg;
      textEl.style.color = '#ff6b6b';
      secondaryOverlay.style.display = 'block';
      setTimeout(function () {
        textEl.style.color = state.secondaryColor || '#ffff00';
        textEl.textContent = '';
        secondaryOverlay.style.display = 'none';
      }, 6000);
    }
  }

  /**
   * Check if text looks like TTML (delegates to parser).
   */
  function looksLikeTTML(text) {
    return TTMLParser.isTTML(text);
  }

  // (Debug export removed for production — reduces permissions and review risk)

  // ============ Player Detection ============

  /**
   * Watch for the Netflix player to appear in the DOM.
   */
  function watchForPlayer() {
    // Try to find the video element immediately
    findVideoElement();

    // Set up the MutationObserver once document.body exists.
    // At run_at: document_start, document.body may be null, so observe safely.
    function setupObserver() {
      if (!document.body) {
        // Body not ready yet — retry shortly
        setTimeout(setupObserver, 50);
        return;
      }
      const observer = new MutationObserver(function () {
        if (!state.videoElement) {
          findVideoElement();
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
      state.playerObserver = observer;
    }
    setupObserver();

    // Periodic check as fallback (runs regardless of observer state)
    setInterval(function () {
      if (!state.videoElement) {
        findVideoElement();
      }
    }, 2000);
  }

  /**
   * Find the Netflix video element and set up overlay.
   */
  function findVideoElement() {
    const video = document.querySelector('video');
    if (!video) return;

    if (video === state.videoElement) return; // Same video, nothing to do

    // Video element changed (new episode, or first load)
    const isEpisodeChange = !!state.videoElement;
    state.videoElement = video;
    console.log('[BilingualSubs] Video element ' + (isEpisodeChange ? 'CHANGED (new episode)' : 'found'));

    if (isEpisodeChange) {
      // Clear stale subtitle data from the previous episode
      state.subtitleTracks = {};
      state.subtitleTrackNames = {};
      state.primaryLang = '';
      // Keep secondaryLang — user's language preference persists
      state.activeSecondaryCue = null;
      state.cachedNetflixFontSize = null;
      console.log('[BilingualSubs] Cleared old subtitle data for new episode');
    }

    // Create overlay elements (if not already created)
    createOverlays();

    // Start tracking video time for subtitle sync
    startTimeTracking();

    // Attach event listeners to the current video element
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('seeked', onTimeUpdate);
    video.addEventListener('play', onTimeUpdate);
    video.addEventListener('playing', onTimeUpdate);
  }

  // ============ Overlay Creation ============

  /**
   * Create the subtitle overlay elements.
   */
  function createOverlays() {
    if (secondaryOverlay) return; // Already created

    // Secondary subtitle overlay (for the additional language)
    secondaryOverlay = document.createElement('div');
    secondaryOverlay.id = 'nbs-secondary-subtitles';
    secondaryOverlay.className = 'nbs-subtitle-overlay nbs-secondary';
    secondaryOverlay.innerHTML = '<div class="nbs-subtitle-text"></div>';

    // CRITICAL: attach to document.body (NOT the player container).
    if (!document.body) {
      console.error('[BilingualSubs] document.body not available for overlay');
      return;
    }

    // Apply CRITICAL inline styles so Netflix CSS can't hide the overlay.
    Object.assign(secondaryOverlay.style, {
      position: 'fixed',
      bottom: '24vh',
      left: '0',
      right: '0',
      width: '100%',
      zIndex: '2147483647',
      pointerEvents: 'none',
      textAlign: 'center',
      display: 'none'
    });

    // Apply configurable styles (font, color, background)
    applyOverlayStyles();

    // Hover + drag behavior on the subtitle text element.
    // The text element has pointer-events:auto (set in applyOverlayStyles)
    // so it receives mouse events even though the overlay container
    // has pointer-events:none.
    const textElInteractive = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (textElInteractive) {
      // Hover: show background
      textElInteractive.addEventListener('mouseenter', function () {
        textElInteractive.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        textElInteractive.style.cursor = 'grab';
      });
      textElInteractive.addEventListener('mouseleave', function () {
        if (!isDragging) {
          textElInteractive.style.backgroundColor = 'transparent';
        }
      });
    }

    // Attach to body — guaranteed root stacking context
    document.body.appendChild(secondaryOverlay);

    console.log('[BilingualSubs] Overlay attached to document.body');

    // Apply saved custom position if any
    applyOverlayPosition();

    // Enable dragging directly on the subtitle text
    setupDrag();

    // Show a brief test message so the user can verify the overlay is visible
    showTestMessage();

    updateOverlayVisibility();
  }

  /**
   * Show a brief test message on the overlay to verify visibility.
   */
  function showTestMessage() {
    if (!secondaryOverlay) return;
    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (!textEl) return;
    const oldColor = textEl.style.color;
    textEl.textContent = '✅ Extension hoạt động — chờ phụ đề...';
    textEl.style.color = '#00ff00';
    secondaryOverlay.style.display = 'block';
    setTimeout(function () {
      textEl.style.color = oldColor || state.secondaryColor || '#ffff00';
      textEl.textContent = '';
      if (!state.activeSecondaryCue) {
        secondaryOverlay.style.display = 'none';
      }
    }, 3000);
  }

  // ============ Fullscreen Handling ============

  /**
   * Detect episode changes via URL.
   * Netflix is a SPA — switching episodes changes the URL without reloading
   * the page. We need to reset subtitle data and re-detect the video element.
   */
  let lastWatchUrl = '';
  function setupEpisodeChangeDetection() {
    // Check URL periodically for changes
    setInterval(function () {
      const currentUrl = window.location.href;
      // Only react to changes on the /watch/ page (different movie/episode ID)
      if (currentUrl.indexOf('/watch/') !== -1 && currentUrl !== lastWatchUrl) {
        if (lastWatchUrl) {
          console.log('[BilingualSubs] Episode changed:', lastWatchUrl, '->', currentUrl);
          handleEpisodeChange();
        }
        lastWatchUrl = currentUrl;
      }
    }, 1000);
  }

  function handleEpisodeChange() {
    // Clear stale subtitle data
    state.subtitleTracks = {};
    state.subtitleTrackNames = {};
    state.primaryLang = '';
    state.activeSecondaryCue = null;
    state.cachedNetflixFontSize = null;
    // Keep secondaryLang — user's language preference persists

    // Force re-detection of the video element on next check
    state.videoElement = null;

    console.log('[BilingualSubs] Episode change: cleared data, will re-detect video');
  }

  /**
   * Listen for fullscreen changes and move the overlay accordingly.
   * In fullscreen, only the fullscreen element and its descendants are visible,
   * so the overlay must be moved inside the fullscreen element.
   */
  function setupFullscreenHandling() {
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    // Also handle the initial state (page might already be in fullscreen)
    setTimeout(handleFullscreenChange, 1000);
  }

  function handleFullscreenChange() {
    if (!secondaryOverlay) return;
    ensureOverlayParent();
    console.log('[BilingualSubs] Fullscreen change detected');
  }

  /**
   * Make sure the overlay is inside a STABLE parent element.
   * DO NOT use Netflix's subtitle container (player-timedtext) — it gets
   * created/destroyed per cue, causing an infinite recreate loop.
   * Instead use the main player wrapper or document.body.
   * Called every frame so Netflix re-renders don't orphan the overlay.
   */
  let _lastRecreateTime = 0;
  function ensureOverlayParent() {
    // If the overlay was removed from the DOM, recreate it (throttled).
    if (!secondaryOverlay || !secondaryOverlay.isConnected) {
      const now = Date.now();
      if (now - _lastRecreateTime < 3000) return; // Don't recreate more than once per 3s
      _lastRecreateTime = now;
      console.log('[BilingualSubs] Overlay detached, recreating...');
      secondaryOverlay = null;
      createOverlays();
      if (!secondaryOverlay) return;
    }

    // Find a STABLE parent. Avoid player-timedtext (unstable, recreated per cue).
    let desiredParent = null;

    const fullscreenEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fullscreenEl) {
      // In fullscreen: use the fullscreen element (or its parent if <video>)
      desiredParent = fullscreenEl.tagName === 'VIDEO'
        ? (fullscreenEl.parentElement || document.body)
        : fullscreenEl;
    } else {
      // Not in fullscreen: find the main player wrapper (stable element)
      const stableSelectors = [
        '.watch-video',
        '.nf-player-container',
        '.player-video-wrapper',
        '#appMountPoint'
      ];
      for (const sel of stableSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.isConnected) {
            desiredParent = el;
            break;
          }
        } catch (e) {}
      }
      // Final fallback
      if (!desiredParent) desiredParent = document.body;
    }

    // Re-append only if parent changed
    if (desiredParent && secondaryOverlay.parentElement !== desiredParent) {
      desiredParent.appendChild(secondaryOverlay);
    }
  }

  // ============ Drag Positioning ============
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let overlayStartX = 0;
  let overlayStartY = 0;

  /**
   * Apply the saved overlay position (default or custom).
   * - Default: bottom: 24vh, full-width, centered text
   * - Custom:  top/left pixel coordinates from drag
   */
  function applyOverlayPosition() {
    if (!secondaryOverlay) return;
    const pos = state.overlayPosition;
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
      // Custom position: x/y is the CENTER of the overlay.
      // Use left + transform: translateX(-50%) so text expands from center outward.
      Object.assign(secondaryOverlay.style, {
        top: pos.y + 'px',
        left: pos.x + 'px',
        bottom: 'auto',
        right: 'auto',
        width: 'auto',
        transform: 'translateX(-50%)'
      });
    } else {
      // Default position
      Object.assign(secondaryOverlay.style, {
        top: 'auto',
        bottom: '24vh',
        left: '0',
        right: '0',
        width: '100%',
        transform: 'none'
      });
    }
  }

  /**
   * Reset the overlay position to default and clear saved position.
   */
  function resetOverlayPosition() {
    state.overlayPosition = null;
    saveSetting('overlayPosition', null);
    applyOverlayPosition();
    console.log('[BilingualSubs] Overlay position reset to default');
  }

  /**
   * Enable mouse drag directly on the subtitle text element.
   */
  function setupDrag() {
    if (!secondaryOverlay) return;
    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (!textEl) return;

    textEl.addEventListener('mousedown', onDragStart);
    textEl.addEventListener('touchstart', onDragStartTouch, { passive: false });
  }

  function onDragStart(e) {
    e.preventDefault();
    e.stopPropagation();
    startDrag(e.clientX, e.clientY);
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragStartTouch(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const t = e.touches[0];
    startDrag(t.clientX, t.clientY);
    document.addEventListener('touchmove', onDragMoveTouch, { passive: false });
    document.addEventListener('touchend', onDragEnd);
  }

  function startDrag(clientX, clientY) {
    isDragging = true;
    dragStartX = clientX;
    dragStartY = clientY;
    // Snapshot the overlay's current CENTER position
    const rect = secondaryOverlay.getBoundingClientRect();
    overlayStartX = rect.left + rect.width / 2;
    overlayStartY = rect.top;

    // Switch overlay to custom positioning mode during drag
    Object.assign(secondaryOverlay.style, {
      top: overlayStartY + 'px',
      left: overlayStartX + 'px',
      bottom: 'auto',
      right: 'auto',
      width: 'auto',
      transform: 'translateX(-50%)'
    });

    // Show grabbing cursor and keep background visible during drag
    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (textEl) {
      textEl.style.cursor = 'grabbing';
      textEl.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
    }
    document.body.style.cursor = 'grabbing';
  }

  function onDragMove(e) {
    moveDrag(e.clientX, e.clientY);
  }

  function onDragMoveTouch(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const t = e.touches[0];
    moveDrag(t.clientX, t.clientY);
  }

  function moveDrag(clientX, clientY) {
    const dx = clientX - dragStartX;
    const dy = clientY - dragStartY;
    const newCenterX = overlayStartX + dx;
    const newY = overlayStartY + dy;
    secondaryOverlay.style.left = newCenterX + 'px';
    secondaryOverlay.style.top = newY + 'px';
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    document.removeEventListener('touchmove', onDragMoveTouch);
    document.removeEventListener('touchend', onDragEnd);

    // Save the final CENTER position (x = center, y = top)
    const rect = secondaryOverlay.getBoundingClientRect();
    state.overlayPosition = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top) };
    saveSetting('overlayPosition', state.overlayPosition);
    console.log('[BilingualSubs] Saved overlay position (center):', state.overlayPosition);

    document.body.style.cursor = '';

    // Restore default state: transparent background, grab cursor
    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (textEl) {
      textEl.style.cursor = 'grab';
      textEl.style.backgroundColor = 'transparent';
    }
  }

  /**
   * Find the Netflix player container element.
   */
  function findPlayerContainer() {
    // Try common Netflix player selectors
    const selectors = [
      '.watch-video',
      '.PlayerContainer',
      '.nf-player-container',
      '#appMountPoint',
      '.VideoContainer',
      '[data-uia="video-player"]',
      '.ltr-1d50h1y' // Common Netflix class pattern
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }

    // Fallback: find the element containing the video
    const video = state.videoElement;
    if (video) {
      // Go up to find a suitable container
      let parent = video.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        if (parent.offsetWidth >= window.innerWidth * 0.8) {
          return parent;
        }
        parent = parent.parentElement;
      }
    }

    return document.body;
  }

  /**
   * Apply styles to the overlay based on current settings.
   * Auto-matches the Netflix native subtitle font size when possible.
   */
  function applyOverlayStyles() {
    if (!secondaryOverlay) return;

    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (!textEl) return;

    // Set CSS custom properties
    secondaryOverlay.style.setProperty('--nbs-color', state.secondaryColor);
    secondaryOverlay.style.setProperty('--nbs-size', state.secondarySize);
    secondaryOverlay.style.setProperty('--nbs-opacity', String(state.secondaryOpacity));

    // Try to match Netflix's native subtitle font size (base).
    // Cache it so the overlay doesn't shrink between subtitle cues.
    let baseFontSize = state.cachedNetflixFontSize || '3.2vh';
    const netflixSubEl = getNetflixSubtitleElement();
    if (netflixSubEl) {
      const computed = window.getComputedStyle(netflixSubEl);
      const netflixFontSize = computed.fontSize;
      if (netflixFontSize && parseFloat(netflixFontSize) > 0) {
        baseFontSize = netflixFontSize;
        state.cachedNetflixFontSize = baseFontSize;
      }
    }

    // Apply the user's size selection as a multiplier on the Netflix base.
    // state.secondarySize is like "0.7em", "1.0em", "1.3em" etc.
    const sizeMultiplier = parseFloat(state.secondarySize) || 1.0;
    let fontSize = baseFontSize;
    const baseVal = parseFloat(baseFontSize);
    if (!isNaN(baseVal) && baseVal > 0) {
      const unit = baseFontSize.replace(/^[\d.]+/, '').trim() || 'px';
      fontSize = (baseVal * sizeMultiplier) + unit;
    }

    // Apply critical inline styles to the text element.
    Object.assign(textEl.style, {
      display: 'inline-block',
      padding: '6px 14px',
      borderRadius: '4px',
      fontFamily: "'Netflix Sans', 'Helvetica Neue', Arial, sans-serif",
      fontSize: fontSize,
      fontWeight: '500',
      lineHeight: '1.4',
      color: state.secondaryColor || '#ffff00',
      opacity: String(state.secondaryOpacity || 0.9),
      backgroundColor: 'transparent',
      textShadow: '-2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 8px rgba(0,0,0,1)',
      whiteSpace: 'pre-wrap',
      maxWidth: '80vw',
      textAlign: 'center',
      pointerEvents: 'auto',
      cursor: 'grab',
      transition: 'background-color 0.15s'
    });
  }

  /**
   * Find Netflix's native subtitle element in the DOM.
   * Returns the element that contains the actual subtitle text.
   */
  function getNetflixSubtitleElement() {
    const selectors = [
      '.player-timedtext-text-container span',
      '.player-timedtext-text-container',
      '.player-timedtext-container span',
      '[data-uia="player-timedtext-text-container"] span',
      '[data-uia*="timedtext"] span',
      '.watch-video .player-timedtext span',
      '.timedtext span'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0) return el;
      } catch (e) {}
    }
    return null;
  }

  /**
   * Get Netflix's native subtitle container element (the wrapper, not the text span).
   */
  function getNetflixSubtitleContainer() {
    const selectors = [
      '.player-timedtext-text-container',
      '.player-timedtext-container',
      '[data-uia="player-timedtext-text-container"]',
      '[data-uia*="timedtext"]',
      '.watch-video .player-timedtext'
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (e) {}
    }
    return null;
  }

  /**
   * Auto-position the overlay right above Netflix's native subtitle.
   * Only applies when the user has NOT set a custom drag position.
   * Returns true if positioned, false if fell back to default.
   */
  function autoPositionOverlay() {
    if (!secondaryOverlay) return;
    // Skip if user dragged to custom position
    if (state.overlayPosition) return;

    const netflixContainer = getNetflixSubtitleContainer();
    if (netflixContainer) {
      const rect = netflixContainer.getBoundingClientRect();
      // Only reposition if Netflix's subtitle is actually visible
      if (rect.width > 0 && rect.height > 0 && rect.top > 0) {
        const vh = window.innerHeight;
        const gap = 8; // pixels between the two subtitles

        if (state.secondaryPosition === 'below') {
          // Place the overlay BELOW Netflix's subtitle.
          // top = bottom of Netflix subtitle + gap
          secondaryOverlay.style.top = (rect.bottom + gap) + 'px';
          secondaryOverlay.style.bottom = 'auto';
        } else {
          // Place the overlay ABOVE Netflix's subtitle.
          // Distance from bottom of viewport to top of Netflix subtitle + gap
          secondaryOverlay.style.bottom = (vh - rect.top + gap) + 'px';
          secondaryOverlay.style.top = 'auto';
        }
        return;
      }
    }
    // Fallback: default position
    if (state.secondaryPosition === 'below') {
      secondaryOverlay.style.top = '12vh';
      secondaryOverlay.style.bottom = 'auto';
    } else {
      secondaryOverlay.style.bottom = '24vh';
      secondaryOverlay.style.top = 'auto';
    }
  }

  /**
   * Apply all settings after a change.
   */
  function applySettings() {
    applyOverlayStyles();
    updateOverlayVisibility();
  }

  /**
   * Show or hide the overlay based on enabled state.
   */
  function updateOverlayVisibility() {
    if (!secondaryOverlay) return;
    if (state.enabled && state.activeSecondaryCue) {
      secondaryOverlay.style.display = 'block';
    } else if (!state.enabled) {
      secondaryOverlay.style.display = 'none';
    }
  }

  // ============ Video Time Tracking ============

  /**
   * Start tracking video currentTime for subtitle syncing.
   */
  function startTimeTracking() {
    if (state.animFrameId) return;

    function tick() {
      updateActiveSubtitles();
      state.animFrameId = requestAnimationFrame(tick);
    }

    state.animFrameId = requestAnimationFrame(tick);
  }

  /**
   * Handle timeupdate/seeked/play events.
   */
  function onTimeUpdate() {
    updateActiveSubtitles();
  }

  /**
   * Update which subtitles should be visible at the current time.
   */
  function updateActiveSubtitles() {
    if (!state.videoElement || !state.enabled) {
      hideSecondarySubtitle();
      return;
    }

    const currentTime = state.videoElement.currentTime;
    if (isNaN(currentTime)) return;

    // The overlay shows the SECONDARY language cues.
    const secondaryCues = state.subtitleTracks[state.secondaryLang] || [];

    let newSecondaryCue = null;
    if (secondaryCues.length > 0) {
      for (let i = 0; i < secondaryCues.length; i++) {
        const cue = secondaryCues[i];
        if (currentTime >= cue.start && currentTime < cue.end) {
          newSecondaryCue = cue;
          break;
        }
        if (cue.start > currentTime) break;
      }
    }

    if (newSecondaryCue !== state.activeSecondaryCue) {
      state.activeSecondaryCue = newSecondaryCue;
      renderSecondarySubtitle();
      // Re-match Netflix's font size whenever subtitle text changes,
      // since Netflix may apply different sizes per cue.
      applyOverlayStyles();
    }

    // Auto-position above Netflix's native subtitle (only when no custom position)
    autoPositionOverlay();

    // Ensure the overlay is in the right parent (handles fullscreen + re-renders)
    ensureOverlayParent();

    // Rate-limited debug logging (every ~2 seconds)
    debugLogTick(currentTime, secondaryCues.length);
  }

  let _lastDebugLog = 0;
  let _lastStyleUpdate = 0;
  function debugLogTick(currentTime, secondaryCueCount) {
    const now = Date.now();
    if (now - _lastDebugLog < 2000) return;
    _lastDebugLog = now;

    // Periodically re-match Netflix's font size (user might change subtitle settings)
    if (now - _lastStyleUpdate > 3000) {
      _lastStyleUpdate = now;
      applyOverlayStyles();
    }

    let rectInfo = '';
    let textContent = '';
    let parentInfo = '';
    let fsInfo = '';
    if (secondaryOverlay) {
      const rect = secondaryOverlay.getBoundingClientRect();
      rectInfo = 'pos=(' + Math.round(rect.left) + ',' + Math.round(rect.top) +
        ') size=' + Math.round(rect.width) + 'x' + Math.round(rect.height);
      const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
      textContent = textEl ? textEl.textContent.substring(0, 40) : '';
      const p = secondaryOverlay.parentElement;
      parentInfo = p ? (p.tagName + '.' + (p.className || '').toString().substring(0, 30)) : 'detached';
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      fsInfo = fs ? 'FS:' + fs.tagName : 'noFS';
    }

    console.log('[BilingualSubs][TICK] t=' + currentTime.toFixed(1) +
      's | secondary=' + JSON.stringify(state.secondaryLang) +
      ' | cues=' + secondaryCueCount +
      ' | primary=' + JSON.stringify(state.primaryLang) +
      ' | allTracks=' + Object.keys(state.subtitleTracks).join(',') +
      ' | manifest=' + Object.keys(state.manifestTracks).join(',') +
      ' | display=' + (secondaryOverlay ? secondaryOverlay.style.display : 'no-overlay') +
      ' | ' + rectInfo +
      ' | ' + fsInfo +
      ' | parent=' + parentInfo +
      ' | text="' + textContent + '"');
  }

  // ============ Subtitle Rendering ============

  /**
   * Render the secondary subtitle text.
   */
  function renderSecondarySubtitle() {
    if (!secondaryOverlay) return;

    const textEl = secondaryOverlay.querySelector('.nbs-subtitle-text');
    if (!textEl) return;

    if (state.activeSecondaryCue && state.enabled) {
      textEl.textContent = state.activeSecondaryCue.text;
      secondaryOverlay.style.display = 'block';
    } else {
      textEl.textContent = '';
      hideSecondarySubtitle();
    }
  }

  /**
   * Hide the secondary subtitle overlay.
   */
  function hideSecondarySubtitle() {
    if (secondaryOverlay) {
      secondaryOverlay.style.display = 'none';
    }
  }

  // ============ Subtitle Data Handling ============

  /**
   * Process intercepted subtitle data.
   */
  function handleSubtitleData(url, text) {
    // Parse the TTML data — now returns { language, cues }
    const parseResult = TTMLParser.parse(text);
    if (!parseResult.cues || parseResult.cues.length === 0) return;

    const cues = parseResult.cues;
    const language = parseResult.language || '';

    // Use the TTML language as the primary track identifier.
    // This is far more meaningful than the URL token (e.g. "vi" vs "gpsSSQ9...").
    // If language is missing, fall back to a URL-based fingerprint.
    const trackInfo = extractTrackId(url);
    const trackId = language || trackInfo.trackId;

    // Determine if this is a new track
    const isNewTrack = !state.subtitleTracks[trackId];

    // Merge cues: Netflix loads subtitle data in segments over time.
    // Accumulate cues and dedupe by (start, text).
    if (isNewTrack) {
      state.subtitleTracks[trackId] = [];
    }
    const existing = state.subtitleTracks[trackId];
    const existingKeys = new Set(existing.map(c => c.start + '|' + c.text));
    let added = 0;
    for (const cue of cues) {
      const key = cue.start + '|' + cue.text;
      if (!existingKeys.has(key)) {
        existing.push(cue);
        existingKeys.add(key);
        added++;
      }
    }
    // Keep sorted
    existing.sort((a, b) => a.start - b.start);

    // Assign a readable display name using the TTML language code
    state.subtitleTrackNames = state.subtitleTrackNames || {};
    if (language && !state.subtitleTrackNames[trackId]) {
      state.subtitleTrackNames[trackId] = languageToName(language);
    } else if (!state.subtitleTrackNames[trackId] && trackInfo.shortId) {
      state.subtitleTrackNames[trackId] = trackInfo.shortId;
    }

    // If this is the first track we've seen, mark it as primary (the one
    // Netflix is currently rendering natively).
    if (!state.primaryLang) {
      state.primaryLang = trackId;
      console.log('[BilingualSubs] Primary track:', trackId, '(' + languageToName(language) + ')');
    }
    state.lastPrimaryUrl = url;

    // Notify the popup about available tracks
    notifyTracksUpdated();

    // Try to auto-select a sensible secondary language now that we have more data.
    // This only acts if no (good) secondary is set yet.
    maybeAutoSelectSecondary();

    console.log('[BilingualSubs] Captured subtitle data:', {
      trackId: trackId,
      language: language,
      name: state.subtitleTrackNames[trackId],
      newCues: added,
      totalCues: existing.length
    });
  }

  /**
   * Automatically pick a secondary language when the current choice is missing
   * or is the same as the primary (which would be useless for bilingual display).
   * Combines captured tracks and manifest tracks.
   */
  function maybeAutoSelectSecondary() {
    // Gather every language we know about (captured + manifest)
    const available = {};
    Object.keys(state.subtitleTracks).forEach(function (lang) {
      available[lang] = true;
    });
    Object.keys(state.manifestTracks).forEach(function (lang) {
      available[lang] = true;
    });
    const langs = Object.keys(available);
    // PRIORITY: Always try to select Vietnamese as the secondary.
    // Even if it's the only language available, still select it so the
    // overlay shows it alongside Netflix's native subtitle.
    if (!state.secondaryLang || state.secondaryLang === state.primaryLang) {
      if (state.primaryLang !== 'vi' && available['vi']) {
        console.log('[BilingualSubs] Auto-selected Vietnamese secondary');
        setSecondaryTrack('vi');
        return;
      }
    }

    // If secondary is already set AND different from primary AND we have data for it, keep it.
    if (state.secondaryLang &&
        state.secondaryLang !== state.primaryLang &&
        available[state.secondaryLang]) {
      return;
    }

    // Pick a secondary that is DIFFERENT from the primary.
    let chosen = null;

    // PRIORITY: Always prefer Vietnamese ("vi") as the secondary language.
    // If primary is already Vietnamese, prefer English.
    if (state.primaryLang !== 'vi' && available['vi']) {
      chosen = 'vi';
    } else if (state.primaryLang !== 'en' && available['en']) {
      chosen = 'en';
    } else {
      for (const lang of langs) {
        if (lang !== state.primaryLang) {
          chosen = lang;
          break;
        }
      }
    }

    if (chosen) {
      console.log('[BilingualSubs] Auto-selected secondary:', chosen,
        '(primary=' + state.primaryLang + ')');
      setSecondaryTrack(chosen);
    }
  }

  /**
   * Map an ISO language code to a readable name.
   */
  function languageToName(code) {
    if (!code) return 'Không rõ';
    const map = {
      'vi': 'Tiếng Việt',
      'en': 'English',
      'ja': '日本語',
      'ko': '한국어',
      'zh': '中文',
      'zh-CN': '中文 (Giản thể)',
      'zh-TW': '中文 (Phồn thể)',
      'fr': 'Français',
      'de': 'Deutsch',
      'es': 'Español',
      'pt': 'Português',
      'pt-BR': 'Português (Brasil)',
      'it': 'Italiano',
      'ru': 'Русский',
      'th': 'ภาษาไทย',
      'id': 'Bahasa Indonesia',
      'ms': 'Bahasa Melayu',
      'ar': 'العربية',
      'hi': 'हिन्दी',
      'tr': 'Türkçe',
      'pl': 'Polski',
      'nl': 'Nederlands',
      'sv': 'Svenska',
      'da': 'Dansk',
      'fi': 'Suomi',
      'no': 'Norsk',
      'cs': 'Čeština',
      'el': 'Ελληνικά',
      'he': 'עברית',
      'hu': 'Magyar',
      'ro': 'Română',
      'uk': 'Українська'
    };
    return map[code] || code.toUpperCase();
  }

  /**
   * Extract track identifier from URL.
   */
  function extractTrackId(url) {
    try {
      const urlObj = new URL(url);

      // Compute a stable fingerprint from the URL:
      // Remove time-varying parameters like expiration (e=), signature, etc.
      // Keep parameters that identify the track.
      const stableParams = new URLSearchParams();
      const trackIdentifyingKeys = ['track', 't', 'id', 'lang', 'l', 'dl', 'v', 'o', 'ctx'];

      urlObj.searchParams.forEach((value, key) => {
        // Skip time-varying / signature params
        if (key === 'e' || key === 'sig' || key === 'signature' || key === '_' || key === 'cb') {
          return;
        }
        // Check if this param could identify a track
        stableParams.set(key, value);
      });

      // Build fingerprint: host + path + sorted stable params
      const pathPart = urlObj.pathname.replace(/\/+/g, '/').replace(/\/$/, '');
      const hostPart = urlObj.hostname.replace(/^ipv4-\w+-/, ''); // Remove CDN prefix
      stableParams.sort();
      const paramStr = stableParams.toString();

      const fingerprint = hostPart + '|' + pathPart + '|' + paramStr;

      // Also extract a human-readable track ID from the params
      const shortId = (
        urlObj.searchParams.get('dl') ||
        urlObj.searchParams.get('lang') ||
        urlObj.searchParams.get('l') ||
        urlObj.searchParams.get('track') ||
        urlObj.searchParams.get('t') ||
        urlObj.searchParams.get('id') ||
        ''
      );

      return {
        trackId: shortId || 'track_' + simpleHash(fingerprint),
        fingerprint: fingerprint,
        shortId: shortId
      };
    } catch (e) {
      return { trackId: 'track_' + Date.now(), fingerprint: url, shortId: '' };
    }
  }

  /**
   * Simple string hash function.
   */
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  /**
   * Set the secondary subtitle track.
   */
  function setSecondaryTrack(trackId) {
    state.secondaryLang = trackId;
    saveSetting('secondaryLang', trackId);

    if (trackId) {
      // If we already have the data, nothing to fetch
      if (!state.subtitleTracks[trackId] || state.subtitleTracks[trackId].length === 0) {
        // First, try to fetch from the manifest (best approach — no manual switching needed)
        if (state.manifestTracks[trackId]) {
          fetchSecondaryLanguageFromManifest(trackId);
        } else {
          // Fallback: ask the user to switch subtitle languages manually
          // so Netflix loads the data and we intercept it
          attemptFetchSecondaryLanguage();
        }
      }
    }

    // Reset active secondary cue to trigger re-render
    state.activeSecondaryCue = null;
    updateActiveSubtitles();
  }

  /**
   * Attempt to fetch secondary language subtitle data.
   * This is done by briefly switching subtitle tracks to trigger
   * Netflix to load the data, which we then intercept.
   */
  function attemptFetchSecondaryLanguage() {
    if (!state.secondaryLang) return;

    console.log('[BilingualSubs] Attempting to fetch secondary language:', state.secondaryLang);

    // Strategy: Try to find and click the subtitle menu to switch languages
    // We'll look for Netflix's subtitle selection UI
    trySwitchSubtitleTrack(state.secondaryLang);
  }

  /**
   * Try to programmatically switch the subtitle track to trigger data loading.
   */
  function trySwitchSubtitleTrack(targetTrackId) {
    // Delegate to inject.js (MAIN world) which has access to Netflix's player API
    sendToInject('switchSubtitleTrack', { trackId: targetTrackId });

    // Method 2: Try to click the subtitle button in Netflix UI as fallback
    tryClickSubtitleMenu();
  }

  /**
   * Try to find and click Netflix's subtitle menu to toggle languages.
   */
  function tryClickSubtitleMenu() {
    // Look for the audio/subtitle control in the Netflix player
    const selectors = [
      '[data-uia="control-audio-subtitle"]',
      '.audio-subtitle-controller button',
      'button[aria-label*="Audio"]',
      'button[aria-label*="Subtitles"]',
      'button[aria-label*="Phụ đề"]',
      '.nfp-button-control-audio-subtitle',
      '[class*="audio-subtitle"] button',
      '.PlayerControls button:has([class*="subtitle"])'
    ];

    for (const selector of selectors) {
      try {
        const button = document.querySelector(selector);
        if (button) {
          console.log('[BilingualSubs] Found subtitle button:', selector);
          // We don't automatically click to avoid disrupting the user
          // Instead, guide the user to manually switch
          showNotification('Vui lòng chuyển phụ đề sang ngôn ngữ thứ hai trong menu Netflix để extension ghi nhận.');
          return;
        }
      } catch (e) {
        // Selector might be invalid, continue
      }
    }
  }

  /**
   * Show a brief notification to the user.
   */
  function showNotification(message) {
    // Remove existing notification if any
    const existing = document.querySelector('.nbs-notification');
    if (existing) existing.remove();

    const notif = document.createElement('div');
    notif.className = 'nbs-notification';
    notif.textContent = message;
    notif.style.cssText = `
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      z-index: 999999;
      pointer-events: none;
      animation: nbs-fadeInOut 4s ease forwards;
    `;

    document.body.appendChild(notif);

    setTimeout(() => notif.remove(), 4500);
  }

  /**
   * Notify the popup about updated track list.
   */
  function notifyTracksUpdated() {
    try {
      // Combine captured + manifest tracks
      const trackIds = new Set(Object.keys(state.subtitleTracks));
      Object.keys(state.manifestTracks).forEach(function (lang) {
        trackIds.add(lang);
      });

      const allTracks = Array.from(trackIds).map(function (id) {
        const manifestInfo = state.manifestTracks[id];
        return {
          id: id,
          name: state.subtitleTrackNames[id] ||
                (manifestInfo ? languageToName(id) : id),
          cueCount: state.subtitleTracks[id] ? state.subtitleTracks[id].length : 0,
          isPrimary: id === state.primaryLang,
          isManifest: !!manifestInfo
        };
      });

      chrome.runtime.sendMessage({
        action: 'tracksUpdated',
        primaryLang: state.primaryLang,
        tracks: allTracks
      }).catch(function () {
        // Popup might not be open, that's fine
      });
    } catch (e) {
      // Ignore
    }
  }

  // ============ Periodic Player Probing ============
  let probeInterval = null;

  function startPlayerProbing() {
    if (probeInterval) return;
    // Probe the player every 5 seconds initially, then slow down
    let attempts = 0;
    probeInterval = setInterval(function () {
      attempts++;
      sendToInject('probePlayer', {});
      if (attempts > 6) {
        // After 6 attempts (30 seconds), slow down to every 15 seconds
        clearInterval(probeInterval);
        probeInterval = setInterval(function () {
          sendToInject('probePlayer', {});
        }, 15000);
      }
    }, 5000);
  }

  // ============ Start ============
  init();

  // Start probing for player API after a short delay
  // (wait for Netflix player to initialize)
  setTimeout(startPlayerProbing, 3000);

})();
