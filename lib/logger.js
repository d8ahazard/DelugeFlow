/* global chrome */
(function(global) {
  // debug flag
  let DEBUG = false;

  // Initialize debug setting from storage
  chrome.storage.local.get('enable_debug_logging', function(data) {
    DEBUG = !!data.enable_debug_logging;
    if (DEBUG) {
      console.warn('[DelugeFlow] *** Debug logging enabled ***');
    }
  });

  // Listen for changes to debug setting
  chrome.storage.onChanged.addListener(function(changes) {
    if (changes.enable_debug_logging) {
      DEBUG = changes.enable_debug_logging.newValue;
      if (DEBUG) {
        console.warn('[DelugeFlow] *** Debug logging enabled ***');
      }
    }
  });

  function debugLog(level, ...args) {
    // Always log errors regardless of debug setting
    if (level === 'error') {
      console.error('[DelugeFlow]', ...args);
      // Stack trace
      console.trace();
      return;
    }
    
    // Always log important info regardless of debug setting
    if (level === 'important') {
      console.log('[DelugeFlow]', ...args);
      return;
    }
    
    // Only log debug and info if debug is enabled
    if (DEBUG) {
      if (level === 'warn') {
        console.warn('[DelugeFlow]', ...args);
      } else {
        console.log('[DelugeFlow]', ...args);
      }
    }
  }

  // For backward compatibility
  function log(...args) {
    debugLog('debug', ...args);
  }

  // Export to global scope
  global.debugLog = debugLog;
  global.log = log;

})(typeof globalThis !== 'undefined' ? globalThis : 
   typeof window !== 'undefined' ? window : 
   typeof global !== 'undefined' ? global : 
   typeof self !== 'undefined' ? self : {}); 