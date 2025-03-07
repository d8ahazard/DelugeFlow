/* global chrome */
// Add uuid4 function definition if it's not already defined
if (typeof uuid4 === 'undefined') {
  function uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
}

var communicator = {
  _Connected: false,
  _connect_observers: [],
  _disconnect_observers: [],
  _message_observers: [],
  _isTab: false,
  _port: null,
  _tab_ports: {},
  init: function (_isTab) {
    if (!!this._Connected) return this;
    this._Connected = true;
    this._isTab = !!_isTab;

    chrome.runtime.onMessage.addListener(this.onGlobalMessage.bind(this));

    if (!this._isTab) {
      chrome.runtime.onConnect.addListener(function (port) {
        this._tab_ports[this.getSenderID(port.sender)] = port;
        port.onMessage.addListener(this.onPortMessage.bind(this));
        this.onConnect(port);
      }.bind(this));
    } else {
      this._port = chrome.runtime.connect({ name: 'DelugeFlow' });
      this._port.onMessage.addListener(this.onPortMessage.bind(this));
      this.onConnect(this._port);
    }

    return this;
  },

  getSenderID: function (sender) {
    var id = 'port';
    if (!!sender) {
      if (!!sender.tab)
        id = id + '-' + sender.tab.id;
      if (!!sender.frameId)
        id = id + '-' + sender.frameId;
    }
    return id;
  },

  onConnect: function (port) {
    port.onDisconnect.addListener(this.onDisconnect.bind(this));

    for (var order_num in this._connect_observers)
      this._connect_observers[order_num](port);
  },

  onDisconnect: function () {
    this._Connected = false;

    for (var order_num in this._disconnect_observers)
      this._disconnect_observers[order_num]();
  },

  onGlobalMessage: function (message, sender, sendResponse) {
    // Handle cookie retrieval request first
    if (message && message.action === "getCookies") {
      this.handleGetCookies(message, sendResponse);
      return true; // Indicate asynchronous response
    }

    // Process other message observers
    for (var order_num in this._message_observers) {
      this._message_observers[order_num](message, sender, sendResponse);
    }
  },

  onPortMessage: function (req, port) {
    // Handle cookie requests in port messages
    if (req._data && req._data.action === "getCookies") {
      this.handleGetCookies(req._data, function(response) {
        port.postMessage({ '_id': req._id, '_data': response });
      });
      return;
    }

    // if this is a tab instance, and the message isn't being
    // sent to a tab, just immediately bail.
    // elswise, if this is the controller and the message is
    // being sent to a tab, we don't wanna listen to our own
    // messages...
    if ((this._isTab && !req._isTab || !this._isTab && req._isTab)) {
      return;
    }

    port = port || this._port;

    for (var o in this._message_observers) {
      this._message_observers[o](req._data, function sendResponse(resp) {
        port.postMessage({ '_id': req._id, '_data': resp });
      }.bind(this));
    }
  },

  observeMessage: function (observer) {
    this._message_observers.push(observer);
    return this;
  },

  observeConnect: function (observer) {
    this._connect_observers.push(observer);
    return this;
  },

  observeDisconnect: function (observer) {
    this._disconnect_observers.push(observer);
    return this;
  },

  sendMessage: function (message, onSuccess, onError, id) {
    // Only controller can send by id (won't work anyway..)
    if ((!!id && this._isTab) || !this._Connected) {
      return;
    }

    try {
      var msgid = uuid4(),
        port = !id ? this._port : this._tab_ports[id];

      if (!!onSuccess) {
        port.onMessage.addListener(function (msg) {
          if (msg._id !== msgid) return;
          onSuccess(msg._data);
          port.onMessage.removeListener(this);
        });
      }

      var msg = { '_id': msgid, '_isTab': !!id, '_data': message };
      port.postMessage(msg);
    } catch (exc) {
      // probably the background page went away -- chrome prevents reconnects.
      debugLog('error', 'Lost connection:', exc);
      if (!!onError) onError(exc);
    }
    return this;
  },

  handleGetCookies: function (message, sendResponse) {
    const url = message.url;
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    
    // Get the eTLD+1 for the partitionKey
    const eTLDplus1 = this.getETLDplus1(hostname);
    
    // First try to get cf_clearance with partition key
    const partitionedCookieOptions = {
      url: url,
      name: "cf_clearance",
      partitionKey: { topLevelSite: `https://${eTLDplus1}` }
    };

    chrome.cookies.getAll(partitionedCookieOptions, (partitionedCookies) => {
      // Generate all domain permutations for regular cookie search
      const domainPermutations = this.generateDomainPermutations(hostname);
      
      // Now get all regular cookies
      chrome.cookies.getAll({ url: url }, (regularCookies) => {
        if (chrome.runtime.lastError) {
          debugLog('error', "Error getting cookies:", chrome.runtime.lastError);
          sendResponse({ error: chrome.runtime.lastError.message });
          return;
        }
        
        // Combine partitioned and regular cookies, with partitioned taking precedence
        const allCookies = [...regularCookies];
        if (partitionedCookies && partitionedCookies.length > 0) {
          // Remove any regular cf_clearance cookies
          const regularCookiesFiltered = allCookies.filter(c => c.name !== "cf_clearance");
          // Add the partitioned cookies
          allCookies.splice(0, allCookies.length, ...regularCookiesFiltered, ...partitionedCookies);
        }

        const cookieMap = {};
        const domainSpecificCookies = {};

        allCookies.forEach((cookie) => {
          // Store all cookies
          cookieMap[cookie.name] = cookie.value;

          // Store cookies with domain information for specificity handling
          if (!domainSpecificCookies[cookie.name]) {
            domainSpecificCookies[cookie.name] = [];
          }
          domainSpecificCookies[cookie.name].push(cookie);
        });

        // Resolve domain conflicts (if multiple cookies with same name)
        const resolvedCookieMap = {};
        for (const cookieName in domainSpecificCookies) {
          const cookiesForName = domainSpecificCookies[cookieName];
          if (cookiesForName.length === 1) {
            // Only one cookie with this name, use it
            resolvedCookieMap[cookieName] = cookiesForName[0].value;
          } else {
            // Multiple cookies with same name, resolve by specificity
            let bestCookie = cookiesForName[0];
            let bestScore = this.getDomainSpecificityScore(bestCookie.domain, domainPermutations);

            for (let i = 1; i < cookiesForName.length; i++) {
              const currentCookie = cookiesForName[i];
              const currentScore = this.getDomainSpecificityScore(currentCookie.domain, domainPermutations);

              if (currentScore > bestScore) {
                bestCookie = currentCookie;
                bestScore = currentScore;
              }
            }
            resolvedCookieMap[cookieName] = bestCookie.value;
          }
        }

        debugLog('debug', 'Resolved cookie map:', resolvedCookieMap);
        sendResponse({ cookies: resolvedCookieMap });
      });
    });
  },

  // Helper function to get eTLD+1 from a hostname
  getETLDplus1: function(hostname) {
    const parts = hostname.split('.');
    if (parts.length <= 2) return hostname;
    
    // Remove subdomains, keeping only the last two parts
    // This is a simplified version - for complete eTLD+1 resolution you'd want to use the Public Suffix List
    return parts.slice(-2).join('.');
  },

  generateDomainPermutations: function (hostname) {
    const permutations = new Set();
    const parts = hostname.split('.');
  
    // Add the base domain
    permutations.add(parts.join('.'));
  
    // Add variations with leading dot
    permutations.add('.' + parts.join('.'));
  
    // Add variations with and without "www"
    if (parts[0] === 'www') {
      permutations.add(parts.slice(1).join('.'));
      permutations.add('.' + parts.slice(1).join('.'));
    } else {
      permutations.add('www.' + parts.join('.'));
      permutations.add('.www.' + parts.join('.'));
    }
  
    // Add variations for subdomains
    for (let i = 1; i < parts.length - 1; i++) {
      const subdomain = parts.slice(i).join('.');
      permutations.add(subdomain);
      permutations.add('.' + subdomain);
      if (parts[i] !== 'www') {
        permutations.add('www.' + subdomain);
        permutations.add('.www.' + subdomain);
      }
    }
  
    return Array.from(permutations);
  },
  
  getDomainSpecificityScore: function (cookieDomain, domainPermutations) {
    // Find the exact match in the permutations
    const exactMatch = domainPermutations.find(domain => domain === cookieDomain);
    if (exactMatch) {
      return 4; // Exact match
    }
  
    // Find the closest match in the permutations
    const cleanCookieDomain = cookieDomain.replace(/^\./, '');
    let bestScore = 0;
    domainPermutations.forEach(domain => {
      const cleanDomain = domain.replace(/^\./, '');
      if (cleanDomain.endsWith(cleanCookieDomain) || cleanCookieDomain.endsWith(cleanDomain)) {
        const score = cleanDomain.length / cleanCookieDomain.length;
        if (score > bestScore) {
          bestScore = score;
        }
      }
    });
  
    return bestScore;
  }
};