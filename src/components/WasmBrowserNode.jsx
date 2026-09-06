import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearOpfsStorage,
  createModuleConfig,
  hasOpfs,
  hasSharedArrayBuffer,
  isCrossOriginIsolated,
  isOpfsReadonlyError,
  isWasmOomError,
  listOpfsEntries,
  markOpfsNeedsReset,
  opfsNeedsReset,
  prepareOpfsForStart,
  recoverOpfsStorage,
  resolveWsPeers,
  startWasmNode,
  terminateWasmWorkers,
} from '../lib/wasmNode.js';
import {
  NODE_NETWORK_LIST,
  defaultWsPeersForNetwork,
  getNodeNetwork,
  persistNodeNetworkId,
  peersStorageKey,
  resolveNodeNetworkId,
} from '../lib/nodeNetworks.js';
import {
  isLocalDevHost,
  isExtensionPage,
  isExtensionPopup,
  isExtensionSidePanel,
  openExtensionFullTab,
  openExtensionSidePanel,
  parsePeerList,
  formatPeerList,
  probeBridgeHttp,
  probeBridgeWs,
} from '../lib/bridge.js';
import {
  formatBytes,
  getLocalChainDbInfo,
  importChainDbBlob,
  importChainDbFromUrl,
  isSqliteDiskIoError,
} from '../lib/opfsSnapshot.js';
import {
  loadAvailablePublicSnapshot,
  publicSnapshotLabel,
  resolvePublicSnapshotUrl,
  snapshotMissingTip,
} from '../lib/snapshotPublic.js';
import { formatHashrate, shortAddr } from '../lib/presets.js';
import PoolThresholdSigner from './PoolThresholdSigner.jsx';
import EthPoolThresholdSigner from './EthPoolThresholdSigner.jsx';
import './NodeDashboard.css';

const CONSOLE_TABS = [
  { key: 'log', label: 'Activity log' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'ext', label: 'Extension' },
];

const MAX_LOG = 400;
const MAX_ROWS = 50;
/** Rolling window for blocks/s estimate. */
const SYNC_SAMPLE_MS = 60_000;

