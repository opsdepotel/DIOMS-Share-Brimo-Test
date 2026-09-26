/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Share2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  HelpCircle,
  RefreshCw,
  Download,
  Copy,
  Trash2,
  Smartphone,
  Database,
  FileText,
  Image as ImageIcon,
  Sliders,
  ExternalLink,
  ArrowDown,
  Play,
  Info,
  Check,
  Code,
  Terminal,
} from 'lucide-react';
import {
  openDB,
  getLatestShare,
  getAllShares,
  clearAllShares,
  getAllEventLogs,
  clearEventLogs,
  addEventLog,
  testIndexedDB,
  getTestMatrix,
  saveTestMatrixEntry,
  type SharedItem,
  type EventLog,
  type TestMatrixEntry,
} from './indexedDb';
import {
  getDeviceDiagnostics,
  getServiceWorkerDiagnostics,
  fetchManifestDiagnostics,
  evaluateDiagnosticOutcome,
  exportDiagnosticsAsJson,
  type DeviceDiagnostics,
  type ServiceWorkerDiagnostics,
  type ManifestDiagnostics,
  type DiagnosticSnapshot,
} from './diagnostics';
import { registerServiceWorker, simulateShareTargetPost } from './shareTarget';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

const DEFAULT_MATRIX_ITEMS = [
  { id: 't1', title: '1. Open PWA normally', expected: 'App opens in browser / standalone' },
  { id: 't2', title: '2. Install PWA', expected: 'PWA icon added to Android Home / Drawer' },
  { id: 't3', title: '3. Service Worker registered', expected: 'Service Worker active at scope /' },
  { id: 't4', title: '4. Service Worker controls page', expected: 'navigator.serviceWorker.controller is truthy' },
  { id: 't5', title: '5. Standalone mode', expected: 'display-mode: standalone detected' },
  { id: 't6', title: '6. Share text from Chrome', expected: 'POST /share-target receives title/text/url' },
  { id: 't7', title: '7. Share image from Gallery', expected: 'POST /share-target receives image/jpeg or png' },
  { id: 't8', title: '8. Share image from BRImo', expected: 'POST /share-target receives BRImo receipt image' },
  { id: 't9', title: '9. Share while PWA is closed', expected: 'Android launches PWA & executes SW POST' },
  { id: 't10', title: '10. Share while PWA is already open', expected: 'PWA window receives share via redirect or message' },
];

