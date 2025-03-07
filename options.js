/* global chrome, communicator */
(function() {
  // URL regular expression used for validating server URLs
  var URLregexp = /^(http|https):\/\/(\w+:{0,1}\w*@)?(\S+)(:[0-9]+)?(\/|\/[\w#!:.?+=&%@!\-\/])?/;

  // Options configuration
  var optionsConfig = {
    CONNECTION_DEFAULTS: [
      {
        id: 'url',
        def: '',
        validate: function(string) {
          if (!string) return false;
          return URLregexp.test(string);
        },
        validate_message: 'Invalid server url.',
        required: true,
        scrubber: function(string) {
          if (!string) return '';
          if (string.substring(0, 4) !== 'http') string = 'http://' + string;
          return string;
        }
      },
      {
        id: 'pass',
        def: '',
        validate: function(string) { return true; },
        required: false
      }
    ],
    DEFAULTS: [
      { id: 'inpage_notification', def: true },
      { id: 'enable_context_menu', def: true },
      { id: 'enable_context_menu_with_options', def: true },
      { id: 'enable_keyboard_macro', def: true },
      { id: 'enable_leftclick', def: true },
      { id: 'send_cookies', def: true },
      { id: 'link_regex', def: '' },
      { id: 'enable_debug_logging', def: false }
    ],
    LABEL_DEFAULTS: [
      { id: 'default_label', def: '' }
    ]
  };

  // Keep track of connections
  var connections = [];
  var primaryServerIndex = 0;
  var serverLabels = {};  // Store labels for each server

  // Communicator state
  let isReconnecting = false;
  let messageQueue = [];

  // Initialize communicator and connection
  async function initCommunication() {
    return new Promise((resolve, reject) => {
      console.log('Starting communication initialization');
      
      if (!communicator) {
        console.warn('Communicator not available at init time');
        reject(new Error('Communicator not available'));
        return;
      }

      console.log('Setting up communicator observers');

      // Set up observers before initializing
      communicator
        .observeConnect(function() {
          console.log('Connect observer triggered');
          connected = true;
          clearTimeout(timeout);
          processMessageQueue();
          resolve();
        })
        .observeDisconnect(function() {
          console.log('Disconnect observer triggered');
          if (!connected) {
            reject(new Error('Connection failed'));
          } else if (!isReconnecting) {
            reconnect();
          }
        });

      let connected = false;
      let retryCount = 0;
      const maxRetries = 3;
      const retryDelay = 1000;

      function tryConnect() {
        if (connected) return;
        
        try {
          console.log('Attempting connection, try #' + (retryCount + 1));
          communicator.init(true);
          console.log('Communicator initialized');
          
          // Test communication channel
          setTimeout(() => {
            if (!connected) {
              safeSendMessage({ method: 'storage-get-connections' }, function(response) {
                console.log('Communication test response:', response);
                if (response !== undefined) {
                  console.log('Communication channel verified');
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
          console.warn('Error during connection attempt:', e);
          if (retryCount < maxRetries) {
            retryCount++;
            setTimeout(tryConnect, retryDelay);
          } else {
            reject(new Error('Max retries reached'));
          }
        }
      }

      // Set timeout
      const timeout = setTimeout(() => {
        if (!connected) {
          console.warn('Communication initialization timed out');
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      // Start connection attempt
      tryConnect();
    });
  }

  // Safe message sender that queues messages when disconnected
  function safeSendMessage(message, callback) {
    console.log('Attempting to send message:', message);
    
    if (!communicator || !communicator._Connected) {
      console.warn('Connection not available, queueing message:', message);
      messageQueue.push({ message, callback });
      if (!isReconnecting) {
        reconnect();
      }
      return;
    }

    try {
      console.log('Sending message via communicator:', message);
      communicator.sendMessage(message, function(response) {
        console.log('Received response from background:', response);
        if (callback) {
          callback(response);
        }
      }, function(error) {
        console.error('Message send failed:', error);
        messageQueue.push({ message, callback });
        if (!isReconnecting) {
          reconnect();
        }
      });
    } catch (e) {
      console.error('Error sending message:', e);
      messageQueue.push({ message, callback });
      if (!isReconnecting) {
        reconnect();
      }
    }
  }

  // Process queued messages
  function processMessageQueue() {
    while (messageQueue.length > 0 && communicator && communicator._Connected) {
      const { message, callback } = messageQueue.shift();
      try {
        communicator.sendMessage(message, callback);
      } catch (e) {
        console.warn('Error processing queued message:', e);
        messageQueue.unshift({ message, callback }); // Put it back at the start
        break;
      }
    }
  }

  // Attempt to reconnect
  function reconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    
    console.log('Attempting to reconnect...');
    
    // Reset communicator state
    if (communicator) {
      communicator._Connected = false;
      communicator._port = null;
    }

    // Try to reinitialize
    initCommunication().then(() => {
      isReconnecting = false;
      console.log('Reconnection successful');
      processMessageQueue();
    }).catch(e => {
      isReconnecting = false;
      console.warn('Reconnection failed:', e);
      // Try again after a delay
      setTimeout(reconnect, 2000);
    });
  }

  // Initialize options page
  document.addEventListener('DOMContentLoaded', function() {
    // Initialize communication first
    initCommunication().then(() => {
      console.log('Communication initialized successfully');
      // Load all options
      loadOptions();
    }).catch(e => {
      console.error('Failed to initialize communication:', e);
      // Still load options but show error state
      loadOptions();
      document.querySelectorAll('.default-label-select').forEach(select => {
        select.innerHTML = '<option value="">Communication Error</option>';
        select.disabled = true;
      });
    });

    // Set up accordion functionality
    document.querySelectorAll('.accordion-header').forEach(header => {
      header.addEventListener('click', () => {
        const content = header.nextElementSibling;
        const isExpanded = content.classList.contains('expanded');
        
        // Toggle this accordion
        content.classList.toggle('expanded');
        header.classList.toggle('expanded');
        
        // Store the state
        const accordionId = header.querySelector('h2').textContent.toLowerCase();
        chrome.storage.local.get('accordion_states', function(data) {
          const states = data.accordion_states || {};
          states[accordionId] = !isExpanded;
          chrome.storage.local.set({ accordion_states: states });
        });
      });
    });

    // Restore accordion states
    chrome.storage.local.get('accordion_states', function(data) {
      const states = data.accordion_states || { 
        'options': true,  // Default expanded
        'advanced': false // Default collapsed
      };
      
      document.querySelectorAll('.accordion-header').forEach(header => {
        const accordionId = header.querySelector('h2').textContent.toLowerCase();
        if (states[accordionId]) {
          header.classList.add('expanded');
          header.nextElementSibling.classList.add('expanded');
        }
      });
    });

    // Set up event listeners
    document.getElementById('add-server').addEventListener('click', addNewServer);

    // Set up event delegation for connection list
    document.getElementById('connection-list').addEventListener('click', function(e) {
      const target = e.target;
      const container = target.closest('.connection-container');
      if (!container) return;

      if (target.classList.contains('remove')) {
        removeServer(container);
      } else if (target.classList.contains('primary-toggle')) {
        setPrimaryServer(container);
      }
    });

    // Set up event delegation for default label changes
    document.getElementById('connection-list').addEventListener('change', function(e) {
      const target = e.target;
      if (target.classList.contains('default-label-select')) {
        const serverIndex = parseInt(target.getAttribute('data-server-index')) - 1;
        const selectedLabel = target.value;
        
        // Save the default label for this server
        chrome.storage.local.get('server_default_labels', function(data) {
          const labels = data.server_default_labels || {};
          if (selectedLabel) {
            labels[serverIndex] = selectedLabel;
          } else {
            delete labels[serverIndex];
          }
          chrome.storage.local.set({ server_default_labels: labels });
        });
      }
    });

    // Set up event listeners for all option fields
    document.querySelectorAll('.option_field').forEach(function(field) {
      if (field.name !== 'url' && field.name !== 'pass' && !field.classList.contains('default-label-select')) {
        field.addEventListener('change', saveOptions);
      }
    });

    // Set up event delegation for connection fields
    document.getElementById('connection-list').addEventListener('change', function(e) {
      const target = e.target;
      if (target.classList.contains('option_field') && !target.classList.contains('default-label-select')) {
        validateAndSaveConnections();
      }
    });

    // Add event listener for URL/password changes to reload labels
    document.getElementById('connection-list').addEventListener('change', function(e) {
      const target = e.target;
      if (target.name === 'url' || target.name === 'pass') {
        const container = target.closest('.connection-container');
        if (container) {
          const index = parseInt(container.getAttribute('data-index')) - 1;
          if (index >= 0) {
            const urlInput = container.querySelector('input[name="url"]');
            const passInput = container.querySelector('input[name="pass"]');
            
            // Only validate if we have both URL and password
            if (urlInput.value && passInput.value && URLregexp.test(urlInput.value)) {
              // Always try to load labels - the function will handle validation first
              loadLabelsForServer(index);
            }
          }
        }
      }
    });
  });

  // Load all options from storage
  function loadOptions() {
    chrome.storage.local.get(null, function(data) {
      // Load connections
      if (data.connections) {
        try {
          connections = Array.isArray(data.connections) ? data.connections : [];
          primaryServerIndex = data.primaryServerIndex || 0;
          renderConnections();

          // After rendering connections, load labels for each server
          connections.forEach((conn, index) => {
            loadLabelsForServer(index);
          });
        } catch (e) {
          console.error('Error loading connections:', e);
          connections = [];
          primaryServerIndex = 0;
        }
      }

      // If no connections exist, add one empty one
      if (connections.length === 0) {
        addNewServer();
      }

      // Load other options
      optionsConfig.DEFAULTS.forEach(function(option) {
        var el = document.getElementById(option.id);
        if (el) {
          if (el.type === 'checkbox') {
            el.checked = data[option.id] !== undefined ? data[option.id] : option.def;
          } else {
            el.value = data[option.id] !== undefined ? data[option.id] : option.def;
          }
        }
      });
    });
  }

  // Load labels for a specific server
  function loadLabelsForServer(serverIndex) {
    const container = document.querySelector(`.connection-container[data-index="${serverIndex + 1}"]`);
    if (!container) {
      console.log('No container found for server index:', serverIndex);
      return;
    }

    const labelSelect = container.querySelector('.default-label-select');
    if (!labelSelect) {
      console.log('No label select found in container');
      return;
    }

    // Show loading state
    labelSelect.innerHTML = '<option value="">Loading labels...</option>';
    labelSelect.disabled = true;

    // First ensure we have valid connection details
    const urlInput = container.querySelector('input[name="url"]');
    const passInput = container.querySelector('input[name="pass"]');
    if (!urlInput || !urlInput.value || !URLregexp.test(urlInput.value)) {
      console.log('Invalid URL for server:', serverIndex, urlInput?.value);
      labelSelect.innerHTML = '<option value="">Please enter valid server URL</option>';
      labelSelect.disabled = true;
      return;
    }

    // Validate credentials - this will also update labels if valid
    validateServerCredentials(container, urlInput.value, passInput.value);
  }

  // Validate server credentials
  function validateServerCredentials(container, url, password) {
    return new Promise((resolve) => {
      // Test connection with explicit credentials
      safeSendMessage({
        method: 'plugins-getinfo',  // Use plugins-getinfo directly as our auth test
        url: url,
        password: password,
        force_check: true  // Force a fresh connection check
      }, function(response) {
        console.log('Validation response:', response);
        
        // Consider it valid if we get a successful plugins response
        const isValid = response && response.value && !response.error;
        
        if (!isValid) {
          container.classList.add('invalid-credentials');
          
          // Clear the label select since credentials are invalid
          const labelSelect = container.querySelector('.default-label-select');
          if (labelSelect) {
            labelSelect.innerHTML = '<option value="">Invalid credentials</option>';
            labelSelect.disabled = true;
          }
          
          resolve(false);
        } else {
          container.classList.remove('invalid-credentials');
          
          // Update labels since we already have the data
          const labelSelect = container.querySelector('.default-label-select');
          if (labelSelect) {
            const serverIndex = parseInt(container.getAttribute('data-index')) - 1;
            updateLabelsFromResponse(labelSelect, response, serverIndex);
          }
          
          resolve(true);
        }
      });
    });
  }

  // Helper function to update labels from a plugin response
  function updateLabelsFromResponse(labelSelect, response, serverIndex) {
    chrome.storage.local.get('server_default_labels', function(data) {
      const serverLabels = data.server_default_labels || {};
      const defaultLabel = serverLabels[serverIndex] || '';
      const labels = response?.value?.plugins?.Label || [];

      if (labels.length === 0) {
        labelSelect.innerHTML = '<option value="">No labels available</option>';
      } else {
        // Update the select options
        labelSelect.innerHTML = `
          <option value="">No Label</option>
          ${labels.map(label => 
            `<option value="${label}" ${label === defaultLabel ? 'selected' : ''}>${label}</option>`
          ).join('\n')}
        `;
      }
      labelSelect.disabled = false;
    });
  }

  // Save all options to storage
  function saveOptions() {
    var options = {};

    // Save all regular options
    optionsConfig.DEFAULTS.forEach(function(option) {
      var el = document.getElementById(option.id);
      if (el) {
        options[option.id] = el.type === 'checkbox' ? el.checked : el.value;
      }
    });

    // Save label options if available
    var labelEl = document.getElementById('default_label');
    if (labelEl) {
      options.default_label = labelEl.value;
    }

    // Save to storage
    chrome.storage.local.set(options);
  }

  // Add a new server connection
  function addNewServer() {
    connections.push({
      url: '',
      pass: ''
    });
    renderConnections();
    validateAndSaveConnections();
  }

  // Remove a server connection
  function removeServer(container) {
    const index = parseInt(container.getAttribute('data-index')) - 1;
    if (index >= 0 && index < connections.length) {
      connections.splice(index, 1);
      
      // Update primary server index if needed
      if (primaryServerIndex >= connections.length) {
        primaryServerIndex = Math.max(0, connections.length - 1);
      } else if (index < primaryServerIndex) {
        primaryServerIndex--;
      }

      // Remove default label for this server
      chrome.storage.local.get('server_default_labels', function(data) {
        const labels = data.server_default_labels || {};
        delete labels[index];
        // Shift all higher indexes down
        for (let i = index + 1; i < connections.length + 1; i++) {
          if (labels[i]) {
            labels[i-1] = labels[i];
            delete labels[i];
          }
        }
        chrome.storage.local.set({ server_default_labels: labels });
      });

      renderConnections();
      validateAndSaveConnections();
    }
  }

  // Set a server as primary
  function setPrimaryServer(container) {
    const index = parseInt(container.getAttribute('data-index')) - 1;
    if (index >= 0 && index < connections.length) {
      primaryServerIndex = index;
      renderConnections();
      validateAndSaveConnections();
    }
  }

  // Render all connections
  function renderConnections() {
    const container = document.getElementById('connection-list');
    container.innerHTML = '';

    connections.forEach((conn, index) => {
      const div = renderConnectionTemplate(index + 1, conn.url, conn.pass);
      const isPrimary = index === primaryServerIndex;
      
      // Update template with primary status
      const primaryBtn = div.querySelector('.primary-toggle');
      if (primaryBtn) {
        primaryBtn.classList.toggle('primary', isPrimary);
        primaryBtn.classList.toggle('not-primary', !isPrimary);
        primaryBtn.textContent = isPrimary ? 'Primary' : 'Make Primary';
      }

      container.appendChild(div);
    });
  }

  // Validate and save all connections
  function validateAndSaveConnections() {
    clearErrors();
    var isValid = true;

    // Validate each connection
    connections = Array.from(document.querySelectorAll('.connection-container')).map(container => {
      const urlInput = container.querySelector('input[name="url"]');
      const passInput = container.querySelector('input[name="pass"]');
      const url = urlInput.value.trim();
      const pass = passInput.value;

      // Validate URL
      if (!URLregexp.test(url)) {
        showError(urlInput, 'Invalid server URL');
        isValid = false;
      }

      return {
        url: url,
        pass: pass
      };
    });

    if (isValid) {
      // Save connections and primary server index
      chrome.storage.local.set({
        connections: connections,
        primaryServerIndex: primaryServerIndex
      });
    }

    return isValid;
  }

  // Show validation error message near an element
  function showError(element, message) {
    // Remove existing error if any
    var existing = element.parentNode.querySelector('.validation-message');
    if(existing) { existing.remove(); }
    var span = document.createElement('span');
    span.className = 'validation-message';
    span.textContent = message;
    element.parentNode.appendChild(span);
  }

  // Clear all validation error messages
  function clearErrors() {
    document.querySelectorAll('.validation-message').forEach(function(el) {
      el.remove();
    });
  }

  // Renders the connection template
  function renderConnectionTemplate(index, url, pass) {
    var container = document.createElement('div');
    container.className = 'connection-container';
    container.setAttribute('data-index', index);

    var html = `
      <div class="connection-row">
        <div class="field-group">
          <label for="url-${index}">Server URL</label>
          <input type="text" id="url-${index}" name="url" class="option_field url-input" placeholder="http://localhost/user/deluge" value="${url || ''}" />
        </div>
        <div class="field-group">
          <label for="pass-${index}">Password</label>
          <input type="password" id="pass-${index}" name="pass" class="option_field pass-input" placeholder="WebUI Password" value="${pass || ''}" />
        </div>
        <div class="field-group">
          <label for="label-${index}">Default Label</label>
          <select id="label-${index}" name="default_label" class="option_field default-label-select" data-server-index="${index}">
            <option value="">No Label</option>
          </select>
        </div>
        <div class="field-group controls-group">
          <label class="server-label">Server ${index}</label>
          <div class="connection-controls">
            <button type="button" class="primary-toggle">Make Primary</button>
            <button type="button" class="remove">Remove</button>
          </div>
        </div>
      </div>`;

    container.innerHTML = html;
    return container;
  }
})();
