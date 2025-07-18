/* global chrome, communicator */
// Remove local debug logging implementation since it's now in logger.js

/**
 * Utility function to retry a promise-based operation with exponential backoff
 * @param {Function} operation - Function returning a promise to retry
 * @param {Object} options - Retry options
 * @param {number} options.maxRetries - Maximum number of retry attempts
 * @param {number} options.baseDelay - Base delay in ms before retrying
 * @param {number} options.maxDelay - Maximum delay in ms
 * @param {Function} options.shouldRetry - Function to determine if retry should happen
 * @returns {Promise} - The operation promise with retry logic
 */
function retryWithBackoff(operation, options = {}) {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 1000;
  const maxDelay = options.maxDelay || 10000;
  const shouldRetry = options.shouldRetry || (() => true);
  
  return new Promise((resolve, reject) => {
    let attempts = 0;
    
    function attempt() {
      attempts++;
      return operation()
        .then(resolve)
        .catch(error => {
          if (attempts < maxRetries && shouldRetry(error)) {
            debugLog('warn', `Operation failed, retrying (${attempts}/${maxRetries})...`, error.message);
            
            // Calculate delay with exponential backoff and jitter
            const delay = Math.min(
              maxDelay,
              baseDelay * Math.pow(2, attempts - 1) * (0.9 + Math.random() * 0.2)
            );
            
            debugLog('debug', `Retrying in ${Math.round(delay / 100) / 10} seconds...`);
            setTimeout(attempt, delay);
          } else {
            reject(error);
          }
        });
    }
    
    return attempt();
  });
}

// globals...
const UA = navigator.userAgent;
const COOKIES = {}; // we need to hang onto your cookies so deluge can ask your sites for files directly..

/* BEGIN DelugeConnection */
function DelugeConnection() {
  this.state = '';
  this.daemon_hosts = [];
  this.CONNECT_ATTEMPTS = 0;
  this.DAEMON_INFO = {
    status: '',
    port: null,
    ip: null,
    host_id: null,
    version: null
  };
  this.CONNECTION_INFO = [];
  this.SERVER_URL = null;
  this.SERVER_PASS = null;
  this.server_config = {};
  this.plugin_info = {};
  this.currentServerIndex = null;
  this.SESSION_COOKIE = null;
  this.SESSION_ID = null;
  this.CSRF_TOKEN = null;
}

DelugeConnection.prototype._initState = function() {
  return new Promise((resolve, reject) => {
    debugLog('warn', '_initState: Starting initialization');

    // Get connection info
    chrome.storage.local.get(['connections', 'primaryServerIndex'], data => {
      try {
        // Parse connections if it's a string
        if (typeof data.connections === 'string') {
          try {
            data.connections = JSON.parse(data.connections);
          } catch (e) {
            debugLog('error', '_initState: JSON parse error:', e);
            data.connections = [];
          }
        }

        // Ensure connections is an array
        this.CONNECTION_INFO = Array.isArray(data.connections) ? data.connections : [];
        
        // Get primary server index
        const primaryIndex = data.primaryServerIndex || 0;
        
        // If no server index specified, use primary
        if (this.currentServerIndex === null) {
          this.currentServerIndex = primaryIndex;
        }
        
        // Set server URL and password from selected connection
        if (this.CONNECTION_INFO.length > 0 && this.currentServerIndex < this.CONNECTION_INFO.length) {
          this.SERVER_URL = this.CONNECTION_INFO[this.currentServerIndex].url;
          this.SERVER_PASS = this.CONNECTION_INFO[this.currentServerIndex].pass;
        } else {
          this.SERVER_URL = null;
          this.SERVER_PASS = null;
        }

        debugLog('warn', '_initState: Initialization complete', {
          hasConnections: this.CONNECTION_INFO.length > 0,
          hasServerUrl: !!this.SERVER_URL,
          currentServerIndex: this.currentServerIndex
        });

        resolve({
          CONNECTION_INFO: this.CONNECTION_INFO,
          SERVER_URL: this.SERVER_URL,
          SERVER_PASS: this.SERVER_PASS
        });

      } catch (e) {
        debugLog('error', '_initState: Critical error during initialization:', e);
        // Reset to safe defaults on error
        this.CONNECTION_INFO = [];
        this.SERVER_URL = null;
        this.SERVER_PASS = null;
        this.currentServerIndex = null;
        resolve({
          CONNECTION_INFO: [],
          SERVER_URL: null,
          SERVER_PASS: null
        });
      }
    });
  });
};

/* public methods */
DelugeConnection.prototype.connectToServer = function(serverIndex) {
  // If serverIndex is provided, set it as current
  if (serverIndex !== undefined) {
    this.currentServerIndex = serverIndex;
  }
  
  return this._initState().then(() => {
    if (!this.SERVER_URL) {
      notify({
        message: 'Server URL is not set',
        contextMessage: 'Click here to visit the options page!',
        isClickable: true,
        requireInteraction: true
      }, -1, 'needs-settings', 'error');

      return Promise.reject(new Error('Server URL not set'));
    }

    return this._connect();
  });
};

DelugeConnection.prototype.addTorrent = function(url, cookies, plugins, options, serverIndex) {
  debugLog('log', '[addTorrent] Called with:', url, cookies, plugins, options, serverIndex);
  
  // If serverIndex is provided, connect to that server first
  if (serverIndex !== undefined) {
    return this.connectToServer(serverIndex).then(() => {
      return this._addTorrentToCurrentServer(url, cookies, plugins, options);
    });
  }
  
  // Otherwise use current/primary server
  return this._addTorrentToCurrentServer(url, cookies, plugins, options);
};

DelugeConnection.prototype._addTorrentToCurrentServer = function(url, cookies, plugins, options) {
  if (!this.SERVER_URL) {
    const error = new Error('SERVER_URL is not set. Please configure it in the options.');
    debugLog('error', '[addTorrent] Rejected due to missing SERVER_URL:', error);
    
    notify({
      message: 'Please visit the options page to get started!'
    }, -1, this._getNotificationId(), 'error');

    return Promise.reject(error);
  }

  notify({
    message: 'Adding torrent' + (plugins?.Label ? ` with label: ${plugins.Label}` : '') + '...',
    contextMessage: url
  }, 3000, this._getNotificationId(url), 'request');

  debugLog('log', '[addTorrent] Starting connection...');
  
  return this._connect()
    .then(() => {
      debugLog('log', '[addTorrent] Connected, adding torrent...');
      return this._addTorrentUrlToServer(url, options, cookies);
    })
    .then((torrentId) => {
      debugLog('log', '[addTorrent] Torrent added successfully:', torrentId);
      
      // Process plugins (like labels) if provided
      if (plugins && Object.keys(plugins).length > 0) {
        return this._processPluginOptions(url, plugins, torrentId)
          .then(() => {
            notify({
              message: 'Torrent added successfully' + (plugins.Label ? ` with label: ${plugins.Label}` : ''),
              contextMessage: url
            }, 5000, this._getNotificationId(url), 'added');
            return torrentId;
          });
      }
      
      notify({
        message: 'Torrent added successfully',
        contextMessage: url
      }, 5000, this._getNotificationId(url), 'added');
      
      return torrentId;
    })
    .catch(error => {
      debugLog('error', '[addTorrent] Error:', error);
      notify({
        message: 'Error adding torrent',
        contextMessage: error.message || 'Unknown error'
      }, 5000, this._getNotificationId(url), 'error');
      throw error;
    });
};