export default function App() {
  const [deviceInfo, setDeviceInfo] = useState<DeviceDiagnostics>(getDeviceDiagnostics());
  const [swInfo, setSwInfo] = useState<ServiceWorkerDiagnostics>({
    supported: false,
    registered: false,
    controlled: false,
    scope: 'Loading...',
    state: 'initial',
    scriptUrl: '',
    version: 'dioms-share-test-v1',
  });
  const [manifestInfo, setManifestInfo] = useState<ManifestDiagnostics>({ loaded: false });
  const [latestShare, setLatestShare] = useState<SharedItem | null>(null);
  const [allShares, setAllShares] = useState<SharedItem[]>([]);
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [dbWorking, setDbWorking] = useState<boolean>(true);
  const [dbTestResult, setDbTestResult] = useState<string | null>(null);
  const [debugMode, setDebugMode] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [simulating, setSimulating] = useState<boolean>(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstallable, setIsInstallable] = useState<boolean>(false);
  const [testMatrix, setTestMatrix] = useState<Record<string, TestMatrixEntry>>({});

  // Image preview state
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Check URL parameters
  const [hasSharedParam, setHasSharedParam] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.location.search.includes('shared=1');
    }
    return false;
  });

  // Load and refresh all diagnostic data
  const refreshDiagnostics = useCallback(async () => {
    setIsLoading(true);
    try {
      const dev = getDeviceDiagnostics();
      setDeviceInfo(dev);

      const sw = await getServiceWorkerDiagnostics();
      setSwInfo(sw);

      const mf = await fetchManifestDiagnostics();
      setManifestInfo(mf);

      const dbRes = await testIndexedDB();
      setDbWorking(dbRes.success);
      setDbTestResult(
        dbRes.success
          ? `IndexedDB OK (${dbRes.durationMs}ms, ${dbRes.recordCount} shared records)`
          : `IndexedDB Error: ${dbRes.error}`
      );

      const latest = await getLatestShare();
      setLatestShare(latest);

      const all = await getAllShares();
      setAllShares(all);

      const logs = await getAllEventLogs();
      setEventLogs(logs);

      const matrixMap = await getTestMatrix();
      setTestMatrix(matrixMap);
    } catch (err) {
      console.error('Diagnostic refresh failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Set up preview URL when latestShare changes
  useEffect(() => {
    if (latestShare?.fileBlob && latestShare.fileType?.startsWith('image/')) {
      const url = URL.createObjectURL(latestShare.fileBlob);
      setPreviewUrl(url);
      return () => {
        URL.revokeObjectURL(url);
      };
    } else {
      setPreviewUrl(null);
    }
  }, [latestShare]);

  // Initial startup routine conforming to Section 9:
  // 1. Register SW
  // 2. Check SW registration
  // 3. Check SW controller
  // 4. Check IndexedDB
  // 5. Check manifest
  // 6. Detect standalone mode
  // 7. Detect browser info
  // 8. Check whether URL contains ?shared=1
  useEffect(() => {
    let mounted = true;

    async function initialize() {
      await addEventLog('PWA loaded', `URL: ${window.location.href}`, 'INFO');

      // Before install prompt handler
      const handleBeforeInstall = (e: Event) => {
        e.preventDefault();
        setDeferredPrompt(e as BeforeInstallPromptEvent);
        setIsInstallable(true);
        addEventLog('Install prompt available', 'beforeinstallprompt event fired', 'PASS');
      };
      window.addEventListener('beforeinstallprompt', handleBeforeInstall);

      window.addEventListener('appinstalled', () => {
        setIsInstallable(false);
        setDeferredPrompt(null);
        addEventLog('App installed successfully', 'appinstalled event fired', 'PASS');
        refreshDiagnostics();
      });

      // Register Service Worker
      await registerServiceWorker(
        () => {
          if (mounted) refreshDiagnostics();
        },
        async () => {
          if (mounted) {
            await refreshDiagnostics();
          }
        }
      );

      // Check URL for ?shared=1
      if (window.location.search.includes('shared=1')) {
        setHasSharedParam(true);
        await addEventLog(
          'Share target redirect detected',
          'URL contains ?shared=1. Retrieving latest IndexedDB record.',
          'PASS'
        );
        // Clean up URL parameter cleanly without page reload
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      await refreshDiagnostics();
    }

    initialize();

    // Periodic check or visibilitychange check
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshDiagnostics();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refreshDiagnostics]);

  // Install PWA trigger
  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        addEventLog('User accepted PWA installation', '', 'PASS');
        setIsInstallable(false);
      } else {
        addEventLog('User dismissed PWA installation', '', 'WARNING');
      }
      setDeferredPrompt(null);
    } catch (err) {
      console.error('Install prompt error:', err);
    }
  };

  // Test service worker communication
  const handleTestServiceWorker = async () => {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      alert('Service Worker is not currently controlling this page. Please reload or wait a moment.');
      return;
    }
    const messageChannel = new MessageChannel();
    messageChannel.port1.onmessage = (event) => {
      if (event.data?.type === 'PONG') {
        addEventLog('SW Ping/Pong Succeeded', `Version: ${event.data.version} | State: ${event.data.state}`, 'PASS');
        refreshDiagnostics();
      }
    };
    navigator.serviceWorker.controller.postMessage({ type: 'PING' }, [messageChannel.port2]);
  };

  // Test IndexedDB write/read directly
  const handleTestIndexedDb = async () => {
    const res = await testIndexedDB();
    if (res.success) {
      await addEventLog('IndexedDB Test Passed', `Latency: ${res.durationMs}ms`, 'PASS');
    } else {
      await addEventLog('IndexedDB Test Failed', res.error || 'Unknown error', 'FAIL');
    }
    refreshDiagnostics();
  };

  // Simulate Share Target POST
  const handleSimulatePost = async () => {
    setSimulating(true);
    try {
      const res = await simulateShareTargetPost();
      if (res.intercepted) {
        await refreshDiagnostics();
      }
    } finally {
      setSimulating(false);
    }
  };

  // Clear all shares
  const handleClearShares = async () => {
    await clearAllShares();
    await addEventLog('Share data cleared', 'All test share records removed from IndexedDB', 'INFO');
    await refreshDiagnostics();
  };

  // Clear event logs
  const handleClearLogs = async () => {
    await clearEventLogs();
    setEventLogs([]);
    await addEventLog('Event log cleared', 'Ready for new diagnostic events', 'INFO');
    refreshDiagnostics();
  };

  // Update test matrix item status
  const handleMatrixChange = async (id: string, newStatus: 'PASS' | 'FAIL' | 'UNKNOWN') => {
    const current = testMatrix[id] || DEFAULT_MATRIX_ITEMS.find((m) => m.id === id);
    if (!current) return;
    const updated: TestMatrixEntry = {
      id,
      title: current.title,
      expected: current.expected,
      status: newStatus,
    };
    setTestMatrix((prev) => ({ ...prev, [id]: updated }));
    await saveTestMatrixEntry(updated);
    await addEventLog(`Matrix updated [${id}]`, `${current.title} → ${newStatus}`, newStatus === 'PASS' ? 'PASS' : 'INFO');
  };

  // Status Cards computation
  const statusCards = useMemo(() => {
    const pwaStatus: 'PASS' | 'WARNING' | 'FAIL' =
      manifestInfo.loaded && swInfo.registered ? 'PASS' : swInfo.supported ? 'WARNING' : 'FAIL';

    const swStatus: 'PASS' | 'WARNING' | 'FAIL' = swInfo.registered ? 'PASS' : swInfo.supported ? 'WARNING' : 'FAIL';

    const controllerStatus: 'PASS' | 'WARNING' | 'FAIL' = swInfo.controlled ? 'PASS' : 'WARNING';

    const idbStatus: 'PASS' | 'WARNING' | 'FAIL' = dbWorking ? 'PASS' : 'FAIL';

    const manifestStatus: 'PASS' | 'WARNING' | 'FAIL' =
      manifestInfo.loaded && manifestInfo.action === '/share-target' ? 'PASS' : manifestInfo.loaded ? 'WARNING' : 'FAIL';

    const standaloneStatus: 'PASS' | 'WARNING' | 'FAIL' = deviceInfo.isStandalone ? 'PASS' : 'WARNING';

    const shareTargetStatus: 'PASS' | 'WARNING' | 'FAIL' =
      latestShare?.fileBlob ? 'PASS' : latestShare ? 'WARNING' : 'UNKNOWN' as unknown as 'WARNING';

    return {
      PWA: pwaStatus,
      'Service Worker': swStatus,
      'Service Worker Controller': controllerStatus,
      IndexedDB: idbStatus,
      Manifest: manifestStatus,
      'Standalone Mode': standaloneStatus,
      'Web Share Target': shareTargetStatus === ('UNKNOWN' as unknown) ? 'WARNING' : shareTargetStatus,
    };
  }, [manifestInfo, swInfo, dbWorking, deviceInfo.isStandalone, latestShare]);

  // Overall Diagnosis (Section 16 & Section 29)
  const diagnosticOutcome = useMemo(() => {
    return evaluateDiagnosticOutcome({
      isStandalone: deviceInfo.isStandalone,
      swControlled: swInfo.controlled,
      hasSharedParam,
      latestShare: latestShare
        ? {
            timestamp: latestShare.timestamp,
            hasFile: !!latestShare.fileBlob,
            parseError: latestShare.parseError,
            requestMethod: latestShare.requestMethod,
          }
        : null,
      dbWorking,
    });
  }, [deviceInfo.isStandalone, swInfo.controlled, hasSharedParam, latestShare, dbWorking]);

  // Share Pipeline Evaluation
  type StageStatus = 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN';
  interface PipelineStage {
    name: string;
    description: string;
    status: StageStatus;
    details: string;
  }

  const pipelineStages: PipelineStage[] = useMemo(() => {
    // 1. BRImo
    const s1: PipelineStage = {
      name: '1. BRImo App',
      description: 'Transaction receipt opened & Share button tapped',
      status: latestShare?.source ? 'PASS' : 'UNKNOWN',
      details: latestShare ? 'Share initiated from external application' : 'Awaiting share action in BRImo',
    };

    // 2. Android Share Sheet
    const s2: PipelineStage = {
      name: '2. Android Share Sheet',
      description: 'OS exposes "DIOMS Share Target Test" to user',
      status: latestShare ? 'PASS' : deviceInfo.isStandalone ? 'PASS' : 'WARNING',
      details: deviceInfo.isStandalone
        ? 'PWA installed; Android OS displays app in share sheet'
        : 'Install PWA so Android adds it to system share targets',
    };

    // 3. Installed PWA
    const s3: PipelineStage = {
      name: '3. Installed PWA',
      description: 'App launches in standalone display mode',
      status: deviceInfo.isStandalone ? 'PASS' : 'WARNING',
      details: deviceInfo.isStandalone
        ? `Running in standalone mode (${deviceInfo.standaloneDisplayMode})`
        : 'Running in browser tab. Real test requires installed standalone mode.',
    };

    // 4. POST /share-target
    const s4: PipelineStage = {
      name: '4. POST /share-target',
      description: 'Android delivers multipart POST to /share-target',
      status: latestShare?.requestMethod === 'POST' ? 'PASS' : hasSharedParam ? 'PASS' : 'UNKNOWN',
      details: latestShare
        ? `Received POST payload (${latestShare.formDataKeys?.length || 0} keys)`
        : 'Waiting for POST request dispatch from OS',
    };

    // 5. Service Worker
    const s5: PipelineStage = {
      name: '5. Service Worker',
      description: 'SW fetch listener intercepts /share-target',
      status: swInfo.controlled ? 'PASS' : swInfo.registered ? 'WARNING' : 'FAIL',
      details: swInfo.controlled
        ? `Controller active (version: ${swInfo.version})`
        : 'Not controlled. Interception requires active controller.',
    };

    // 6. request.formData()
    const s6: PipelineStage = {
      name: '6. request.formData()',
      description: 'Multipart form data parsed by Service Worker',
      status: latestShare?.parseError ? 'FAIL' : latestShare ? 'PASS' : 'UNKNOWN',
      details: latestShare?.parseError
        ? `Parse error: ${latestShare.parseError}`
        : latestShare
        ? `Form data parsed successfully. Title: "${latestShare.title || '(none)'}"`
        : 'Waiting for payload',
    };

    // 7. IndexedDB
    const s7: PipelineStage = {
      name: '7. IndexedDB',
      description: 'Binary file & metadata persisted to shared_items',
      status: latestShare?.id ? 'PASS' : dbWorking ? 'UNKNOWN' : 'FAIL',
      details: latestShare?.id
        ? `Record stored [${latestShare.id}] (${latestShare.fileSize} bytes)`
        : dbWorking
        ? 'Database open & operational'
        : 'IndexedDB write failed',
    };

    // 8. React Application
    const s8: PipelineStage = {
      name: '8. React Application',
      description: 'React loads share record and displays receipt image',
      status: latestShare ? 'PASS' : 'UNKNOWN',
      details: latestShare
        ? `Loaded record into React state at ${new Date(latestShare.timestamp).toLocaleTimeString()}`
        : 'Ready to receive',
    };

    return [s1, s2, s3, s4, s5, s6, s7, s8];
  }, [latestShare, deviceInfo, swInfo, hasSharedParam, dbWorking]);

  // Construct diagnostic snapshot for export
  const buildDiagnosticSnapshot = (): DiagnosticSnapshot => {
    return {
      timestamp: new Date().toISOString(),
      device: deviceInfo,
      serviceWorker: swInfo,
      manifest: manifestInfo,
      statusCards,
      pipelineStages,
      diagnosisSummary: diagnosticOutcome,
      latestShareMetadata: latestShare
        ? {
            id: latestShare.id,
            timestamp: latestShare.timestamp,
            title: latestShare.title,
            text: latestShare.text,
            url: latestShare.url,
            fileName: latestShare.fileName,
            fileType: latestShare.fileType,
            fileSize: latestShare.fileSize,
            source: latestShare.source,
            requestMethod: latestShare.requestMethod,
            userAgent: latestShare.userAgent,
            formDataKeys: latestShare.formDataKeys,
            parseError: latestShare.parseError,
          }
        : null,
      recentEventLogs: eventLogs.slice(0, 30),
    };
  };

  // Copy diagnostics to clipboard
  const handleCopyDiagnostics = async () => {
    const snapshot = buildDiagnosticSnapshot();
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopyFeedback('Diagnostics copied to clipboard!');
      setTimeout(() => setCopyFeedback(null), 3000);
    } catch {
      setCopyFeedback('Failed to copy. Use Export button.');
      setTimeout(() => setCopyFeedback(null), 3000);
    }
  };

  // Export diagnostics as local JSON file
  const handleExportDiagnostics = () => {
    const snapshot = buildDiagnosticSnapshot();
    exportDiagnosticsAsJson(snapshot);
    addEventLog('Diagnostics exported', 'Saved snapshot to local JSON file', 'INFO');
  };

  // Render badge helper
  const renderStatusBadge = (status: 'PASS' | 'WARNING' | 'FAIL' | 'UNKNOWN') => {
    switch (status) {
      case 'PASS':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-700/60">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            PASS
          </span>
        );
      case 'WARNING':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-950 text-amber-300 border border-amber-700/60">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
            WARNING
          </span>
        );
      case 'FAIL':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-950 text-rose-300 border border-rose-700/60">
            <XCircle className="w-3.5 h-3.5 text-rose-400" />
            FAIL
          </span>
        );
      case 'UNKNOWN':
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700">
            <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
            UNKNOWN
          </span>
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 pb-16">
      {/* Top Header */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20 ring-2 ring-blue-400/30">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
                DIOMS Share Target Test
                {deviceInfo.isStandalone && (
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-blue-900/60 text-blue-300 border border-blue-700/50">
                    Standalone
                  </span>
                )}
              </h1>
              <p className="text-xs text-slate-400">Android 16 / Web Share Target Diagnostic</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isInstallable && (
              <button
                onClick={handleInstallClick}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition active:scale-95"
              >
                <Download className="w-3.5 h-3.5" />
                Install App
              </button>
            )}
            <button
              onClick={refreshDiagnostics}
              disabled={isLoading}
              title="Refresh Diagnostics"
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition active:scale-95"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-blue-400' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Core Diagnostic Outcome Alert (Sections 16 & 29) */}
        <div
          className={`rounded-2xl p-5 border shadow-xl transition ${
            diagnosticOutcome.categoryCode === 'I'
              ? 'bg-emerald-950/40 border-emerald-700/70 text-emerald-100'
              : diagnosticOutcome.categoryCode === 'B'
              ? 'bg-amber-950/30 border-amber-600/60 text-amber-100'
              : diagnosticOutcome.categoryCode === 'A'
              ? 'bg-blue-950/30 border-blue-700/60 text-blue-100'
              : 'bg-rose-950/40 border-rose-700/70 text-rose-100'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 p-2 rounded-xl bg-black/30 border border-white/10 shrink-0">
              {diagnosticOutcome.categoryCode === 'I' ? (
                <CheckCircle2 className="w-6 h-6 text-emerald-400" />
              ) : diagnosticOutcome.categoryCode === 'B' || diagnosticOutcome.categoryCode === 'A' ? (
                <Info className="w-6 h-6 text-amber-400" />
              ) : (
                <AlertTriangle className="w-6 h-6 text-rose-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-black/40 border border-white/10">
                  DIAGNOSTIC CATEGORY [{diagnosticOutcome.categoryCode}]
                </span>
                <span className="text-xs text-slate-300">
                  {diagnosticOutcome.categoryCode === 'I'
                    ? 'Success'
                    : diagnosticOutcome.categoryCode === 'B'
                    ? 'PWA Launched Without POST'
                    : 'Action Required'}
                </span>
              </div>
              <h2 className="text-base sm:text-lg font-bold text-white">{diagnosticOutcome.title}</h2>
              <p className="text-sm mt-1 text-slate-300 leading-relaxed">{diagnosticOutcome.explanation}</p>
              <div className="mt-3 text-xs bg-black/40 rounded-lg p-2.5 border border-white/10 text-slate-200">
                <span className="font-semibold text-white">Next Step: </span>
                {diagnosticOutcome.recommendation}
              </div>
            </div>
          </div>
        </div>

        {/* Section 10: Status Cards */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-2">
            <Sliders className="w-3.5 h-3.5 text-blue-400" />
            System Status Cards
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {Object.entries(statusCards).map(([name, status]) => (
              <div
                key={name}
                className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between hover:border-slate-700 transition"
              >
                <div className="text-xs font-medium text-slate-400 mb-2 truncate" title={name}>
                  {name}
                </div>
                <div className="flex items-center justify-between">{renderStatusBadge(status)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Section 14 & 17: Share Received & Raw Payload */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3 flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-950/80 border border-blue-700/50 flex items-center justify-center text-blue-400">
                <Share2 className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-white uppercase tracking-wide">
                  {latestShare ? 'SHARE RECEIVED' : 'Share Target Payload Status'}
                </h2>
                <p className="text-xs text-slate-400">
                  {latestShare
                    ? `Captured at ${new Date(latestShare.timestamp).toLocaleString()}`
                    : 'Awaiting Web Share Target POST from Android 16'}
                </p>
              </div>
            </div>

            {latestShare && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleClearShares}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-xs text-rose-300 hover:text-white bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/50 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear Share
                </button>
              </div>
            )}
          </div>

          {latestShare ? (
            <div className="space-y-4">
              {/* Share details grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">Timestamp:</span>
                  <p className="font-mono text-slate-200">{latestShare.timestamp}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">Request Method:</span>
                  <p className="font-mono text-emerald-400 font-bold">{latestShare.requestMethod}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">Title:</span>
                  <p className="text-slate-200">{latestShare.title || '(empty)'}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">Text:</span>
                  <p className="text-slate-200">{latestShare.text || '(empty)'}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">URL:</span>
                  <p className="text-slate-200 truncate">{latestShare.url || '(empty)'}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">Source:</span>
                  <p className="text-slate-200">{latestShare.source}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">File Name:</span>
                  <p className="font-mono text-slate-200">{latestShare.fileName || 'No file received.'}</p>
                </div>
                <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">File Type & Size:</span>
                  <p className="font-mono text-slate-200">
                    {latestShare.fileType || 'N/A'} ({(latestShare.fileSize / 1024).toFixed(1)} KB)
                  </p>
                </div>
                <div className="sm:col-span-2 bg-slate-950/70 p-3 rounded-xl border border-slate-800/80 space-y-1">
                  <span className="text-slate-400 font-medium">User Agent:</span>
                  <p className="font-mono text-[11px] text-slate-300 break-all">{latestShare.userAgent}</p>
                </div>
              </div>

              {/* Image Preview / PDF Notice / No File */}
              <div className="bg-slate-950/80 rounded-xl p-4 border border-slate-800">
                <h3 className="text-xs font-bold uppercase text-slate-400 mb-3 flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-blue-400" />
                  Received File Preview
                </h3>

                {previewUrl ? (
                  <div className="space-y-3">
                    <div className="max-w-md mx-auto bg-black rounded-lg overflow-hidden border border-slate-700 shadow-inner flex items-center justify-center p-2">
                      <img
                        src={previewUrl}
                        alt="Shared receipt preview"
                        className="max-h-96 w-auto object-contain rounded"
                      />
                    </div>
                    <div className="text-center">
                      <a
                        href={previewUrl}
                        download={latestShare.fileName || 'receipt.png'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg shadow transition"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download Received File
                      </a>
                    </div>
                  </div>
                ) : latestShare.fileType === 'application/pdf' ? (
                  <div className="p-4 bg-blue-950/30 border border-blue-800/60 rounded-lg text-center space-y-2">
                    <FileText className="w-10 h-10 text-blue-400 mx-auto" />
                    <p className="text-sm font-semibold text-white">PDF received successfully</p>
                    <p className="text-xs text-slate-400 font-mono">
                      {latestShare.fileName} ({latestShare.fileSize} bytes)
                    </p>
                  </div>
                ) : !latestShare.fileBlob ? (
                  <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg text-center">
                    <p className="text-xs text-amber-400 font-medium">No file received.</p>
                    <p className="text-[11px] text-slate-400 mt-1">
                      The share target triggered, but no file binary was attached to the form payload.
                    </p>
                  </div>
                ) : (
                  <div className="p-4 bg-slate-900 border border-slate-800 rounded-lg text-center">
                    <p className="text-xs text-slate-300">
                      Binary file received: <span className="font-mono text-white">{latestShare.fileName}</span> ({latestShare.fileType})
                    </p>
                  </div>
                )}
              </div>

              {/* Section 17: Raw Share Payload (Metadata-only JSON, NEVER Base64) */}
              <div>
                <h3 className="text-xs font-bold uppercase text-slate-400 mb-2 flex items-center gap-1.5">
                  <Code className="w-3.5 h-3.5 text-blue-400" />
                  Raw Share Payload (Metadata Representation)
                </h3>
                <pre className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 text-[11px] font-mono text-emerald-400 overflow-x-auto leading-relaxed">
                  {JSON.stringify(
                    {
                      title: latestShare.title,
                      text: latestShare.text,
                      url: latestShare.url,
                      fileName: latestShare.fileName,
                      fileType: latestShare.fileType,
                      fileSize: `${latestShare.fileSize} bytes`,
                      timestamp: latestShare.timestamp,
                      requestMethod: latestShare.requestMethod,
                      source: latestShare.source,
                      formDataKeys: latestShare.formDataKeys,
                      parseError: latestShare.parseError,
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            </div>
          ) : (
            <div className="p-6 bg-slate-950/60 rounded-xl border border-slate-800/80 text-center space-y-2">
              <p className="text-sm font-semibold text-amber-300">
                PWA launched, but no Web Share Target payload was captured.
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">
                If you just shared from BRImo, either Android did not deliver the POST request to the Service Worker, or the
                PWA opened normally via its launcher icon.
              </p>
              <div className="pt-2">
                <button
                  onClick={handleSimulatePost}
                  disabled={simulating}
                  className="inline-flex items-center gap-2 px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium transition"
                >
                  <Play className="w-3.5 h-3.5 text-blue-400" />
                  {simulating ? 'Simulating POST...' : 'Simulate POST /share-target (Local Test)'}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Section 15: Share Pipeline Visualizer */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-lg space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-3">
            <div>
              <h2 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-blue-400" />
                Share Pipeline (End-to-End Tracing)
              </h2>
              <p className="text-xs text-slate-400">
                Identifies precisely where the Android 16 Web Share Target delivery succeeds or halts
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {pipelineStages.map((stage, idx) => (
              <div
                key={stage.name}
                className="bg-slate-950/80 rounded-xl p-3 border border-slate-800/90 flex items-start justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">{stage.name}</span>
                    <span className="text-[11px] text-slate-400 hidden sm:inline">— {stage.description}</span>
                  </div>
                  <p className="text-xs text-slate-300 font-mono">{stage.details}</p>
                </div>
                <div className="shrink-0">{renderStatusBadge(stage.status)}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Diagnostics Tabs / Collapsibles */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Section 11: Device Diagnostics */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Smartphone className="w-4 h-4 text-blue-400" />
              Device Diagnostics
            </h2>
            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Standalone Mode:</span>
                <span className={`font-bold ${deviceInfo.isStandalone ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {deviceInfo.isStandalone ? 'YES' : 'NO'} ({deviceInfo.standaloneDisplayMode})
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Browser:</span>
                <span className="text-slate-200">
                  {deviceInfo.browser} {deviceInfo.browserVersion}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Operating System:</span>
                <span className="text-slate-200">{deviceInfo.os}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Platform:</span>
                <span className="text-slate-200">{deviceInfo.platform}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Screen Size:</span>
                <span className="text-slate-200">{deviceInfo.screenSize}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Language:</span>
                <span className="text-slate-200">{deviceInfo.language}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Online Status:</span>
                <span className={deviceInfo.isOnline ? 'text-emerald-400' : 'text-rose-400'}>
                  {deviceInfo.isOnline ? 'ONLINE' : 'OFFLINE'}
                </span>
              </div>
              <div className="pt-1">
                <span className="text-slate-400 block mb-1">User Agent:</span>
                <p className="text-[10px] text-slate-300 bg-slate-950 p-2 rounded border border-slate-800/80 break-all leading-normal">
                  {deviceInfo.userAgent}
                </p>
              </div>
            </div>
          </div>

          {/* Section 12: Service Worker Diagnostics */}
          <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Database className="w-4 h-4 text-blue-400" />
              Service Worker Diagnostics
            </h2>
            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">SW Supported:</span>
                <span className={swInfo.supported ? 'text-emerald-400' : 'text-rose-400'}>
                  {swInfo.supported ? 'YES' : 'NO'}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Registration:</span>
                <span className={swInfo.registered ? 'text-emerald-400' : 'text-rose-400'}>
                  {swInfo.registered ? 'REGISTERED' : 'NOT REGISTERED'}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Controller:</span>
                <span className={swInfo.controlled ? 'text-emerald-400' : 'text-amber-400'}>
                  {swInfo.controlled ? 'CONTROLLED' : 'NOT CONTROLLED'}
                </span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Scope:</span>
                <span className="text-slate-200">{swInfo.scope}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">State:</span>
                <span className="text-slate-200 capitalize">{swInfo.state}</span>
              </div>
              <div className="flex justify-between border-b border-slate-800/60 pb-1.5">
                <span className="text-slate-400">Version:</span>
                <span className="text-blue-400">{swInfo.version}</span>
              </div>
              <div className="pt-1">
                <span className="text-slate-400 block mb-1">IndexedDB Status:</span>
                <p className="text-[11px] text-slate-300 bg-slate-950 p-2 rounded border border-slate-800/80 font-mono">
                  {dbTestResult || 'Checking IndexedDB...'}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Section 13: Manifest Diagnostics */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-blue-400" />
              Manifest Diagnostics (/manifest.json)
            </h2>
            {manifestInfo.loaded ? (
              <span className="text-xs text-emerald-400 font-mono font-semibold">Valid Manifest</span>
            ) : (
              <span className="text-xs text-rose-400 font-mono font-semibold">
                Error: {manifestInfo.error || 'Failed to fetch'}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">name</span>
              <span className="text-slate-200">{manifestInfo.name || 'N/A'}</span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">short_name</span>
              <span className="text-slate-200">{manifestInfo.short_name || 'N/A'}</span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">display</span>
              <span className="text-emerald-400 font-semibold">{manifestInfo.display || 'N/A'}</span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">scope / start_url</span>
              <span className="text-slate-200">
                {manifestInfo.scope} / {manifestInfo.start_url}
              </span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">share_target.action</span>
              <span className="text-blue-400 font-semibold">{manifestInfo.action || 'N/A'}</span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">share_target.method</span>
              <span className="text-emerald-400 font-semibold">{manifestInfo.method || 'N/A'}</span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">share_target.enctype</span>
              <span className="text-slate-200">{manifestInfo.enctype || 'N/A'}</span>
            </div>
            <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80">
              <span className="text-slate-400 block text-[10px]">files.accept</span>
              <span className="text-slate-200 truncate" title={manifestInfo.acceptedTypes?.join(', ')}>
                {manifestInfo.acceptedTypes?.join(', ') || 'N/A'}
              </span>
            </div>
          </div>
        </section>

        {/* Section 19: Debug Mode Toggle & View */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-blue-400" />
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-300">DEBUG MODE</h2>
                <p className="text-[11px] text-slate-400">Detailed inspection of headers, FormData keys, and SW state</p>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={debugMode}
                onChange={(e) => setDebugMode(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {debugMode && (
            <div className="mt-3 p-4 bg-slate-950 rounded-xl border border-slate-800 text-xs font-mono space-y-2">
              <div className="text-blue-400 font-bold mb-2">// DEBUG PARAMETERS (NO BINARY CONTENTS EXPOSED)</div>
              <div>
                <span className="text-slate-400">Request URL:</span>{' '}
                <span className="text-slate-200">{deviceInfo.currentUrl}</span>
              </div>
              <div>
                <span className="text-slate-400">Intercept Action Target:</span>{' '}
                <span className="text-slate-200">/share-target</span>
              </div>
              <div>
                <span className="text-slate-400">Expected Intercept Method:</span>{' '}
                <span className="text-slate-200">POST</span>
              </div>
              <div>
                <span className="text-slate-400">Expected Content-Type:</span>{' '}
                <span className="text-slate-200">multipart/form-data</span>
              </div>
              <div>
                <span className="text-slate-400">Redirect Target:</span>{' '}
                <span className="text-emerald-400">/?shared=1 (Status: 303 See Other)</span>
              </div>
              <div>
                <span className="text-slate-400">FormData Keys Captured:</span>{' '}
                <span className="text-slate-200">
                  {latestShare?.formDataKeys ? JSON.stringify(latestShare.formDataKeys) : 'None'}
                </span>
              </div>
              <div>
                <span className="text-slate-400">Service Worker Controller State:</span>{' '}
                <span className="text-slate-200">
                  {swInfo.controlled ? 'Active & Intercepting' : 'Inactive / Uncontrolled'}
                </span>
              </div>
              <div>
                <span className="text-slate-400">Total Share Records in IDB:</span>{' '}
                <span className="text-slate-200">{allShares.length}</span>
              </div>
            </div>
          )}
        </section>

        {/* Section 20: Test Buttons */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <Sliders className="w-4 h-4 text-blue-400" />
            Diagnostic Actions & Tools
          </h2>
          <div className="flex flex-wrap gap-2.5">
            <button
              onClick={handleTestServiceWorker}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              <Database className="w-3.5 h-3.5 text-blue-400" />
              Test Service Worker
            </button>
            <button
              onClick={handleTestIndexedDb}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              <Database className="w-3.5 h-3.5 text-emerald-400" />
              Test IndexedDB
            </button>
            <button
              onClick={refreshDiagnostics}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
              Refresh Diagnostics
            </button>
            <button
              onClick={handleClearShares}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-rose-300 border border-slate-700 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Test Data
            </button>
            <button
              onClick={handleClearLogs}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Event Log
            </button>
            <button
              onClick={handleCopyDiagnostics}
              className="px-3.5 py-2 rounded-xl bg-blue-900/60 hover:bg-blue-800/80 text-blue-200 border border-blue-700/60 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              {copyFeedback ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copyFeedback || 'Copy Diagnostics'}
            </button>
            <button
              onClick={handleExportDiagnostics}
              className="px-3.5 py-2 rounded-xl bg-emerald-900/60 hover:bg-emerald-800/80 text-emerald-200 border border-emerald-700/60 text-xs font-semibold shadow-sm transition active:scale-95 flex items-center gap-1.5"
            >
              <Download className="w-3.5 h-3.5" />
              Export Diagnostics (JSON)
            </button>
          </div>
        </section>

        {/* Section 18: Event Log */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800/80 pb-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Terminal className="w-4 h-4 text-blue-400" />
              Real-Time Event Log
            </h2>
            <button
              onClick={handleClearLogs}
              className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              Clear Log
            </button>
          </div>

          <div className="bg-slate-950 rounded-xl p-3 border border-slate-800 max-h-64 overflow-y-auto space-y-1.5 font-mono text-xs">
            {eventLogs.length > 0 ? (
              eventLogs.map((log, index) => (
                <div key={index} className="flex items-start gap-2 py-0.5 border-b border-slate-900 last:border-0">
                  <span className="text-slate-500 text-[10px] shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={`px-1.5 py-0.2 rounded text-[10px] font-bold uppercase shrink-0 ${
                      log.status === 'PASS'
                        ? 'bg-emerald-950 text-emerald-400'
                        : log.status === 'WARNING'
                        ? 'bg-amber-950 text-amber-400'
                        : log.status === 'FAIL'
                        ? 'bg-rose-950 text-rose-400'
                        : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {log.source || 'client'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold text-slate-200">{log.event}</span>
                    {log.details && <span className="text-slate-400 ml-1.5">— {log.details}</span>}
                  </div>
                </div>
              ))
            ) : (
              <div className="text-slate-500 text-center py-4">No events logged yet.</div>
            )}
          </div>
        </section>

        {/* Section 22: Test Matrix */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-3">
          <div className="border-b border-slate-800/80 pb-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Android 16 Test Matrix
            </h2>
            <p className="text-xs text-slate-400">
              Interactive verification matrix for diagnosing Web Share Target test scenarios
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2.5 px-3 font-semibold">Test Case</th>
                  <th className="py-2.5 px-3 font-semibold hidden sm:table-cell">Expected Result</th>
                  <th className="py-2.5 px-3 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-850">
                {DEFAULT_MATRIX_ITEMS.map((item) => {
                  const currentStatus = testMatrix[item.id]?.status || 'UNKNOWN';
                  return (
                    <tr key={item.id} className="hover:bg-slate-800/40 transition">
                      <td className="py-2.5 px-3 font-medium text-slate-200">
                        {item.title}
                        <div className="text-[11px] text-slate-400 sm:hidden mt-0.5">{item.expected}</div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-400 hidden sm:table-cell">{item.expected}</td>
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-1">
                          {(['PASS', 'FAIL', 'UNKNOWN'] as const).map((s) => (
                            <button
                              key={s}
                              onClick={() => handleMatrixChange(item.id, s)}
                              className={`px-2 py-1 rounded text-[10px] font-bold tracking-wider transition ${
                                currentStatus === s
                                  ? s === 'PASS'
                                    ? 'bg-emerald-600 text-white shadow'
                                    : s === 'FAIL'
                                    ? 'bg-rose-600 text-white shadow'
                                    : 'bg-slate-700 text-white'
                                  : 'bg-slate-950 text-slate-400 hover:text-slate-200 border border-slate-850'
                              }`}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 21: Manual BRImo Test Instructions */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4">
          <div className="border-b border-slate-800/80 pb-2">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Smartphone className="w-4 h-4 text-blue-400" />
              HOW TO TEST WITH BRImo (STEP-BY-STEP)
            </h2>
          </div>

          <div className="space-y-2 text-xs text-slate-300 leading-relaxed font-mono">
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">1.</span> Deploy this PWA to Vercel (or open via HTTPS).
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">2.</span> Open the HTTPS URL using Google Chrome on Android 16.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">3.</span> Install it using: Chrome → ⋮ → Add to Home screen / Install app.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">4.</span> Open the installed PWA once from the Android Home Screen or App Drawer.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">5.</span> Close the PWA completely (swipe away from Android Recents).
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">6.</span> Open the BRImo application.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">7.</span> Open a receipt / nota transaksi (Transfer, QRIS, etc.).
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">8.</span> Tap the Share (Bagikan) button in BRImo.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">9.</span> In the Android system Share Sheet, select "DIOMS Share Target Test".
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">10.</span> Observe what happens: does Android launch the PWA and redirect to /?shared=1?
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">11.</span> Open the diagnostic screen in the PWA.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">12.</span> Check "Share Pipeline" to see which stage succeeded or failed.
            </div>
            <div className="bg-slate-950/70 p-3 rounded-xl border border-slate-800">
              <span className="text-blue-400 font-bold">13.</span> Check "Share Received" for receipt image preview and metadata.
            </div>
          </div>

          <div className="p-3 bg-blue-950/40 border border-blue-800/60 rounded-xl text-xs text-blue-200">
            <span className="font-bold text-white">Important Notice: </span>
            The test must be performed using the installed standalone PWA on Android. Do not rely only on opening the
            website in a normal browser tab, as Android requires installation before registering Web Share Target
            intents.
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-4 mt-8 text-center text-xs text-slate-500 font-mono">
        DIOMS Share Target Test • Standalone Static PWA • Version dioms-share-test-v1
      </footer>
    </div>
  );
}
