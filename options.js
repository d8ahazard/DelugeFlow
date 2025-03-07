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

  // Save options to chrome.storage.local
  function saveOptions() {
    clearErrors();
    document.getElementById('save_options').textContent = 'Saving...';
    var hasError = false;
    var connectionData = [];
    var connContainers = document.querySelectorAll('#connection-info .connection-container');
    connContainers.forEach(function(container) {
      var urlInput = container.querySelector('input[name="url"]');
      var passInput = container.querySelector('input[name="pass"]');
      var urlVal = urlInput.value.trim();
      var passVal = passInput.value;
      // apply scrubber
      urlVal = optionsConfig.CONNECTION_DEFAULTS[0].scrubber(urlVal);
      // validate url
      if(optionsConfig.CONNECTION_DEFAULTS[0].required && !urlVal) {
        showError(urlInput, 'Required field.');
        hasError = true;
      } else if(!optionsConfig.CONNECTION_DEFAULTS[0].validate(urlVal)) {
        showError(urlInput, optionsConfig.CONNECTION_DEFAULTS[0].validate_message);
        hasError = true;
      }
      connectionData.push({ url: urlVal, pass: passVal });
    });

    if(!hasError) {
      // Save all data at once
      var dataToSave = {
        connections: connectionData
      };

      // Add default options
      optionsConfig.DEFAULTS.forEach(function(opt) {
        var element = document.getElementById(opt.id);
        if(element) {
          dataToSave[opt.id] = element.type === 'checkbox' ? element.checked : element.value;
        }
      });

      // Add label options
      var defaultLabel = document.getElementById('default_label');
      if(defaultLabel) {
        dataToSave.default_label = defaultLabel.value;
      }

      // Save all data at once
      chrome.storage.local.set(dataToSave, function() {
        debugLog('important', 'Settings saved:', dataToSave);
        // Verify the save by reading back
        chrome.storage.local.get(null, function(allData) {
          debugLog('debug', 'All settings after save:', allData);
        });
        document.getElementById('save_options').textContent = 'Save';
        // Broadcast settings change
        chrome.runtime.sendMessage(chrome.runtime.id, { method: 'settings-changed' });
      });
    } else {
      document.getElementById('save_options').textContent = 'Save';
    }
  }

  // Set option values from chrome.storage.local
  function setOptionValues(defaults) {
    defaults.forEach(function(opt) {
      var element = document.getElementById(opt.id);
      if(!element) return;
      
      chrome.storage.local.get(opt.id, function(data) {
        var value = data[opt.id];
        if(value === undefined) value = opt.def;
        
        if(element.type === 'checkbox') {
          element.checked = (value === 'true' || value === true);
        } else {
          element.value = value;
        }
      });
    });
  }

  // Restore settings from chrome.storage.local
  function restoreOptions() {
    // Restore connection info
    chrome.storage.local.get('connections', function(data) {
      var connections = [{}];
      try {
        if(data.connections) {
          connections = Array.isArray(data.connections) ? data.connections : [{}];
        }
      } catch(e) {
        connections = [{}];
      }
      
      var connContainer = document.getElementById('connection-info');
      connContainer.innerHTML = '';
      connections.forEach(function(conn, index) {
        var el = renderConnectionTemplate(index, conn.url, conn.pass);
        connContainer.appendChild(el);
      });
    });

    // Restore default options
    setOptionValues(optionsConfig.DEFAULTS);

    // For labels, if needed, we call communicator to get label info
    communicator.sendMessage({ method: 'plugins-getinfo' }, function(response) {
      var labels = response.value?.plugins?.Label || null;
      var labelsContainer = document.getElementById('labels-options');
      labelsContainer.innerHTML = '';
      if(labels) {
        if(labels.length > 0) {
          var html = '<h3>Default Label</h3>' +
                     '<div class="select opts"><select id="default_label" class="option_field"><option value=""></option>';
          labels.forEach(function(label) {
            html += '<option value="' + label + '">' + label + '</option>';
          });
          html += '</select><br><span><small>Apply this label to all new torrents by default</small></span></div>';
          labelsContainer.innerHTML = html;
          // Set stored default label
          chrome.storage.local.get('default_label', function(data) {
            if(data.default_label) {
              document.getElementById('default_label').value = data.default_label;
            }
          });
        } else {
          labelsContainer.innerHTML = '<p>You have not created any labels. Visit your server\'s Web UI to make some.</p>';
        }
      } else {
        labelsContainer.innerHTML = '<p>Labels plugin not enabled. Visit your server\'s Web UI to enable them.</p>';
      }
    });
  }

  // Clear all stored settings
  function clearOptions() {
    chrome.storage.local.clear(function() {
      restoreOptions();
      chrome.runtime.sendMessage(chrome.runtime.id, { method: 'settings-changed' });
    });
  }

  // Utility function to create an element from an HTML string
  function createElementFromHTML(htmlString) {
    var div = document.createElement('div');
    div.innerHTML = htmlString.trim();
    return div.firstChild;
  }

  // Renders the connection template
  function renderConnectionTemplate(index, url, pass) {
    var container = document.createElement('div');
    container.className = 'connection-container';
    container.setAttribute('data-index', index);

    var html = '<div class="connection-index">Deluge Server ' + index + '</div>' +
      '<h3>URL</h3>' +
      '<div class="textinput opts">' +
      '  <label>' +
      '    <input type="text" name="url" size="60" class="option_field" value="' + (url || '') + '" />' +
      '  </label>' +
      '  <br/><span><small>ex: http://localhost/user/deluge</small></span>' +
      '</div>' +
      '<h3>WebUI Password</h3>' +
      '<div class="textinput opts">' +
      '  <label>' +
      '    <input type="password" name="pass" size="40" class="option_field" value="' + (pass || '') + '" />' +
      '  </label>' +
      '</div>';
    container.innerHTML = html;
    return container;
  }

  // Show validation error message near an element
  function showError(element, message) {
    // Remove existing error if any
    var existing = element.parentNode.querySelector('.validation-message');
    if(existing) { existing.remove(); }
    var span = document.createElement('span');
    span.className = 'validation-message';
    span.style.color = 'red';
    span.textContent = message;
    element.parentNode.appendChild(span);
  }

  // Clear all validation error messages
  function clearErrors() {
    document.querySelectorAll('.validation-message').forEach(function(el) {
      el.remove();
    });
  }

  // Initialization: wire up event listeners
  function init() {
    restoreOptions();
    document.getElementById('version').textContent = chrome.runtime.getManifest().version;

    // Event listeners for option fields
    document.querySelectorAll('input.option_field, select.option_field').forEach(function(el) {
      var eventType = (el.type === 'checkbox') ? 'change' : 'blur';
      el.addEventListener(eventType, saveOptions);
    });

    // Special handler for leftclick enabling link_regex
    var leftclick = document.getElementById('enable_leftclick');
    var linkRegex = document.getElementById('link_regex');
    if(leftclick && linkRegex) {
      leftclick.addEventListener('change', function() {
        linkRegex.disabled = !leftclick.checked;
      });
      linkRegex.disabled = !leftclick.checked;
    }

    // Reset button
    var resetBtn = document.getElementById('reset_options');
    if(resetBtn) {
      resetBtn.addEventListener('click', function(e) {
        e.preventDefault();
        clearOptions();
      });
    }

    // Save button
    var saveBtn = document.getElementById('save_options');
    if(saveBtn) {
      saveBtn.addEventListener('click', saveOptions);
    }

    // Manage extension click
    var manage = document.getElementById('manage_extension');
    if(manage) {
      manage.addEventListener('click', function(e) {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
      });
    }

    // Initialize accordions
    document.querySelectorAll('.accordion-header').forEach(function(header) {
      header.addEventListener('click', function() {
        const isExpanded = header.classList.contains('expanded');
        const content = header.nextElementSibling;
        
        if (isExpanded) {
          header.classList.remove('expanded');
          content.classList.remove('expanded');
        } else {
          header.classList.add('expanded');
          content.classList.add('expanded');
        }
      });
    });
  }

  // Initialize when communicator connects
  communicator.observeConnect(function() {
    init();
  }).init(!!chrome.runtime.id);

})();