export default function WasmBrowserNode() {
  const [isolated, setIsolated] = useState(false);
  const [sab, setSab] = useState(false);
  const [opfsOk, setOpfsOk] = useState(false);
  const [networkId, setNetworkId] = useState(() => resolveNodeNetworkId());
  const network = useMemo(() => getNodeNetwork(networkId), [networkId]);
  const [wsPeers, setWsPeers] = useState(() => resolveWsPeers(
    typeof window !== 'undefined' ? window.location.search : '',
    resolveNodeNetworkId(),
  ));
  const [peersInput, setPeersInput] = useState(() => resolveWsPeers(
    typeof window !== 'undefined' ? window.location.search : '',
    resolveNodeNetworkId(),
  ));
  const [defiTriadReady, setDefiTriadReady] = useState(false);

  const [status, setStatus] = useState('Ready — click Start full node');
  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  /** True while killing workers and waiting for OPFS/socket settle. */
  const [stopping, setStopping] = useState(false);
  /** True when SQLite/OPFS failed mid-run — node is not healthy even if workers still exist. */
  const [storageFatal, setStorageFatal] = useState(false);
  /** True when WASM heap hit MAXIMUM_MEMORY (Cannot enlarge memory). */
  const [memoryFatal, setMemoryFatal] = useState(false);
  const [clearingOpfs, setClearingOpfs] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);

  const [bridgeHttp, setBridgeHttp] = useState({ state: 'idle' });
  const [bridgeWs, setBridgeWs] = useState({ state: 'idle' });
  const [bridgeStream, setBridgeStream] = useState({ state: 'idle' });

  const [chain, setChain] = useState(null);
  const [peerCount, setPeerCount] = useState(0);
  const [peers, setPeers] = useState([]);
  const [mempoolCount, setMempoolCount] = useState(0);
  const [mempool, setMempool] = useState([]);
  const [logLines, setLogLines] = useState([]);
  /** { blocksPerSec, etaSec, lag } derived from height samples vs network tip. */
  const [syncStats, setSyncStats] = useState(null);
  const [tabHidden, setTabHidden] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [localDbInfo, setLocalDbInfo] = useState(null);
  /** Manifest for same-origin / public community snapshot (optional). */
  const [publicSnapshot, setPublicSnapshot] = useState(null);
  // Activity log is a drawer now: closed while idle, opened once the node starts.
  const [logOpen, setLogOpen] = useState(false);
  /** Which console pane is showing. Panes stay mounted so the log keeps its scroll. */
  const [consoleTab, setConsoleTab] = useState('log');
  const snapshotFileRef = useRef(null);

  const startedRef = useRef(false);
  /** Sync flag for OPFS fatal during boot (state updates are async). */
  const storageFatalRef = useRef(false);
  /** Sync flag for WASM OOM during printErr (state updates are async). */
  const memoryFatalRef = useRef(false);
  const consoleRef = useRef(null);
  const logAutoOpenedRef = useRef(false);
  /** Height samples: { t, h }[] for rate estimation. */
  const heightSamplesRef = useRef([]);
  /** Latest network tip from HTTP probe (for ETA). */
  const netHeightRef = useRef(null);

  const appendLog = useCallback((text) => {
    setLogLines((prev) => {
      const next = [...prev, `${new Date().toLocaleTimeString()}  ${text}`];
      return next.length > MAX_LOG ? next.slice(-MAX_LOG) : next;
    });
  }, []);

  const runBridgeProbes = useCallback(async (wsUrl, { probeP2pWs = false, probeStream = false } = {}, netId = networkId) => {
    setBridgeHttp({ state: 'checking' });
    // Defaults on page load: HTTP only.
    // - /ws  = P2P bridge (rate-limit/ban risk) — never auto
    // - /stream = RPC dashboard feed — not used by full WASM node
    if (probeP2pWs) {
      setBridgeWs({ state: 'checking' });
    } else {
      setBridgeWs({
        state: 'skipped',
        detail: 'not auto-probed (protects handshake slot)',
      });
    }
    if (probeStream) {
      setBridgeStream({ state: 'checking' });
    } else {
      setBridgeStream({
        state: 'skipped',
        detail: 'optional RPC feed — not used by full WASM node',
      });
    }

    const net = getNodeNetwork(netId);
    appendLog(`Probing ${net.label} HTTP ${net.httpBase}/chain/head …`);
    const http = await probeBridgeHttp(net.httpBase);
    if (http.ok) {
      setBridgeHttp({
        state: 'ok',
        height: http.height ?? http.data?.height,
        synced: http.synced ?? http.data?.synced,
      });
      appendLog(
        `${net.label} HTTP OK — height ${http.height ?? http.data?.height ?? '?'} `
        + `synced=${http.synced ?? http.data?.synced ?? '?'}`,
      );
    } else {
      setBridgeHttp({ state: 'bad', error: http.error });
      appendLog(`${net.label} HTTP FAIL — ${http.error}`);
    }

    if (probeP2pWs) {
      appendLog(
        `⚠ Probing P2P ${wsUrl} — this burns the bridge per-IP connect slot (~30s). `
        + 'Wait ≥30s before Start full WASM node.',
      );
      const ws = await probeBridgeWs(wsUrl, { protocol: 'binary', timeoutMs: 10000 });
      if (ws.ok) {
        setBridgeWs({ state: 'ok', detail: ws.detail, openedMs: ws.openedMs });
        appendLog(`${net.label} /ws OPEN (${ws.openedMs ?? '?'}ms) — wait 30s before Start`);
      } else {
        setBridgeWs({ state: 'bad', detail: ws.detail });
        appendLog(`${net.label} /ws FAIL — ${ws.detail}`);
      }
    } else {
      appendLog(
        `P2P /ws (${wsUrl}) not auto-probed — protects handshake slot. `
        + `Start full WASM node does the real ${net.gruntConnect} handshake.`,
      );
    }

    if (probeStream) {
      appendLog(`Probing RPC stream ${net.wsStream} (optional) …`);
      const stream = await probeBridgeWs(net.wsStream, { protocol: null, timeoutMs: 10000 });
      if (stream.ok) {
        setBridgeStream({ state: 'ok', detail: stream.detail, openedMs: stream.openedMs });
        appendLog(`${net.label} /stream OPEN (${stream.openedMs ?? '?'}ms)`);
      } else {
        setBridgeStream({ state: 'bad', detail: stream.detail });
        appendLog(`${net.label} /stream FAIL (optional) — ${stream.detail}`);
      }
    } else {
      appendLog(
        `/stream is optional (RPC dashboards only). Full WASM node uses /ws via Start — not needed on page load.`,
      );
    }

    appendLog(
      `If Isolation OK + HTTP OK → click Start (${net.label} WASM ${net.versionText}).`,
    );
  }, [appendLog, networkId]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsolated(isCrossOriginIsolated());
      setSab(hasSharedArrayBuffer());
      setOpfsOk(hasOpfs());
      const netId = resolveNodeNetworkId();
      setNetworkId(netId);
      persistNodeNetworkId(netId);
      const peers = resolveWsPeers(window.location.search, netId);
      setWsPeers(peers);
      setPeersInput(peers);

      // Wait for head bootstrap wipe (?resetDb / session flag) before probes / Start.
      try {
        const boot = await window.__wartOpfsBootstrap;
        if (cancelled) return;
        if (boot && boot.skipped !== true) {
          if (boot.ok) {
            storageFatalRef.current = false;
            setStorageFatal(false);
            appendLog(
              `OPFS bootstrap wipe OK — removed: ${boot.removed?.length ? boot.removed.join(', ') : '(empty)'}`,
            );
            setStatus('OPFS reset OK — click Start full WASM node once');
          } else if (boot.failed?.length || boot.error) {
            storageFatalRef.current = true;
            setStorageFatal(true);
            appendLog(
              `OPFS bootstrap wipe FAILED — ${boot.failed?.join('; ') || boot.error}. `
              + 'Close EVERY other tab/window on this host:port (including duplicates), then Recover again. '
              + 'Or: DevTools → Application → Storage → Clear site data.',
            );
            setStatus('OPFS still locked by another tab — close all tabs for this origin');
          }
          try {
            const clean = new URL(window.location.href);
            if (clean.searchParams.has('resetDb') || clean.searchParams.has('resetdb')) {
              clean.searchParams.delete('resetDb');
              clean.searchParams.delete('resetdb');
              window.history.replaceState({}, '', clean.toString());
            }
          } catch {
            // ignore
          }
        }
      } catch (e) {
        appendLog(`OPFS bootstrap error: ${e?.message || e}`);
      }

      if (cancelled) return;

      // Second-pass clear if bootstrap left residue or session still dirty
      if (opfsNeedsReset()) {
        appendLog('Session still marked dirty — second OPFS clear (workers already dead on fresh load)…');
        const r = await clearOpfsStorage({
          terminateWorkers: false,
          retries: 5,
          log: appendLog,
        });
        if (cancelled) return;
        if (r.ok) {
          storageFatalRef.current = false;
          setStorageFatal(false);
          appendLog(`Second clear OK — ${r.removed?.join(', ') || '(empty)'}`);
          setStatus('OPFS clear OK — Start full WASM node once');
        } else {
          storageFatalRef.current = true;
          setStorageFatal(true);
          appendLog(`Second clear FAILED: ${r.error}`);
        }
      }

      if (!cancelled) {
        runBridgeProbes(peers);
      }

      // Public snapshot: manifest may exist without the multi‑GB file (Netlify).
      // Only advertise one-click import when the .db3 URL actually responds.
      try {
        const man = await loadAvailablePublicSnapshot();
        if (!cancelled && man) {
          setPublicSnapshot(man);
          if (man.url && !snapshotUrl) {
            setSnapshotUrl(man.url);
          }
        } else if (!cancelled) {
          setPublicSnapshot(null);
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runBridgeProbes, appendLog]);

  // Stick to bottom only if the user is already near the bottom.
  // Scrolling up to read history should not jump back on every new line.
  useEffect(() => {
    const el = consoleRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stickThresholdPx = 64;
    if (distanceFromBottom <= stickThresholdPx) {
      // rAF: controlled textarea value update can reset scroll before layout.
      requestAnimationFrame(() => {
        if (consoleRef.current) {
          consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
        }
      });
    }
  }, [logLines, logOpen, consoleTab]);

  // Open the log the first time the node starts; after that the user's toggle wins.
  useEffect(() => {
    if ((starting || running) && !logAutoOpenedRef.current) {
      logAutoOpenedRef.current = true;
      setLogOpen(true);
    }
  }, [starting, running]);

  // Warn when the tab is backgrounded — Chromium throttles workers hard.
  useEffect(() => {
    const onVis = () => {
      const hidden = document.visibilityState === 'hidden';
      setTabHidden(hidden);
      if (hidden && startedRef.current) {
        appendLog('[sync] Tab hidden — browser may throttle the node. Keep this tab focused for faster IBD.');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [appendLog]);

  // Refresh local chain.db3 size (after import / clear).
  const refreshLocalDbInfo = useCallback(async () => {
    const info = await getLocalChainDbInfo({ subdir: getNodeNetwork(networkId).opfsSubdir });
    setLocalDbInfo(info);
    return info;
  }, [networkId]);

  useEffect(() => {
    refreshLocalDbInfo();
  }, [refreshLocalDbInfo]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/node/defi/wart-node.js', { cache: 'no-store' });
        if (!cancelled) setDefiTriadReady(res.ok);
      } catch {
        if (!cancelled) setDefiTriadReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /** Healthy run only — storage/memory fatal means not healthy even if workers linger. */
  const nodeHealthy = running && !storageFatal && !memoryFatal;

  const configuredPeerCount = useMemo(
    () => parsePeerList(wsPeers).length,
    [wsPeers],
  );

  const canStart = useMemo(
    () => isolated && sab && !running && !starting && !stopping && !storageFatal && !clearingOpfs && !snapshotBusy
      && (networkId !== 'defi' || defiTriadReady),
    [isolated, sab, running, starting, stopping, storageFatal, clearingOpfs, snapshotBusy, networkId, defiTriadReady],
  );

  /** File/URL import when idle — site one-click needs publicSnapshot (probed). */
  const canImportPublicSnapshot = useMemo(
    () => opfsOk && !running && !starting && !stopping && !snapshotBusy && !clearingOpfs,
    [opfsOk, running, starting, stopping, snapshotBusy, clearingOpfs],
  );

  const canImportSiteSnapshot = useMemo(
    () => canImportPublicSnapshot && !!publicSnapshot?.url,
    [canImportPublicSnapshot, publicSnapshot],
  );

  /** Stop only while a node is (or was) running — not mid-start or mid-recover. */
  const canStop = useMemo(
    () => running && !starting && !stopping && !clearingOpfs,
    [running, starting, stopping, clearingOpfs],
  );

  /** Allow clear while broken; block only during a healthy run or mid-start. */
  const canClearOpfs = useMemo(
    () => opfsOk && !starting && !stopping && !clearingOpfs && (!running || storageFatal),
    [opfsOk, starting, stopping, clearingOpfs, running, storageFatal],
  );

  const handleOpfsReadonly = useCallback((sourceText) => {
    markOpfsNeedsReset();
    storageFatalRef.current = true;
    setStorageFatal(true);
    setRunning(false);
    startedRef.current = false;
    // Drop pthread locks immediately so Clear/Recover can delete db files.
    try {
      terminateWasmWorkers(appendLog);
    } catch {
      // ignore
    }
    setError(
      'SQLite readonly / OPFS lock — close every other tab on this host:port, '
      + 'then click Recover (clear OPFS + reload). Do not spam Start.',
    );
    setStatus('OPFS / SQLite write failed — use Recover');
    appendLog(
      `[storage] readonly/OPFS lock${sourceText ? `: ${String(sourceText).slice(0, 120)}` : ''}`,
    );
  }, [appendLog]);

  /** WASM linear memory hit MAXIMUM_MEMORY — sync cannot continue in this runtime. */
  const handleWasmOom = useCallback((sourceText) => {
    if (memoryFatalRef.current) return;
    memoryFatalRef.current = true;
    setMemoryFatal(true);
    setRunning(false);
    startedRef.current = false;
    try {
      terminateWasmWorkers(appendLog);
    } catch {
      // ignore
    }
    const snippet = sourceText ? String(sourceText).slice(0, 200) : '';
    setError(
      'WASM heap exhausted (Cannot enlarge memory). The full-chain sync needs more '
      + 'browser RAM than this node build allows. OPFS data is usually still intact — '
      + 'Stop is not required; after a rebuild with a higher MAXIMUM_MEMORY you can Start '
      + 'again to resume. Restarting the same build will hit the same wall.',
    );
    setStatus('WASM out of memory — heap limit reached');
    appendLog(`[memory] WASM OOM / Cannot enlarge memory${snippet ? `: ${snippet}` : ''}`);
    appendLog(
      '[memory] Fix: rebuild public/node triad with -sMAXIMUM_MEMORY=2048mb (or higher). '
      + 'Clear/Recover only if you want a full resync after upgrading.',
    );
  }, [appendLog]);

  /**
   * SQLite "disk I/O error" on OPFS — usually WAL/hot copy, OPFS lock, or
   * incomplete multi‑GB write. (emsdk 3.1.74+ has i64 OPFS offsets — not a 2 GiB wall.)
   */
  const handleSqliteDiskIo = useCallback((sourceText) => {
    setRunning(false);
    startedRef.current = false;
    try {
      terminateWasmWorkers(appendLog);
    } catch {
      // ignore
    }
    const snippet = sourceText ? String(sourceText).slice(0, 180) : '';
    setError(
      'SQLite disk I/O error opening chain.db3. Common causes: WAL/hot copy import, '
      + 'another tab holding OPFS, or a bad multi‑GB write. '
      + 'Close every other tab on this origin → Clear local data → re-import a checkpointed '
      + 'DELETE-mode chain.db3 → Start once.',
    );
    setStatus('OPFS SQLite open failed — see console');
    appendLog(`[storage] SQLite disk I/O / open failure${snippet ? `: ${snippet}` : ''}`);
    appendLog(
      '[storage] Prefer: close ALL tabs for this origin → Clear local data → re-import '
      + 'chain.db3 (journal_mode=DELETE, no -wal/-shm) → Start once.',
    );
    appendLog(
      '[storage] If never checkpointed on native: stop node → '
      + 'sqlite3 chain.db3 "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;" '
      + '→ import only that file.',
    );
  }, [appendLog]);

  const persistPeers = (v) => {
    try {
      localStorage.setItem(peersStorageKey(networkId), v);
      if (!network.testnet) localStorage.setItem('wsPeers', v);
    } catch {
      // ignore
    }
  };

  const applyPeers = () => {
    const v = formatPeerList(peersInput.trim() || defaultWsPeersForNetwork(networkId));
    setPeersInput(v);
    setWsPeers(v);
    persistPeers(v);
    const n = parsePeerList(v).length;
    appendLog(`Bridge peers set → ${n} URL${n === 1 ? '' : 's'}: ${v}`);
    runBridgeProbes(v);
  };

  const useNetworkDefaultPeers = () => {
    const v = defaultWsPeersForNetwork(networkId);
    setPeersInput(v);
    setWsPeers(v);
    persistPeers(v);
    appendLog(`Reset to ${network.label} bridge → ${v}`);
    runBridgeProbes(v);
  };

  /** Local Vite proxy — browser only opens same-origin /ws-bridge[-defi]. */
  const useLocalProxy = () => {
    const url = defaultWsPeersForNetwork(networkId);
    setPeersInput(url);
    setWsPeers(url);
    persistPeers(url);
    appendLog(
      `Using local dev WS proxy → ${url} `
      + '(requires restarted `npm run dev` with /ws-bridge or /ws-bridge-defi). '
      + 'Do not Probe /ws on public URL before Start.',
    );
    runBridgeProbes(url, { probeP2pWs: false });
  };

  const selectNetwork = (id) => {
    if (id === networkId || running || starting || stopping) return;
    const net = getNodeNetwork(id);
    setNetworkId(id);
    persistNodeNetworkId(id);
    const peers = resolveWsPeers(window.location.search, id);
    setWsPeers(peers);
    setPeersInput(peers);
    setChain(null);
    setSyncStats(null);
    setPeerCount(0);
    setPeers([]);
    setMempoolCount(0);
    setMempool([]);
    heightSamplesRef.current = [];
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('network', id);
      window.history.replaceState({}, '', url.toString());
    } catch {
      // ignore
    }
    appendLog(
      `Network → ${net.label} (WASM ${net.versionText}, session ${net.session}, GRUNT ${net.gruntConnect})`,
    );
    runBridgeProbes(peers, {}, id);
    getLocalChainDbInfo({ subdir: net.opfsSubdir }).then(setLocalDbInfo).catch(() => {});
  };

  /** Raw open test (no GRUNT) — success = onopen. Uses current peers field. */
  const testRawWs = async () => {
    const url = (peersInput.trim() || wsPeers || defaultWsPeersForNetwork(networkId)).split(';')[0].trim();
    appendLog(`Raw WSS open test → ${url} (success = onopen; close after open is OK for bare client)`);
    const result = await probeBridgeWs(url, { protocol: 'binary', timeoutMs: 12000 });
    if (result.ok) {
      appendLog(`Raw open OK in ${result.openedMs ?? '?'}ms — bridge reachable from this browser`);
      setBridgeWs({ state: 'ok', detail: result.detail, openedMs: result.openedMs });
    } else {
      appendLog(`Raw open FAIL — ${result.detail}`);
      setBridgeWs({ state: 'bad', detail: result.detail });
    }
  };

  // Keep network tip ref fresh for sync ETA without re-binding WASM callbacks.
  useEffect(() => {
    if (bridgeHttp?.height != null) {
      netHeightRef.current = Number(bridgeHttp.height);
    }
  }, [bridgeHttp?.height]);

  const onChain = useCallback((event) => {
    if (!event) return;
    const height = Number(event.length ?? event.height ?? 0) || 0;
    setChain({
      height,
      difficulty: event.difficulty,
      worksum: event.worksum,
    });

    const now = Date.now();
    const samples = heightSamplesRef.current;
    samples.push({ t: now, h: height });
    while (samples.length > 2 && now - samples[0].t > SYNC_SAMPLE_MS) {
      samples.shift();
    }
    if (samples.length >= 2) {
      const first = samples[0];
      const last = samples[samples.length - 1];
      const dt = (last.t - first.t) / 1000;
      const dh = last.h - first.h;
      if (dt > 0.5 && dh >= 0) {
        const blocksPerSec = dh / dt;
        const netH = netHeightRef.current;
        const lag = netH != null && Number.isFinite(netH) ? Math.max(0, netH - height) : null;
        const etaSec = lag != null && blocksPerSec > 0.01 ? lag / blocksPerSec : null;
        setSyncStats({
          blocksPerSec,
          lag,
          etaSec,
          netHeight: netH ?? null,
          localHeight: height,
        });
      }
    }
  }, []);

  const onConnect = useCallback((event) => {
    if (!event) return;
    setPeerCount(event.total ?? 0);
    setPeers((prev) => {
      const row = {
        id: event.id,
        inbound: event.inbound,
        type: event.type,
        address: event.address,
        since: event.since,
      };
      const next = [row, ...prev.filter((p) => p.id !== event.id)];
      return next.slice(0, MAX_ROWS);
    });
  }, []);

  const onDisconnect = useCallback((event) => {
    if (!event) return;
    setPeerCount(event.total ?? 0);
    setPeers((prev) => prev.filter((p) => p.id !== event.id));
  }, []);

  const onMempoolAdd = useCallback((event) => {
    if (!event) return;
    setMempoolCount(event.total ?? 0);
    setMempool((prev) => {
      const row = {
        id: event.id,
        fromAddress: event.fromAddress,
        toAddress: event.toAddress,
        amount: event.amount,
        fee: event.fee,
        txHash: event.txHash,
      };
      const next = [row, ...prev.filter((p) => p.id !== event.id)];
      return next.slice(0, MAX_ROWS);
    });
  }, []);

  const onMempoolErase = useCallback((event) => {
    if (!event) return;
    setMempoolCount(event.total ?? 0);
    setMempool((prev) => prev.filter((p) => p.id !== event.id));
  }, []);

  const clearOpfs = async () => {
    if (!canClearOpfs) return;
    setClearingOpfs(true);
    setError(null);
    appendLog('Terminating WASM workers, then clearing OPFS…');
    try {
      terminateWasmWorkers(appendLog);
      const before = await listOpfsEntries(network.opfsSubdir);
      appendLog(`OPFS before: ${before.length ? before.join(', ') : '(empty)'}`);
      const result = await clearOpfsStorage({
        terminateWorkers: true,
        log: appendLog,
        subdir: network.opfsSubdir,
      });
      if (result.ok) {
        storageFatalRef.current = false;
        setStorageFatal(false);
        startedRef.current = false;
        setRunning(false);
        appendLog(`OPFS cleared — removed: ${result.removed?.join(', ') || '(already empty)'}`);
        setStatus('OPFS cleared — click Start full WASM node (one tab only)');
      } else {
        setError(result.error || 'OPFS clear failed');
        appendLog(`OPFS clear FAILED: ${result.error}`);
        setStatus('OPFS clear failed — use Recover, or close all tabs for this origin');
      }
    } catch (err) {
      setError(err.message || String(err));
      appendLog(`OPFS clear ERROR: ${err.message || err}`);
    } finally {
      setClearingOpfs(false);
    }
  };

  /**
   * Hard recovery: kill pthreads → wipe OPFS → hard reload.
   * Next document runs bootstrap wipe before React/WASM can re-lock files.
   */
  const recoverOpfs = async () => {
    if (starting || stopping || clearingOpfs) return;
    setClearingOpfs(true);
    setError(null);
    startedRef.current = false;
    setRunning(false);
    markOpfsNeedsReset();
    appendLog('Recover: kill workers → clear OPFS → reload (?resetDb=1)…');
    try {
      // reload:true always navigates away; may not return
      await recoverOpfsStorage({ reload: true, log: appendLog, subdir: network.opfsSubdir });
    } catch (err) {
      appendLog(`Recover error: ${err.message || err}`);
      // Force navigation even if helper threw
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('resetDb', '1');
        window.location.replace(url.toString());
      } catch {
        window.location.reload();
      }
    }
  };

  /**
   * Hard-stop this tab's WASM node: kill workers, reset live UI state.
   * Leaves OPFS (chain/peers DBs) intact so Start can resume without reload.
   */
  const stop = async () => {
    if (!running || starting || stopping || clearingOpfs) return;
    setStopping(true);
    setError(null);
    setStatus('Stopping…');
    appendLog('Stopping node — terminating workers (local chain data kept)…');
    try {
      terminateWasmWorkers(appendLog);
    } catch (err) {
      appendLog(`Stop warning: ${err?.message || err}`);
    }
    startedRef.current = false;
    setRunning(false);
    memoryFatalRef.current = false;
    setMemoryFatal(false);
    setProgress(null);
    setChain(null);
    setSyncStats(null);
    heightSamplesRef.current = [];
    setPeerCount(0);
    setPeers([]);
    setMempoolCount(0);
    setMempool([]);
    // OPFS exclusive handles + bridge sockets release slightly after worker death.
    await new Promise((r) => setTimeout(r, 600));
    setStatus('Stopped — click Start to run again');
    appendLog('Node stopped. OPFS unchanged. You can Start again (wait a few seconds if reconnect fails).');
    setStopping(false);
    refreshLocalDbInfo();
  };

  const importSnapshotFile = async (file) => {
    if (!file || running || starting || stopping || snapshotBusy) return;
    setSnapshotBusy(true);
    setError(null);
    appendLog(`[snapshot] importing file “${file.name}” (${formatBytes(file.size)})…`);
    try {
      const result = await importChainDbBlob(file, { log: appendLog, subdir: network.opfsSubdir });
      if (!result.ok) {
        setError(result.error || 'Snapshot import failed');
        appendLog(`[snapshot] FAIL — ${result.error}`);
      } else {
        appendLog(
          `[snapshot] OK — ${formatBytes(result.bytes)}. Press Start to catch up remaining tip blocks.`,
        );
        await refreshLocalDbInfo();
      }
    } catch (err) {
      setError(err?.message || String(err));
      appendLog(`[snapshot] ERROR — ${err?.message || err}`);
    } finally {
      setSnapshotBusy(false);
      if (snapshotFileRef.current) snapshotFileRef.current.value = '';
    }
  };

  const importSnapshotUrl = async (urlOverride) => {
    if (running || starting || stopping || snapshotBusy) return;
    const url = String(urlOverride || snapshotUrl || resolvePublicSnapshotUrl()).trim();
    if (!url) {
      setError('Enter a snapshot URL (must be fetchable under COEP / same-origin).');
      return;
    }
    setSnapshotBusy(true);
    setError(null);
    appendLog(`[snapshot] downloading ${url}…`);
    try {
      const result = await importChainDbFromUrl(url, { log: appendLog, subdir: network.opfsSubdir });
      if (!result.ok) {
        setError(result.error || 'Snapshot URL import failed');
        appendLog(`[snapshot] FAIL — ${result.error}`);
        if (/404|403|HTTP/.test(String(result.error || '')) || url.startsWith('/snapshot/')) {
          appendLog(snapshotMissingTip(url));
        }
      } else {
        appendLog(
          `[snapshot] OK — ${formatBytes(result.bytes)}. Press Start to catch up remaining tip blocks.`,
        );
        await refreshLocalDbInfo();
      }
    } catch (err) {
      setError(err?.message || String(err));
      appendLog(`[snapshot] ERROR — ${err?.message || err}`);
    } finally {
      setSnapshotBusy(false);
    }
  };

  /** One-click community / site-hosted snapshot (default /snapshot/chain.db3). */
  const importPublicSnapshot = async () => {
    const url = publicSnapshot?.url || resolvePublicSnapshotUrl();
    setSnapshotUrl(url);
    appendLog(`[snapshot] importing ${publicSnapshotLabel(publicSnapshot)}…`);
    await importSnapshotUrl(url);
  };

  const start = async () => {
    if (startedRef.current || starting || stopping || storageFatal || storageFatalRef.current) return;
    setStarting(true);
    setError(null);
    storageFatalRef.current = false;
    setStorageFatal(false);
    memoryFatalRef.current = false;
    setMemoryFatal(false);
    setSyncStats(null);
    heightSamplesRef.current = [];
    setStatus('Loading WASM full node…');
    appendLog('Starting Warthog WASM full node…');
    appendLog(
      `crossOriginIsolated=${isCrossOriginIsolated()} SharedArrayBuffer=${hasSharedArrayBuffer()} OPFS=${hasOpfs()}`,
    );
    appendLog(
      `Sync profile: ${configuredPeerCount} WS peer URL(s) · WebRTC on · keep this tab focused`,
    );
    if (localDbInfo?.present) {
      appendLog(
        `Local ${localDbInfo.name || 'chain.db3'} present (${formatBytes(localDbInfo.bytes)}) — will resume / catch up`,
      );
    }
    if (opfsNeedsReset()) {
      appendLog('Prior OPFS failure flagged — clearing storage before boot…');
    }

    try {
      if (!hasOpfs()) {
        throw new Error(
          'OPFS is not available. Use Chrome/Edge (or Chromium) on http://127.0.0.1 or https. '
          + 'The full node stores chain.db3 under /opfs via createSyncAccessHandle.',
        );
      }

      const prep = await prepareOpfsForStart({
        forceClear: opfsNeedsReset(),
        subdir: network.opfsSubdir,
      });
      if (!prep.ok) {
        throw new Error(prep.error || 'OPFS prepare failed');
      }
      if (prep.cleared) {
        appendLog(`OPFS pre-cleared: ${prep.removed?.join(', ') || '(empty)'}`);
      }
      appendLog(
        `OPFS entries: ${prep.entries?.length ? prep.entries.join(', ') : '(empty — will create DBs)'}`,
      );

      appendLog(`Using WS_PEERS=${wsPeers}`);
      appendLog(`${network.label} argv: ${network.argv.join(' ')}`);
      appendLog(
        `Booting ${network.glueUrl} (expect log: Warthog Node v${network.versionText} / Adding websocket peer …)`,
      );
      appendLog(
        `Handshake v4: settle ~250ms after open, then C++ sends ${network.gruntConnect} on the wire. `
        + '1 connect/IP (~30s) — do not probe /ws first.',
      );
      appendLog(
        `Storage: ${network.session}/*.db3 (separate from ${network.testnet ? 'Official1' : 'DeFi'} OPFS). `
        + 'Only one tab per origin. If readonly database → Recover, then Start once.',
      );
      if (network.testnet && !defiTriadReady) {
        throw new Error(
          'DeFi WASM triad is not installed at /node/defi/wart-node.js. '
          + 'Copy wasm-out/wasm/* from core-wasm-build-0.10.22 after the emscripten build.',
        );
      }
      // Brief settle so any prior sockets are fully closed.
      await new Promise((r) => setTimeout(r, 400));
      const moduleConfig = createModuleConfig({
        wsPeers,
        networkId,
        print: (text) => {
          appendLog(text);
          // WASM throws inside the worker — surface recovery when SQLite fails
          if (isOpfsReadonlyError(text)) {
            handleOpfsReadonly(text);
          } else if (isWasmOomError(text)) {
            handleWasmOom(text);
          } else if (isSqliteDiskIoError(text)) {
            handleSqliteDiskIo(text);
          }
        },
        setStatus,
        onChain,
        onConnect,
        onDisconnect,
        onMempoolAdd,
        onMempoolErase,
        onProgress: setProgress,
      });

      const instance = await startWasmNode(moduleConfig);
      // Live Module instance only — never assign the constructor config.
      window.wartNode = instance;
      window.Module = instance;
      window.__wartRunningNetworkId = network.id;
      // If SQLite already failed during init, do not paint healthy "running".
      // (print → handleOpfsReadonly may have fired; state is async — use ref.)
      if (storageFatalRef.current) {
        appendLog('Runtime returned but storage is fatal — use Recover, do not trust peer state');
        setStatus('OPFS / SQLite write failed — use Recover');
        setRunning(false);
        startedRef.current = false;
      } else if (memoryFatalRef.current) {
        appendLog('Runtime returned but WASM heap is exhausted — do not trust peer/chain state');
        setStatus('WASM out of memory — heap limit reached');
        setRunning(false);
        startedRef.current = false;
      } else {
        startedRef.current = true;
        setRunning(true);
        setStatus('Full node runtime started — watch peers / chain / console for GRUNT');
        appendLog('Emscripten runtime ready — full node is running in this tab');
        appendLog(`Expect: [ws-handshake] … ${network.gruntConnect} complete · Adding websocket peer …`);
      }
    } catch (err) {
      console.error(err);
      const msg = err.message || String(err);
      if (isOpfsReadonlyError(err)) {
        handleOpfsReadonly(msg);
      } else if (isWasmOomError(err)) {
        handleWasmOom(msg);
      } else if (isSqliteDiskIoError(err)) {
        handleSqliteDiskIo(msg);
      } else {
        setError(msg);
        setStatus('Failed to start');
      }
      appendLog(`ERROR: ${msg}`);
      startedRef.current = false;
      setRunning(false);
    } finally {
      setStarting(false);
    }
  };

  const browserReady = isolated && sab && opfsOk;
  const badgeClass = storageFatal || memoryFatal
    ? 'is-bad'
    : nodeHealthy
      ? 'is-ok'
      : browserReady
        ? 'is-ok'
        : 'is-warn';
  const badgeLabel = storageFatal
    ? 'Needs fix'
    : memoryFatal
      ? 'Out of memory'
      : nodeHealthy
        ? 'Running'
        : browserReady
          ? 'Ready'
          : 'Setup needed';

  const friendlyStatus = (() => {
    if (storageFatal) {
      return 'Storage is locked. Close other tabs on this site, then use Recover below.';
    }
    if (memoryFatal) {
      return 'WASM ran out of memory during sync (heap limit). Local chain data is usually kept — Start again after upgrading the node build, or try Start once more if you already have the 2048 MB build.';
    }
    if (stopping) return 'Stopping your node…';
    if (nodeHealthy) {
      if (chain?.height != null) {
        return `Your node is live on the network · block #${chain.height}`;
      }
      return 'Your node is running — connecting to the network…';
    }
    if (starting) return 'Starting your node — this can take a moment…';
    if (!isolated || !sab) {
      return 'This page needs a special browser mode. Use Chrome/Edge via the normal site link, not a bare IP.';
    }
    if (!opfsOk) {
      return 'This browser cannot store the chain. Please use Chrome or Edge on HTTPS (or localhost).';
    }
    if (status?.startsWith('Stopped')) {
      return 'Node stopped. Local data is kept — press Start when you want to run again.';
    }
    if (bridgeHttp.state === 'ok') {
      return `Network is reachable${bridgeHttp.height != null ? ` (height #${bridgeHttp.height})` : ''}. Press Start to run a full node in this tab.`;
    }
    if (bridgeHttp.state === 'checking') return 'Checking network…';
    if (bridgeHttp.state === 'bad') {
      return 'Could not reach the public network probe — you can still try Start.';
    }
    return status || 'Ready when you are.';
  })();

  const displayPeerCount = peerCount || peers.length;
  const displayMempoolCount = mempoolCount || mempool.length;

  const formatEta = (sec) => {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
    if (sec < 90) return `~${Math.round(sec)}s`;
    if (sec < 3600) return `~${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `~${h}h ${m}m`;
  };

  /** Local height as a share of network height — drives the sync meter. */
  const syncPercent = useMemo(() => {
    const local = Number(chain?.height);
    const net = Number(bridgeHttp?.height);
    if (!Number.isFinite(local) || !Number.isFinite(net) || net <= 0) return null;
    return Math.max(0, Math.min(100, (local / net) * 100));
  }, [chain, bridgeHttp]);

  // Lifecycle phase — distinct from the header badge, which reports browser readiness.
  const heroEyebrow = storageFatal || memoryFatal
    ? 'Needs attention'
    : starting
      ? 'Starting up'
      : stopping
        ? 'Shutting down'
        : nodeHealthy
          ? 'Node online'
          : 'Node idle';

  const syncRateLabel = syncStats?.blocksPerSec != null
    ? `${syncStats.blocksPerSec < 10
      ? syncStats.blocksPerSec.toFixed(1)
      : Math.round(syncStats.blocksPerSec)} blk/s`
    : null;

  const inExtPopup = isExtensionPopup();
  const inExtSide = isExtensionSidePanel();
  const inExtDocked = inExtPopup || inExtSide;
  const inExtPage = isExtensionPage();

  return (
    <div className={`dash${inExtDocked ? ' dash--popup' : ''}${inExtSide ? ' dash--sidepanel' : ''}`}>
      <header className="dash__header">
        <div className="dash__brand">
          <img src="/img/main_logo.png" alt="" className="dash__logo" />
          <div>
            <h1>{inExtDocked ? 'Warthog Node' : 'Warthog in your browser'}</h1>
            <p className="dash__subtitle">
              {inExtSide
                ? 'Side panel — stays open while you browse'
                : inExtPopup
                  ? 'Toolbar popup — dock to side panel to stay open'
                  : inExtPage
                    ? 'Full node in this tab — keep focused while syncing'
                    : network.testnet
                      ? 'DeFi testnet full node in this tab — separate OPFS from Official1'
                      : 'Run a full node in this tab — no install required'}
            </p>
          </div>
        </div>
        <div className="dash__header-right">
          <div className="dash__nets" role="group" aria-label="Network">
            {NODE_NETWORK_LIST.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`tab${networkId === n.id ? ' is-on' : ''}`}
                disabled={running || starting || stopping}
                onClick={() => selectNetwork(n.id)}
                title={n.testnet ? `DeFi testnet WASM ${n.versionText}` : `Official1 WASM ${n.versionText}`}
              >
                {n.shortLabel}
              </button>
            ))}
          </div>
          <div className={`dash__badge ${badgeClass}`}>{badgeLabel}</div>
        </div>
      </header>

      {network.testnet && !defiTriadReady && (
        <div className="dash__error" style={{ textAlign: 'left' }}>
          DeFi WASM triad is not at <code className="mono">/node/defi/</code> yet.
          Finish the 0.10.22 emscripten build, then copy
          {' '}<code className="mono">wasm-out/wasm/wart-node.*</code> there.
          Official1 (0.9.6) still works from the network switch.
        </div>
      )}

      {inExtPopup && (
        <>
          <div className="ext-popup-banner">
            <strong>This popup closes when you click away</strong>
            {' '}— that stops the node. Prefer <strong>Open side panel</strong>
            {' '}(stays open like Leo) for sync, or <strong>Expand to tab</strong>.
          </div>
          <div className="ext-popup-toolbar">
            <button
              type="button"
              className="btn btn--start"
              onClick={() => openExtensionSidePanel()}
              title="Dock in the browser side panel — stays open while you browse"
            >
              Open side panel
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => openExtensionFullTab()}
              title="Open full dashboard tab (do not run popup + tab at once)"
            >
              Expand to tab
            </button>
          </div>
        </>
      )}

      {inExtSide && (
        <>
          <div className="ext-popup-banner">
            <strong>Stays open while you browse</strong>
            {' '}other tabs. Closing this side panel stops the node.
            One surface only (don’t also Start in a tab).
          </div>
          <div className="ext-popup-toolbar">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => openExtensionFullTab()}
              title="Open full dashboard tab for a larger view"
            >
              Expand to tab
            </button>
          </div>
        </>
      )}

      <section
        className="panel hero"
        style={{ '--sync': syncPercent ?? 0 }}
        data-sync={syncPercent != null ? 'on' : 'off'}
      >
        <span className="hero__eyebrow">{heroEyebrow}</span>
        <p className="hero__status">{friendlyStatus}</p>
        <div className="hero__actions">
          <button
            type="button"
            className={`btn btn--start${nodeHealthy ? ' is-running' : ''}`}
            onClick={start}
            disabled={!canStart}
          >
            {starting
              ? 'Starting…'
              : stopping
                ? 'Please wait…'
                : storageFatal
                  ? 'Fix storage first'
                  : memoryFatal
                    ? 'Memory limit hit — Start to retry'
                    : nodeHealthy
                      ? 'Node is running'
                      : 'Start node'}
          </button>
          {(running || stopping) && (
            <button
              type="button"
              className="btn btn--stop"
              onClick={stop}
              disabled={!canStop}
              title="Stop the node in this tab (keeps local chain data)"
            >
              {stopping ? 'Stopping…' : 'Stop node'}
            </button>
          )}
          {!nodeHealthy && !localDbInfo?.present && publicSnapshot && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={importPublicSnapshot}
              disabled={!canImportSiteSnapshot}
              title={
                `Import site chain.db3 (${formatBytes(publicSnapshot.bytes || 0)}`
                + (publicSnapshot.height != null
                  ? `, height ${Number(publicSnapshot.height).toLocaleString()}`
                  : '')
                + ')'
              }
            >
              {snapshotBusy ? 'Importing snapshot…' : 'Import snapshot'}
            </button>
          )}
        </div>
        {progress && (
          <progress
            className="hero__progress"
            value={progress.value}
            max={progress.max}
          />
        )}
        {!nodeHealthy && !storageFatal && !memoryFatal && !stopping && browserReady && (
          <p className="hero__hint">
            {inExtSide
              ? 'Side panel can stay open while you use other tabs. Close the panel → node stops.'
              : inExtPopup
                ? 'Use Open side panel to keep the node up while browsing.'
                : 'Keep this tab focused for faster sync. Only one tab per site can run the node.'}
          </p>
        )}
        {tabHidden && nodeHealthy && !inExtSide && (
          <div className="dash__error" style={{ marginTop: '0.85rem', textAlign: 'left' }}>
            <strong>Tab in background</strong> — Chrome may throttle the WASM node.
            Switch back to this tab to keep IBD moving.
          </div>
        )}
        {error && !memoryFatal && (
          <div className="dash__error" style={{ marginTop: '0.85rem', textAlign: 'left' }}>{error}</div>
        )}
        {memoryFatal && (
          <div className="dash__error" style={{ marginTop: '0.85rem', textAlign: 'left' }}>
            <strong>Out of memory</strong> — the WASM node hit its heap limit (
            <code>Cannot enlarge memory</code>
            ). Full-chain sync around mid/late IBD needs more than older 768 MB builds allowed.
            <ol className="dash__checklist">
              <li>This build should use <strong>2048 MB</strong> max heap — hard-refresh after deploy.</li>
              <li>Local OPFS chain data is usually kept; you do <strong>not</strong> need Recover just for OOM.</li>
              <li>Press <strong>Start</strong> again to resume (if height still stalls at the same point, the triad was not upgraded).</li>
              <li>Use a 64-bit desktop Chrome/Edge with enough free RAM; close heavy tabs if needed.</li>
            </ol>
          </div>
        )}
        {storageFatal && (
          <div className="dash__error" style={{ marginTop: '0.85rem', textAlign: 'left' }}>
            <strong>Storage locked</strong> — another tab may still be using this site&apos;s data.
            <ol className="dash__checklist">
              <li>Close every other tab or window on this same site.</li>
              <li>
                Open <strong>Advanced</strong> below and click <strong>Recover</strong> once.
              </li>
              <li>If that fails: clear site data in the browser, refresh, then Start once.</li>
            </ol>
            <div className="controls__actions" style={{ marginTop: '0.65rem' }}>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={recoverOpfs}
                disabled={starting || clearingOpfs || !opfsOk}
              >
                {clearingOpfs ? 'Recovering…' : 'Recover & reload'}
              </button>
            </div>
          </div>
        )}
        <div className="snapshot" aria-label="Network snapshot">
          <div className={`snapshot__card${chain?.height != null ? ' is-live' : ''}`}>
            <span className="snapshot__label">Block height</span>
            <span className="snapshot__value">
              {chain?.height != null ? Number(chain.height).toLocaleString() : '—'}
            </span>
            {bridgeHttp?.height != null && (
              <span className="snapshot__sub">
                network {Number(bridgeHttp.height).toLocaleString()}
                {syncStats?.lag != null ? ` · lag ${syncStats.lag.toLocaleString()}` : ''}
              </span>
            )}
            {chain?.difficulty != null && !bridgeHttp?.height && (
              <span className="snapshot__sub">{formatHashrate(chain.difficulty)}</span>
            )}
          </div>
          <div className={`snapshot__card${nodeHealthy && syncRateLabel ? ' is-live' : ''}`}>
            <span className="snapshot__label">Sync rate</span>
            <span className="snapshot__value">
              {nodeHealthy && syncRateLabel ? syncRateLabel : '—'}
            </span>
            <span className="snapshot__sub">
              {nodeHealthy && syncStats?.etaSec != null
                ? `ETA ${formatEta(syncStats.etaSec)}`
                : nodeHealthy
                  ? 'measuring…'
                  : 'after start'}
            </span>
          </div>
          <div className={`snapshot__card${displayPeerCount > 0 ? ' is-live' : ''}`}>
            <span className="snapshot__label">Connections</span>
            <span className="snapshot__value">{nodeHealthy || peers.length ? displayPeerCount : '—'}</span>
            <span className="snapshot__sub">
              {nodeHealthy
                ? `${displayPeerCount === 1 ? 'peer' : 'peers'} · ${configuredPeerCount} WS URL${configuredPeerCount === 1 ? '' : 's'}`
                : 'after start'}
            </span>
          </div>
          <div className={`snapshot__card${displayMempoolCount > 0 ? ' is-live' : ''}`}>
            <span className="snapshot__label">Pending txs</span>
            <span className="snapshot__value">{nodeHealthy || mempool.length ? displayMempoolCount : '—'}</span>
            <span className="snapshot__sub">mempool</span>
          </div>
        </div>
      </section>

      {(!isolated || !sab) && (
        <div className="dash__error">
          This site must load with secure isolation headers so the node can run in-browser.
          Open it via the normal HTTPS link (or <code>npm run dev</code> locally on localhost), not a raw IP address.
        </div>
      )}
      {isolated && sab && !opfsOk && (
        <div className="dash__error">
          Storage is unavailable. Use Chrome or Edge on HTTPS (or <code>http://127.0.0.1</code>).
        </div>
      )}

      <div className="signers-row">
        <PoolThresholdSigner />
        <EthPoolThresholdSigner />
      </div>

      <section className="panel network" aria-label="Live network">
        <div className="panel__head">
          <h2>Network</h2>
          <span className="panel__count">
            {displayPeerCount} peer{displayPeerCount === 1 ? '' : 's'}
            {' · '}
            {displayMempoolCount} pending
          </span>
        </div>
        <div className="network__split">
          <div className="network__col">
            <h3 className="network__k">Connections</h3>
            <div className="list">
              {peers.length === 0 ? (
                <p className="list__empty">
                  {nodeHealthy ? 'Waiting for peers…' : 'Start the node to connect'}
                </p>
              ) : (
                peers.map((p) => {
                  const inbound = p.inbound === true || p.inbound === 'true' || p.inbound === 1 || p.inbound === '1';
                  const addr = String(p.address ?? '—');
                  return (
                    <div className="list-item" key={String(p.id)}>
                      <div className="list-item__row">
                        <span className="list-item__main">
                          {String(p.type || 'peer')}
                        </span>
                        <span className={`tag ${inbound ? 'tag--in' : 'tag--out'}`}>
                          {inbound ? 'in' : 'out'}
                        </span>
                      </div>
                      <div className="list-item__addr" title={addr}>
                        {shortAddr(addr, 10)}
                      </div>
                      {p.since != null && p.since !== '' && (
                        <div className="list-item__amounts">
                          <span className="muted">since {String(p.since)}</span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          <div className="network__col">
            <h3 className="network__k">Pending transactions</h3>
            <div className="list">
              {mempool.length === 0 ? (
                <p className="list__empty">
                  {nodeHealthy ? 'No pending transactions' : 'Empty until the node is running'}
                </p>
              ) : (
                mempool.map((tx) => (
                  <div className="list-item" key={String(tx.id ?? tx.txHash)}>
                    <div className="list-item__row">
                      <span className="list-item__main" title={String(tx.fromAddress || '')}>
                        {shortAddr(tx.fromAddress, 5)}
                        {' → '}
                        {shortAddr(tx.toAddress, 5)}
                      </span>
                    </div>
                    <div className="list-item__amounts">
                      <span>
                        <span className="muted">amount </span>
                        {tx.amount ?? '—'}
                      </span>
                      <span>
                        <span className="muted">fee </span>
                        {tx.fee ?? '—'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <details
        className="advanced console-card"
        open={logOpen}
        onToggle={(e) => setLogOpen(e.currentTarget.open)}
      >
        <summary>
          Console
          <span className="advanced__hint">
            Activity log, diagnostics and network settings
          </span>
          <span className="advanced__tail" title={status}>
            {status}
          </span>
        </summary>
        <div className="advanced__body">
          <div className="tabs" role="tablist" aria-label="Console sections">
            {CONSOLE_TABS.filter((t) => t.key !== 'ext' || !inExtPage).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={consoleTab === t.key}
                className={`tab${consoleTab === t.key ? ' is-on' : ''}`}
                onClick={() => setConsoleTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className={`pane${consoleTab === 'advanced' ? ' is-on' : ''}`} role="tabpanel">
          <div className="advanced__section">
            <h3>Browser readiness</h3>
            <div className="checks-grid">
              <Stat label="Isolation" value={isolated ? 'OK' : 'Missing'} />
              <Stat label="Shared memory" value={sab ? 'OK' : 'Missing'} />
              <Stat label="Storage" value={opfsOk ? 'OK' : 'Missing'} />
              <Stat label="Mode" value="Full node" />
            </div>
          </div>

          <div className="advanced__section">
            <h3>Public network</h3>
            <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
              Connected via <strong>{network.label}</strong>
              {` · WASM ${network.versionText}`}
              {bridgeHttp.state === 'ok' && bridgeHttp.height != null
                ? ` · network height #${bridgeHttp.height}`
                : ''}
              {network.testnet && !defiTriadReady
                ? ' · DeFi triad not installed yet'
                : ''}
            </p>
            <div className="status-row">
              <div className="status-card">
                <span className="label">Network HTTP</span>
                <span>
                  {bridgeHttp.state === 'ok' && (
                    <>OK{bridgeHttp.height != null ? ` · #${bridgeHttp.height}` : ''}</>
                  )}
                  {bridgeHttp.state === 'bad' && `Down · ${bridgeHttp.error}`}
                  {bridgeHttp.state === 'checking' && 'Checking…'}
                  {bridgeHttp.state === 'idle' && '—'}
                </span>
              </div>
              <div className="status-card">
                <span className="label">P2P bridge</span>
                <span>
                  {bridgeWs.state === 'ok' && `Open · ${bridgeWs.openedMs ?? '?'}ms`}
                  {bridgeWs.state === 'bad' && `Not ready · ${bridgeWs.detail}`}
                  {bridgeWs.state === 'skipped' && 'Not probed (safer)'}
                  {bridgeWs.state === 'checking' && 'Checking…'}
                  {bridgeWs.state === 'idle' && '—'}
                </span>
              </div>
              <div
                className="status-card"
                title="Official1 dashboard WebSocket only — not used by this full node. See docs/TRANSACTIONS.md"
              >
                <span className="label">RPC stream</span>
                <span>
                  {bridgeStream.state === 'ok' && `Open · ${bridgeStream.openedMs ?? '?'}ms`}
                  {bridgeStream.state === 'bad' && `Fail · ${bridgeStream.detail}`}
                  {bridgeStream.state === 'skipped' && 'Optional · not used'}
                  {bridgeStream.state === 'checking' && 'Checking…'}
                  {bridgeStream.state === 'idle' && '—'}
                </span>
              </div>
            </div>
            {bridgeHttp.state === 'bad' && (
              <div className="dash__error" style={{ marginTop: '0.5rem' }}>
                Network probe failed ({bridgeHttp.error}). Starting the node may still work.
              </div>
            )}
            {bridgeWs.state === 'bad' && (
              <div className="dash__error" style={{ marginTop: '0.5rem' }}>
                Bridge probe failed for <code className="mono">{wsPeers || network.wsBridge}</code>
                {bridgeWs.detail ? ` (${bridgeWs.detail})` : ''}.
                You can still try Start if the browser is Ready.
              </div>
            )}
          </div>

          {chain && (
            <div className="advanced__section">
              <h3>Chain detail</h3>
              <div className="chain-grid">
                <Stat label="Height" value={String(chain.height)} />
                <Stat label="Difficulty" value={formatHashrate(chain.difficulty)} />
                <Stat label="Worksum" value={formatHashrate(chain.worksum)} />
              </div>
            </div>
          )}

          <div className="advanced__section">
            <h3>Peer endpoints (multi-peer)</h3>
            <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
              Semicolon-separated <code>wss://…/ws</code> URLs. More bridges = more parallel
              block batches. WebRTC is enabled so Official1 can also introduce extra peers after connect.
            </p>
            <div className="controls__custom">
              <input
                type="text"
                value={peersInput}
                onChange={(e) => setPeersInput(e.target.value)}
                disabled={running || starting}
                placeholder={`${network.wsBridge};wss://other-bridge/ws`}
                aria-label="WebSocket peer URLs"
              />
              <div className="controls__actions">
                <button type="button" className="btn" onClick={applyPeers} disabled={running || starting}>
                  Save
                </button>
                <button type="button" className="btn btn--ghost" onClick={useNetworkDefaultPeers} disabled={running || starting}>
                  {network.shortLabel} default
                </button>
                {isLocalDevHost() && (
                  <button type="button" className="btn btn--ghost" onClick={useLocalProxy} disabled={running || starting}>
                    Local proxy
                  </button>
                )}
              </div>
            </div>
            <div className="controls__meta" style={{ marginTop: '0.5rem' }}>
              <span className="mono muted small" title={wsPeers}>
                WS_PEERS ({configuredPeerCount})={wsPeers}
              </span>
            </div>
          </div>

          <div className="advanced__section">
            <h3>Chain snapshot</h3>
            <p className="muted small" style={{ margin: '0 0 0.65rem' }}>
              Skip most of genesis→tip, then Start to catch up.
              Local:{' '}
              {localDbInfo?.present
                ? <strong>{formatBytes(localDbInfo.bytes)}</strong>
                : <em>none</em>}
              {publicSnapshot?.height != null ? (
                <>
                  {' · '}Site offer:{' '}
                  <strong>h{Number(publicSnapshot.height).toLocaleString()}</strong>
                  {' '}({formatBytes(publicSnapshot.bytes || 0)})
                </>
              ) : (
                <>
                  {' · '}Site offer: <em>none on this host</em>
                  {' '}(use Choose file or a CDN URL)
                </>
              )}
            </p>
            <div className="controls__actions" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn"
                onClick={importPublicSnapshot}
                disabled={!canImportSiteSnapshot}
                title={
                  publicSnapshot
                    ? undefined
                    : 'No reachable site snapshot (Netlify does not ship multi‑GB chain.db3)'
                }
              >
                {snapshotBusy ? 'Importing…' : 'Import site snapshot'}
              </button>
              <label className="btn btn--ghost" style={{ cursor: canImportPublicSnapshot ? 'pointer' : 'not-allowed' }}>
                Choose file…
                <input
                  ref={snapshotFileRef}
                  type="file"
                  accept=".db3,application/octet-stream"
                  disabled={!canImportPublicSnapshot}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) importSnapshotFile(f);
                  }}
                  aria-label="Import chain.db3 file"
                />
              </label>
            </div>
            <div className="controls__custom" style={{ marginTop: '0.65rem' }}>
              <input
                type="url"
                value={snapshotUrl}
                onChange={(e) => setSnapshotUrl(e.target.value)}
                disabled={running || starting || stopping || snapshotBusy}
                placeholder="Or paste URL…"
                aria-label="Snapshot URL"
              />
              <div className="controls__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => importSnapshotUrl()}
                  disabled={!canImportPublicSnapshot || !snapshotUrl.trim()}
                >
                  Import URL
                </button>
              </div>
            </div>
            <p className="muted small" style={{ margin: '0.5rem 0 0' }}>
              Own file must be checkpointed DELETE-mode <code>chain.db3</code> only (no <code>-wal</code>).
              Local dev: <code>npm run snapshot:link</code>. Production: host the .db3 on a CDN/VPS with
              {' '}<code>Cross-Origin-Resource-Policy</code> and set <code>PUBLIC_SNAPSHOT_URL</code>
              {' '}or <code>manifest.url</code> — do not force-deploy multi‑GB to Netlify.
            </p>
          </div>

          <div className="advanced__section">
            <h3>Tools</h3>
            <div className="controls__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => runBridgeProbes(wsPeers, { probeP2pWs: false, probeStream: false })}
                disabled={running || starting}
              >
                Re-check network
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={testRawWs}
                disabled={running || starting}
                title="Open WebSocket only — burns public /ws slot if pointed at Official1"
              >
                Test connection
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => runBridgeProbes(wsPeers, { probeP2pWs: true })}
                disabled={running || starting}
                title="Opens P2P /ws — burns Official1 per-IP slot for ~30s"
              >
                Probe P2P (caution)
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={clearOpfs}
                disabled={!canClearOpfs}
                title="Delete local chain databases for this site"
              >
                {clearingOpfs ? 'Clearing…' : 'Clear local data'}
              </button>
              <button
                type="button"
                className="btn btn--danger-ghost"
                onClick={recoverOpfs}
                disabled={starting || clearingOpfs || !opfsOk}
                title="Clear storage and reload the page"
              >
                Recover &amp; reload
              </button>
            </div>
          </div>

          <details className="dash__help">
            <summary>For operators (VPS / nginx)</summary>
            <ol className="dash__checklist">
              <li>
                Browser needs isolation headers (COOP/COEP), WASM under{' '}
                <code className="mono">/node/</code>, and{' '}
                <code className="mono">WS_PEERS=wss://…/ws</code>.
              </li>
              <li>
                Node flags:{' '}
                <code className="mono">{network.flags?.join(' ') || '—'}</code>
              </li>
              <li>
                Nginx: proxy <code className="mono">/ws</code> to localhost with Upgrade + X-Forwarded-For.
              </li>
            </ol>
          </details>
          </div>

          <div className={`pane${consoleTab === 'log' ? ' is-on' : ''}`} role="tabpanel">
            <textarea
              ref={consoleRef}
              className="console"
              readOnly
              value={logLines.join('\n')}
              spellCheck={false}
              aria-label="Node console log"
            />
          </div>

          <div
            className={`pane ext-download${consoleTab === 'ext' && !inExtPage ? ' is-on' : ''}`}
            role="tabpanel"
          >
          <p className="ext-download__lead">
            Same full WASM node as this page, as a Chrome / Brave / Edge extension.
            Side panel stays open while you browse (more reliable isolation on Brave).
          </p>
          <div className="ext-download__actions">
            <a
              className="btn btn--ghost"
              href="/downloads/warthog_node_extension.zip"
              download="warthog_node_extension.zip"
            >
              Download extension (.zip)
            </a>
          </div>
          <ol className="ext-download__steps">
            <li>Unzip the archive (one folder: <code>warthog_node_extension</code>).</li>
            <li>Open <code>chrome://extensions</code> (or <code>brave://extensions</code>).</li>
            <li>Enable <strong>Developer mode</strong> → <strong>Load unpacked</strong>.</li>
            <li>Select the unzipped folder that contains <code>manifest.json</code>.</li>
            <li>Click the toolbar icon → side panel → <strong>Start node</strong>.</li>
          </ol>
          </div>
        </div>
      </details>

      <footer className="dash__footer">
        <p>
          A full Warthog node runs inside this browser tab via WebAssembly.
          Leave the tab open while it syncs and stays connected.
        </p>
      </footer>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}
