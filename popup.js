(() => {
  // Helper function to get elements by ID
  const getEl = id => document.getElementById(id);
  
  // Elements we'll be working with
  const serverTabs = getEl('server-tabs');
  const serverContainers = getEl('server-containers');
  const reminder = getEl('reminder');
  
  // State management
  let activeServerIndex = 0;
  let servers = [];
  let refreshTimers = {};
  
  // Refresh interval in milliseconds
  const REFRESH_INTERVAL = 3000;
  const MAX_VISIBLE_SERVERS = 3;

  // Create styles for torrent display
  const style = document.createElement('style');
  style.textContent = `
    .server-container {
      display: none;
    }
    .server-container.active {
      display: block;
    }
    .torrents-container {
      margin-top: 10px;
      max-height: 300px;
      overflow-y: auto;
      border-top: 1px solid #ddd;
      padding-top: 10px;
    }
    .torrent-item {
      margin-bottom: 8px;
      padding: 8px;
      border-radius: 4px;
      background: #f5f5f5;
    }
    .torrent-name {
      font-weight: bold;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .torrent-progress {
      height: 4px;
      background: #ddd;
      border-radius: 2px;
      margin: 4px 0;
    }
    .torrent-progress-bar {
      height: 100%;
      background: #4285f4;
      border-radius: 2px;
    }
    .torrent-stats {
      display: flex;
      justify-content: space-between;
      font-size: 10px;
      color: #666;
    }
    .torrent-eta {
      font-style: italic;
    }
    .no-torrents {
      text-align: center;
      color: #666;
      padding: 10px;
    }
    @media (prefers-color-scheme: dark) {
      .torrent-item {
        background: #333;
      }
      .torrent-progress {
        background: #555;
      }
      .torrent-stats {
        color: #bbb;
      }
      .torrents-container {
        border-top-color: #444;
      }
    }
  `;
  document.head.appendChild(style);

  function createServerTab(server, index) {
    const tab = document.createElement('div');
    tab.className = `server-tab ${index === activeServerIndex ? 'active' : ''}`;
    tab.setAttribute('data-index', index);
    
    tab.innerHTML = `
      <span class="server-name">Server ${index + 1}</span>
      <a href="${server.url}" class="web-ui-link" target="_deluge_web" title="Open Web UI">⚙️</a>
    `;
    
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('web-ui-link')) return; // Don't switch tabs when clicking web UI link
      switchServer(index);
    });
    
    return tab;
  }

  function createServerContainer(index) {
    const container = document.createElement('div');
    container.className = `server-container ${index === activeServerIndex ? 'active' : ''}`;
    container.setAttribute('data-index', index);
    
    const torrentsContainer = document.createElement('div');
    torrentsContainer.className = 'torrents-container';
    container.appendChild(torrentsContainer);
    
    return container;
  }

  function switchServer(index) {
    // Update active states
    document.querySelectorAll('.server-tab').forEach(tab => {
      tab.classList.toggle('active', parseInt(tab.getAttribute('data-index')) === index);
    });
    document.querySelectorAll('.server-container').forEach(container => {
      container.classList.toggle('active', parseInt(container.getAttribute('data-index')) === index);
    });
    
    activeServerIndex = index;
    
    // Stop all refresh timers and start only the active one
    Object.keys(refreshTimers).forEach(key => {
      clearInterval(refreshTimers[key]);
      delete refreshTimers[key];
    });
    
    // Start fetching data for the active server
    if (servers[index]) {
      fetchTorrentData(index);
      refreshTimers[index] = setInterval(() => fetchTorrentData(index), REFRESH_INTERVAL);
    }
  }

  function updateUI(serverConnections) {
    servers = serverConnections || [];
    
    if (servers.length === 0) {
      reminder.textContent = "Don't forget to configure your server info first!";
      serverTabs.innerHTML = '';
      serverContainers.innerHTML = '';
      return;
    }
    
    reminder.textContent = '';
    
    // Clear existing content
    serverTabs.innerHTML = '';
    serverContainers.innerHTML = '';
    
    // Create tabs and containers for up to MAX_VISIBLE_SERVERS
    const visibleServers = servers.slice(0, MAX_VISIBLE_SERVERS);
    visibleServers.forEach((server, index) => {
      serverTabs.appendChild(createServerTab(server, index));
      serverContainers.appendChild(createServerContainer(index));
    });
    
    // Start data fetching for active server
    switchServer(activeServerIndex);
  }
  
  function fetchTorrentData(serverIndex) {
    const server = servers[serverIndex];
    if (!server) return;
    
    communicator.sendMessage({
      method: "torrent-list",
      url: server.url,
      password: server.pass
    }, response => {
      if (response && response.value) {
        displayTorrents(response.value, serverIndex);
      } else {
        const container = document.querySelector(`.server-container[data-index="${serverIndex}"] .torrents-container`);
        if (container) {
          container.innerHTML = '<div class="no-torrents">Could not retrieve torrent data</div>';
        }
      }
    });
  }
  
  function displayTorrents(torrents, serverIndex) {
    const container = document.querySelector(`.server-container[data-index="${serverIndex}"] .torrents-container`);
    if (!container) return;
    
    if (!torrents || torrents.length === 0) {
      container.innerHTML = '<div class="no-torrents">No active torrents</div>';
      return;
    }
    
    // Sort torrents: downloading first, then by progress
    torrents.sort((a, b) => {
      if (a.state === 'Downloading' && b.state !== 'Downloading') return -1;
      if (a.state !== 'Downloading' && b.state === 'Downloading') return 1;
      return b.progress - a.progress;
    });
    
    // Limit to top 5 torrents
    const topTorrents = torrents.slice(0, 5);
    
    // Create HTML for each torrent
    const html = topTorrents.map(torrent => {
      const progress = Math.round(torrent.progress * 100);
      const speedDown = formatSpeed(torrent.download_speed);
      const speedUp = formatSpeed(torrent.upload_speed);
      const eta = formatEta(torrent.eta);
      
      return `
        <div class="torrent-item">
          <div class="torrent-name" title="${torrent.name}">${torrent.name}</div>
          <div class="torrent-progress">
            <div class="torrent-progress-bar" style="width: ${progress}%"></div>
          </div>
          <div class="torrent-stats">
            <div class="torrent-speed">↓ ${speedDown} ↑ ${speedUp}</div>
            <div class="torrent-state">${torrent.state}</div>
            <div class="torrent-eta">${eta}</div>
          </div>
        </div>
      `;
    }).join('');
    
    container.innerHTML = html + 
      `<div class="no-torrents">Showing ${topTorrents.length} of ${torrents.length} torrents</div>`;
  }
  
  // Helper functions for formatting
  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec) return '0 KB/s';
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let value = bytesPerSec;
    let unitIndex = 0;
    
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    
    return value.toFixed(1) + ' ' + units[unitIndex];
  }
  
  function formatEta(seconds) {
    if (!seconds || seconds < 0) return 'ΞΞ';
    if (seconds === 0) return 'Done';
    
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
    return `${remainingSeconds}s`;
  }

  // Initialize communication and get server info
  communicator.observeConnect(() => {
    // Function to fetch and update server info
    const updateServerInfo = () => {
      communicator.sendMessage({
        method: "storage-get-connections"
      }, response => {
        try {
          updateUI(response?.value);
        } catch (e) {
          debugLog('error', 'Error getting server info:', e);
          updateUI(null);
        }
      });
    };

    // Initial update
    updateServerInfo();
    
    // Set up cleanup when popup closes
    window.addEventListener('unload', () => {
      Object.keys(refreshTimers).forEach(key => {
        clearInterval(refreshTimers[key]);
      });
      refreshTimers = {};
    });
  }).init('popup');
})();
