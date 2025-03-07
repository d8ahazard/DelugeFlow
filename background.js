// Service worker for the Chrome extension

// Import necessary scripts without jQuery
importScripts(
  'lib/logger.js',
  'lib/utils.js',
  'lib/controller_communicator.js',
  'controller_actions.js'
);

// Add event listeners for service worker lifecycle events
self.addEventListener('install', (event) => {
  debugLog('important', 'Service Worker: Installed');
  // Ensure the service worker activates immediately
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  debugLog('important', 'Service Worker: Activated');
  // Ensure the service worker takes control immediately
  event.waitUntil(self.clients.claim());
});

// Handle fetch requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Check if this is a JSON request to the Deluge server
  if (url.pathname.endsWith('/json')) {
    event.respondWith(
      fetch(event.request.clone(), {
        credentials: 'include',
        mode: 'cors'
      }).then(response => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.clone().json().then(data => {
          debugLog('debug', 'Deluge server response:', data);
          return response;
        });
      }).catch(error => {
        debugLog('error', 'Deluge server request failed:', error);
        // Return a proper JSON error response
        return new Response(JSON.stringify({
          error: true,
          message: error.message
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      })
    );
  } else if (url.origin === self.location.origin) {
    // Handle extension-specific requests
    event.respondWith(
      fetch(event.request).then((response) => {
        return response;
      }).catch((error) => {
        debugLog('warn', 'Extension fetch error:', error, event.request);
        return new Response('Network error occurred', {
          status: 408,
          statusText: 'Request Timeout'
        });
      })
    );
  }
});

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  debugLog('debug', 'Message received:', request);

  if (request.method === 'get-server-info') {
    // Get server info from storage
    delugeConnection.getAvailableServers().then(serverInfo => {
      sendResponse(serverInfo);
    });
    return true;
  }

  if (request.method === 'plugins-getinfo') {
    // Create a temporary connection if URL and password are provided
    let connection = delugeConnection;
    if (request.url && request.password) {
      connection = new DelugeConnection();
      connection.SERVER_URL = request.url;
      connection.SERVER_PASS = request.password;
    }

    // If using existing connection and serverIndex is provided, connect to that server first
    const promise = request.serverIndex !== undefined && !request.url
      ? delugeConnection.connectToServer(request.serverIndex).then(() => delugeConnection.getPluginInfo())
      : connection._connect(true).then(() => connection.getPluginInfo());

    promise.then(pluginInfo => {
      sendResponse(pluginInfo);
    }).catch(error => {
      debugLog('error', 'Error getting plugin info:', error);
      sendResponse({ error: error.message });
    });
    return true;
  }

  if (request.method === 'addlink-todeluge') {
    const { url, domain, plugins, options, serverIndex, cookies } = request;
    
    delugeConnection.addTorrent(url, cookies, plugins, options, serverIndex)
      .then(result => {
        sendResponse({ success: true, result });
      })
      .catch(error => {
        debugLog('error', 'Error adding torrent:', error);
        sendResponse({ error: error.message });
      });
    return true;
  }

  // Handle other messages...
  return false;
}); 