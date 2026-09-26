/**
 * IndexedDB storage for DIOMS Share Target Test
 * Database: DIOMS_SHARE_TARGET_TEST
 * Stores: shared_items, event_logs, test_matrix
 */

export const DB_NAME = 'DIOMS_SHARE_TARGET_TEST';
export const DB_VERSION = 1;
export const STORE_SHARED = 'shared_items';
export const STORE_LOGS = 'event_logs';
export const STORE_MATRIX = 'test_matrix';

export interface SharedItem {
  id: string;
  timestamp: string;
  title: string;
  text: string;
  url: string;
  fileName: string | null;
  fileType: string | null;
  fileSize: number;
  fileBlob: Blob | null;
  source: string;
  requestMethod: string;
  userAgent: string;
  formDataKeys?: string[];
  parseError?: string | null;
  durationMs?: number;
}

export interface EventLog {
  id?: number;
  timestamp: string;
  event: string;
  details?: string;
  source: 'sw' | 'client';
  status?: 'PASS' | 'WARNING' | 'FAIL' | 'INFO';
}

export interface TestMatrixEntry {
  id: string;
  title: string;
  expected: string;
  actual?: string;
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
}

let dbInstance: IDBDatabase | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not supported in this browser.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_SHARED)) {
        db.createObjectStore(STORE_SHARED, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        db.createObjectStore(STORE_LOGS, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_MATRIX)) {
        db.createObjectStore(STORE_MATRIX, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

// Save shared item
export async function saveSharedItem(item: SharedItem): Promise<string> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHARED, 'readwrite');
    const store = tx.objectStore(STORE_SHARED);
    store.put(item);
    tx.oncomplete = () => resolve(item.id);
    tx.onerror = () => reject(tx.error);
  });
}

// Get latest share item
export async function getLatestShare(): Promise<SharedItem | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHARED, 'readonly');
    const store = tx.objectStore(STORE_SHARED);
    const request = store.openCursor(null, 'prev'); // cursor in descending order

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        resolve(cursor.value as SharedItem);
      } else {
        resolve(null);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

// Get all shared items
export async function getAllShares(): Promise<SharedItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHARED, 'readonly');
    const store = tx.objectStore(STORE_SHARED);
    const request = store.getAll();

    request.onsuccess = () => {
      const items = (request.result || []) as SharedItem[];
      // Sort newest first
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      resolve(items);
    };

    request.onerror = () => reject(request.error);
  });
}

// Clear all shares
export async function clearAllShares(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHARED, 'readwrite');
    const store = tx.objectStore(STORE_SHARED);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Add event log
export async function addEventLog(
  event: string,
  details: string = '',
  status: 'PASS' | 'WARNING' | 'FAIL' | 'INFO' = 'INFO',
  source: 'sw' | 'client' = 'client'
): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      const store = tx.objectStore(STORE_LOGS);
      store.add({
        timestamp: new Date().toISOString(),
        event,
        details,
        source,
        status,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (err) {
    console.warn('Could not record event log to IndexedDB:', err);
  }
}

// Get all event logs
export async function getAllEventLogs(): Promise<EventLog[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOGS, 'readonly');
    const store = tx.objectStore(STORE_LOGS);
    const request = store.getAll();

    request.onsuccess = () => {
      const logs = (request.result || []) as EventLog[];
      // Sort newest first
      logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      resolve(logs);
    };

    request.onerror = () => reject(request.error);
  });
}

// Clear event logs
export async function clearEventLogs(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LOGS, 'readwrite');
    const store = tx.objectStore(STORE_LOGS);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Test IndexedDB write & read
export async function testIndexedDB(): Promise<{
  success: boolean;
  durationMs: number;
  error?: string;
  recordCount: number;
}> {
  const t0 = performance.now();
  try {
    const db = await openDB();
    const testKey = `test-${Date.now()}`;
    // Write test record to STORE_LOGS
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_LOGS, 'readwrite');
      const store = tx.objectStore(STORE_LOGS);
      store.add({
        timestamp: new Date().toISOString(),
        event: 'IndexedDB Self-Test',
        details: `Diagnostic verification probe [${testKey}]`,
        source: 'client',
        status: 'PASS',
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Count records
    const count = await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE_SHARED, 'readonly');
      const store = tx.objectStore(STORE_SHARED);
      const req = store.count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const durationMs = Math.round(performance.now() - t0);
    return { success: true, durationMs, recordCount: count };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - t0);
    return {
      success: false,
      durationMs,
      error: err instanceof Error ? err.message : String(err),
      recordCount: 0,
    };
  }
}

// Get test matrix entries
export async function getTestMatrix(): Promise<Record<string, TestMatrixEntry>> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_MATRIX, 'readonly');
      const store = tx.objectStore(STORE_MATRIX);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result || []) as TestMatrixEntry[];
        const map: Record<string, TestMatrixEntry> = {};
        for (const item of list) {
          map[item.id] = item;
        }
        resolve(map);
      };
      req.onerror = () => resolve({});
    });
  } catch {
    return {};
  }
}

// Save single test matrix entry
export async function saveTestMatrixEntry(entry: TestMatrixEntry): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MATRIX, 'readwrite');
    const store = tx.objectStore(STORE_MATRIX);
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
