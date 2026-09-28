// DIOMS Share Target Test - Service Worker
// Version: dioms-share-test-v2
const CACHE_NAME = 'dioms-share-test-v2';
const DB_NAME = 'DIOMS_SHARE_TARGET_TEST';
const DB_VERSION = 1;
const STORE_SHARED = 'shared_items';
const STORE_LOGS = 'event_logs';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Helper to open IndexedDB inside Service Worker
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_SHARED)) {
        db.createObjectStore(STORE_SHARED, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        db.createObjectStore(STORE_LOGS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('test_matrix')) {
        db.createObjectStore('test_matrix', { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Log event to IndexedDB
async function logSwEvent(event, details = '', status = 'INFO') {
  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      const store = tx.objectStore(STORE_LOGS);
      store.add({
        timestamp: new Date().toISOString(),
        event,
        details,
        source: 'sw',
        status,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.error('[SW Log Error]', err);
  }
}

// Store shared payload in IndexedDB
async function storeSharedPayload(data) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHARED, 'readwrite');
    const store = tx.objectStore(STORE_SHARED);
    store.put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Notify all active window clients via postMessage
async function notifyClients(message) {
  const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientsList) {
    client.postMessage(message);
  }
}

// Convert Base64 data URI to Blob
function dataURItoBlob(dataURI) {
  try {
    const byteString = atob(dataURI.split(',')[1]);
    const mimeString = dataURI.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
  } catch {
    return null;
  }
}

// Generate image Blob from shared text if no binary image was attached by Android
function textToReceiptBlob(title, text, url) {
  try {
    const canvas = new OffscreenCanvas(400, 500);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, 400, 500);

    ctx.fillStyle = '#2563eb';
    ctx.fillRect(20, 20, 360, 60);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('TEXT SHARE CAPTURED', 200, 55);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';

    let y = 110;
    ctx.fillText(`Title: ${title || '(none)'}`, 30, y);
    y += 25;

    ctx.fillText('Shared Content / URL:', 30, y);
    y += 20;

    const fullContent = (text + ' ' + url).trim();
    const words = fullContent.split(' ');
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const testLine = line + words[i] + ' ';
      if (testLine.length > 35) {
        ctx.fillText(line, 40, y);
        line = words[i] + ' ';
        y += 20;
      } else {
        line = testLine;
      }
    }
    if (line) {
      ctx.fillText(line, 40, y);
    }

    return canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return null;
  }
}

// Installation
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await logSwEvent('Service Worker installing', `Version: ${CACHE_NAME}`, 'INFO');
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(PRECACHE_ASSETS);
        await logSwEvent('Service Worker precache complete', '', 'PASS');
      } catch (err) {
        await logSwEvent('Service Worker precache warning', err.message, 'WARNING');
      }
      await self.skipWaiting();
      await logSwEvent('Service Worker skipWaiting() called', '', 'PASS');
    })()
  );
});

// Activation
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await logSwEvent('Service Worker activating', `Version: ${CACHE_NAME}`, 'INFO');
      const cacheKeys = await caches.keys();
      for (const key of cacheKeys) {
        if (key !== CACHE_NAME) {
          await caches.delete(key);
          await logSwEvent('Old cache pruned', key, 'INFO');
        }
      }
      await self.clients.claim();
      await logSwEvent('Service Worker clients.claim() called - controller active', '', 'PASS');
    })()
  );
});

