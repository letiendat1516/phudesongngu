/**
 * inject.js - Runs in MAIN world to intercept Netflix subtitle data.
 * Captures ALL subtitle-like network responses for analysis.
 */
(function () {
  'use strict';

  if (window.__netflixBilingualInjected) return;
  window.__netflixBilingualInjected = true;

  /**
   * Broad check: is this URL related to subtitles / Netflix CDN?
   */
  function isInterestingURL(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.toLowerCase();
    return (
      u.includes('nflxvideo.net') ||
      u.includes('nflxext.com') ||
      u.includes('timedtext') ||
      u.includes('subtitle') ||
      u.includes('/dfxp') ||
      u.includes('ttml') ||
      u.includes('.vtt') ||
      u.includes('texttrack') ||
      u.includes('/cadmium/') ||
      u.includes('/msl/') ||
      u.includes('/lic/') ||
      u.includes('?o=') ||
      u.includes('&o=') ||
      u.includes('manifest') ||
      u.includes('track')
    );
  }

  /**
   * Is this URL a Netflix manifest (lists all subtitle tracks)?
   */
  function isManifestURL(url) {
    if (!url) return false;
    const u = url.toLowerCase();
    return (
      u.includes('/cadmium/manifest/') ||
      u.includes('/cadmium/licensedmanifest') ||
      u.includes('/playapi/cadmium/manifest')
    );
  }

  /**
   * Parse a Netflix manifest JSON to extract all timed text (subtitle) tracks.
   * Returns: [{ language, languageDescription, isForced, isCC, urls: [...] }]
   */
  function extractSubtitleTracksFromManifest(manifestText) {
    const tracks = [];
    let manifest;

    // Try parsing the full JSON first
    try {
      manifest = JSON.parse(manifestText);
    } catch (e) {
      // Netflix responses sometimes have trailing data or multiple JSON objects.
      // Try to find the first valid JSON object in the text.
      console.log('[Netflix Bilingual Subs] Manifest JSON parse failed, trying salvage...');

      // Strategy 1: Find the first '{' and try progressively shorter substrings
      // until we find one that parses successfully.
      const firstBrace = manifestText.indexOf('{');
      if (firstBrace === -1) return tracks;

      // Binary search for the longest valid JSON prefix
      let lo = firstBrace;
      let hi = manifestText.length;
      let bestValid = null;

      // Try a few strategic cut points rather than binary search (faster)
      const cutPoints = [];
      // Try cutting at each '}' from the end
      let pos = manifestText.length;
      while ((pos = manifestText.lastIndexOf('}', pos - 1)) > firstBrace) {
        cutPoints.push(pos + 1);
        if (cutPoints.length >= 20) break; // limit attempts
      }

      for (const cut of cutPoints) {
        try {
          const candidate = JSON.parse(manifestText.substring(firstBrace, cut));
          bestValid = candidate;
          break; // first valid parse (largest cut)
        } catch (e2) {
          // continue trying
        }
      }

      if (!bestValid) {
        console.log('[Netflix Bilingual Subs] Could not salvage manifest JSON');
        return tracks;
      }
      manifest = bestValid;
      console.log('[Netflix Bilingual Subs] Salvaged manifest JSON');
    }

    const result = manifest.result || manifest;

    // Log the top-level keys so we can see the structure
    console.log('[Netflix Bilingual Subs] Manifest keys:', Object.keys(result));

    // Try every plausible field name for subtitle tracks
    const candidateFields = [
      'timedTextTracks',
      'textTracks',
      'subtitleTracks',
      'captionTracks',
      'subtitles'
    ];

    let timedTextTracks = null;
    for (const field of candidateFields) {
      if (Array.isArray(result[field])) {
        timedTextTracks = result[field];
        console.log('[Netflix Bilingual Subs] Found subtitle tracks in field:', field);
        break;
      }
    }

    // Also check inside audioTracks (some manifest versions nest them there)
    if (!timedTextTracks && Array.isArray(result.audioTracks)) {
      for (const at of result.audioTracks) {
        for (const field of candidateFields) {
          if (Array.isArray(at[field])) {
            timedTextTracks = at[field];
            console.log('[Netflix Bilingual Subs] Found subtitle tracks in audioTrack.' + field);
            break;
          }
        }
        if (timedTextTracks) break;
      }
    }

    // Deep search fallback: look for any array whose items have 'language' + 'urls'
    if (!timedTextTracks) {
      function deepFind(obj, depth) {
        if (!obj || typeof obj !== 'object' || depth > 4) return null;
        if (Array.isArray(obj)) {
          if (obj.length > 0 && obj[0] && obj[0].language && (obj[0].urls || obj[0].streams)) {
            return obj;
          }
          for (const item of obj) {
            const found = deepFind(item, depth + 1);
            if (found) return found;
          }
        } else {
          for (const key of Object.keys(obj)) {
            const found = deepFind(obj[key], depth + 1);
            if (found) return found;
          }
        }
        return null;
      }
      timedTextTracks = deepFind(result, 0);
      if (timedTextTracks) {
        console.log('[Netflix Bilingual Subs] Found subtitle tracks via deep search:',
          timedTextTracks.length, 'tracks');
      }
    }

    if (!timedTextTracks || !Array.isArray(timedTextTracks)) {
      console.log('[Netflix Bilingual Subs] No subtitle tracks found in manifest');
      return tracks;
    }

    for (const track of timedTextTracks) {
      const urls = [];
      if (track.urls && Array.isArray(track.urls)) {
        for (const u of track.urls) {
          if (u.url) urls.push(u.url);
        }
      }
      if (track.streams && Array.isArray(track.streams)) {
        for (const stream of track.streams) {
          if (stream.urls && Array.isArray(stream.urls)) {
            for (const u of stream.urls) {
              if (u.url) urls.push(u.url);
            }
          }
          if (stream.url) urls.push(stream.url);
        }
      }
      if (urls.length > 0 || track.language) {
        tracks.push({
          language: track.language || track.locale || '',
          languageDescription: track.languageDescription || track.displayName || '',
          isForced: track.isForced || track.forced || false,
          rawTrackType: track.rawTrackType || track.trackType || '',
          urls: urls
        });
      }
    }

    console.log('[Netflix Bilingual Subs] Extracted', tracks.length, 'subtitle tracks from manifest');
    return tracks;
  }

  /**
   * Is the response body actually TTML/DFXP subtitle XML?
   */
  function looksLikeSubtitleData(text) {
    if (!text || typeof text !== 'string') return false;
    return (
      text.includes('<tt') ||
      text.includes('<?xml') ||
      text.includes('xmlns="http://www.w3.org/ns/ttml"') ||
      text.includes('<p begin=')
    );
  }

  /**
   * Send captured data to the content script.
   */
  function sendToContent(payload) {
    window.postMessage(
      Object.assign({ source: 'netflix-bilingual-subtitles' }, payload),
      '*'
    );
  }

  function sendSubtitleData(url, text) {
    sendToContent({ type: 'SUBTITLE_DATA', url: url, data: text, timestamp: Date.now() });
  }

  /**
   * Process a captured response body. Handles manifests, TTML, and logging.
   */
  function processResponseBody(url, text) {
    // Send to content script for logging (truncated)
    sendToContent({
      type: 'NETWORK_RESPONSE',
      url: url,
      data: text.substring(0, 50000),
      isSubtitle: looksLikeSubtitleData(text),
      timestamp: Date.now()
    });

    // If it's TTML subtitle data, send the full body
    if (looksLikeSubtitleData(text)) {
      sendSubtitleData(url, text);
      return;
    }

    // If it's a manifest, extract subtitle track URLs and send them
    if (isManifestURL(url)) {
      const tracks = extractSubtitleTracksFromManifest(text);
      if (tracks.length > 0) {
        sendToContent({
          type: 'MANIFEST_TRACKS',
          url: url,
          tracks: tracks,
          timestamp: Date.now()
        });
      }
    }
  }

  // ===== Intercept fetch =====
  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');

    return originalFetch.apply(this, arguments).then(function (response) {
      if (isInterestingURL(url) || isManifestURL(url)) {
        try {
          const cloned = response.clone();
          cloned.text().then(function (text) {
            processResponseBody(url, text);
          }).catch(function () {});
        } catch (e) {}
      }
      return response;
    });
  };

  // ===== Intercept XMLHttpRequest =====
  const OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    const xhr = new OrigXHR();
    let _url = '';

    const origOpen = xhr.open;
    xhr.open = function (method, url) {
      _url = typeof url === 'string' ? url : (url ? url.toString() : '');
      return origOpen.apply(this, arguments);
    };

    const origSend = xhr.send;
    xhr.send = function () {
      // Only add listeners for subtitle/manifest URLs — skip telemetry etc.
      if (isInterestingURL(_url) || isManifestURL(_url)) {
        xhr.addEventListener('load', function () {
          let responseText = '';
          try {
            responseText = xhr.responseText;
          } catch (e) {
            return;
          }
          if (responseText) {
            processResponseBody(_url, responseText);
          }
        });
      }
      return origSend.apply(this, arguments);
    };

    return xhr;
  };

  // Copy static props
  try {
    Object.keys(OrigXHR).forEach(function (key) {
      if (key !== 'prototype') window.XMLHttpRequest[key] = OrigXHR[key];
    });
    window.XMLHttpRequest.prototype = OrigXHR.prototype;
    ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (k) {
      window.XMLHttpRequest[k] = OrigXHR[k];
    });
  } catch (e) {}

  // ===== Listen for commands from content script =====
  window.addEventListener('message', function (event) {
    if (!event.data) return;
    if (event.data.target !== 'netflix-bilingual-inject') return;

    switch (event.data.action) {
      case 'probePlayer':
        probeNetflixPlayer();
        break;
      case 'switchSubtitleTrack':
        break;
    }
  });

  // ===== Probe Netflix player internal state =====
  function probeNetflixPlayer() {
    const result = { found: false, subtitleTracks: [], playerKeys: [] };

    try {
      const netflix = window.netflix;
      if (netflix) {
        result.found = true;
        result.playerKeys = Object.keys(netflix).slice(0, 20);
      }
    } catch (e) {
      result.error = e.message;
    }

    sendToContent({ type: 'PLAYER_PROBE_RESULT', data: result });
  }

  console.log('[Netflix Bilingual Subs] inject.js loaded in MAIN world');
})();
