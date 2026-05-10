/**
 * AWS DevOps Agent Interactive Demo
 * Polls GET /health every 5s, GET /events every 5s.
 * Break/Fix buttons trigger POST /t and POST /r for 6 scenarios.
 * Mutual exclusion: only one scenario active at a time.
 */

// ── Configuration ──────────────────────────────────────────────────
let API_BASE_URL = window.DASHBOARD_CONFIG?.apiUrl || '';
let currentSessionId = null;
let knownEventCount = 0;
let activeScenarioId = null;
let webhookConfigured = false;
let authToken = null;
let authTokenExpiry = 0;
let cognitoConfig = null;

const SCENARIOS = {
  1: { name: 'Security Group Rule', short: 'RDS port 3306' },
  2: { name: 'NAT Gateway Route', short: 'outbound internet' },
  3: { name: 'VPC Endpoint Policy', short: 'S3 access' },
  4: { name: 'Bedrock Endpoint Subnets', short: 'AI feature' },
  5: { name: 'ALB Backend Failure', short: '502 Bad Gateway' },
  6: { name: 'TLS/SNI Mismatch + PCAP', short: 'cert mismatch' },
};


// ── Authentication ─────────────────────────────────────────────────
function getAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = authToken;
  return headers;
}

async function authenticateWithCognito(username, password) {
  if (!cognitoConfig) throw new Error('Auth not configured');
  const body = JSON.stringify({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: cognitoConfig.dashboardClientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  const res = await fetch(
    `https://cognito-idp.${cognitoConfig.region}.amazonaws.com/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      },
      body,
    }
  );
  const data = await res.json();
  if (data.AuthenticationResult) {
    authToken = data.AuthenticationResult.IdToken;
    authTokenExpiry = Date.now() + (data.AuthenticationResult.ExpiresIn * 1000) - 60000;
    sessionStorage.setItem('dashboardAuthToken', authToken);
    sessionStorage.setItem('dashboardAuthExpiry', String(authTokenExpiry));
    return true;
  }
  throw new Error(data.message || data.__type || 'Authentication failed');
}

async function ensureAuth() {
  if (authToken && Date.now() < authTokenExpiry) return true;
  // Token expired — try to re-authenticate with stored credentials
  const stored = sessionStorage.getItem('dashboardAuthToken');
  const expiry = parseInt(sessionStorage.getItem('dashboardAuthExpiry') || '0', 10);
  if (stored && Date.now() < expiry) {
    authToken = stored;
    authTokenExpiry = expiry;
    return true;
  }
  // Need fresh login
  showLoginOverlay();
  return false;
}

function showLoginOverlay() {
  document.getElementById('loginOverlay').style.display = 'flex';
  document.getElementById('loginError').textContent = '';
}

function hideLoginOverlay() {
  document.getElementById('loginOverlay').style.display = 'none';
}

async function handleLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const errorEl = document.getElementById('loginError');

  if (!username || !password) {
    errorEl.textContent = 'Username and password are required.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  errorEl.textContent = '';

  try {
    await authenticateWithCognito(username, password);
    hideLoginOverlay();
    // Re-initialize after login
    fetchConfig();
    pollHealth();
    pollEvents();
  } catch (e) {
    errorEl.textContent = e.message || 'Login failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

// ── Tab Switching ──────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  if (tabName === 'config') {
    document.getElementById('tabConfig').classList.add('active');
    document.getElementById('tabBtnConfig').classList.add('active');
  } else if (tabName === 'scenarios') {
    document.getElementById('tabScenarios').classList.add('active');
    document.getElementById('tabBtnScenarios').classList.add('active');
  } else if (tabName === 'explain') {
    document.getElementById('tabExplain').classList.add('active');
    document.getElementById('tabBtnExplain').classList.add('active');
  } else {
    document.getElementById('tabWelcome').classList.add('active');
    document.getElementById('tabBtnWelcome').classList.add('active');
  }
}

// ── Config Sub-tab Switching ───────────────────────────────────────
function switchConfigSubtab(subtab) {
  document.querySelectorAll('.subtab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.subtab-btn').forEach(el => el.classList.remove('active'));

  if (subtab === 'mcp') {
    document.getElementById('subtabMcp').classList.add('active');
    document.getElementById('subtabBtnMcp').classList.add('active');
  } else if (subtab === 'webhook') {
    document.getElementById('subtabWebhook').classList.add('active');
    document.getElementById('subtabBtnWebhook').classList.add('active');
  } else if (subtab === 's3') {
    document.getElementById('subtabS3').classList.add('active');
    document.getElementById('subtabBtnS3').classList.add('active');
  }
}

// ── Theme ──────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('dashboardTheme') || 'dark';
  applyTheme(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('dashboardTheme', theme);
  document.getElementById('themeIcon').textContent = theme === 'dark' ? '☀️' : '🌙';
  document.getElementById('themeLabel').textContent = theme === 'dark' ? 'Light' : 'Dark';
}

// ── Topology Fullscreen Toggle ─────────────────────────────────────
function toggleTopologyFullscreen() {
  const container = document.getElementById('topologyContainer');
  const btn = document.getElementById('fullscreenBtn');
  if (!container) return;

  container.classList.toggle('fullscreen');
  const isFullscreen = container.classList.contains('fullscreen');
  btn.textContent = isFullscreen ? '✕' : '⛶';
  btn.title = isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen';

  // ESC key to exit
  if (isFullscreen) {
    document.addEventListener('keydown', exitFullscreenOnEsc);
  } else {
    document.removeEventListener('keydown', exitFullscreenOnEsc);
  }
}

function exitFullscreenOnEsc(e) {
  if (e.key === 'Escape') {
    const container = document.getElementById('topologyContainer');
    if (container && container.classList.contains('fullscreen')) {
      toggleTopologyFullscreen();
    }
  }
}

// ── Initialization ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  const params = new URLSearchParams(window.location.search);
  const apiParam = params.get('api');
  if (apiParam) {
    API_BASE_URL = apiParam.replace(/\/+$/, '');
    localStorage.setItem('dashboardApiUrl', API_BASE_URL);
  } else if (!API_BASE_URL) {
    API_BASE_URL = (localStorage.getItem('dashboardApiUrl') || '').replace(/\/+$/, '');
  }

  if (!API_BASE_URL) {
    const url = prompt(
      'Enter the Dashboard API Gateway URL:\n(Found in CDK output: DashboardApiUrl)',
      'https://xxxxxxxxxx.execute-api.us-east-1.amazonaws.com/prod'
    );
    if (url) {
      API_BASE_URL = url.replace(/\/+$/, '');
      localStorage.setItem('dashboardApiUrl', API_BASE_URL);
    }
  }

  if (API_BASE_URL) {
    // Check for auth params in URL
    const region = params.get('region');
    const userPoolId = params.get('userPoolId');
    const clientId = params.get('clientId');
    if (region && userPoolId && clientId) {
      cognitoConfig = { region, userPoolId, dashboardClientId: clientId };
      localStorage.setItem('dashboardCognitoConfig', JSON.stringify(cognitoConfig));
    } else {
      const saved = localStorage.getItem('dashboardCognitoConfig');
      if (saved) cognitoConfig = JSON.parse(saved);
    }

    // Restore auth token from session
    const storedToken = sessionStorage.getItem('dashboardAuthToken');
    const storedExpiry = parseInt(sessionStorage.getItem('dashboardAuthExpiry') || '0', 10);
    if (storedToken && Date.now() < storedExpiry) {
      authToken = storedToken;
      authTokenExpiry = storedExpiry;
    }

    // If we have Cognito config but no valid token, show login
    if (cognitoConfig && !authToken) {
      showLoginOverlay();
      // Try auto-login via /config (unauthenticated first fetch to get credentials)
      autoLogin();
    } else {
      initDashboard();
    }
  } else {
    log('t-error', 'No API URL configured. Reload and enter the API Gateway URL.');
    setConnectionStatus(false);
  }
});

function initDashboard() {
  log('t-system', 'Dashboard initialized');
  log('t-system', `API: ${API_BASE_URL}`);

  // Restore session from localStorage
  const savedSession = localStorage.getItem('dashboardSessionId');
  const savedScenario = localStorage.getItem('dashboardActiveScenario');
  if (savedSession) {
    currentSessionId = savedSession;
    activeScenarioId = savedScenario ? parseInt(savedScenario, 10) : null;
    knownEventCount = 0;
    showSessionInfo();
    log('t-system', `Restored session: ${currentSessionId}`);
  }

  fetchConfig();
  pollHealth();
  pollEvents();
  setInterval(pollHealth, 3000);
  setInterval(pollEvents, 3000);

  // Auto-scroll terminal to bottom on resize
  window.addEventListener('resize', scrollTerminalToBottom);
}

async function autoLogin() {
  // If credentials are embedded in config response, auto-login
  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/config`, { headers: getAuthHeaders() });
    if (res.status === 401 || res.status === 403) {
      // API requires auth — show login form, user must enter credentials manually
      return;
    }
    const cfg = await res.json();
    if (cfg.auth?.credentials) {
      const { username, password } = cfg.auth.credentials;
      cognitoConfig = cfg.auth;
      localStorage.setItem('dashboardCognitoConfig', JSON.stringify(cognitoConfig));
      await authenticateWithCognito(username, password);
      hideLoginOverlay();
      initDashboard();
    }
  } catch (e) {
    // Auto-login failed — user will use the login form
  }
}

// ── Connection Status ──────────────────────────────────────────────
function setConnectionStatus(connected) {
  const el = document.getElementById('connectionStatus');
  if (connected) {
    el.className = 'status-badge status-badge-success';
    el.innerHTML = '<span class="status-dot status-dot-success"></span>Connected';
  } else {
    el.className = 'status-badge status-badge-error';
    el.innerHTML = '<span class="status-dot status-dot-error"></span>Disconnected';
  }
}

// ── Health Polling ─────────────────────────────────────────────────
async function pollHealth() {
  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/health`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    setConnectionStatus(true);

    // Update active scenario from server state
    const serverActiveScenario = d.activeScenario ? parseInt(d.activeScenario.scenarioId, 10) : null;
    activeScenarioId = serverActiveScenario;

    // If server says there's an active scenario and we have a session, keep it
    if (d.activeScenario && d.activeScenario.sessionId) {
      if (!currentSessionId || currentSessionId !== d.activeScenario.sessionId) {
        currentSessionId = d.activeScenario.sessionId;
        localStorage.setItem('dashboardSessionId', currentSessionId);
        showSessionInfo();
      }
    }

    // Update each scenario card status
    const scenarios = d.scenarios || [];
    if (Array.isArray(scenarios)) {
      // Array format: [{id: 1, status: 'healthy'}, ...]
      scenarios.forEach(s => {
        updateScenarioCard(s.id, s.status || 'healthy');
      });
    } else {
      // Object format: {"1": "healthy", ...}
      for (let i = 1; i <= 6; i++) {
        const status = scenarios[String(i)] || 'healthy';
        updateScenarioCard(i, status);
      }
    }

    // Update button states based on mutual exclusion
    updateButtonStates();

  } catch (e) {
    setConnectionStatus(false);
  }
}

// ── Scenario Card Updates ──────────────────────────────────────────
function updateScenarioCard(scenarioId, status) {
  const card = document.getElementById(`scenarioCard${scenarioId}`);
  const statusEl = document.getElementById(`scenarioStatus${scenarioId}`);
  if (!card || !statusEl) return;

  // Remove old status classes
  card.classList.remove('status-healthy', 'status-broken', 'status-investigating');

  const dot = statusEl.querySelector('.status-dot');
  const text = statusEl.querySelector('.scenario-status-text');

  switch (status) {
    case 'broken':
      card.classList.add('status-broken');
      statusEl.className = 'status-badge status-badge-error scenario-status';
      dot.className = 'status-dot status-dot-error';
      text.textContent = 'Broken';
      break;
    case 'investigating':
      card.classList.add('status-investigating');
      statusEl.className = 'status-badge status-badge-warning scenario-status';
      dot.className = 'status-dot status-dot-warning';
      text.textContent = 'Investigating';
      break;
    default:
      card.classList.add('status-healthy');
      statusEl.className = 'status-badge status-badge-success scenario-status';
      dot.className = 'status-dot status-dot-success';
      text.textContent = 'Healthy';
      break;
  }

  // Update topology diagram
  updateTopologyPath(scenarioId, status);

  // Update alarm pipeline dot
  updateAlarmDot(scenarioId, status);
}

// ── Button State Management (Mutual Exclusion) ─────────────────────
function updateButtonStates() {
  const breakBtns = document.querySelectorAll('.break-btn');
  const fixBtns = document.querySelectorAll('.fix-btn');
  const banner = document.getElementById('webhookBanner');

  if (!webhookConfigured) {
    // Webhook not configured: disable ALL buttons, show banner
    breakBtns.forEach(btn => { btn.disabled = true; });
    fixBtns.forEach(btn => { btn.disabled = true; });
    if (banner) banner.style.display = 'block';
    return;
  }

  // Webhook configured: hide banner
  if (banner) banner.style.display = 'none';

  if (activeScenarioId) {
    // Active scenario exists: disable ALL break buttons, enable only the active scenario's fix button
    breakBtns.forEach(btn => { btn.disabled = true; });
    fixBtns.forEach(btn => {
      const sid = parseInt(btn.getAttribute('data-scenario'), 10);
      btn.disabled = (sid !== activeScenarioId);
    });
  } else {
    // No active scenario: enable all break buttons, disable all fix buttons
    breakBtns.forEach(btn => { btn.disabled = false; });
    fixBtns.forEach(btn => { btn.disabled = true; });
  }
}

// ── Topology Diagram Updates ───────────────────────────────────────
function updateTopologyPath(scenarioId, status) {
  const isBroken = (status === 'broken' || status === 'investigating');
  const sid = String(scenarioId);

  // Scenario 2 has two path segments, Scenario 6 also has two segments
  const pathIds = sid === '2'
    ? [`path-s2a`, `path-s2b`]
    : sid === '3'
    ? [`path-s3`, `path-s3b`]
    : sid === '4'
    ? [`path-s4`, `path-s4b`]
    : sid === '6'
    ? [`path-s6`, `path-s6b`]
    : [`path-s${sid}`];
  const flowIds = sid === '2'
    ? [`flow-s2a`, `flow-s2b`]
    : sid === '3'
    ? [`flow-s3`, `flow-s3b`]
    : sid === '4'
    ? [`flow-s4`, `flow-s4b`]
    : sid === '6'
    ? [`flow-s6`, `flow-s6b`]
    : [`flow-s${sid}`];
  const dotIds = sid === '2'
    ? [`dot-s2a`, `dot-s2b`]
    : [`dot-s${sid}`];

  // Update path colors
  pathIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('topo-path-healthy', 'topo-path-broken');
    el.classList.add(isBroken ? 'topo-path-broken' : 'topo-path-healthy');
  });

  // Update flow animation
  flowIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('topo-flow-healthy', 'topo-flow-broken');
    el.classList.add(isBroken ? 'topo-flow-broken' : 'topo-flow-healthy');
  });

  // Update glowing dot particles
  dotIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('topo-dot-healthy', 'topo-dot-broken');
    el.classList.add(isBroken ? 'topo-dot-broken' : 'topo-dot-healthy');
    el.setAttribute('opacity', isBroken ? '0.5' : '0.9');
  });

  // Update break X indicator
  const breakX = document.getElementById(`break-x-s${sid}`);
  const breakBg = document.getElementById(`break-bg-s${sid}`);
  if (breakX) breakX.classList.toggle('visible', isBroken);
  if (breakBg) breakBg.classList.toggle('visible', isBroken);

  // Update badge color
  const badgeBg = document.getElementById(`badge-bg-s${sid}`);
  if (badgeBg) badgeBg.setAttribute('fill', isBroken ? '#d91515' : '#037f0c');
}

// ── Alarm Pipeline Updates ─────────────────────────────────────────
function updateAlarmDot(scenarioId, status) {
  const node = document.getElementById(`alarmNode${scenarioId}`);
  if (!node) return;
  const isBroken = (status === 'broken' || status === 'investigating');
  const box = node.querySelector('.topo-node-box');
  if (box) {
    box.style.stroke = isBroken ? '#d91515' : '';
    box.style.strokeWidth = isBroken ? '2' : '';
  }

  // Show/hide the specific alarm line
  const alarmLine = document.getElementById(`alarmLine${scenarioId}`);
  if (alarmLine) {
    alarmLine.style.display = isBroken ? 'block' : 'none';
  }

  // Show/hide pipeline flow based on any active alarm
  const anyBroken = document.querySelector('.scenario-card.status-broken, .scenario-card.status-investigating');
  const pipelineFlow = document.getElementById('pipelineFlow');
  const pipelineIdle = document.getElementById('pipelineIdle');
  if (pipelineFlow && pipelineIdle) {
    if (anyBroken) {
      pipelineFlow.style.display = 'block';
      pipelineIdle.style.display = 'none';
    } else {
      pipelineFlow.style.display = 'none';
      pipelineIdle.style.display = 'block';
    }
  }
}

// ── Events Polling ─────────────────────────────────────────────────
async function pollEvents() {
  if (!currentSessionId) return;
  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/events?sessionId=${currentSessionId}`, { headers: getAuthHeaders() });
    if (!res.ok) return;
    const d = await res.json();
    const evts = d.events || [];
    if (evts.length > knownEventCount) {
      evts.slice(knownEventCount).forEach(renderEvent);
      knownEventCount = evts.length;
      scrollTerminalToBottom();
    }
  } catch (e) {
    console.warn('pollEvents error:', e.message);
  }
}

