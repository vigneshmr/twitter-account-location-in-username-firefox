// Cache for user locations - persistent storage
let locationCache = new Map();
const CACHE_KEY = 'twitter_location_cache';
const CACHE_EXPIRY_DAYS = 30; // Cache for 30 days

// Rate limiting
const requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 2000; // 2 seconds between requests (increased to avoid rate limits)
const MAX_CONCURRENT_REQUESTS = 2; // Reduced concurrent requests
let activeRequests = 0;
let rateLimitResetTime = 0; // Unix timestamp when rate limit resets

// Observer for dynamically loaded content
let observer = null;

// Load cache from persistent storage
async function loadCache() {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    if (result[CACHE_KEY]) {
      const cached = result[CACHE_KEY];
      const now = Date.now();
      
      // Filter out expired entries
      for (const [username, data] of Object.entries(cached)) {
        if (data.expiry && data.expiry > now) {
          locationCache.set(username, data.location);
        }
      }
      console.log(`Loaded ${locationCache.size} cached locations`);
    }
  } catch (error) {
    console.error('Error loading cache:', error);
  }
}

// Save cache to persistent storage
async function saveCache() {
  try {
    const cacheObj = {};
    const now = Date.now();
    const expiry = now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    
    for (const [username, location] of locationCache.entries()) {
      cacheObj[username] = {
        location: location,
        expiry: expiry,
        cachedAt: now
      };
    }
    
    await chrome.storage.local.set({ [CACHE_KEY]: cacheObj });
  } catch (error) {
    console.error('Error saving cache:', error);
  }
}

// Save a single entry to cache
async function saveCacheEntry(username, location) {
  locationCache.set(username, location);
  // Debounce saves - only save every 5 seconds
  if (!saveCache.timeout) {
    saveCache.timeout = setTimeout(async () => {
      await saveCache();
      saveCache.timeout = null;
    }, 5000);
  }
}

// Inject script into page context to access fetch with proper cookies
function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('pageScript.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
  
  // Listen for rate limit info from page script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__rateLimitInfo') {
      rateLimitResetTime = event.data.resetTime;
      const waitTime = event.data.waitTime;
      console.log(`Rate limit detected. Will resume requests in ${Math.ceil(waitTime / 1000 / 60)} minutes`);
    }
  });
}

// Process request queue with rate limiting
async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }
  
  // Check if we're rate limited
  if (rateLimitResetTime > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now < rateLimitResetTime) {
      const waitTime = (rateLimitResetTime - now) * 1000;
      console.log(`Rate limited. Waiting ${Math.ceil(waitTime / 1000 / 60)} minutes...`);
      setTimeout(processRequestQueue, Math.min(waitTime, 60000)); // Check every minute max
      return;
    } else {
      // Rate limit expired, reset
      rateLimitResetTime = 0;
    }
  }
  
  isProcessingQueue = true;
  
  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    
    // Wait if needed to respect rate limit
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    
    const { screenName, resolve, reject } = requestQueue.shift();
    activeRequests++;
    lastRequestTime = Date.now();
    
    // Make the request
    makeLocationRequest(screenName)
      .then(location => {
        resolve(location);
      })
      .catch(error => {
        reject(error);
      })
      .finally(() => {
        activeRequests--;
        // Continue processing queue
        setTimeout(processRequestQueue, 200);
      });
  }
  
  isProcessingQueue = false;
}

// Make actual API request
function makeLocationRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();
    
    // Listen for response via postMessage
    const handler = (event) => {
      // Only accept messages from the page (not from extension)
      if (event.source !== window) return;
      
      if (event.data && 
          event.data.type === '__locationResponse' &&
          event.data.screenName === screenName && 
          event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        const location = event.data.location;
        
        // Cache the result (even if null to avoid repeated failed requests)
        saveCacheEntry(screenName, location || null);
        
        resolve(location || null);
      }
    };
    window.addEventListener('message', handler);
    
    // Send fetch request to page script via postMessage
    window.postMessage({
      type: '__fetchLocation',
      screenName,
      requestId
    }, '*');
    
    // Timeout after 10 seconds
    setTimeout(() => {
      window.removeEventListener('message', handler);
      saveCacheEntry(screenName, null); // Cache null to avoid retrying immediately
      resolve(null);
    }, 10000);
  });
}

// Function to query Twitter GraphQL API for user location (with rate limiting)
async function getUserLocation(screenName) {
  // Check cache first
  if (locationCache.has(screenName)) {
    const cached = locationCache.get(screenName);
    return cached;
  }
  
  // Queue the request
  return new Promise((resolve, reject) => {
    requestQueue.push({ screenName, resolve, reject });
    processRequestQueue();
  });
}

