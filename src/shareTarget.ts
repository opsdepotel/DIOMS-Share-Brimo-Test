/**
 * Web Share Target and Service Worker registration coordination
 */

import { addEventLog } from './indexedDb';

export interface SWRegistrationStatus {
  supported: boolean;
  registered: boolean;
  controller: boolean;
  registration: ServiceWorkerRegistration | null;
  error?: string;
}

export async function registerServiceWorker(
  onControllerChange?: () => void,
  onShareReceived?: (data: unknown) => void
): Promise<SWRegistrationStatus> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    await addEventLog('Service Worker unsupported', 'navigator.serviceWorker not found in browser', 'FAIL');
    return {
      supported: false,
      registered: false,
      controller: false,
      registration: null,
      error: 'Service Worker is not supported in this browser.',
    };
  }

  await addEventLog('Service Worker registration started', 'Scope requested: /', 'INFO');

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });

    await addEventLog('Service Worker registered', `Scope: ${registration.scope}`, 'PASS');

    // Listen for controller changes
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      addEventLog('Controller detected', 'Service Worker took control of the page', 'PASS');
      if (onControllerChange) {
        onControllerChange();
      }
    });

    // Listen for postMessages from Service Worker
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SHARE_RECEIVED') {
        addEventLog('Message received from SW', `Share target item: ${event.data.payload?.id}`, 'PASS');
        if (onShareReceived) {
          onShareReceived(event.data.payload);
        }
      }
    });

    // Check if currently controlled
    const isControlled = !!navigator.serviceWorker.controller;
    if (isControlled) {
      await addEventLog('Controller detected', 'Page is currently controlled by Service Worker', 'PASS');
    } else {
      await addEventLog(
        'Controller pending',
        'Service Worker registered but not yet controlling this client (page reload or clients.claim will activate)',
        'WARNING'
      );
    }

    return {
      supported: true,
      registered: true,
      controller: isControlled,
      registration,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await addEventLog('Service Worker registration failed', message, 'FAIL');
    return {
      supported: true,
      registered: false,
      controller: false,
      registration: null,
      error: message,
    };
  }
}

/**
 * Creates a synthetic receipt image Blob for self-testing the Share Target pipeline
 */
export function createSyntheticReceiptBlob(): Promise<Blob> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      // Fallback plain text blob if 2d context unavailable
      resolve(new Blob(['Test Receipt Data'], { type: 'text/plain' }));
      return;
    }

    // Receipt background: crisp white with subtle shadow
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, 400, 600);

    // Header banner
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(20, 20, 360, 80);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BRImo SIMULATED RECEIPT', 200, 55);
    ctx.font = '12px monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('TRANSACTION SUCCESSFUL', 200, 80);

    // Receipt details
    ctx.fillStyle = '#1e293b';
    ctx.textAlign = 'left';
    ctx.font = '14px monospace';

    const lines = [
      '--------------------------------',
      `Date: ${new Date().toLocaleDateString()}`,
      `Time: ${new Date().toLocaleTimeString()}`,
      'Ref: BRIMO-TEST-' + Math.floor(Math.random() * 899999 + 100000),
      '--------------------------------',
      'From: TJATUR SADONO',
      'Bank: BANK BRI (002)',
      'To: DIOMS SHARE TARGET TEST',
      'Account: 1234-****-5678',
      'Amount: IDR 250,000',
      'Fee: IDR 0',
      'Total: IDR 250,000',
      '--------------------------------',
      'Status: BERHASIL / SUCCESS',
      'Channel: BRImo Mobile Banking',
      '--------------------------------',
      'DIOMS Android 16 PWA Test File',
    ];

    let y = 140;
    for (const line of lines) {
      ctx.fillText(line, 40, y);
      y += 24;
    }

    // Barcode representation
    ctx.fillStyle = '#000000';
    for (let x = 60; x < 340; x += (x % 7 === 0 ? 6 : 3)) {
      ctx.fillRect(x, 520, 2, 40);
    }

    canvas.toBlob((blob) => {
      resolve(blob || new Blob(['Fallback Receipt'], { type: 'image/png' }));
    }, 'image/png');
  });
}

/**
 * Execute a test POST to /share-target to test the interception mechanism
 */
export async function simulateShareTargetPost(): Promise<{
  intercepted: boolean;
  status: number;
  redirected: boolean;
  error?: string;
}> {
  await addEventLog('Simulating Web Share Target POST', 'Creating FormData with receipt image', 'INFO');

  const receiptBlob = await createSyntheticReceiptBlob();
  const formData = new FormData();
  formData.append('title', 'BRImo Receipt - Transfer 250,000 IDR');
  formData.append('text', 'Bukti transaksi berhasil via BRImo Mobile');
  formData.append('url', 'https://brimo.bri.co.id');
  formData.append('file', receiptBlob, `brimo_receipt_${Date.now()}.png`);

  try {
    const response = await fetch('/share-target', {
      method: 'POST',
      body: formData,
      redirect: 'manual', // or 'follow'
    });

    await addEventLog(
      'Simulate POST response received',
      `Status: ${response.status} | Type: ${response.type} | Redirected: ${response.redirected}`,
      response.status === 303 || response.type === 'opaqueredirect' || response.ok ? 'PASS' : 'WARNING'
    );

    return {
      intercepted: true,
      status: response.status,
      redirected: response.redirected,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await addEventLog('Simulate POST failed', errorMsg, 'FAIL');
    return {
      intercepted: false,
      status: 0,
      redirected: false,
      error: errorMsg,
    };
  }
}