// ── Event Rendering ────────────────────────────────────────────────
const EVENT_MAP = {
  scenario_break_triggered: ['t-break', '💥', d => `Break triggered: Scenario ${d.scenarioId || '?'} — ${SCENARIOS[d.scenarioId]?.name || ''}`],
  scenario_active:          ['t-break', '🔴', d => `Scenario ${d.scenarioId || '?'} broken`],
  scenario_fix_triggered:   ['t-fix',   '🔧', d => `Fix triggered: Scenario ${d.scenarioId || '?'} — ${SCENARIOS[d.scenarioId]?.name || ''}`],
  scenario_resolved:           ['t-fix',   '✅', d => `Scenario ${d.scenarioId || '?'} fixed`],
  alarm_triggered:          ['t-alarm', '🚨', d => `Alarm: ${d.alarmName || ''} ${d.newStateValue || 'ALARM'}`],
  webhook_sent:             ['t-webhook','📤', d => `Webhook sent: ${d.incidentId || ''}`],
  investigation_created:    ['t-inv-created',  '🔍', d => `Investigation started: ${d.investigationId || ''}`],
  investigation_in_progress:['t-inv-progress', '⏳', d => `Investigation in progress${d.progress ? ': ' + d.progress : ''}`],
  investigation_completed:  ['t-inv-completed','✅', d => { if (d.findings) showFindings(d.findings); return `Investigation completed: ${d.investigationId || ''}`; }],
  investigation_failed:     ['t-inv-failed',   '❌', d => `Investigation failed: ${d.error || ''}`],
  findings_retrieved:       ['t-findings','📋', d => { if (d.findings) showFindings(d.findings); return 'Findings retrieved'; }],
  break_event:              ['t-break', '💥', d => `Break: ${d.message || JSON.stringify(d)}`],
  fix_event:                ['t-fix',   '✅', d => `Fix: ${d.message || JSON.stringify(d)}`],
};