DelugeConnection.prototype.getTorrentInfo = function(url, cookie_domain) {
  if (!this.SERVER_URL) {
    notify({
      message: 'Please visit the options page to get started!'
    }, -1, this._getNotificationId(), 'error');
    return Promise.reject(new Error('Server URL not set'));
  }

  notify({ message: 'Getting torrent info...' }, 3000, this._getNotificationId(url), null);

  return this._connect()
    .then(() => this._getDomainCookies(url, cookie_domain))
    .then(() => this._getPlugins())
    .then(() => this._downloadTorrent(url, cookie_domain))
    .then(result => this._getTorrentInfo(result));
};

DelugeConnection.prototype.getPluginInfo = function(silent) {
  return this._connect(silent).then(() => this._getPlugins());
};

/* helpers */
DelugeConnection.prototype._serverError = function(payload, silent) {
  if (payload.error) {
    debugLog('error', '_serverError', payload);
    const contextMessage = String(payload.error.message || this.state);
    if (!silent && contextMessage) {
      notify({ 
        message: 'Deluge server error', 
        contextMessage 
      }, -1, this._getNotificationId(), 'error');
    }
    return true;
  }
  return false;
};

DelugeConnection.prototype._getNotificationId = function(torrent_url) {
  return torrent_url ? String(torrent_url.hashCode()) : `server-${Date.now()}`;
};

/* Promise helpers */
DelugeConnection.prototype._connect = function(silent, isValidating = false) {
  this._isValidating = isValidating;
  
  // Always ensure state is initialized first
  return this._initState()
    .then(() => {
      debugLog('log', 'State initialized:', {
        SERVER_URL: this.SERVER_URL,
        CONNECTION_INFO: this.CONNECTION_INFO,
        isValidating: this._isValidating
      });
      
      if (!this.SERVER_URL) {
        return Promise.reject(new Error('Server URL not set after initialization'));
      }
      
      return this._doLogin(silent)
        .then(() => this._checkDaemonConnection())
        .catch(() => this._getDaemons()
          .then(daemons => this._getConnectedDaemon(daemons))
        )
        .then(() => this._getServerConfig())
        .finally(() => {
          // Reset validation flag
          this._isValidating = false;
        });
    });
};

