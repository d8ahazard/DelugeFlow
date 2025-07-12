/* global stopEvent, communicator, chrome, registerEventListener */
( function ( window, document ) {
  debugLog('debug', 'Content handler script loaded');
  let cookies = {};
  
  // Queue for messages that need to be sent when connection is restored
  let messageQueue = [];
  let isReconnecting = false;

  // Safe message sender that queues messages when disconnected
  function safeSendMessage(message, callback) {
    debugLog('debug', 'Attempting to send message:', message);
    
    if (!communicator || !communicator._Connected) {
      debugLog('warn', 'Connection not available, queueing message:', message);
      messageQueue.push({ message, callback });
      if (!isReconnecting) {
        reconnect();
      }
      return;
    }

    try {
      debugLog('debug', 'Sending message via communicator:', message);
      communicator.sendMessage(message, function(response) {
        debugLog('debug', 'Received response from background:', response);
        if (callback) {
          callback(response);
        }
      }, function(error) {
        debugLog('error', 'Message send failed:', error);
        messageQueue.push({ message, callback });
        if (!isReconnecting) {
          reconnect();
        }
      });
    } catch (e) {
      debugLog('error', 'Error sending message:', e);
      messageQueue.push({ message, callback });
      if (!isReconnecting) {
        reconnect();
      }
    }
  }

  /* env check */
  if (!document || !document.addEventListener || !document.body || !document.body.addEventListener) {
    debugLog('error', 'Environment check failed:', {
      document: !!document,
      addEventListener: !!document?.addEventListener,
      body: !!document?.body,
      bodyAddEventListener: !!document?.body?.addEventListener
    });
    return;
  }

  debugLog('debug', 'Environment check passed');

  var CONTROL_KEY_DEPRESSED = false,
    SITE_META = {
      DOMAIN: window.location.host,
      TORRENT_REGEX:
      '^magnet:' 
      + '|(\\/|^)(torrent|torrents)(?=.*action=download)'
      + '|(\\/|^)(index|download)(\\.php)?(\\&|\\?|\\/)(?=.*torrent)'
      // + '|\\/(torrent|download)(\\.php)?(\\/|\\?).+'
      + '|\\.torrent', // eslint-disable-line no-useless-escape
      TORRENT_URL_ATTRIBUTE: 'href',
      INSTALLED: false
    };

  debugLog('debug', 'SITE_META initialized:', SITE_META);

  const log = function (...args) {
    debugLog('debug', `[${SITE_META.DOMAIN}]`, ...args);
  };

  const warn = function (...args) {
    debugLog('warn', `[${SITE_META.DOMAIN}]`, ...args);
  };

  // Verify communicator is available
  if (!communicator) {
    debugLog('error', 'Communicator not found in global scope');
    return;
  }

  // Initialize cookies
  safeSendMessage( {
    action: "getCookies",
    url: window.location.href
  }, function ( response ) {
    if (response?.cookies) {
      debugLog('debug', 'Cookies received:', response.cookies);
      cookies = response.cookies;
    } else if (response?.error) {
      debugLog('error', 'Error getting cookies:', response.error);
    }
  } );

  debugLog('debug', 'Communicator found:', {
    isObject: typeof communicator === 'object',
    hasInit: typeof communicator.init === 'function',
    hasObserveConnect: typeof communicator.observeConnect === 'function'
  });

  // Process queued messages
  function processMessageQueue() {
    while (messageQueue.length > 0 && communicator && communicator._Connected) {
      const { message, callback } = messageQueue.shift();
      try {
        communicator.sendMessage(message, callback);
      } catch (e) {
        warn('Error processing queued message:', e);
        messageQueue.unshift({ message, callback }); // Put it back at the start
        break;
      }
    }
  }

  // Attempt to reconnect
  function reconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    
    log('Attempting to reconnect...');
    
    // Reset communicator state
    if (communicator) {
      communicator._Connected = false;
      communicator._port = null;
    }

    // Try to reinitialize
    initialize().then(() => {
      isReconnecting = false;
      log('Reconnection successful');
      processMessageQueue();
    }).catch(e => {
      isReconnecting = false;
      warn('Reconnection failed:', e);
      // Try again after a delay
      setTimeout(reconnect, 2000);
    });
  }

  // Initialize communication with background page
  function initCommunication() {
    return new Promise((resolve, reject) => {
      log('Starting communication initialization');
      
      if (!communicator) {
        warn('Communicator not available at init time');
        reject(new Error('Communicator not available'));
        return;
      }

      log('Communicator state:', {
        isConnected: communicator._Connected,
        hasPort: !!communicator._port,
        observerCounts: {
          connect: communicator._connect_observers.length,
          disconnect: communicator._disconnect_observers.length,
          message: communicator._message_observers.length
        }
      });

      // Set up observers before initializing
      communicator
        .observeConnect(function() {
          log('Connect observer triggered');
          connected = true;
          clearTimeout(timeout);
          resolve();
        })
        .observeDisconnect(function() {
          log('Disconnect observer triggered');
          cleanup_handlers();
          if (!connected) {
            reject(new Error('Connection failed'));
          } else if (!isReconnecting) {
            reconnect();
          }
        })
        .observeMessage(function(request, sendResponse) {
          log('Message observer received:', request);
          
          // Handle context menu click specifically
          if (request.method === "context-menu-click") {
            log('Processing context menu click with data:', request);
            
            // Show modal directly for context menu clicks
            showModal({
                method: 'addlink-todeluge:withoptions',
                url: request.url,
                domain: SITE_META.DOMAIN,
                info: { name: 'Add Torrent' }
            });
            
            if (typeof sendResponse === 'function') {
                sendResponse({ success: true });
            }
            return true;
          }
          
          // Handle direct modal requests
          if (request.method === "add_dialog" || request.method === "addlink-todeluge:withoptions") {
            log('Showing add dialog for:', request);
            try {
                showModal(request);
                if (typeof sendResponse === 'function') {
                    sendResponse({ success: true });
                }
            } catch (e) {
                warn('Error showing modal:', e);
                if (typeof sendResponse === 'function') {
                    sendResponse({ error: e.message });
                }
            }
            return true;
          }
          
          // Log unhandled messages
          log('Unhandled message:', request);
          if (typeof sendResponse === 'function') {
            sendResponse({ error: 'Unhandled message type' });
          }
          return true;
        });

        let connected = false;
        let retryCount = 0;
        const maxRetries = 3;
        const retryDelay = 1000; // 1 second between retries
        
        function tryConnect() {
          if (connected) return;
          
          try {
            log('Attempting connection, try #' + (retryCount + 1));
            communicator.init(true);
            log('Communicator initialized');
            
            // Test basic communication channel
            setTimeout(() => {
              if (!connected) {
                safeSendMessage({ method: 'storage-get-connections' }, function(response) {
                  log('Communication test response:', response);
                  if (response !== undefined) {
                    log('Communication channel verified');
                    connected = true;
                    clearTimeout(timeout);
                    resolve();
                  } else if (retryCount < maxRetries) {
                    retryCount++;
                    setTimeout(tryConnect, retryDelay);
                  }
                });
              }
            }, 100);
          } catch (e) {
            warn('Error during connection attempt:', e);
            if (retryCount < maxRetries) {
              retryCount++;
              setTimeout(tryConnect, retryDelay);
            } else {
              reject(new Error('Max retries reached'));
            }
          }
        }
        
        // Set a timeout to reject if connection takes too long
        const timeout = setTimeout(() => {
          if (!connected) {
            warn('Communication initialization timed out');
            reject(new Error('Connection timeout'));
          }
        }, 5000);
  
        // Start connection attempt
        tryConnect();
    });
  }

  // Initialize the site functionality
  async function initialize() {
    try {
      log('Starting initialization...');
      
      // First establish communication
      await initCommunication();
      
      // Initialize site functionality immediately
      site_init();
      
      // Initialize modal container
      modal_init();
      
      // Initialize toast notification system
      initToastSystem();      

      
      log('Initialization complete');
    } catch (e) {
      warn('Initialization error:', e);
      
      if (!initialize.retrying) {
        initialize.retrying = true;
        setTimeout(() => {
          warn('Retrying initialization...');
          initialize.retrying = false;
          initialize();
        }, 2000);
      } else {
        warn('Max retries reached - please refresh the page');
      }
    }
  }

  function cleanup_handlers() {
    document.removeEventListener('keydown', handle_keydown);
    document.removeEventListener('keyup', handle_keyup);
    document.removeEventListener('contextmenu', handle_contextmenu);
    document.body.removeEventListener('click', handle_leftclick);
  }

  function extract_torrent_url(target) {
    log('Attempting to extract torrent URL from:', target);
    var element = target, torrent_match, torrent_url,
      attr = SITE_META.TORRENT_URL_ATTRIBUTE,
      regex = new RegExp(SITE_META.TORRENT_REGEX);

    log('Initial element:', element, 'with attribute:', attr);
    
    // Try the target element first
    if (element.getAttribute(attr)) {
      log('Found attribute on target element');
    } else {
      // Try parent if no attribute on target
      element = target.parentElement;
      log('Trying parent element:', element);
    }
    
    if (!element.getAttribute(attr)) {
      // Try finding first anchor tag
      element = target.closest('a');
      if (!element) {
      element = target.querySelector('a');
      }
      log('Trying anchor element:', element);
    }
    
    if (!element) {
      log('No suitable element found');
      return;
    }

    // Get the URL value
    val = attr === 'href' ? element.href : element.getAttribute(attr);
    log('Found URL value:', val);
    
    if (val) {
      // First try exact regex match
      torrent_match = val.match(regex);
      log('Regex match result:', torrent_match);
      
      if (!torrent_match) {
        // Fallback: check if it's a magnet link
        if (val.startsWith('magnet:')) {
          log('URL is a magnet link, using as fallback');
          torrent_match = { input: val };
        }
        // Fallback: check if it ends with .torrent
        else if (val.endsWith('.torrent')) {
          log('URL ends with .torrent, using as fallback');
          torrent_match = { input: val };
        }
        // Fallback: check if it contains 'download.php' or similar
        else if (val.includes('download.php') || val.includes('dl.php') || val.includes('get.php')) {
          log('URL contains download pattern, using as fallback');
          torrent_match = { input: val };
        }
      }
    }
    
    if (torrent_match) {
      torrent_url = torrent_match.input;
      log('Successfully extracted torrent URL:', torrent_url);
    } else {
      log('No torrent URL pattern matched');
    }
    
    return torrent_url;
  }

  function process_event(e, with_options) {
    log('Processing event:', e, 'with options:', with_options);
    var torrent_url = extract_torrent_url(e.target);
    if (!torrent_url) {
      log('No torrent URL found in event target');
      return;
    }
    
    log('Processing torrent URL:', torrent_url, 'with options:', with_options);
    stopEvent(e);
  }

  function handle_keydown ( e ) {
    if ( e.ctrlKey ) {
      CONTROL_KEY_DEPRESSED = true;
      log('Control key pressed');
    }
  }

  function handle_keyup ( /*e*/ ) {
    if (CONTROL_KEY_DEPRESSED) {
      log('Control key released');
    CONTROL_KEY_DEPRESSED = false;
    }
  }

  function handle_contextmenu ( e ) {
    log( 'Processing context menu event' );
    var torrentUrl = extract_torrent_url(e.target);
    log('Extracted torrent URL:', torrentUrl);
    
    // Store the URL for later use by the background script
    if (torrentUrl) {
      window.lastTorrentUrl = torrentUrl;
      window.lastTorrentDomain = SITE_META.DOMAIN;
      window.lastTorrentCookies = cookies;
    }
  }

  function handle_leftclick(e) {
    log('LEFT CLICK', 'CTRL:', CONTROL_KEY_DEPRESSED);
    
    // Ignore clicks on the modal itself
    if (e.target.closest('.delugeflow-modal')) {
        log('Click inside modal, ignoring');
        return;
    }
    
    var torrentUrl = extract_torrent_url(e.target);
    log('Extracted torrent URL:', torrentUrl);
    if (torrentUrl) {
        
    if (CONTROL_KEY_DEPRESSED) {
        log('Control + left click detected, processing with options');
            stopEvent(e);
            showModal({
                method: 'addlink-todeluge:withoptions',
                url: torrentUrl,
                domain: SITE_META.DOMAIN,
                info: { name: 'Add Torrent' }
            }, e);
        
    } else {
      stopEvent(e);
        
        // Get cookies first, then send message
        safeSendMessage({
          method: 'addlink-todeluge',
          url: torrentUrl,
          domain: SITE_META.DOMAIN,
          info: { name: 'Add Torrent' },
          cookies: cookies
        }, function(response) {
            if (response?.error) {
                // Check if it's the "already in session" case
                if (response.error.includes('already in session')) {
                    log('Torrent already exists in session');
                    showToast('Torrent already exists in Deluge', 'warning', 5000);
                } else {
                    showToast(`Error adding torrent: ${response.error}`, 'error', 5000);
                }
            }
        });
    }
  }
  }
  function handle_visibilityChange () {
    if ( !document.webkitHidden && document.webkitVisibilityState != 'prerender' ) {
      site_init();
    }
  }

  function modal_init() {
    log('Initializing modal...');
    var modalId = 'delugeflow-modal-' + chrome.runtime.id;
    
    // Create or get modal container and overlay
    var modal = document.getElementById(modalId);
    var overlay = document.getElementById(modalId + '-overlay');
    
    if (!modal) {
        modal = document.createElement('div');
        modal.id = modalId;
        modal.className = 'delugeflow-modal';
        document.body.appendChild(modal);
        
        overlay = document.createElement('div');
        overlay.id = 'delugeflow-backdrop-' + chrome.runtime.id;
        overlay.className = 'delugeflow-modal-overlay';
        document.body.appendChild(overlay);
        
        log('Created modal container');
    }

    // Verify modal exists
    const addedModal = document.getElementById(modalId);
    if (!addedModal) {
        warn('Failed to find modal in DOM after creation');
        return;
    }
    
    log('Modal initialization complete');
    return modal;
  }

  function showModal(req, clickEvent) {
    log('Showing modal with config:', req);
    
    // Ensure we have a URL to work with
    if (!req.url) {
        warn('No URL provided for modal');
        return;
    }

    var modalId = 'delugeflow-modal-' + chrome.runtime.id;
    var modal = document.getElementById(modalId);
    var overlay = document.getElementById("delugeflow-backdrop-" + chrome.runtime.id);
    
    if (!modal) {
        warn('Modal container not found, initializing...');
        modal = modal_init();
        overlay = document.getElementById("delugeflow-backdrop-" + chrome.runtime.id);
        if (!modal) {
            warn('Failed to initialize modal');
            return;
        }
    }

    // Show the modal immediately with loading state
    modal.innerHTML = `
        <form action="javascript:void(0);" class="delugeflow-form">
            <h3>${req.info?.name || 'Add Torrent'}</h3>
            <div class="note">${req.url}</div>
            <input type="hidden" name="url" value="${req.url}"/>
            <div class="loading">Loading options...</div>
        </form>
    `;
    
    // Show the modal and overlay immediately
    modal.classList.add('displayed');
    overlay.classList.add('displayed');
    log('Modal displayed with loading state');

    // Get server info and plugin info in parallel
    Promise.all([
      new Promise((resolve) => {
        safeSendMessage({
          method: 'get-server-info'
        }, function(response) {
          log('Server info response:', response);
          resolve(response);
        });
      }),
      new Promise((resolve) => {
        safeSendMessage({
          method: 'plugins-getinfo'
        }, function(response) {
          log('Plugin info response:', response);
          resolve(response);
        });
      }),
      new Promise((resolve) => {
        chrome.storage.local.get('server_default_labels', function(data) {
          log('Server default labels response:', data);
          resolve(data.server_default_labels || {});
        });
      })
    ]).then(([serverResponse, pluginResponse, serverLabels]) => {
      log('Got all initial data:', {
        servers: serverResponse,
        plugins: pluginResponse,
        serverLabels: serverLabels
      });
      
      // Get the primary server index
      const primaryIndex = serverResponse?.primaryServerIndex || 0;
      
      // Combine the data and render
      const data = {
        servers: serverResponse?.servers || [],
        primaryServerIndex: primaryIndex,
        plugins: pluginResponse?.value?.plugins || {},
        config: pluginResponse?.value?.config || {},
        defaultLabel: serverLabels[primaryIndex] || ''
      };
      
      log('Prepared data for rendering:', data);
      renderModalContent(data);
    }).catch(error => {
      warn('Error fetching initial data:', error);
      // Render with empty data if there's an error
      renderModalContent({
        servers: [],
        primaryServerIndex: 0,
        plugins: {},
        config: {},
        defaultLabel: ''
      });
    });

    function renderModalContent(data) {
      try {
        log('Starting modal content render with:', data);
        
        // Extract plugin and config data
        const plugins = data.plugins || {};
        const config = data.config || {};
        
        modal.innerHTML = `
          <form action="javascript:void(0);" class="delugeflow-form">
            <h3>${req.info?.name || 'Add Torrent'}</h3>
            <div class="note">${req.url}</div>
            <input type="hidden" name="url" value="${req.url}"/>
            
            ${data.servers.length > 1 ? `
            <div class="form-group">
              <label>Server:</label>
              <select name="server" class="server-select">
                ${data.servers.map(server => 
                  `<option value="${server.index}" ${server.isPrimary ? 'selected' : ''}>
                    ${server.url}${server.isPrimary ? ' (Primary)' : ''}
                  </option>`
                ).join('\n')}
              </select>
            </div>
            ` : ''}
            
            ${plugins.Label?.length > 0 ? `
            <div class="form-group">
              <label>Label:</label>
              <select name="plugins[Label]">
                <option value="">No Label</option>
                ${plugins.Label.map(label => 
                  `<option value="${label}" ${label === data.defaultLabel ? 'selected' : ''}>${label}</option>`
                ).join('\n')}
              </select>
            </div>
            ` : ''}
            
            ${plugins.AutoAdd?.length > 0 ? `
            <div class="form-group">
              <label>Watch Directory:</label>
              <select name="plugins[AutoAdd]">
                <option value="">Default Location</option>
                ${plugins.AutoAdd.map(path => 
                  `<option value="${path}">${path}</option>`
                ).join('\n')}
              </select>
            </div>
            ` : ''}

            <div class="form-group">
              <label>Download Location:</label>
              <input type="text" name="options[download_location]" value="${config.download_location || ''}"/>
            </div>

            <div class="form-group">
              <label>
                <input type="checkbox" name="options[add_paused]" ${config.add_paused ? 'checked' : ''}/>
                Add Paused
              </label>
            </div>
            
            <div class="form-group">
              <label>
                <input type="checkbox" name="options[move_completed]" ${config.move_completed ? 'checked' : ''}/>
                Move on Completion
              </label>
            </div>

            <div class="form-group move-completed-path" style="display: ${config.move_completed ? 'block' : 'none'}">
              <label>Move Completed To:</label>
              <input type="text" name="options[move_completed_path]" value="${config.move_completed_path || ''}"/>
            </div>
            
            <div class="actions">
              <button type="button" class="cancel">Cancel</button>
              <button type="submit">Add</button>
            </div>
          </form>
        `;

        // Add event listener for server selection change
        const serverSelect = modal.querySelector('.server-select');
        if (serverSelect) {
          serverSelect.addEventListener('change', function() {
            const selectedServerIndex = parseInt(this.value);
            log('Server selection changed to:', selectedServerIndex);
            
            // Show loading state
            const form = modal.querySelector('form');
            const loadingDiv = document.createElement('div');
            loadingDiv.className = 'loading-overlay';
            loadingDiv.innerHTML = 'Loading server options...';
            form.appendChild(loadingDiv);
            
            // Get server-specific default label
            chrome.storage.local.get('server_default_labels', function(data) {
              const serverLabels = data.server_default_labels || {};
              const defaultLabel = serverLabels[selectedServerIndex] || '';
              
              // Get plugin info and configuration for the selected server
              safeSendMessage({
                method: 'plugins-getinfo',
                serverIndex: selectedServerIndex
              }, function(response) {
                log('Got updated plugin info for server:', response);
                
                // Remove loading state
                loadingDiv.remove();
                
                if (response.error) {
                  showToast(`Error loading server options: ${response.error}`, 'error', 5000);
                  return;
                }
                
                const plugins = response.value?.plugins || {};
                const config = response.value?.config || {};
                
                // Update label select if it exists
                const labelSelect = modal.querySelector('select[name="plugins[Label]"]');
                const labelGroup = labelSelect?.closest('.form-group');
                if (labelGroup) {
                  if (plugins.Label && plugins.Label.length > 0) {
                    labelGroup.style.display = '';
                    labelSelect.innerHTML = `
                      <option value="">No Label</option>
                      ${plugins.Label.map(label => 
                        `<option value="${label}" ${label === defaultLabel ? 'selected' : ''}>${label}</option>`
                      ).join('\n')}
                    `;
                  } else {
                    labelGroup.style.display = 'none';
                  }
                }
                
                // Update AutoAdd (watch directory) select if it exists
                const watchSelect = modal.querySelector('select[name="plugins[AutoAdd]"]');
                const watchGroup = watchSelect?.closest('.form-group');
                if (watchGroup) {
                  if (plugins.AutoAdd && plugins.AutoAdd.length > 0) {
                    watchGroup.style.display = '';
                    watchSelect.innerHTML = `
                      <option value="">Default Location</option>
                      ${plugins.AutoAdd.map(path => 
                        `<option value="${path}">${path}</option>`
                      ).join('\n')}
                    `;
                  } else {
                    watchGroup.style.display = 'none';
                  }
                }
                
                // Update download location
                const downloadLocation = modal.querySelector('input[name="options[download_location]"]');
                if (downloadLocation && config.download_location) {
                  downloadLocation.value = config.download_location;
                }
                
                // Update add paused checkbox
                const addPaused = modal.querySelector('input[name="options[add_paused]"]');
                if (addPaused) {
                  addPaused.checked = config.add_paused || false;
                }
                
                // Update move completed checkbox and path
                const moveCompleted = modal.querySelector('input[name="options[move_completed]"]');
                const moveCompletedPath = modal.querySelector('input[name="options[move_completed_path]"]');
                const moveCompletedGroup = moveCompletedPath?.closest('.form-group');
                
                if (moveCompleted) {
                  moveCompleted.checked = config.move_completed || false;
                  if (moveCompletedGroup) {
                    moveCompletedGroup.style.display = moveCompleted.checked ? '' : 'none';
                  }
                }
                
                if (moveCompletedPath && config.move_completed_path) {
                  moveCompletedPath.value = config.move_completed_path;
                }
              });
            });
          });
          
          // Also handle move_completed checkbox changes
          const moveCompleted = modal.querySelector('input[name="options[move_completed]"]');
          const moveCompletedPath = modal.querySelector('input[name="options[move_completed_path]"]')?.closest('.form-group');
          if (moveCompleted && moveCompletedPath) {
            moveCompleted.addEventListener('change', function() {
              moveCompletedPath.style.display = this.checked ? '' : 'none';
            });
          }
        }

        setupModalEventListeners();
      } catch (e) {
        warn('Error rendering modal content:', e);
        modal.innerHTML = `
          <form action="javascript:void(0);" class="delugeflow-form">
            <h3>Add Torrent</h3>
            <div class="note">${req.url}</div>
            <input type="hidden" name="url" value="${req.url}"/>
            <div class="form-group">
              <label>Error loading options. Add anyway?</label>
            </div>
            <div class="actions">
              <button type="button" class="cancel">Cancel</button>
              <button type="submit">Add</button>
            </div>
          </form>
        `;
        setupModalEventListeners();
      }
    }

    function setupModalEventListeners() {
      const form = modal.querySelector('form');
      if (!form) return;

      form.addEventListener('submit', function(e) {
        e.preventDefault();
        hideModal();
        
        const formData = new FormData(e.target);
        const data = {
          method: 'addlink-todeluge',
          url: formData.get('url'),
          domain: req.domain,
          options: {},
          plugins: {}
        };

        // Get selected server if available
        const serverSelect = form.querySelector('.server-select');
        if (serverSelect) {
          data.serverIndex = parseInt(serverSelect.value);
        }

        // Process options and plugins
        for (let [key, value] of formData.entries()) {
          if (key.startsWith('options[')) {
            const optionKey = key.match(/options\[(.*?)\]/)[1];
            data.options[optionKey] = value === 'on' ? true : value;
          } else if (key.startsWith('plugins[')) {
            const pluginKey = key.match(/plugins\[(.*?)\]/)[1];
            if (value) {
              data.plugins[pluginKey] = value;
            }
          }
        }

        // ADD THE FUCKING COOKIES
        data.cookies = window.lastTorrentCookies;

        log('Submitting form data:', data);

        // Save selected label as default if one was chosen
        if (data.plugins.Label) {
          safeSendMessage({
            method: 'storage-set',
            key: 'default_label',
            value: data.plugins.Label
          });
        }

        // Show a loading toast
        const loadingToastId = showToast('Adding torrent to Deluge...', 'info', 0);

        // Send the torrent add request
        safeSendMessage(data, function(response) {
          // Remove the loading toast
          removeToast(loadingToastId);
          
          if (response?.error) {
            log('Error adding torrent:', response.error);
            
            // Check if it's the "already in session" case
            if (response.error.includes('already in session')) {
              log('Torrent already exists in session');
              showToast('Torrent already exists in Deluge', 'warning', 5000);
            } else {
              showToast(`Error adding torrent: ${response.error}`, 'error', 5000);
            }
          } else {
            log('Torrent added successfully');
            
            // Build success message with details
            let successMsg = 'Torrent added successfully';
            
            // Add label info if available
            if (data.plugins.Label) {
              successMsg += ` with label "${data.plugins.Label}"`;
            }
            
            // Add paused state if set
            if (data.options.add_paused) {
              successMsg += ' (paused)';
            }
            
            // Show success toast
            showToast(successMsg, 'success', 5000);
          }
        });
      });

      // Handle cancel button
      const cancelBtn = form.querySelector('button.cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', hideModal);
      }

      // Handle overlay click
      overlay.addEventListener('click', hideModal);
    }

    function hideModal() {
      log('Hiding modal');
      modal.classList.remove('displayed');
      overlay.classList.remove('displayed');
      modal.innerHTML = '';
    }
  }

  function install_configurable_handlers () {
    log('Installing configurable handlers');

    /* install control + rightclick keyboard macro */
    safeSendMessage({
      method: "storage-get-enable_keyboard_macro"
    }, function ( response ) {
      if ( response.value ) {
        log('Enabling keyboard macro handlers');
        document.addEventListener( 'keydown', handle_keydown );
        document.addEventListener( 'keyup', handle_keyup );
        document.addEventListener( 'contextmenu', handle_contextmenu );
      } else {
        log('Disabling keyboard macro handlers');
        document.removeEventListener( 'keydown', handle_keydown );
        document.removeEventListener( 'keyup', handle_keyup );
        document.removeEventListener( 'contextmenu', handle_contextmenu );
      }
    } );

    
    /* install leftclick handling */
    safeSendMessage( {
      method: "storage-get-enable_leftclick"
    }, function ( response ) {
      if ( !!response.value ) {
        log('Enabling left click handler');
        document.body.addEventListener( 'click', handle_leftclick );
      } else {
        log('Disabling left click handler');
        document.body.removeEventListener( 'click', handle_leftclick );
      }
    } );
  }

  function site_init() {
    if (!communicator._Connected) {
      warn('Cannot initialize site - communicator not connected');
      return;
    }

    log('Initializing site functionality');
    
    // Initialize the modal container
    modal_init();
    
    // Set default regex if none provided
    // https://passthepopcorn.me/torrents.php?action=download&id=671675&authkey=c058131650a963d2d3813042121794c4&torrent_pass=mjc7q3wiw7i2ij5iyd31ctfleyd74a4x
    const defaultRegex = '^magnet:'
      + '|(\\/|^)(torrent|torrents|dl|download|get)(\\.php)?\\?(.*&)?action=download'  // Matches PTP style with action=download
      + '|(\\/|^)(torrent|torrents|dl|download|get)(\\.php)?\\/(\\d+|[a-f0-9]{32})'   // Matches numeric IDs or hashes
      + '|(\\/|^)(index|download)(\\.php)?(\\?|\\/).*\\.torrent'                       // Matches .torrent in query/path
      + '|\\.torrent(\\?.*)?$';                                                        // Matches .torrent files
    
    // Get regex for link checking from settings
    safeSendMessage({
      method: 'storage-get-link_regex'
    }, function(response) {
      if (!response) {
        warn('No response from link regex request, using default');
        SITE_META.TORRENT_REGEX = defaultRegex;
        install_configurable_handlers();
        return;
      }
      
      log('Link regex configuration:', response);
      
      // Use provided regex or fall back to default
      SITE_META.TORRENT_REGEX = response.value || defaultRegex;
      log('Using torrent regex pattern:', SITE_META.TORRENT_REGEX);

      // Check if we're on Deluge UI before installing handlers
      safeSendMessage({
        method: 'storage-get-connections'
      }, function(response) {
        try {
          var conns = response.value || [];
          var currentUrl = new URL(window.location.href);
          var currentPathname = currentUrl.pathname.replace(/\/$/, "");
          
        for (var i = 0, l = conns.length; i < l; i++) {
            try {
              var connUrl = new URL(conns[i].url);
          var connPathname = connUrl.pathname.replace(/\/$/, "");
              
              if (currentUrl.hostname === connUrl.hostname && currentPathname === connPathname) {
                warn('On Deluge web UI page - not installing handlers');
                return;
              }
            } catch (e) {
              warn('Error parsing connection URL:', e);
              continue;
            }
          }
          
          // Not on Deluge UI, install handlers
          install_configurable_handlers();
        } catch (e) {
          warn('Error checking Deluge UI:', e);
          // Install handlers anyway if check fails
          install_configurable_handlers();
        }
      });
    });
  }

  // Start initialization immediately and also set up for document ready
  initialize().catch(e => {
    warn('Initial initialization failed:', e);
    if (document.readyState !== 'complete') {
      log('Document not ready, will retry on DOMContentLoaded');
      document.addEventListener('DOMContentLoaded', () => {
        log('DOMContentLoaded fired, retrying initialization');
        initialize();
      });
    }
  });
  
  // Re-initialize when the page becomes visible, but only if we're not already connected
  document.addEventListener('webkitvisibilitychange', function() {
    log('Visibility changed:', {
      hidden: document.webkitHidden,
      state: document.webkitVisibilityState
    });
    if (!document.webkitHidden && document.webkitVisibilityState !== 'prerender' && (!communicator || !communicator._Connected)) {
      log('Page became visible and not connected, reinitializing');
      initialize();
    }
  });
  
  log('Content handler setup complete');
  
  // Toast notification system
  function initToastSystem() {
    // Create container if it doesn't exist
    let toastContainer = document.querySelector('.delugeflow-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'delugeflow-toast-container';
      document.body.appendChild(toastContainer);
    }
    
    // Store reference for later use
    window.delugeflowToastContainer = toastContainer;
  }

  // Show a toast notification
  function showToast(message, type = 'info', duration = 5000) {
    if (!window.delugeflowToastContainer) {
      initToastSystem();
    }
    
    // Generate unique ID for this toast
    const toastId = 'toast-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    
    // Create icons based on type
    const icons = {
      success: '✓',
      error: '✗',
      warning: '⚠',
      info: 'ℹ'
    };
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `delugeflow-toast ${type}`;
    toast.id = toastId;
    toast.style.opacity = '1'; // Ensure it's visible
    toast.style.transform = 'translateX(0)'; // Start in correct position
    toast.innerHTML = `
      <div class="delugeflow-toast-icon">${icons[type] || icons.info}</div>
      <div class="delugeflow-toast-content">${message}</div>
      <div class="delugeflow-toast-close">×</div>
    `;
    
    // Add to container
    window.delugeflowToastContainer.appendChild(toast);
    
    // Set up close button
    const closeBtn = toast.querySelector('.delugeflow-toast-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        removeToast(toastId);
      });
    }
    
    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => {
        removeToast(toastId);
      }, duration);
    }
    
    // Log toast
    log('Toast notification shown:', { message, type, duration });
    
    return toastId;
  }

  // Remove a toast by ID
  function removeToast(toastId) {
    const toast = document.getElementById(toastId);
    if (!toast) return;
    
    // Add the remove class to trigger the slide-out animation
    toast.classList.add('remove');
    
    // Remove element after animation completes
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }

  // Listen for messages from the background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    log('Received message from background:', request);
    
    if (request.method === 'add_dialog') {
      log('Showing add dialog for:', request.url);
      showModal({
        method: 'addlink-todeluge:withoptions',
        url: request.url,
        domain: request.domain || SITE_META.DOMAIN,
        info: { name: 'Add Torrent' }
      });
      sendResponse({ success: true });
      return true;
    }
    
    // Handle other messages...
    return false;
  });
} )( window, document );
