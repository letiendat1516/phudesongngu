/**
 * background.js - Service Worker
 * Handles extension-level events and default settings.
 */
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.set({
    enabled: true,
    secondaryLang: '',
    secondaryPosition: 'above',
    secondaryColor: '#ffff00',
    secondarySize: '1.5em',
    secondaryOpacity: '0.9'
  });
});