DelugeConnection.prototype._request = function(state, params, silent) {
  this.state = state;
  
  debugLog('log', '[_request] Starting request:', {
    state,
    params,
    SERVER_URL: this.SERVER_URL ? this.SERVER_URL.replace(/:[^\/]+@/, ':*****@') : null,
    CONNECTION_INFO: this.CONNECTION_INFO ? 'Connection info exists' : 'No connection info'
  });
  
  if (!this.SERVER_URL) {
    // Try to re-initialize state if SERVER_URL is not available
    debugLog('log', '[_request] No SERVER_URL, trying to reinitialize state');
    return this._initState().then(() => {
      if (!this.SERVER_URL) {
        debugLog('warn', '[_request] SERVER_URL still not available after _initState');
        return Promise.reject(new Error('Server URL not available'));
      }
      debugLog('log', '[_request] STATE reinitialized, retrying request');
      // Retry the request now that we have initialized
      return this._request(state, params, silent);
    });
  }
  
  let url;
  try {
    // Ensure we have a valid URL by properly joining paths
    const baseUrl = this.SERVER_URL.endsWith('/') ? this.SERVER_URL : this.SERVER_URL + '/';
    url = new URL('json', baseUrl).href;
    debugLog('log', '[_request] Request URL (redacted):', url.replace(/:[^\/]+@/, ':*****@'));
  } catch (e) {
    debugLog('error', '[_request] Error constructing URL:', e);
    return Promise.reject(new Error('Invalid server URL'));
  }

  let headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  
  if (this.SESSION_COOKIE) {
    debugLog('log', '[_request] Adding session cookie to request');
    headers['Cookie'] = this.SESSION_COOKIE;
  } else if (this.SESSION_ID) {
    debugLog('log', '[_request] Adding session ID as cookie to request');
    headers['Cookie'] = `_session_id=${this.SESSION_ID}`;
  }
  
  if (this.CSRF_TOKEN) {
    debugLog('log', '[_request] Adding CSRF token to request');
    headers['X-CSRF-Token'] = this.CSRF_TOKEN;
  }

  // Ensure params is properly structured with required fields
  const requestBody = {
    method: params.method,
    params: params.params || [],
    id: params.id || Date.now()
  };

  const fetchOptions = {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(requestBody),
    credentials: 'include'
  };

  debugLog('log', '[_request] Making fetch request to Deluge server:', { 
    url: url.replace(/:[^\/]+@/, ':*****@'), 
    method: requestBody.method,
    params: requestBody.params,
    id: requestBody.id,
    headers: Object.keys(headers)
  });

  const timeoutDuration = 20000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutDuration);
  fetchOptions.signal = controller.signal;
  
  return fetch(url, fetchOptions)
    .then(response => {
      clearTimeout(timeoutId);
      debugLog('log', `[_request] Response received: ${response.status} ${response.statusText}`);
      
      // Store session cookie if provided
      const setCookie = response.headers.get('Set-Cookie');
      if (setCookie) {
        debugLog('log', '[_request] Received cookies from server');
        this.SESSION_COOKIE = setCookie;
        
        // Extract session ID from Set-Cookie header for Deluge
        const sessionMatch = setCookie.match(/_session_id=([^;]+)/);
        if (sessionMatch) {
          this.SESSION_ID = sessionMatch[1];
          debugLog('log', '[_request] Extracted session ID:', this.SESSION_ID);
        }
      }
      
      // Store CSRF token if provided
      const csrfToken = response.headers.get('X-CSRF-Token');
      if (csrfToken) {
        debugLog('log', '[_request] Received CSRF token from server');
        this.CSRF_TOKEN = csrfToken;
      }
      
      if (!response.ok) {
        debugLog('error', '[_request] HTTP error:', response.status, response.statusText);
        
        if (response.status === 403 && !params.method.includes('torrent')) {
          debugLog('log', '[_request] 403 Forbidden on non-torrent operation - attempting to re-authenticate');
          return this._getSession().then(() => this._request(state, params, silent));
        }
        
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then(payload => {
      debugLog('log', '[_request] Response payload:', JSON.stringify(payload).substring(0, 200) + '...');
      
      if (payload.error) {
        //logger.js:27 [delugesiphon] Error adding torrent: Error: Failure: [Failure instance: Traceback (failure with no frames): <class 'deluge.error.AddTorrentError'>: Torrent already in session (6b35332ed3481bd5cca00f5058e4d63b674be99a).
        // If 'already in session' is in the error, it's not really an error
        if (payload.error.message.includes('already in session')) {
          debugLog('warn', '[_request] Torrent already in session:', payload.error, url, params);
          return payload;
        }

        debugLog('warn', '[_request] Server reported error:', payload.error, url, params);
        throw new Error(payload.error.message || 'Unknown server error');
      }

      if (payload.status === 403) {
        debugLog('log', '[_request] Remote server returned 403 - this is likely a torrent access issue');
        throw new Error('Access denied by remote server');
      }

      // Handle authentication errors
      if (this._isAuthError(payload)) {
        debugLog('log', '[_request] Authentication error detected, attempting to re-authenticate');
        
        // Prevent infinite retry loops
        if (params.isRetry) {
          debugLog('error', '[_request] Authentication retry failed, giving up');
          throw new Error('Authentication failed after retry');
        }
        
        // Clear session state and retry login
        this.SESSION_COOKIE = null;
        this.SESSION_ID = null;
        this.CSRF_TOKEN = null;
        
        return this._doLogin(silent).then(() => {
          // Mark this as a retry to prevent infinite loops
          const retryParams = { ...params, isRetry: true };
          return this._request(state, retryParams, silent);
        });
      }

      // Update state if provided
      if (payload.state) {
        this.state = payload.state;
      }

      debugLog('log', '[_request] Request completed successfully:', state);
      return payload;
    })
    .catch(error => {
      clearTimeout(timeoutId);
      // This is a warning because it happens if an extension is not installed
      console.warn('[_request] Request failed:', error);
      
      if (error.name === 'AbortError') {
        console.error('[_request] Request timed out after', timeoutDuration, 'ms');
        throw new Error(`Request timed out after ${timeoutDuration}ms`);
      }

      throw error;
    });
};

DelugeConnection.prototype._getDomainCookies = function(url, cookie_domain) {
  return new Promise((resolve) => {
    chrome.storage.local.get('send_cookies', data => {
      if (!data.send_cookies) {
        debugLog('log', '_getDomainCookies', 'Sending cookies is disabled');
        resolve({});
        return;
      }

      try {
        const hostname = new URL(url).hostname;
        const cleanCookieDomain = cookie_domain?.replace(/^\./, '');
        if (!cleanCookieDomain || !hostname.endsWith(cleanCookieDomain)) {
          debugLog('log', '_getDomainCookies', cookie_domain, '!=', hostname);
          resolve({});
          return;
        }

        debugLog('log', '_getDomainCookies', 'Fetching cookies for domain:', cookie_domain);

        communicator.sendMessage(
          { action: "getCookies", url: url },
          (response) => {
            if (response.error) {
              debugLog('error', "Error getting cookies:", response.error);
              resolve({});
              return;
            }

            if (response.cookies) {
              const cookies = Object.values(response.cookies).map(value => ({name:Object.keys(response.cookies).find(key => response.cookies[key] === value), value:value, domain: cookie_domain}));

              // Process cookies based on domain specificity
              const cookiesByName = {};
              cookies.forEach(cookie => {
                const name = cookie.name;
                const currentCookie = cookiesByName[name];
                let score = 0;
                const domain = cookie.domain.replace(/^\./, '');

                if (domain === cleanCookieDomain) {
                  score = 4;
                } else if (cookie.domain === '.' + cleanCookieDomain) {
                  score = 3;
                } else if (cleanCookieDomain.endsWith('.' + domain)) {
                  score = 2;
                } else if (cookie.domain.startsWith('.') && cleanCookieDomain.endsWith(domain)) {
                  score = 1;
                }

                if (!currentCookie || score > currentCookie.score) {
                  cookiesByName[name] = {
                    cookie,
                    score
                  };
                }
              });

              const cookieString = Object.values(cookiesByName)
                .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
                .join('; ');

              if (!cookieString) {
                debugLog('log', '_getDomainCookies', 'No valid cookies found');
                resolve({});
                return;
              }

              COOKIES[cookie_domain] = cookieString;
              debugLog('log', '_getDomainCookies', 'Final cookies:', Object.keys(cookiesByName));
              resolve(cookiesByName);

            } else {
              resolve({});
            }
          }
        );

      } catch (e) {
        debugLog('error', '_getDomainCookies error:', e);
        resolve({});
      }
    });
  });
};
DelugeConnection.prototype._getSession = function() {
  debugLog('log', '[_getSession] Checking if session is valid');
  
  return this._request('auth.check_session', {
    method: 'auth.check_session'
  }, true)
    .then(payload => {
      if (payload.result === true) {
        debugLog('log', '[_getSession] Session is valid');
        return true;
      }
      debugLog('error', '[_getSession] Session is invalid:', payload);
      return this._doLogin();
    });
};

DelugeConnection.prototype._doLogin = function(silent) {
  debugLog('log', '[_doLogin] Attempting to login with saved credentials');
  
  if (!this.SERVER_PASS) {
    debugLog('error', '[_doLogin] No password available');
    return Promise.reject(new Error('No password available'));
  }

  // For validation, always start fresh by clearing session
  const loginPromise = this._isValidating 
    ? this._deleteSession().catch(() => {}) // Ignore delete errors
    : this._request('auth.check_session', { method: 'auth.check_session' }, true)
        .then(payload => {
          if (payload.result === true) {
            debugLog('log', '[_doLogin] Valid session already exists');
            return true; // Session is valid, no need to login
          }
          return false; // Need to login
        })
        .catch(() => false); // Assume need to login on error

  return loginPromise
    .then(hasValidSession => {
      if (hasValidSession && !this._isValidating) {
        debugLog('log', '[_doLogin] Using existing valid session');
        return true;
      }
      
      // Clear any existing session state
      this.SESSION_COOKIE = null;
      this.SESSION_ID = null;
      this.CSRF_TOKEN = null;
      
      // Now try to login with the credentials
      debugLog('log', '[_doLogin] Performing fresh login');
      return this._request('auth.login', {
        method: 'auth.login',
        params: [this.SERVER_PASS],
        id: '-17000.' + Date.now()
      }, silent)
      .then(payload => {
        debugLog('log', '[_doLogin] Login response:', payload?.result ? 'Success' : 'Failed');
        
        if (payload.result === true) {
          debugLog('log', '[_doLogin] Login successful');
          return payload.result;
        }
        
        if (!silent) {
          notify({
            message: 'Login failed',
            contextMessage: 'Check your Deluge password in the extension options',
            isClickable: true,
            requireInteraction: true
          }, -1, 'needs-settings', 'error');
        }
        
        throw new Error('Login failed - check your Deluge password');
      });
    });
};

DelugeConnection.prototype._checkDaemonConnection = function() {
  debugLog('log', 'Checking daemon connection');
  
  return this._request('web.connected', {
    method: 'web.connected'
  })
  .then(response => {
    if (response.result === true) {
      debugLog('log', 'Daemon is connected');
      return true;
    }
    debugLog('log', 'Daemon is not connected, will try to connect to one');
    return false;
  });
};

DelugeConnection.prototype._getDaemons = function() {
  return this._request('web.get_hosts', {
    method: 'web.get_hosts'
  }).then(payload => {
    debugLog('log', '_getDaemons__callback', payload);
    this.daemon_hosts = payload.result || [];
    return this.daemon_hosts;
  }).catch(error => {
    debugLog('error', '_getDaemons failed', error);
    throw error;
  });
};

DelugeConnection.prototype._getHostStatus = function(hostId) {
  debugLog('log', '_getHostStatus', hostId);

  return this._request('web.get_host_status', {
    method: 'web.get_host_status',
    params: [hostId]
  }).then(payload => {
    if (!payload.result) {
      debugLog('error', '_getHostStatus__callback', hostId, 'failed', payload);
      throw new Error('Failed to get host status');
    }

    const [status, info] = payload.result;
    const daemon_info = {
      status: status,
      info: info,
      hostId: hostId,
      host: this.daemon_hosts.find(h => h[0] === hostId)
    };

    debugLog('log', '_getHostStatus__callback', daemon_info);
    return daemon_info;
  });
};

DelugeConnection.prototype._getConnectedDaemon = function(daemon_hosts) {
  if (this.DAEMON_INFO?.host_id) {
    return Promise.resolve(this.DAEMON_INFO);
  }

  if (!daemon_hosts?.length) {
    debugLog('error', 'No daemons available:', daemon_hosts);
    return Promise.reject(new Error('No daemons available'));
  }

  // Process each daemon host sequentially until we find one that works
  return daemon_hosts.reduce((promise, daemon_host) => {
    return promise.catch(() => {
      return this._getHostStatus(daemon_host[0])
        .then(daemon_info => {
          switch (daemon_info.status) {
            case 'Connected':
              debugLog('log', '_getConnectedDaemon__callback', 'Connected', daemon_info);
              return daemon_info;
            
            case 'Online':
              debugLog('log', '_getConnectedDaemon__callback', 'Connecting');
              return this._connectDaemon(daemon_info);
            
            case 'Offline':
              debugLog('log', '_getConnectedDaemon__callback', 'Starting');
              return this._startDaemon(daemon_info)
                .then(info => this._connectDaemon(info));
            
            default:
              debugLog('warn', '_getConnectedDaemon__callback', 'UNKNOWN STATUS: ' + daemon_info.status);
              notify({
                message: `Error: failed to connect to deluge server: '${daemon_info.host}:${daemon_info.port}'`
              }, 3000, this._getNotificationId(), 'error');
              return Promise.reject(new Error(`Unknown daemon status: ${daemon_info.status}`));
          }
        })
        .then(daemon_info => {
          this.DAEMON_INFO = daemon_info;
          this.CONNECT_ATTEMPTS = 1;
          return daemon_info;
        });
    });
  }, Promise.reject(new Error('Starting daemon connection attempts')));
};

DelugeConnection.prototype._startDaemon = function(daemon_info) {
  debugLog('log', '_startDaemon', daemon_info);

  return this._request('web.start_daemon', {
    method: 'web.start_daemon',
    params: [daemon_info.hostId]
  }).then(payload => {
    debugLog('log', '_startDaemon__callback', payload);
    return this._connectDaemon(daemon_info);
  }).catch(error => {
    debugLog('error', this.state, 'ERROR', error);
    throw error;
  });
};

DelugeConnection.prototype._connectDaemon = function(daemon_info) {
  debugLog('log', '_connectDaemon', daemon_info);

  return this._request('web.connect', {
    method: 'web.connect',
    params: [daemon_info.hostId]
  }).then(payload => {
    debugLog('log', '_connectDaemon__callback', payload);
    return true;
  }).catch(error => {
    debugLog('error', '_connectDaemon__callback', this.state, 'ERROR', error);
    throw error;
  });
};

DelugeConnection.prototype._getServerConfig = function() {
  debugLog('log', '_getServerConfig');

  return this._request('core.get_config', {
    method: 'core.get_config'
  }).then(payload => {
    if (!payload.result) {
      throw new Error('No config result');
    }

    debugLog('log', '_getServerConfig__callback', payload.result);
    this.server_config = payload.result;
    return this.server_config;
  }).catch(error => {
    if (error.message === 'Access denied by remote server') {
      debugLog('error', '_getServerConfig__error', 'Remote connections disabled');
      throw new Error('Remote connections are not enabled on your Deluge server');
    }
    debugLog('error', '_getServerConfig__error', error);
    throw error;
  });
};

DelugeConnection.prototype._getPlugins = function() {
  debugLog('log', 'Requesting plugins from server...');

  return this._request('web.get_plugins', {
    method: 'web.get_plugins'
  }).then(payload => {
    debugLog('log', 'Raw plugin response:', payload);
    
    if (!payload.result) {
      debugLog('error', '_getPlugins failed - no result:', payload);
      throw new Error('No plugin data received');
    }
    
    let plugins;
    if (Array.isArray(payload.result)) {
      debugLog('log', 'Plugin result is array:', payload.result);
      plugins = payload.result;
    } else if (typeof payload.result === 'object') {
      debugLog('log', 'Plugin result is object:', payload.result);
      plugins = Object.keys(payload.result).filter(key => payload.result[key]);
    } else {
      debugLog('warn', 'Unexpected plugin result format:', payload.result);
      plugins = [];
    }
    
    debugLog('log', 'Processed plugin list:', plugins);
    
    // If Label plugin is found, get available labels
    if (plugins.includes('Label')) {
      debugLog('log', 'Label plugin found, requesting labels...');

      return this._request('label.get_labels', {
        method: 'label.get_labels'
      })
        .then(labelPayload => {
          debugLog('log', 'Label list response:', labelPayload);

          if (!labelPayload.result) {
            debugLog('warn', 'Error getting labels, trying alternative method:', labelPayload.error);

            // Try alternative method for older versions
            return this._request('label.get_config', {
              method: 'label.get_config'
            });
          }
          return labelPayload;
        })
        .then(labelPayload => {
          debugLog('log', 'Trying alternative label method...');

          if (labelPayload.result) {
            const altPayload = labelPayload.result.labels || [];
            debugLog('log', 'Alternative label response:', altPayload);
            return {
              plugins,
              Label: altPayload
            };
          }

          debugLog('warn', 'No valid labels found in alternative response');
          return { plugins, Label: [] };
        })
        .catch(err => {
          debugLog('error', 'All label retrieval methods failed:', err);
          return { plugins, Label: [] };
        });
    }

    // If label plugin (lowercase) is found, get available labels
    if (plugins.includes('label')) {
      debugLog('log', 'lowercase label plugin found, requesting labels...');

      return this._request('label.get_labels', {
        method: 'label.get_labels'
      })
        .then(labelPayload => {
          debugLog('log', 'lowercase label list response:', labelPayload);
          return {
            plugins,
            Label: labelPayload.result || []
          };
        })
        .catch(err => {
          debugLog('error', 'lowercase label retrieval failed:', err);
          return { plugins, Label: [] };
        });
    }

    // No label plugin found
    return { plugins };
  })
  .then(pluginInfo => {
    debugLog('log', 'Final plugin info structure:', pluginInfo);
    this.plugin_info = pluginInfo;
    return pluginInfo;
  });
};

// Add a new method to get labels with fallbacks
DelugeConnection.prototype._getLabelsWithFallbacks = function() {
  debugLog('log', 'Getting labels with fallbacks...');
  
  // Try the standard method first
  return this._request('label.get_labels', {
    method: 'label.get_labels'
  })
  .then(labelPayload => {
    debugLog('log', 'Standard label response:', labelPayload);
    if (labelPayload && Array.isArray(labelPayload.result)) {
      return labelPayload.result;
    }
    if (labelPayload && labelPayload.error) {
      debugLog('warn', 'Standard label method failed, trying fallback 1');
      throw new Error('Standard method failed: ' + labelPayload.error);
    }
    return [];
  })
  .catch(err => {
    // Fallback 1: Try with alternative method for older Deluge versions
    debugLog('log', 'Trying label fallback method 1...');
    return this._request('label.get_config', {
      method: 'label.get_config'
    })
    .then(altPayload => {
      debugLog('log', 'Fallback 1 label response:', altPayload);
      if (altPayload.result && Array.isArray(altPayload.result.labels)) {
        return altPayload.result.labels;
      }
      debugLog('warn', 'Fallback 1 failed, trying fallback 2');
      throw new Error('Fallback 1 failed');
    });
  })
  .catch(err => {
    // Fallback 2: Try with the LabelPlus plugin
    debugLog('log', 'Trying label fallback method 2 (LabelPlus)...');
    return this._request('labelplus.get_labels', {
      method: 'labelplus.get_labels'
    })
    .then(labelPlusPayload => {
      debugLog('log', 'Fallback 2 (LabelPlus) response:', labelPlusPayload);
      if (labelPlusPayload.result) {
        // LabelPlus returns an object with label IDs as keys
        return Object.values(labelPlusPayload.result)
          .filter(label => typeof label === 'object' && label.name)
          .map(label => label.name);
      }
      debugLog('warn', 'All label fallbacks failed');
      return [];
    });
  })
  .catch(err => {
    debugLog('error', 'All label retrieval methods failed:', err);
    return [];
  });
};

// Add the missing method for adding torrent URLs
DelugeConnection.prototype._addTorrentUrlToServer = function(url, options, cookies) {
    debugLog('log', '[_addTorrentUrlToServer] Starting with:', url, options, cookies);
    
    // Build parameter object with correct structure for Deluge
    let params = {};
    
    // Add options if provided
    if (options) {
        // Common options that might be provided
        if (options.add_paused !== undefined) {
            params.add_paused = Boolean(options.add_paused);
        }
        
        if (options.download_location) {
            params.download_location = options.download_location;
        }
        
        if (options.move_completed) {
            params.move_completed = Boolean(options.move_completed);
        }
        
        if (options.move_completed_path) {
            params.move_completed_path = options.move_completed_path;
        }
        
        // Add any additional options that were passed
        Object.entries(options).forEach(([key, value]) => {
            if (!params.hasOwnProperty(key)) {
                params[key] = value;
            }
        });
    }

    // Ensure URL is properly encoded if it's not a magnet link
    const encodedUrl = url.startsWith('magnet:') ? url : encodeURI(url);
    
    // For magnet links, use the dedicated magnet API method
    if (url.startsWith('magnet:')) {
        return this._addTorrentViaMagnet(encodedUrl, params);
    }

    // For non-magnet URLs, check if we should send cookies
    return new Promise((resolve, reject) => {
        chrome.storage.local.get('send_cookies', data => {
            // If send_cookies is enabled, add cookies to the request
            if (data.send_cookies !== false) {
                const cookieString = Object.entries(cookies || {})
                    .map(([name, value]) => `${name}=${value}`)
                    .join('; ');

                if (cookieString) {
                    debugLog('log', '[_addTorrentUrlToServer] Adding cookies to request', cookieString);
                    params.cookie = cookieString;
                } else {
                    debugLog('log', '[_addTorrentUrlToServer] No cookies to add');
                }
            } else {
                debugLog('log', '[_addTorrentUrlToServer] Cookie sending is disabled');
            }
            
            // Always proceed with the request, with or without cookies
            this._addTorrentViaUrl(encodedUrl, params)
                .then(resolve)
                .catch(reject);
        });
    });
};

DelugeConnection.prototype._addTorrentViaMagnet = function(magnetUri, params) {
    debugLog('log', '[_addTorrentViaMagnet] Adding magnet link:', magnetUri);
    
    return this._request('core.add_torrent_magnet', {
        method: 'core.add_torrent_magnet',
        params: [magnetUri, params],  // Magnet API takes URI and options
        id: '-17002.' + Date.now()
    })
    .then(payload => {
        debugLog('log', '[_addTorrentViaMagnet] Add magnet response:', payload);
        
        if (!payload) {
            throw new Error('Empty response from server');
        }
        
        if (payload.error) {
            // Check if the server doesn't support the magnet API (older Deluge versions)
            if (payload.error.message && 
                (payload.error.message.includes('Unknown method') || 
                 payload.error.message.includes('add_torrent_magnet'))) {
                
                debugLog('log', '[_addTorrentViaMagnet] Magnet API not supported, falling back to URL method');
                
                // Fallback to the URL method for older Deluge versions
                return this._addTorrentViaUrl(magnetUri, params);
            }
            
            // Handle other specific magnet-related errors
            if (payload.error.message && payload.error.message.includes('Unsupported scheme')) {
                debugLog('error', '[_addTorrentViaMagnet] Unsupported magnet scheme');
                throw new Error('Invalid magnet link format - unsupported scheme');
            }
            
            throw new Error(payload.error.message || 'Failed to add magnet link');
        }
        
        if (payload.result === false) {
            throw new Error('Server refused magnet link');
        }
        
        // Success - return the torrent ID
        return payload.result;
    })
    .catch(error => {
        // If the magnet API fails completely, try the URL method as fallback
        if (error.message && error.message.includes('Unknown method')) {
            debugLog('log', '[_addTorrentViaMagnet] Falling back to URL method due to API error');
            return this._addTorrentViaUrl(magnetUri, params);
        }
        throw error;
    });
};

DelugeConnection.prototype._addTorrentViaUrl = function(url, params) {
    // Extract cookie from params if it exists and move it to headers
    const headers = {};
    if (params.cookie) {
        headers.Cookie = params.cookie;
        delete params.cookie;  // Remove from params since it's now in headers
    }

    return this._request('core.add_torrent_url', {
        method: 'core.add_torrent_url',
        params: [url, params, headers],  // Pass headers as third argument
        id: '-17003.' + Date.now()
    })
    .then(payload => {
        debugLog('log', '[_addTorrentViaUrl] Add torrent response:', payload);
        
        if (!payload) {
            throw new Error('Empty response from server');
        }
        
        if (payload.error) {
            // Special handling for Deluge 1.x API difference
            if (payload.error.message && 
                (payload.error.message.includes('takes exactly 3 arguments') || 
                 payload.error.message.includes('takes exactly three arguments'))) {
                
                debugLog('log', '[_addTorrentViaUrl] Detected Deluge 1.x API, retrying with adjusted parameters');
                
                // Deluge 1.x has a different API signature
                return this._request('core.add_torrent_url', {
                    method: 'core.add_torrent_url',
                    params: [url, params, {}],  // Deluge 1.x doesn't support headers
                    id: '-17003.v1.' + Date.now()
                });
            }
            
            // If we get a 403, it's likely the URL is inaccessible to Deluge
            if (payload.error.message && payload.error.message.includes('403 Forbidden')) {
                const error = new Error('Unable to access torrent - the site may require authentication or cookies');
                error.code = 403;
                throw error;
            }
            
            throw new Error(payload.error.message || 'Failed to add torrent');
        }
        
        if (payload.result === false) {
            throw new Error('Server refused torrent');
        }
        
        // Success - return the torrent ID
        return payload.result;
    });
};

// Implement the method to handle plugin options like labels
DelugeConnection.prototype._processPluginOptions = function(url, plugins, torrentId) {
    if (!plugins || !torrentId) {
        return Promise.resolve();
    }
    
    const promises = [];
    
    // Handle Label plugin
    if (plugins.Label) {
        debugLog('log', '[_processPluginOptions] Setting label:', plugins.Label);
        promises.push(
            this._request('label.set_torrent', {
                method: 'label.set_torrent',
                params: [torrentId, plugins.Label],
                id: '-17004.' + Date.now()
            })
            .catch(error => {
                debugLog('error', '[_processPluginOptions] Error setting label:', error);
                // Don't fail the whole operation if label setting fails
                return Promise.resolve();
            })
        );
    }
    
    // Handle other plugin options here if needed
    
    return Promise.all(promises);
};

// Add the missing _isAuthError method
DelugeConnection.prototype._isAuthError = function(payload) {
  if (!payload.error) return false;
  
  const errorMessage = payload.error.message || '';
  return errorMessage.includes('Not authenticated') || 
         errorMessage.includes('Invalid session') ||
         errorMessage.includes('No session exists') ||
         errorMessage.includes('Authentication required') ||
         errorMessage.includes('Session expired');
};

/* notification handling */
function notify(opts, decay, id, icon_type) {
  // Convert Chrome notification parameters to toast parameters
  const message = opts.message || '';
  const contextMessage = opts.contextMessage || '';
  const fullMessage = contextMessage ? `${message}\n${contextMessage}` : message;
  const type = icon_type || 'info';
  const duration = decay || 3000;

  // Send message to content script to show toast
  communicator.sendMessage({
    method: 'show-toast',
    message: fullMessage,
    type: type,
    duration: duration
  });
}

/* BEGIN Setup */
const notificationTimeouts = {};
const delugeConnection = new DelugeConnection();

function createContextMenu(add, with_options) {
  debugLog('log', '[createContextMenu] Creating context menus for all links');
  
  chrome.contextMenus.removeAll(() => {
      if (with_options) {
        chrome.contextMenus.create({
          id: 'add-with-options',
          title: 'Add with Options',
          contexts: ['link']
          // No targetUrlPatterns - appears on ALL links, filtered in handler
        }, () => {
          if (chrome.runtime.lastError) {
            debugLog('error', '[createContextMenu] Error creating add-with-options menu:', chrome.runtime.lastError);
          } else {
            debugLog('log', '[createContextMenu] Successfully created add-with-options menu');
          }
        });
      }

      if (add) {
        chrome.contextMenus.create({
          id: 'add',
          title: with_options ? 'Add' : 'Add to Deluge',
          contexts: ['link']
          // No targetUrlPatterns - appears on ALL links, filtered in handler
        }, () => {
          if (chrome.runtime.lastError) {
            debugLog('error', '[createContextMenu] Error creating add menu:', chrome.runtime.lastError);
          } else {
            debugLog('log', '[createContextMenu] Successfully created add menu');
          }
        });
      }
    });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  debugLog('log', '[contextMenus.onClicked] Context menu clicked:', {
    menuItemId: info.menuItemId,
    linkUrl: info.linkUrl,
    pageUrl: info.pageUrl
  });
  
  const torrentUrl = info.linkUrl;
  
  if (!torrentUrl) {
    debugLog('warn', '[contextMenus.onClicked] No URL found');
    return;
  }
  
  // Check if this is actually a torrent/magnet link
  const isTorrentLink = torrentUrl.startsWith('magnet:') ||
    torrentUrl.includes('.torrent') ||
    torrentUrl.includes('download.php') ||
    torrentUrl.includes('dl.php') ||
    torrentUrl.includes('get.php') ||
    torrentUrl.includes('action=download');

  if (!isTorrentLink) {
    debugLog('log', '[contextMenus.onClicked] Not a torrent/magnet link, ignoring:', torrentUrl);
    return;
  }

  const s1 = torrentUrl.indexOf('//') + 2;
  let domain = torrentUrl.substring(s1);
  
  const s2 = domain.indexOf('/');
  const cleanDomain = s2 >= 0 ? domain.substring(0, s2) : domain;

  if (info.menuItemId === 'add-with-options') {
    // Send message to content script in the active tab
    chrome.tabs.sendMessage(tab.id, {
      method: 'add_dialog',
      url: torrentUrl,
      domain: cleanDomain
    }, (response) => {
      if (chrome.runtime.lastError) {
        debugLog('error', 'Error sending message to content script:', chrome.runtime.lastError);
        // Fallback: try to add directly if content script fails
        communicator.sendMessage({
          method: 'getCookies',
          url: torrentUrl
        }, (response) => {
          const cookies = response?.cookies || {};
          delugeConnection.addTorrent(torrentUrl, cookies);
        });
      }
    });
  } else if (info.menuItemId === 'add') {
    // Get cookies and add torrent directly
    communicator.sendMessage({
      method: 'getCookies',
      url: torrentUrl
    }, (response) => {
      const cookies = response?.cookies || {};
      delugeConnection.addTorrent(torrentUrl, cookies);
    });
  }
});

// Initialize context menu based on settings
chrome.storage.local.get(['enable_context_menu', 'enable_context_menu_with_options'], data => {
  debugLog('log', '[contextMenu init] Context menu settings:', data);
  if (data.enable_context_menu) {
    debugLog('log', '[contextMenu init] Context menu enabled, creating menus');
    createContextMenu(true, data.enable_context_menu_with_options);
  } else {
    debugLog('log', '[contextMenu init] Context menu disabled');
  }
});

// Message handling
communicator
  .observeMessage((request, sendResponse) => {
    debugLog('log', 'Message received by background script:', request);
    
    if (!request || !request.method) {
      debugLog('error', 'Invalid message received', request);
      sendResponse({ error: 'Invalid message format' });
      return;
    }
    
    const [prefix, ...parts] = request.method.split('-');
    const method = parts.join('-');

    debugLog('log', 'Processing message:', prefix, method, request);
    if (request.method === "settings-changed") {
      debugLog('log', '~~~ MESSAGE ~~~ Settings Changed');
      delugeConnection._initState().then(() => {
        chrome.storage.local.get(['enable_context_menu', 'enable_context_menu_with_options'], data => {
          if (data.enable_context_menu) {
            createContextMenu(true, data.enable_context_menu_with_options);
          }
        });
      });
    } else if (request.method === "get-server-info") {
      debugLog('log', '~~~ MESSAGE ~~~ Get Server Info');
      delugeConnection.getAvailableServers().then(serverInfo => {
        debugLog('log', 'Server info retrieved:', serverInfo);
        sendResponse(serverInfo);
      });
      return true;
    } else if (request.method === "notify") {
      debugLog('log', '~~~ MESSAGE ~~~ Send Notification');
      notify(request.opts, request.decay, 'content', request.type);
    } else if (prefix === "storage") {
      const [action, ...keyParts] = parts;
      const key = keyParts.join('-');

      if (action === 'set') {
        chrome.storage.local.set({ [key]: request.value });
      } else {
        chrome.storage.local.get(key, data => {
          try {
            sendResponse({ value: JSON.parse(data[key]) });
          } catch (e) {
            sendResponse({ value: data[key] });
          }
        });
      }
    } else if (prefix === "addlink") {
      const addtype = parts[0];
      const { url, domain, plugins, options, cookies } = request;

      debugLog('log', '==== ADDLINK REQUEST ====', addtype, url, domain, plugins, options, cookies);

      if (!url) {
        debugLog('error', 'Empty URL in addlink request');
        notify({ message: 'Error: Empty URL' }, 3000, delugeConnection._getNotificationId(), 'error');
        sendResponse({ error: 'Empty URL' });
        return;
      }

      const url_match = url.match(/^(magnet:)|((file|(ht|f)tp(s?)):\/\/).+/);
      if (!url_match) {
        debugLog('error', 'Invalid URL format:', url);
        notify({ message: `Error: Invalid URL '${url}'` }, 3000, delugeConnection._getNotificationId(), 'error');
        sendResponse({ error: 'Invalid URL format' });
        return;
      }

      if (addtype === 'todeluge') {
        debugLog('log', '<<<< PROCESSING ADDLINK-TODELUGE >>>>', url, domain, plugins, options, cookies);
        try {
          // Get cookies before adding torrent
            delugeConnection.addTorrent(url, cookies, plugins, options)
              .then((result) => {
                debugLog('log', 'Torrent add successful, sending response:', result);
                sendResponse({ success: true, result });
              })
              .catch((error) => {
                debugLog('error', 'Error adding torrent:', error);
                sendResponse({ error: error.message || 'Unknown error adding torrent' });
              });
          return true;
        } catch (e) {
          debugLog('error', 'Exception in addTorrent:', e);
          sendResponse({ error: e.message || 'Exception in addTorrent' });
        }
      } else if (addtype === 'todeluge:withoptions') {
        debugLog('log', 'Processing addlink-todeluge:withoptions request');
        // First get plugin info and server config
        delugeConnection._connect(true)
          .then(() => {
            debugLog('log', 'Connected to server, getting plugin info and config');
            return Promise.all([
              delugeConnection._getPlugins(),
              delugeConnection._getServerConfig()
            ]);
          })
          .then(([plugins, [config]]) => {
            debugLog('log', 'Got plugin info and config:', { plugins, config });
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: config || {},
              plugins: plugins || {}
            });
          })
          .catch(error => {
            debugLog('error', 'Error getting plugin info or config:', error);
            // Send response with empty data so modal can still show
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: {},
              plugins: {}
            });
          });
      } else {
        notify({ message: `Unknown server type: '${addtype}'` }, 3000, delugeConnection._getNotificationId(), 'error');
      }
    } else if (request.method === 'connect') {
      delugeConnection.connectToServer();
    } else if (prefix === "plugins") {
      const actiontype = parts[0];

      switch(actiontype) {
        case 'getinfo':
          debugLog('log', 'Handling plugins-getinfo request');
          
          // Create a temporary connection if URL and password are provided
          let connection = delugeConnection;
          if (request.url && request.password) {
            debugLog('log', 'Creating temporary connection for validation');
            connection = new DelugeConnection();
            connection.SERVER_URL = request.url;
            connection.SERVER_PASS = request.password;
          }

          // If using existing connection and serverIndex is provided, connect to that server first
          const promise = request.serverIndex !== undefined && !request.url
            ? delugeConnection.connectToServer(request.serverIndex).then(() => delugeConnection._connect(true))
            : connection._connect(true, true); // Pass true for isValidating

          promise
            .then(() => {
              debugLog('log', 'Connected to server, getting data...');
              return Promise.all([
                connection._request('web.get_plugins', {
                  method: 'web.get_plugins'
                }),
                connection._request('core.get_config', {
                  method: 'core.get_config'
                }),
                // Always try to get labels regardless of plugin list
                connection._getLabelsWithFallbacks(),
                // Try to get AutoAdd plugin paths if available
                connection._request('autoadd.get_watchdirs', {
                  method: 'autoadd.get_watchdirs'
                }).catch(err => {
                  debugLog('log', 'AutoAdd plugin not available:', err);
                  return { result: {} };
                })
              ]);
            })
            .then(([pluginsPayload, configPayload, labels, autoaddPayload]) => {
              debugLog('log', 'Raw responses:', {
                plugins: pluginsPayload,
                config: configPayload,
                labels: labels,
                autoadd: autoaddPayload
              });
              
              // Process the plugins list
              let enabledPlugins = [];
              if (Array.isArray(pluginsPayload.result)) {
                enabledPlugins = pluginsPayload.result;
              } else if (typeof pluginsPayload.result === 'object') {
                enabledPlugins = Object.entries(pluginsPayload.result)
                  .filter(([_, enabled]) => enabled)
                  .map(([name]) => name);
              }
              debugLog('log', 'Enabled plugins:', enabledPlugins);
              
              // Process AutoAdd plugin data
              let watchDirs = [];
              if (autoaddPayload && autoaddPayload.result && typeof autoaddPayload.result === 'object') {
                watchDirs = Object.keys(autoaddPayload.result).map(path => ({
                  path,
                  enabled: autoaddPayload.result[path].enabled
                })).filter(dir => dir.enabled).map(dir => dir.path);
              }
              
              // Create final response structure
              const response = {
                value: {
                  plugins: {
                    Label: labels || [],
                    AutoAdd: watchDirs,
                    EnabledPlugins: enabledPlugins
                  },
                  config: configPayload?.result || {}
                }
              };
              
              debugLog('log', 'Sending final plugin info response:', response);
              sendResponse(response);
            })
            .catch(error => {
              debugLog('error', 'Failed to get plugin info:', error);
              sendResponse({
                error: error.message,
                value: {
                  plugins: { Label: [], AutoAdd: [], EnabledPlugins: [] },
                  config: {}
                }
              });
            });
          break;
        default:
          debugLog('error', 'Unknown plugin action:', actiontype);
          sendResponse({ error: `unknown plugin action: '${actiontype}'` });
      }
    } else if (request.method === "storage-get-default_label") {
      // Get default label from storage
      chrome.storage.local.get(['default_label'], function(result) {
        sendResponse({ value: result.default_label || '' });
      });
      
      return true;
    } else if (request.method === "torrent-list") {
      // Get list of active torrents for the popup
      delugeConnection._connect(true)
        .then(() => {
          debugLog('log', 'Connected, getting torrent list');
          return delugeConnection._request('web.update_ui', {
            method: 'web.update_ui',
            params: [
              ['name', 'progress', 'state', 'download_payload_rate', 'upload_payload_rate', 'eta'],
              {}
            ],
            id: '-17100'
          });
        })
        .then(response => {
          debugLog('log', 'Torrent list response:', response);
          if (response && response.result && response.result.torrents) {
            // Format the torrent data for the popup
            const torrents = Object.entries(response.result.torrents).map(([id, data]) => ({
              id,
              name: data.name || 'Unknown',
              progress: data.progress / 100 || 0,
              state: data.state || 'Unknown',
              download_speed: data.download_payload_rate || 0,
              upload_speed: data.upload_payload_rate || 0,
              eta: data.eta || -1
            }));
            
            sendResponse({ value: torrents });
          } else {
            sendResponse({ value: [] });
          }
        })
        .catch(error => {
          debugLog('error', 'Error getting torrent list:', error);
          sendResponse({ error: error.message, value: [] });
        });
      
      return true;
    } else if (prefix === "add") {
      const addtype = parts[0];
      const { url, domain, plugins, options } = request;

      if (!url) {
        notify({ message: 'Error: Empty URL' }, 3000, delugeConnection._getNotificationId(), 'error');
        return;
      }

      const url_match = url.match(/^(magnet:)|((file|(ht|f)tp(s?)):\/\/).+/);
      if (!url_match) {
        notify({ message: `Error: Invalid URL '${url}'` }, 3000, delugeConnection._getNotificationId(), 'error');
        return;
      }

      if (addtype === 'todeluge') {
        debugLog('log', '<<<< ADDLINK >>>>', url, domain, plugins, options);
        // Get cookies before adding torrent
        communicator.sendMessage({
          method: 'getCookies',
          url: url
        }, (response) => {
          const cookies = response?.cookies || {};
          delugeConnection.addTorrent(url, cookies, plugins, options);
        });
      } else if (addtype === 'todeluge:withoptions') {
        debugLog('log', 'Processing addlink-todeluge:withoptions request');
        // First get plugin info and server config
        delugeConnection._connect(true)
          .then(() => {
            debugLog('log', 'Connected to server, getting plugin info and config');
            return Promise.all([
              delugeConnection._getPlugins(),
              delugeConnection._getServerConfig()
            ]);
          })
          .then(([plugins, [config]]) => {
            debugLog('log', 'Got plugin info and config:', { plugins, config });
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: config || {},
              plugins: plugins || {}
            });
          })
          .catch(error => {
            debugLog('error', 'Error getting plugin info or config:', error);
            // Send response with empty data so modal can still show
            sendResponse({
              method: 'add_dialog',
              url,
              domain,
              config: {},
              plugins: {}
            });
          });
      } else {
        notify({ message: `Unknown server type: '${addtype}'` }, 3000, delugeConnection._getNotificationId(), 'error');
      }
    } else {
      debugLog('error',  `unknown method: '${request.method}'`, request);
      sendResponse({ error: `unknown method: '${request.method}'` });
    }
    
    // Return true to indicate we'll send a response asynchronously
    return true;
  })
  .init();

// Handle notification clicks
chrome.notifications.onClicked.addListener(notId => {
  if (notId === 'needs-settings') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
    chrome.notifications.clear(notId);
  }
});

// Handle extension installation/updates
chrome.runtime.onInstalled.addListener(install => {
  const manifest = chrome.runtime.getManifest();
  debugLog('log', '[INSTALLED: ' + manifest.version + ']', install);
});

// Add method to get available servers
DelugeConnection.prototype.getAvailableServers = function() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['connections', 'primaryServerIndex'], data => {
      const connections = Array.isArray(data.connections) ? data.connections : [];
      const primaryIndex = data.primaryServerIndex || 0;
      
      resolve({
        servers: connections.map((conn, index) => ({
          url: conn.url,
          isPrimary: index === primaryIndex,
          index: index
        })),
        primaryIndex: primaryIndex
      });
    });
  });
};

DelugeConnection.prototype._deleteSession = function() {
  return this._request('auth.delete_session', {
    method: 'auth.delete_session'
  }, true).catch(error => {
    debugLog('warn', 'Error deleting session:', error);
    // Don't throw, as we want to continue even if delete fails
  });
};
