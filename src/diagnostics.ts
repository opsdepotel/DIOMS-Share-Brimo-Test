/**
 * Diagnostic analysis tools for DIOMS Share Target Test
 */

export interface DeviceDiagnostics {
  userAgent: string;
  platform: string;
  browser: string;
  browserVersion: string;
  os: string;
  screenSize: string;
  language: string;
  isOnline: boolean;
  currentUrl: string;
  isStandalone: boolean;
  standaloneDisplayMode: string;
}

export interface ServiceWorkerDiagnostics {
  supported: boolean;
  registered: boolean;
  controlled: boolean;
  scope: string;
  state: string;
  scriptUrl: string;
  version: string;
  lastPingResponse?: string;
}

export interface ManifestDiagnostics {
  loaded: boolean;
  error?: string;
  name?: string;
  short_name?: string;
  display?: string;
  start_url?: string;
  scope?: string;
  action?: string;
  method?: string;
  enctype?: string;
  acceptedTypes?: string[];
  rawManifest?: Record<string, unknown>;
}

export interface DiagnosticSnapshot {
  timestamp: string;
  device: DeviceDiagnostics;
  serviceWorker: ServiceWorkerDiagnostics;
  manifest: ManifestDiagnostics;
  statusCards: Record<string, 'PASS' | 'WARNING' | 'FAIL'>;
  pipelineStages: {
    name: string;
    description: string;
    status: 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN';
    details: string;
  }[];
  diagnosisSummary: {
    categoryCode: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
    title: string;
    explanation: string;
    recommendation: string;
  };
  latestShareMetadata?: Record<string, unknown> | null;
  recentEventLogs?: unknown[];
}