// Function to extract username from various Twitter UI elements
function extractUsername(element) {
  // Try data-testid="UserName" first (most reliable)
  const usernameElement = element.querySelector('[data-testid="UserName"]');
  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1] && 
          match[1] !== 'home' && 
          match[1] !== 'explore' && 
          match[1] !== 'notifications' && 
          match[1] !== 'messages' &&
          match[1] !== 'i' &&
          match[1] !== 'compose' &&
          match[1] !== 'search' &&
          !match[1].startsWith('hashtag')) {
        return match[1];
      }
    }
  }
  
  // Try finding username links in the element
  const usernameLinks = element.querySelectorAll('a[href^="/"]');
  for (const link of usernameLinks) {
    const href = link.getAttribute('href');
    const match = href.match(/^\/([^\/\?]+)/);
    if (match && match[1] && 
        match[1] !== 'home' && 
        match[1] !== 'explore' && 
        match[1] !== 'notifications' && 
        match[1] !== 'messages' &&
        match[1] !== 'i' &&
        match[1] !== 'compose' &&
        match[1] !== 'search' &&
        !match[1].startsWith('hashtag') &&
        !match[1].includes('status')) {
      // Check if this looks like a username (not a route)
      const text = link.textContent?.trim();
      if (text && text.startsWith('@')) {
        return match[1];
      }
      // If link text matches the href, it's likely a username
      if (text && text.toLowerCase() === match[1].toLowerCase()) {
        return match[1];
      }
    }
  }
  
  return null;
}

// Function to add flag to username element
async function addFlagToUsername(usernameElement, screenName) {
  // Check if flag already added
  if (usernameElement.dataset.flagAdded === 'true') {
    return;
  }

  // Mark as processing to avoid duplicate requests
  usernameElement.dataset.flagAdded = 'processing';

  // Get location
  const location = await getUserLocation(screenName);
  if (!location) {
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }

  // Get flag emoji
  const flag = getCountryFlag(location);
  if (!flag) {
    console.log(`No flag found for location: ${location}`);
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }

  // Find the username link - try multiple strategies
  let usernameLink = null;
  
  // Strategy 1: Find link with matching href
  const links = usernameElement.querySelectorAll('a[href^="/"]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (href === `/${screenName}` || href.startsWith(`/${screenName}?`)) {
      usernameLink = link;
      break;
    }
  }
  
  // Strategy 2: Find link in UserName container
  if (!usernameLink) {
    const userNameContainer = usernameElement.querySelector('[data-testid="UserName"]');
    if (userNameContainer) {
      usernameLink = userNameContainer.querySelector(`a[href="/${screenName}"], a[href^="/${screenName}?"]`);
    }
  }
  
  // Strategy 3: First link that matches
  if (!usernameLink && links.length > 0) {
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1] === screenName) {
        usernameLink = link;
        break;
      }
    }
  }

  if (!usernameLink) {
    console.log(`Could not find username link for ${screenName}`);
    usernameElement.dataset.flagAdded = 'failed';
    return;
  }

  // Check if flag already exists
  const existingFlag = usernameLink.parentElement?.querySelector('[data-twitter-flag]');
  if (existingFlag) {
    usernameElement.dataset.flagAdded = 'true';
    return;
  }

  // Add flag emoji after username link
  const flagSpan = document.createElement('span');
  flagSpan.textContent = ` ${flag}`;
  flagSpan.setAttribute('data-twitter-flag', 'true');
  flagSpan.style.marginLeft = '4px';
  flagSpan.style.display = 'inline';
  
  // Insert flag after username link
  if (usernameLink.parentNode) {
    usernameLink.parentNode.insertBefore(flagSpan, usernameLink.nextSibling);
  } else {
    // Fallback: append to username link itself
    usernameLink.appendChild(flagSpan);
  }
  
  // Mark as processed
  usernameElement.dataset.flagAdded = 'true';
  console.log(`Added flag ${flag} for ${screenName} (${location})`);
}

// Function to process all username elements on the page
async function processUsernames() {
  // Find all tweet/article containers and user cells
  const containers = document.querySelectorAll('article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="User-Names"], [data-testid="User-Name"]');
  
  console.log(`Processing ${containers.length} containers for usernames`);
  
  for (const container of containers) {
    const screenName = extractUsername(container);
    if (screenName) {
      const status = container.dataset.flagAdded;
      if (!status || status === 'failed') {
        // Process in parallel but limit concurrency
        addFlagToUsername(container, screenName).catch(err => {
          console.error(`Error processing ${screenName}:`, err);
        });
      }
    }
  }
}

// Initialize observer for dynamically loaded content
function initObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    let shouldProcess = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        shouldProcess = true;
        break;
      }
    }
    
    if (shouldProcess) {
      // Debounce processing
      setTimeout(processUsernames, 500);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// Main initialization
async function init() {
  console.log('Twitter Location Flag extension initialized');
  
  // Load persistent cache first
  await loadCache();
  
  // Inject page script
  injectPageScript();
  
  // Wait a bit for page to fully load
  setTimeout(() => {
    processUsernames();
  }, 2000);
  
  // Set up observer for new content
  initObserver();
  
  // Re-process on navigation (Twitter uses SPA)
  let lastUrl = location.href;
  new MutationObserver(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      console.log('Page navigation detected, reprocessing usernames');
      setTimeout(processUsernames, 2000);
    }
  }).observe(document, { subtree: true, childList: true });
  
  // Save cache periodically
  setInterval(saveCache, 30000); // Save every 30 seconds
}

// Wait for page to load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