// Handle Web Share Target POST request
async function handleShareTarget(request) {
  const startTime = Date.now();
  await logSwEvent('Share Target POST detected', `URL: ${request.url}`, 'INFO');

  let formData = null;
  let parseError = null;

  try {
    formData = await request.formData();
    await logSwEvent('formData() successful', `Keys: ${Array.from(formData.keys()).join(', ')}`, 'PASS');
  } catch (err) {
    parseError = err;
    await logSwEvent('formData() failed', err.message || String(err), 'FAIL');
  }

  let file = null;
  let title = '';
  let text = '';
  let url = '';
  let keys = [];

  if (formData) {
    keys = Array.from(formData.keys());
    title = (formData.get('title') || '').toString();
    text = (formData.get('text') || '').toString();
    url = (formData.get('url') || '').toString();

    // 1. Scan all form keys for binary Blob / File objects
    for (const key of keys) {
      const val = formData.get(key);
      if (val instanceof Blob && val.size > 0) {
        file = val;
        await logSwEvent('Binary Blob found in form field', `Key: "${key}" | Size: ${val.size} bytes`, 'PASS');
        break;
      }
    }

    // 2. If no binary Blob, check if text/url/field contains a Base64 data URL
    if (!file) {
      for (const key of keys) {
        const strVal = (formData.get(key) || '').toString();
        if (strVal.includes('data:image/') || strVal.includes('data:application/pdf')) {
          const match = strVal.match(/data:(image\/[a-zA-Z0-9+-]+|application\/pdf);base64,[A-Za-z0-9+/=]+/);
          if (match) {
            file = dataURItoBlob(match[0]);
            if (file) {
              await logSwEvent('Base64 image data extracted from text field', `Key: "${key}" | Size: ${file.size} bytes`, 'PASS');
              break;
            }
          }
        }
      }
    }

    // 3. Fallback: if text or URL was provided without binary file, generate receipt blob representation
    if (!file && (text || url || title)) {
      file = await textToReceiptBlob(title, text, url);
      if (file) {
        await logSwEvent('Text share receipt rendered into image Blob', `Title: "${title}"`, 'INFO');
      }
    }
  }

  if (file) {
    await logSwEvent(
      'File detected in share payload',
      `Name: ${file.name || 'unnamed'} | Type: ${file.type || 'unknown'} | Size: ${file.size} bytes`,
      'PASS'
    );
  } else {
    await logSwEvent(
      'No file found in share payload',
      formData ? `Keys found: [${keys.join(', ')}]` : 'FormData parse failed',
      'WARNING'
    );
  }

  const shareRecordId = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const shareRecord = {
    id: shareRecordId,
    timestamp: new Date().toISOString(),
    title: title || '',
    text: text || '',
    url: url || '',
    fileName: file ? (file.name || (file.type ? `shared-file.${file.type.split('/')[1] || 'bin'}` : 'shared-file')) : null,
    fileType: file ? (file.type || 'application/octet-stream') : null,
    fileSize: file ? file.size : 0,
    fileBlob: file || null,
    source: 'web_share_target',
    requestMethod: 'POST',
    userAgent: navigator.userAgent,
    formDataKeys: keys,
    parseError: parseError ? parseError.message : null,
    durationMs: Date.now() - startTime,
  };

  try {
    await storeSharedPayload(shareRecord);
    await logSwEvent('IndexedDB write successful', `Record ID: ${shareRecordId}`, 'PASS');
  } catch (dbErr) {
    await logSwEvent('IndexedDB write failed', dbErr.message || String(dbErr), 'FAIL');
  }

  // Notify any existing active windows
  await notifyClients({
    type: 'SHARE_RECEIVED',
    payload: {
      id: shareRecord.id,
      timestamp: shareRecord.timestamp,
      title: shareRecord.title,
      text: shareRecord.text,
      url: shareRecord.url,
      fileName: shareRecord.fileName,
      fileType: shareRecord.fileType,
      fileSize: shareRecord.fileSize,
      hasFile: !!file,
    },
  });

  await logSwEvent('Redirecting to /?shared=1', 'HTTP 303 See Other', 'PASS');

  // HTTP 303 redirect compatible with Android Chrome Web Share Target
  return Response.redirect('/?shared=1', 303);
}

// Fetch handler
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Web Share Target intercept
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // 2. Only handle GET requests for caching
  if (event.request.method !== 'GET') {
    return;
  }

  // 3. Ignore non-http schemes
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // 4. Cache-first strategy for precached assets, network fallback
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) {
        return cached;
      }
      try {
        const response = await fetch(event.request);
        return response;
      } catch (err) {
        if (event.request.mode === 'navigate') {
          const indexFallback = await caches.match('/index.html');
          if (indexFallback) return indexFallback;
        }
        throw err;
      }
    })()
  );
});

// Messages from UI
self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data.type === 'PING') {
    event.ports && event.ports[0] && event.ports[0].postMessage({
      type: 'PONG',
      version: CACHE_NAME,
      state: 'active',
      time: new Date().toISOString(),
    });
  }
});
