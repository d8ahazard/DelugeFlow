(() => {
  // Helper function to get elements by ID
  const getEl = id => document.getElementById(id);
  
  // Elements we'll be working with
  const serverUrlDiv = getEl('server-url');
  const serverUrlLink = getEl('server-url-link');
  const reminder = getEl('reminder');
  const torrentsContainer = getEl('torrents') || document.createElement('div');
  
  // Refresh interval in milliseconds
  const REFRESH_INTERVAL = 3000;
  let refreshTimer = null;
  
  // If torrents container doesn't exist, create and add it
  if (!getEl('torrents')) {
    torrentsContainer.id = 'torrents';
    torrentsContainer.className = 'torrents-container';
    document.querySelector('body > div').appendChild(torrentsContainer);
    
    // Add styles for torrent display
    const style = document.createElement('style');
    style.textContent = `
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
  }

  function updateUI(serverUrl) {
    if (serverUrl) {
      serverUrlDiv.classList.remove('hidden');
      serverUrlLink.href = serverUrl;
      reminder.textContent = '';
      
      // Get torrent data if we have a valid server
      fetchTorrentData();
      
      // Set up periodic refresh
      if (!refreshTimer) {
        refreshTimer = setInterval(() => {
          fetchTorrentData();
        }, REFRESH_INTERVAL);
      }
    } else {
      serverUrlDiv.classList.add('hidden');
      serverUrlLink.removeAttribute('href');
      reminder.textContent = "Don't forget to configure your server info first!";
      torrentsContainer.innerHTML = '';
      
      // Clear refresh timer if no server
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }
  }
  
  function fetchTorrentData() {
    communicator.sendMessage({
      method: "torrent-list"
    }, response => {
      if (response && response.value) {
        displayTorrents(response.value);
      } else {
        torrentsContainer.innerHTML = '<div class="no-torrents">Could not retrieve torrent data</div>';
      }
    });
  }
  
  function displayTorrents(torrents) {
    if (!torrents || torrents.length === 0) {
      torrentsContainer.innerHTML = '<div class="no-torrents">No active torrents</div>';
      return;
    }
    
    // Sort torrents: downloading first, then by progress
    torrents.sort((a, b) => {
      // Downloading torrents first
      if (a.state === 'Downloading' && b.state !== 'Downloading') return -1;
      if (a.state !== 'Downloading' && b.state === 'Downloading') return 1;
      // Then by progress
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
    
    torrentsContainer.innerHTML = html + 
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

  // Remove focus from links after clicking
  document.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', e => e.target.blur());
  });

  // Initialize communication and get server info
  communicator.observeConnect(() => {
    // Function to fetch and update server info
    const updateServerInfo = () => {
      communicator.sendMessage({
        method: "storage-get-connections"
      }, response => {
        try {
          const serverUrl = response?.value?.[0]?.url;
          updateUI(serverUrl);
        } catch (e) {
          debugLog('error', 'Error getting server URL:', e);
          updateUI(null);
        }
      });
    };

    // Initial update
    updateServerInfo();
    
    // Set up cleanup when popup closes
    window.addEventListener('unload', () => {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    });
  }).init('popup');
})();