export function detectBrowserAndOS(ua: string): {
  browser: string;
  browserVersion: string;
  os: string;
} {
  let browser = 'Unknown Browser';
  let browserVersion = '';
  let os = 'Unknown OS';

  // Detect OS
  if (/Android\s([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Android\s([0-9.]+)/i);
    os = `Android ${match ? match[1] : ''}`;
  } else if (/iPhone|iPad|iPod/i.test(ua)) {
    const match = ua.match(/OS\s([0-9_]+)/i);
    os = `iOS ${match ? match[1].replace(/_/g, '.') : ''}`;
  } else if (/Windows NT\s([0-9.]+)/i.test(ua)) {
    os = 'Windows';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    os = 'macOS';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  // Detect Browser
  if (/Edg\/([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Edg\/([0-9.]+)/i);
    browser = 'Microsoft Edge';
    browserVersion = match ? match[1] : '';
  } else if (/Chrome\/([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Chrome\/([0-9.]+)/i);
    browser = 'Google Chrome';
    browserVersion = match ? match[1] : '';
  } else if (/Firefox\/([0-9.]+)/i.test(ua)) {
    const match = ua.match(/Firefox\/([0-9.]+)/i);
    browser = 'Mozilla Firefox';
    browserVersion = match ? match[1] : '';
  } else if (/Version\/([0-9.]+).*Safari/i.test(ua)) {
    const match = ua.match(/Version\/([0-9.]+)/i);
    browser = 'Apple Safari';
    browserVersion = match ? match[1] : '';
  }

  return { browser, browserVersion, os };
}

export function getDeviceDiagnostics(): DeviceDiagnostics {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown';
  const { browser, browserVersion, os } = detectBrowserAndOS(ua);

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true);

  let displayMode = 'browser';
  if (typeof window !== 'undefined') {
    if (window.matchMedia('(display-mode: standalone)').matches) {
      displayMode = 'standalone';
    } else if (window.matchMedia('(display-mode: fullscreen)').matches) {
      displayMode = 'fullscreen';
    } else if (window.matchMedia('(display-mode: minimal-ui)').matches) {
      displayMode = 'minimal-ui';
    } else if (window.matchMedia('(display-mode: browser)').matches) {
      displayMode = 'browser';
    }
  }

  return {
    userAgent: ua,
    platform: typeof navigator !== 'undefined' ? navigator.platform || 'Unknown' : 'Unknown',
    browser,
    browserVersion,
    os,
    screenSize:
      typeof window !== 'undefined'
        ? `${window.innerWidth}×${window.innerHeight} viewport (${window.screen.width}×${window.screen.height} screen)`
        : 'Unknown',
    language: typeof navigator !== 'undefined' ? navigator.language : 'Unknown',
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    currentUrl: typeof window !== 'undefined' ? window.location.href : '',
    isStandalone,
    standaloneDisplayMode: displayMode,
  };
}

export async function getServiceWorkerDiagnostics(): Promise<ServiceWorkerDiagnostics> {
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  if (!supported) {
    return {
      supported: false,
      registered: false,
      controlled: false,
      scope: 'N/A',
      state: 'unsupported',
      scriptUrl: 'N/A',
      version: 'N/A',
    };
  }

  const controlled = !!navigator.serviceWorker.controller;
  let registered = false;
  let scope = 'N/A';
  let state = controlled ? 'activated' : 'unregistered';
  let scriptUrl = controlled ? navigator.serviceWorker.controller?.scriptURL || '' : '';

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      registered = true;
      scope = reg.scope;
      const sw = reg.active || reg.waiting || reg.installing;
      if (sw) {
        state = sw.state;
        scriptUrl = sw.scriptURL;
      }
    }
  } catch (err) {
    console.warn('Error reading SW registration:', err);
  }

  return {
    supported: true,
    registered,
    controlled,
    scope,
    state,
    scriptUrl,
    version: 'dioms-share-test-v1',
  };
}

export async function fetchManifestDiagnostics(): Promise<ManifestDiagnostics> {
  try {
    const res = await fetch('/manifest.json');
    if (!res.ok) {
      return {
        loaded: false,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }
    const manifest = await res.json();
    const shareTarget = manifest.share_target;
    let acceptedTypes: string[] = [];
    if (shareTarget?.params?.files) {
      for (const f of shareTarget.params.files) {
        if (Array.isArray(f.accept)) {
          acceptedTypes.push(...f.accept);
        } else if (typeof f.accept === 'string') {
          acceptedTypes.push(f.accept);
        }
      }
    }

    return {
      loaded: true,
      name: manifest.name,
      short_name: manifest.short_name,
      display: manifest.display,
      start_url: manifest.start_url,
      scope: manifest.scope,
      action: shareTarget?.action,
      method: shareTarget?.method,
      enctype: shareTarget?.enctype,
      acceptedTypes,
      rawManifest: manifest,
    };
  } catch (err: unknown) {
    return {
      loaded: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function evaluateDiagnosticOutcome(params: {
  isStandalone: boolean;
  swControlled: boolean;
  hasSharedParam: boolean;
  latestShare: {
    timestamp: string;
    hasFile: boolean;
    parseError?: string | null;
    requestMethod: string;
  } | null;
  dbWorking: boolean;
}): {
  categoryCode: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I';
  title: string;
  explanation: string;
  recommendation: string;
} {
  const { isStandalone, swControlled, hasSharedParam, latestShare, dbWorking } = params;

  if (!dbWorking) {
    return {
      categoryCode: 'F',
      title: 'IndexedDB write / read failure',
      explanation: 'Browser IndexedDB failed to initialize or execute read/write transactions.',
      recommendation: 'Check browser privacy/incognito restrictions or storage quotas.',
    };
  }

  if (!swControlled) {
    return {
      categoryCode: 'C',
      title: 'Service Worker not controlling page',
      explanation:
        'The Service Worker is not controlling the current scope. A Web Share Target POST cannot be intercepted without an active controller.',
      recommendation: 'Reload the PWA or wait for activation. Ensure Service Worker scope covers "/".',
    };
  }

  // If we arrived via ?shared=1 or have a recent share
  if (latestShare) {
    if (latestShare.parseError) {
      return {
        categoryCode: 'D',
        title: 'request.formData() parsing failed',
        explanation: `Service Worker received the POST, but request.formData() threw: "${latestShare.parseError}".`,
        recommendation:
          'Ensure the multipart payload encoding sent by Android / BRImo complies with standard multipart/form-data.',
      };
    }

    if (!latestShare.hasFile) {
      return {
        categoryCode: 'E',
        title: 'File not included in share payload',
        explanation:
          'The Web Share Target POST was received, but no binary file/image was found in the FormData keys.',
        recommendation:
          'BRImo may be sharing plain text or URL instead of a file stream, or using an unexpected field name.',
      };
    }

    return {
      categoryCode: 'I',
      title: 'Complete Web Share Target flow succeeded!',
      explanation:
        'Android delivered the POST request to the Service Worker, formData() extracted the file, and IndexedDB persisted it for React.',
      recommendation: 'The pipeline works end-to-end on Android 16 with BRImo.',
    };
  }

  // If ?shared=1 was passed in URL but no record in DB
  if (hasSharedParam && !latestShare) {
    return {
      categoryCode: 'H',
      title: 'Redirect arrived, but React cannot retrieve share',
      explanation: 'The URL contained ?shared=1, but no corresponding record was found in IndexedDB.',
      recommendation: 'Check if IndexedDB write completed before redirect or if transaction aborted.',
    };
  }

  // PWA opened without share parameter
  if (isStandalone) {
    return {
      categoryCode: 'B',
      title: 'PWA launched, but no Web Share Target payload was captured.',
      explanation:
        'The PWA is running in standalone mode, but this session was launched normally or Android opened the PWA start_url instead of issuing a POST to /share-target.',
      recommendation:
        'Share a receipt image from BRImo and choose "DIOMS Share Target Test" in the Android Share Sheet.',
    };
  }

  return {
    categoryCode: 'A',
    title: 'PWA running in standard browser tab (Not installed)',
    explanation:
      'Web Share Target requires the PWA to be installed on Android to register with the OS Share Sheet.',
    recommendation: 'Tap Chrome menu (⋮) → "Add to Home screen" / "Install app" on Android 16.',
  };
}

export function exportDiagnosticsAsJson(data: DiagnosticSnapshot): void {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
  a.download = `dioms-share-target-diagnostics-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