function renderEvent(evt) {
  const type = evt.eventType || 'unknown';
  const data = typeof evt.data === 'string' ? tryParse(evt.data) : (evt.data || evt);
  const [cls, icon, fn] = EVENT_MAP[type] || ['t-system', '•', d => `${type}: ${JSON.stringify(d)}`];
  log(cls, `${icon} ${fn(data)}`, evt.timestamp);
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return { message: s }; }
}

// ── Terminal ───────────────────────────────────────────────────────
function log(cls, text, timestamp) {
  const el = document.getElementById('terminal');
  const line = document.createElement('div');
  line.className = `terminal-line ${cls}`;
  const t = new Date(timestamp || Date.now()).toLocaleTimeString();
  line.innerHTML = `<span class="ts">[${t}]</span><span class="ev">${esc(text)}</span>`;
  el.appendChild(line);
  if (document.getElementById('autoScroll').checked) el.scrollTop = el.scrollHeight;
}

function clearTerminal() {
  document.getElementById('terminal').innerHTML = '';
  log('t-system', 'Cleared');
}

function scrollTerminalToBottom() {
  const el = document.getElementById('terminal');
  if (el) el.scrollTop = el.scrollHeight;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Findings ───────────────────────────────────────────────────────
function showFindings(f) {
  document.getElementById('findingsContent').textContent = typeof f === 'string' ? f : JSON.stringify(f, null, 2);
  document.getElementById('findingsCard').style.display = 'block';
}

function clearFindings() { document.getElementById('findingsCard').style.display = 'none'; }

// ── Session Info ───────────────────────────────────────────────────
function showSessionInfo() {
  document.getElementById('sessionInfo').style.display = 'block';
  document.getElementById('currentSessionId').textContent = currentSessionId || '—';
}

function clearSession() {
  currentSessionId = null;
  activeScenarioId = null;
  knownEventCount = 0;
  localStorage.removeItem('dashboardSessionId');
  localStorage.removeItem('dashboardActiveScenario');
  document.getElementById('sessionInfo').style.display = 'none';
}

// ── Break Scenario ─────────────────────────────────────────────────
async function breakScenario(scenarioId) {
  const btn = document.querySelector(`.break-btn[data-scenario="${scenarioId}"]`);
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Breaking...';
  log('t-system', `Sending break request for Scenario ${scenarioId}...`);

  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/t`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ id: scenarioId }),
    });
    const d = await res.json();
    if (res.ok) {
      currentSessionId = d.sessionId;
      activeScenarioId = scenarioId;
      knownEventCount = 0;
      localStorage.setItem('dashboardSessionId', currentSessionId);
      localStorage.setItem('dashboardActiveScenario', String(scenarioId));
      showSessionInfo();
      log('t-break', `💥 Break initiated: Scenario ${scenarioId} — ${SCENARIOS[scenarioId]?.name || ''} (session: ${currentSessionId})`);
      updateButtonStates();
      // Immediately poll to update UI
      pollHealth();
      pollEvents();
    } else if (res.status === 409) {
      log('t-error', `Break rejected: ${d.error || 'Another scenario is already active'}`);
    } else {
      log('t-error', `Break failed: ${d.error || 'Unknown error'}`);
    }
  } catch (e) {
    log('t-error', `Break failed: ${e.message}`);
  } finally {
    btn.textContent = originalText;
    // Button state will be updated by next health poll
  }
}

// ── Fix Scenario ───────────────────────────────────────────────────
async function fixScenario(scenarioId) {
  const btn = document.querySelector(`.fix-btn[data-scenario="${scenarioId}"]`);
  if (!btn) return;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Fixing...';
  log('t-system', `Sending fix request for Scenario ${scenarioId}...`);

  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/r`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ id: scenarioId, sessionId: currentSessionId }),
    });
    const d = await res.json();
    if (res.ok) {
      log('t-fix', `🔧 Fix initiated: Scenario ${scenarioId} — ${SCENARIOS[scenarioId]?.name || ''}`);
      // Keep session for event tracking but clear active scenario
      activeScenarioId = null;
      localStorage.removeItem('dashboardActiveScenario');
      updateButtonStates();
      // Immediately poll to update UI
      pollHealth();
      pollEvents();
    } else {
      log('t-error', `Fix failed: ${d.error || 'Unknown error'}`);
    }
  } catch (e) {
    log('t-error', `Fix failed: ${e.message}`);
  } finally {
    btn.textContent = originalText;
  }
}

