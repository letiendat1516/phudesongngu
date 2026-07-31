/**
 * popup.js - Popup UI logic
 */
(function () {
  'use strict';

  // DOM Elements
  const toggleEnabled = document.getElementById('toggleEnabled');
  const trackList = document.getElementById('trackList');
  const positionSelect = document.getElementById('positionSelect');
  const colorPicker = document.getElementById('colorPicker');
  const colorPreview = document.getElementById('colorPreview');
  const sizeSelect = document.getElementById('sizeSelect');
  const opacitySlider = document.getElementById('opacitySlider');
  const opacityValue = document.getElementById('opacityValue');
  const refreshBtn = document.getElementById('refreshBtn');
  const resetPosBtn = document.getElementById('resetPosBtn');
  const displaySettingsToggle = document.getElementById('displaySettingsToggle');
  const displaySettings = document.getElementById('displaySettings');

  // State
  let currentState = {};

  // ============ Initialization ============

  async function init() {
    // Load current state from content script
    await loadState();

    // Set up event listeners
    setupEventListeners();

    // Set up collapse toggle
    setupCollapse();

    // Listen for real-time track updates from content script
    chrome.runtime.onMessage.addListener(function (message) {
      if (message.action === 'tracksUpdated' && message.tracks) {
        currentState.availableTracks = message.tracks;
        renderTrackList(message.tracks, currentState.secondaryLang, currentState.primaryLang);
      }
    });
  }

  /**
   * Load current extension state from the content script.
   */
  async function loadState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url.includes('netflix.com')) {
        showNotOnNetflix();
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getState' });
      if (response) {
        currentState = response;
        // Ensure availableTracks is an array
        if (!Array.isArray(currentState.availableTracks)) {
          currentState.availableTracks = [];
        }
        updateUI();
      }
    } catch (e) {
      console.log('[BilingualSubs Popup] Could not load state:', e.message);
      // Try loading from storage as fallback
      try {
        const stored = await chrome.storage.local.get([
          'enabled', 'secondaryLang', 'secondaryPosition',
          'secondaryColor', 'secondarySize', 'secondaryOpacity'
        ]);
        currentState = {
          enabled: stored.enabled !== undefined ? stored.enabled : true,
          secondaryLang: stored.secondaryLang || '',
          secondaryPosition: stored.secondaryPosition || 'above',
          secondaryColor: stored.secondaryColor || '#ffff00',
          secondarySize: stored.secondarySize || '1.5em',
          secondaryOpacity: stored.secondaryOpacity || 0.9,
          availableTracks: []
        };
        updateUI();
      } catch (e2) {
        showNotOnNetflix();
      }
    }
  }

  /**
   * Update the popup UI to reflect current state.
   */
  function updateUI() {
    // Toggle
    toggleEnabled.checked = currentState.enabled;

    // Position
    positionSelect.value = currentState.secondaryPosition || 'above';

    // Color
    colorPicker.value = currentState.secondaryColor || '#ffff00';
    updateColorPreview(currentState.secondaryColor || '#ffff00');

    // Size
    sizeSelect.value = currentState.secondarySize || '1.5em';

    // Opacity
    const opacity = currentState.secondaryOpacity || 0.9;
    opacitySlider.value = opacity;
    opacityValue.textContent = opacity;

    // Track list
    renderTrackList(currentState.availableTracks || [], currentState.secondaryLang, currentState.primaryLang);
  }

  /**
   * Render the available subtitle tracks.
   */
  function renderTrackList(tracks, activeTrackId, primaryTrackId) {
    trackList.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      trackList.innerHTML = '<div class="empty-state">Chưa phát hiện phụ đề. Hãy phát video Netflix...</div>';
      return;
    }

    // Add "None" option
    const noneItem = document.createElement('div');
    noneItem.className = 'track-item' + (!activeTrackId ? ' active' : '');
    noneItem.innerHTML = `
      <div class="track-radio"></div>
      <div class="track-info">
        <div class="track-name">Không hiển thị</div>
        <div class="track-meta">Chỉ hiện phụ đề gốc</div>
      </div>
    `;
    noneItem.addEventListener('click', () => selectTrack(''));
    trackList.appendChild(noneItem);

    // Add discovered tracks
    tracks.forEach((track, index) => {
      const item = document.createElement('div');
      const isActive = track.id === activeTrackId;
      const isPrimary = track.id === primaryTrackId || track.isPrimary;
      item.className = 'track-item' + (isActive ? ' active' : '');
      const displayName = track.name || track.id || ('Track #' + (index + 1));
      let cueInfo;
      if (track.cueCount > 0) {
        cueInfo = track.cueCount + ' câu đã tải';
      } else if (track.isManifest) {
        cueInfo = '⚡ Sẵn có - tự tải khi chọn';
      } else {
        cueInfo = 'Đã ghi nhận';
      }
      const primaryTag = isPrimary ? ' <span class="primary-tag">(gốc)</span>' : '';
      item.innerHTML = `
        <div class="track-radio"></div>
        <div class="track-info">
          <div class="track-name">${escapeHtml(displayName)}${primaryTag}</div>
          <div class="track-meta">${escapeHtml(cueInfo)}</div>
        </div>
      `;
      item.addEventListener('click', () => selectTrack(track.id));
      trackList.appendChild(item);
    });
  }

  /**
   * Select a secondary subtitle track.
   */
  async function selectTrack(trackId) {
    currentState.secondaryLang = trackId;
    updateUI();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'setSecondaryTrack',
          trackId: trackId
        });
        // Also save to storage
        await chrome.storage.local.set({ secondaryLang: trackId });
      }
    } catch (e) {
      console.log('[BilingualSubs Popup] Could not set track:', e);
    }
  }

  // ============ Event Listeners ============

  function setupEventListeners() {
    // Toggle enabled
    toggleEnabled.addEventListener('change', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          const response = await chrome.tabs.sendMessage(tab.id, {
            action: 'toggleEnabled'
          });
          if (response) {
            currentState.enabled = response.enabled;
          }
        }
      } catch (e) {
        // Fallback: save to storage
        const enabled = toggleEnabled.checked;
        await chrome.storage.local.set({ enabled });
      }
    });

    // Position
    positionSelect.addEventListener('change', async () => {
      await updateSetting('secondaryPosition', positionSelect.value);
    });

    // Color
    colorPicker.addEventListener('input', () => {
      updateColorPreview(colorPicker.value);
    });
    colorPicker.addEventListener('change', async () => {
      await updateSetting('secondaryColor', colorPicker.value);
    });

    // Size
    sizeSelect.addEventListener('change', async () => {
      await updateSetting('secondarySize', sizeSelect.value);
    });

    // Opacity
    opacitySlider.addEventListener('input', () => {
      opacityValue.textContent = parseFloat(opacitySlider.value).toFixed(2);
    });
    opacitySlider.addEventListener('change', async () => {
      await updateSetting('secondaryOpacity', parseFloat(opacitySlider.value));
    });

    // Refresh button
    refreshBtn.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.sendMessage(tab.id, { action: 'refreshSubtitles' });
        }
      } catch (e) {
        console.log('[BilingualSubs Popup] Could not refresh:', e);
      }
      // Reload state
      setTimeout(() => loadState(), 500);
    });

    // Reset overlay position button
    resetPosBtn.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          await chrome.tabs.sendMessage(tab.id, { action: 'resetPosition' });
        }
      } catch (e) {
        console.log('[BilingualSubs Popup] Could not reset position:', e);
      }
      window.close();
    });
  }

  /**
   * Update a setting in the content script and storage.
   */
  async function updateSetting(key, value) {
    currentState[key] = value;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'updateSetting',
          key: key,
          value: value
        });
      }
    } catch (e) {
      console.log('[BilingualSubs Popup] Could not update setting:', e);
    }
    // Always save to storage
    await chrome.storage.local.set({ [key]: value });
  }

  // ============ Collapse ============

  function setupCollapse() {
    // Start expanded
    displaySettingsToggle.parentElement.classList.add('open');

    displaySettingsToggle.addEventListener('click', () => {
      displaySettingsToggle.parentElement.classList.toggle('open');
    });
  }

  // ============ Helpers ============

  function updateColorPreview(color) {
    colorPreview.style.color = color;
  }

  function showNotOnNetflix() {
    document.querySelector('.popup-container').innerHTML = `
      <div style="text-align: center; padding: 40px 20px;">
        <div style="font-size: 48px; margin-bottom: 16px;">🎬</div>
        <h2 style="font-size: 16px; color: #e50914; margin-bottom: 8px;">
          Netflix Phụ Đề Song Ngữ
        </h2>
        <p style="color: #999; font-size: 12px; line-height: 1.6;">
          Hãy mở <strong style="color: #e50914;">netflix.com</strong> và phát một video để sử dụng extension.
        </p>
      </div>
    `;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ============ Start ============
  document.addEventListener('DOMContentLoaded', init);

})();