// ── MCP Config ─────────────────────────────────────────────────────
async function fetchConfig() {
  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/config`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cfg = await res.json();

    // Agent Space console link
    const linkEl = document.getElementById('agentSpaceLink');
    if (cfg.consoleUrl) {
      linkEl.innerHTML = `<p class="config-section-note">Go to the <a href="${esc(cfg.consoleUrl)}" target="_blank" style="color:var(--color-text-interactive);">Agent Space console</a>, navigate to <strong>Capabilities → MCP Servers → Register</strong>, and use the values below to register the PCAP MCP server.</p>`;
      // Also set the webhook section link
      const webhookLink = document.getElementById('webhookAgentSpaceLink');
      if (webhookLink) webhookLink.href = cfg.consoleUrl;
    }

    // Set DevOps Agent operator dashboard link in topology diagram
    if (cfg.agentSpaceId) {
      const agentLink = document.getElementById('devopsAgentLink');
      if (agentLink) agentLink.setAttribute('href', `https://${cfg.agentSpaceId}.aidevops.global.app.aws/dashboard`);
    }

    // PCAP MCP Server details
    setConfigValue('mcpEndpointUrl', cfg.mcpEndpointUrl || 'Not deployed');
    setConfigValue('mcpClientId', cfg.cognitoClientId || 'Not available');
    setConfigValue('mcpClientSecret', cfg.clientSecret || 'Not available');
    setConfigValue('mcpTokenEndpoint', cfg.cognitoTokenEndpoint || 'Not available');

    // S3 bucket ARNs
    setConfigValue('vpcFlowLogBucket', cfg.buckets?.vpcFlowLogs || 'Not available');
    setConfigValue('elbAccessLogBucket', cfg.buckets?.elbAccessLogs || 'Not available');
    setConfigValue('pcapStorageBucket', cfg.buckets?.pcapStorage || 'Not available');

    // Webhook status
    const ws = document.getElementById('webhookStatus');
    if (cfg.webhook?.configured) {
      ws.innerHTML = '<span style="color:var(--color-text-status-success);">✓ Webhook configured</span>';
      document.getElementById('webhookUrlInput').placeholder = 'Webhook already configured. Paste new URL to update.';
      document.getElementById('hmacSecretInput').placeholder = 'Paste new HMAC secret to update.';
      webhookConfigured = true;
    } else {
      ws.innerHTML = '<span style="color:var(--color-text-status-warning);">Not configured. Paste the webhook URL and HMAC secret from the DevOps Agent console.</span>';
      webhookConfigured = false;
    }
    updateButtonStates();
  } catch (e) {
    setConfigValue('mcpEndpointUrl', 'Error loading config');
    setConfigValue('mcpClientId', '—');
    setConfigValue('mcpClientSecret', '—');
    setConfigValue('mcpTokenEndpoint', '—');
    setConfigValue('vpcFlowLogBucket', '—');
    setConfigValue('elbAccessLogBucket', '—');
    setConfigValue('pcapStorageBucket', '—');
  }
}

function setConfigValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── Copy Button ────────────────────────────────────────────────────
function copyValue(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const btn = el.parentElement.querySelector('.btn-copy');
  navigator.clipboard.writeText(el.textContent).then(() => {
    if (btn) {
      btn.textContent = 'Copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
    }
  });
}

function copyText(text) {
  const caller = event?.target;
  navigator.clipboard.writeText(text).then(() => {
    if (caller && caller.classList.contains('btn-copy')) {
      caller.textContent = 'Copied';
      caller.classList.add('copied');
      setTimeout(() => { caller.textContent = 'Copy'; caller.classList.remove('copied'); }, 2000);
    }
  });
}

// ── Webhook Config ─────────────────────────────────────────────────
async function configureWebhook() {
  const url = document.getElementById('webhookUrlInput').value.trim();
  const secret = document.getElementById('hmacSecretInput').value.trim();
  const status = document.getElementById('webhookStatus');
  const btn = document.getElementById('webhookConfigBtn');

  if (!url || !secret) {
    status.innerHTML = '<span style="color:var(--color-text-status-error);">Both fields are required.</span>';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';
  status.textContent = '';

  try {
    if (!await ensureAuth()) return;
    const res = await fetch(`${API_BASE_URL}/webhook-config`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ webhookUrl: url, hmacSecret: secret }),
    });
    const d = await res.json();
    if (res.ok) {
      status.innerHTML = '<span style="color:var(--color-text-status-success);">✓ Webhook configured successfully.</span>';
      document.getElementById('webhookUrlInput').value = '';
      document.getElementById('hmacSecretInput').value = '';
      log('t-system', 'Webhook configured via dashboard');
      fetchConfig(); // Refresh status
    } else {
      status.innerHTML = `<span style="color:var(--color-text-status-error);">${esc(d.error || 'Failed to configure webhook.')}</span>`;
    }
  } catch (e) {
    status.innerHTML = `<span style="color:var(--color-text-status-error);">Error: ${esc(e.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save webhook';
  }
}
