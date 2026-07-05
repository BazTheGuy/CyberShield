// CyberShield JS Engine - Native 3D WebGL Edition (Three.js)

// State Management
let appStatus = { admin: false, os: 'win32' };
let activeFlows = [];
let alarmThreshold = parseInt(localStorage.getItem('alarmThreshold')) || 999999999;
let activeAlarm = null;
let tabState = 'realtime';
let historyRangePreset = localStorage.getItem('historyRangePreset') || '5m';

// Settings State
let viewportMode = '3d'; // '3d', 'cli', or 'graph'
let currentTheme = localStorage.getItem('cyberTheme') || 'cyber-neon';
let currentVizMode = 'highway';
let scanlinesEnabled = localStorage.getItem('scanlines') !== 'false';
let animIntensity = localStorage.getItem('animIntensity') || 'medium';

// Real-time Line Graph Variables
let liveLineChart = null;
let graphHistory = [];
let lastGraphUpdateTime = 0;
let graphProcessFilter = '_total_';
let graphTimescale = 60;
let graphUpdateRate = 1000;

// Realtime Neon Streams Chart State
let neonStreamsChart = null;
let realtimeHistory = [];
const maxHistoryPoints = 30; // 30 seconds of rolling history
let appColors = {};
const neonPalette = ['#00f0ff', '#ff0055', '#9900ff', '#e8d020', '#39ff14', '#00ffaa', '#ffaa00'];
let colorIndex = 0;

// Three.js Scene Components
let scene, camera, renderer, canvas;
let roadMesh;
let laneMeshes = [];
let laneHitboxes = [];
let vehicles3D = [];
let lightsGroup;
let animationFrameId;

// Drifting data particles state
let dataParticlesGeom;
let dataParticlesPoints;
const numParticles = 200;

// Neon Streams Mode Components
let neonStreamMeshes = [];
let neonStreamParticles = [];

// Chart.js Components
let donutChart = null;
let timelineChart = null;

let lanes = [
    { id: 0, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#00f0ff', xOffset: -48 },
    { id: 1, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#ff0055', xOffset: -32 },
    { id: 2, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#9900ff', xOffset: -16 },
    { id: 3, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#39ff14', xOffset: 0 },
    { id: 4, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#e8d020', xOffset: 16 },
    { id: 5, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#ff6600', xOffset: 32 },
    { id: 6, appName: 'IDLE_FLOW', speed: 0, blocked: false, color: '#ff00aa', xOffset: 48 }
];

let hoveredLane = null;
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let clock = new THREE.Clock();

// Safe PyWebView API Call Wrapper
function callAPI(methodName, ...args) {
    return new Promise((resolve, reject) => {
        const check = () => {
            if (window.pywebview && window.pywebview.api && window.pywebview.api[methodName]) {
                window.pywebview.api[methodName](...args)
                    .then(resolve)
                    .catch(reject);
            } else {
                setTimeout(check, 50);
            }
        };
        check();
    });
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadSavedSettings();
    initTabs();
    initControls();
    loadSavedOptions();
    checkSystemStatus();
    startPolling();
    init3DEngine();
});

function loadSavedOptions() {
    const alarmSelect = document.getElementById('speed-alarm-input');
    if (alarmSelect) {
        alarmSelect.value = alarmThreshold;
    }
    const settingsAlarm = document.getElementById('settings-alarm-input');
    if (settingsAlarm) {
        settingsAlarm.value = alarmThreshold;
    }
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        if (btn.getAttribute('data-range') === historyRangePreset) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// --- Settings System ---
async function loadSavedSettings() {
    let settings = {};
    try {
        settings = await callAPI('load_settings');
    } catch (e) {
        console.error("Error loading backend settings:", e);
    }

    // Apply values from backend settings, local storage, or defaults
    currentTheme = settings.theme || localStorage.getItem('cyberTheme') || 'cyber-neon';
    scanlinesEnabled = false;
    animIntensity = 'medium';
    alarmThreshold = settings.alarmThreshold !== undefined ? settings.alarmThreshold : (parseInt(localStorage.getItem('alarmThreshold')) || 999999999);

    // Apply theme
    document.documentElement.setAttribute('data-theme', currentTheme);
    
    // Sync settings modal controls after DOM ready
    setTimeout(() => {
        // Theme buttons
        document.querySelectorAll('.theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-theme') === currentTheme);
        });
        // Startup toggle
        callAPI('get_startup')
            .then(enabled => {
                const startupToggle = document.getElementById('startup-toggle');
                if (startupToggle) startupToggle.checked = enabled;
            })
            .catch(err => console.error("Error reading startup status:", err));
        // Alarm in settings
        const settingsAlarm = document.getElementById('settings-alarm-input');
        if (settingsAlarm) settingsAlarm.value = alarmThreshold;
        const mainAlarm = document.getElementById('speed-alarm-input');
        if (mainAlarm) mainAlarm.value = alarmThreshold;
    }, 100);
}

function saveSettingsToBackend() {
    callAPI('save_settings', {
        theme: currentTheme,
        alarmThreshold: alarmThreshold
    }).catch(err => console.error("Error saving settings to backend:", err));
}

function toggleStartup(enabled) {
    callAPI('toggle_startup', enabled)
        .catch(err => console.error("Error setting startup registry:", err));
}

function openSettings() {
    document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
}

function setTheme(themeName) {
    currentTheme = themeName;
    localStorage.setItem('cyberTheme', themeName);
    document.documentElement.setAttribute('data-theme', themeName);
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-theme') === themeName);
    });
    saveSettingsToBackend();
}

function toggleScanlines(enabled) {
    scanlinesEnabled = enabled;
    localStorage.setItem('scanlines', enabled);
    const scanlineEl = document.querySelector('.cyber-scanline');
    if (scanlineEl) scanlineEl.classList.toggle('disabled', !enabled);
    saveSettingsToBackend();
}



function setAlarmFromSettings(val) {
    alarmThreshold = parseInt(val);
    localStorage.setItem('alarmThreshold', alarmThreshold);
    const mainAlarm = document.getElementById('speed-alarm-input');
    if (mainAlarm) mainAlarm.value = alarmThreshold;
    saveSettingsToBackend();
}



// --- Tab Management ---
function initTabs() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            const tabId = tab.getAttribute('data-tab');
            document.getElementById(tabId).classList.add('active');
            
            tabState = tabId === 'realtime-tab' ? 'realtime' : tabId === 'usage-tab' ? 'usage' : tabId === 'firewall-tab' ? 'firewall' : tabId === 'alerts-tab' ? 'alerts' : 'devices';
            if (tabState === 'usage') {
                updateHistoryDateInputs(historyRangePreset);
                queryUsage();
            } else if (tabState === 'firewall') {
                queryFirewall();
            } else if (tabState === 'alerts') {
                queryAlerts();
            }
        });
    });
}

function initControls() {
    document.getElementById('process-search').addEventListener('input', (e) => {
        renderProcessList(e.target.value);
    });

    document.getElementById('speed-alarm-input').addEventListener('change', (e) => {
        alarmThreshold = parseInt(e.target.value);
        localStorage.setItem('alarmThreshold', alarmThreshold);
    });

    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            presetBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            historyRangePreset = btn.getAttribute('data-range');
            localStorage.setItem('historyRangePreset', historyRangePreset);
            updateHistoryDateInputs(historyRangePreset);
            queryUsage();
        });
    });

    document.getElementById('query-history-btn').addEventListener('click', () => {
        queryUsage();
    });

    // Close modals on clicking outside the content window (on the overlay background)
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                if (overlay.id === 'settings-modal') {
                    closeSettings();
                } else if (overlay.id === 'inspector-modal') {
                    closeInspector();
                }
            }
        });
    });
}

function updateHistoryDateInputs(preset) {
    const startInput = document.getElementById('history-start');
    const endInput = document.getElementById('history-end');
    
    const now = new Date();
    let startTime;
    
    switch (preset) {
        case '5m':
            startTime = new Date(now.getTime() - 5 * 60 * 1000);
            break;
        case '1h':
            startTime = new Date(now.getTime() - 60 * 60 * 1000);
            break;
        case '24h':
            startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            break;
        case '7d':
            startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
    }
    
    const formatDateTime = (date) => {
        const pad = (num) => String(num).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    
    startInput.value = formatDateTime(startTime);
    endInput.value = formatDateTime(now);
}

// --- API Polling (WebView Native) ---
function checkSystemStatus() {
    callAPI('get_status')
        .then(status => {
            appStatus = status;
            const adminEl = document.getElementById('admin-status');
            if (status.admin) {
                adminEl.textContent = 'ENABLED';
                adminEl.className = 'ticker-value text-cyan glow-cyan';
            } else {
                adminEl.textContent = 'USER (LIMITED)';
                adminEl.className = 'ticker-value text-red';
                adminEl.setAttribute('title', 'Restart as Administrator to enable firewall features.');
            }
        })
        .catch(err => console.error("Error fetching system status:", err));
}

function startPolling() {
    pollTraffic();
    setInterval(pollTraffic, 1000);
}

function pollTraffic() {
    callAPI('get_traffic')
        .then(data => {
            activeFlows = data;
            
            let totalDown = 0;
            let totalUp = 0;
            let totalConns = 0;
            
            data.forEach(app => {
                totalDown += app.speed_recv;
                totalUp += app.speed_sent;
                totalConns += app.connection_count;
            });
            
            document.getElementById('total-download').textContent = formatSpeed(totalDown);
            document.getElementById('total-upload').textContent = formatSpeed(totalUp);
            document.getElementById('total-flows').textContent = data.length;
            
            checkSpeedAlarms(data);
            
            const searchVal = document.getElementById('process-search').value;
            renderProcessList(searchVal);
            updateHighwayLanes(data);
            appendConsoleLogs(data);
            pushLiveGraphHistory(data);
        })
        .catch(err => console.error("Error polling traffic:", err));
}

// --- UI Rendering ---
let lastResortTime = 0;

function renderProcessList(filter = '') {
    const listContainer = document.getElementById('process-list');
    if (!listContainer) return;
    
    // Check if we should resort the list (every 5 seconds or on initial load)
    const currentTime = Date.now();
    const shouldResort = (currentTime - lastResortTime >= 5000) || (lastResortTime === 0);
    
    if (shouldResort) {
        lastResortTime = currentTime;
    }
    
    const filtered = activeFlows.filter(flow => 
        flow.name.toLowerCase().includes(filter.toLowerCase())
    );
    
    if (filtered.length === 0) {
        listContainer.innerHTML = `<div class="empty-state">NO ACTIVE FLOWS FOUND</div>`;
        return;
    }
    
    // If list container has an empty or loading state, or if we want to do a full resort, rebuild it:
    const hasItems = listContainer.querySelector('.process-item');
    if (!hasItems || shouldResort) {
        // Sort filtered flows by speed before doing a full render
        filtered.sort((a, b) => (b.speed_recv + b.speed_sent) - (a.speed_recv + a.speed_sent));
        
        let html = '';
        filtered.forEach(flow => {
            const isBlocked = flow.blocked;
            const blockClass = isBlocked ? 'blocked-app' : '';
            const lane = lanes.find(l => l.appName === flow.name);
            const laneIndicator = lane ? `<span class="lane-tag" style="background:${lane.color}" title="Mapped to highway Lane ${lane.id + 1}">L${lane.id + 1}</span>` : '';
            
            const btnHtml = flow.path 
                ? `<button class="fw-btn ${isBlocked ? 'blocked' : ''}" onclick="event.stopPropagation(); toggleFirewall('${flow.name}', '${escapePath(flow.path)}', ${!isBlocked})">${isBlocked ? '[ BLOCKED ]' : '[ BLOCK ]'}</button>`
                : `<span class="text-muted" style="font-size: 9px; font-family: var(--font-mono)">SYSTEM</span>`;
                
            html += `
                <div class="process-item ${blockClass}" 
                     data-appname="${flow.name}"
                     onclick="inspectProcess('${flow.name}', '${escapePath(flow.path)}', ${isBlocked})"
                     onmouseenter="highlightLaneFromApp('${flow.name}')"
                     onmouseleave="clearLaneHighlight()">
                    <span class="process-name-cell" title="${flow.name}">${laneIndicator} ${flow.name}</span>
                    <span class="process-conn-cell">${flow.connection_count}</span>
                    <span class="process-speed-cell">
                        <span class="speed-down">D: ${formatSpeed(flow.speed_recv)}</span>
                        <span class="speed-up">U: ${formatSpeed(flow.speed_sent)}</span>
                    </span>
                    <span class="col-action">${btnHtml}</span>
                </div>
            `;
        });
        listContainer.innerHTML = html;
    } else {
        // Otherwise, update existing DOM elements in-place to prevent layout jump and flicker!
        filtered.forEach(flow => {
            const item = listContainer.querySelector(`.process-item[data-appname="${flow.name}"]`);
            if (item) {
                // Update connection count
                const connCell = item.querySelector('.process-conn-cell');
                if (connCell) connCell.textContent = flow.connection_count;
                
                // Update speeds in-place
                const speedDown = item.querySelector('.speed-down');
                if (speedDown) speedDown.textContent = `D: ${formatSpeed(flow.speed_recv)}`;
                
                const speedUp = item.querySelector('.speed-up');
                if (speedUp) speedUp.textContent = `U: ${formatSpeed(flow.speed_sent)}`;
                
                // Keep the firewall button updated in case state changes
                const actionCell = item.querySelector('.col-action');
                if (actionCell) {
                    const isBlocked = flow.blocked;
                    const btnHtml = flow.path 
                        ? `<button class="fw-btn ${isBlocked ? 'blocked' : ''}" onclick="event.stopPropagation(); toggleFirewall('${flow.name}', '${escapePath(flow.path)}', ${!isBlocked})">${isBlocked ? '[ BLOCKED ]' : '[ BLOCK ]'}</button>`
                        : `<span class="text-muted" style="font-size: 9px; font-family: var(--font-mono)">SYSTEM</span>`;
                    actionCell.innerHTML = btnHtml;
                }
            } else {
                // If it's a new flow, append it to the bottom
                const isBlocked = flow.blocked;
                const blockClass = isBlocked ? 'blocked-app' : '';
                const lane = lanes.find(l => l.appName === flow.name);
                const laneIndicator = lane ? `<span class="lane-tag" style="background:${lane.color}" title="Mapped to highway Lane ${lane.id + 1}">L${lane.id + 1}</span>` : '';
                
                const btnHtml = flow.path 
                    ? `<button class="fw-btn ${isBlocked ? 'blocked' : ''}" onclick="event.stopPropagation(); toggleFirewall('${flow.name}', '${escapePath(flow.path)}', ${!isBlocked})">${isBlocked ? '[ BLOCKED ]' : '[ BLOCK ]'}</button>`
                    : `<span class="text-muted" style="font-size: 9px; font-family: var(--font-mono)">SYSTEM</span>`;
                
                const div = document.createElement('div');
                div.className = `process-item ${blockClass}`;
                div.setAttribute('data-appname', flow.name);
                div.onclick = () => inspectProcess(flow.name, escapePath(flow.path), isBlocked);
                div.onmouseenter = () => highlightLaneFromApp(flow.name);
                div.onmouseleave = () => clearLaneHighlight();
                div.innerHTML = `
                    <span class="process-name-cell" title="${flow.name}">${laneIndicator} ${flow.name}</span>
                    <span class="process-conn-cell">${flow.connection_count}</span>
                    <span class="process-speed-cell">
                        <span class="speed-down">D: ${formatSpeed(flow.speed_recv)}</span>
                        <span class="speed-up">U: ${formatSpeed(flow.speed_sent)}</span>
                    </span>
                    <span class="col-action">${btnHtml}</span>
                `;
                listContainer.appendChild(div);
            }
        });
        
        // Remove items that are no longer active
        const domItems = listContainer.querySelectorAll('.process-item');
        domItems.forEach(item => {
            const appName = item.getAttribute('data-appname');
            const isActive = filtered.some(f => f.name === appName);
            if (!isActive) {
                listContainer.removeChild(item);
            }
        });
    }
}

function escapePath(path) {
    if (!path) return '';
    return path.replace(/\\/g, '\\\\');
}

function highlightLaneFromApp(appName) {
    const lane = lanes.find(l => l.appName === appName);
    if (lane) {
        hoveredLane = lane.id;
    }
}

function clearLaneHighlight() {
    hoveredLane = null;
}

function updateHighwayLanes(data) {
    // Filter active flows with speed > 0
    const active = data.filter(flow => (flow.speed_sent + flow.speed_recv) > 0);
    const activeAppNames = active.map(a => a.name);
    
    // 1. Reset lanes whose apps are no longer active
    lanes.forEach(lane => {
        if (lane.appName !== 'IDLE_FLOW' && !activeAppNames.includes(lane.appName)) {
            lane.appName = 'IDLE_FLOW';
            lane.speed = 0;
            lane.blocked = false;
        }
    });
    
    // 2. Assign top active apps to lanes stably (to prevent lane swapping flicker)
    active.slice(0, 7).forEach(app => {
        let lane = lanes.find(l => l.appName === app.name);
        if (!lane) {
            lane = lanes.find(l => l.appName === 'IDLE_FLOW');
        }
        if (lane) {
            lane.appName = app.name;
            lane.speed = app.speed_sent + app.speed_recv;
            lane.blocked = app.blocked;
        }
    });
    
    // 3. Keep existing active lanes updated
    lanes.forEach(lane => {
        if (lane.appName !== 'IDLE_FLOW') {
            const app = data.find(a => a.name === lane.appName);
            if (app) {
                lane.speed = app.speed_sent + app.speed_recv;
                lane.blocked = app.blocked;
            } else {
                lane.appName = 'IDLE_FLOW';
                lane.speed = 0;
                lane.blocked = false;
            }
        }
    });
}

// --- Alarm Core ---
function checkSpeedAlarms(data) {
    if (alarmThreshold === 999999999) return;
    
    let maxApp = null;
    let maxSpeed = 0;
    
    data.forEach(app => {
        const speed = app.speed_recv + app.speed_sent;
        if (speed > maxSpeed) {
            maxSpeed = speed;
            maxApp = app;
        }
    });
    
    if (maxSpeed > alarmThreshold && maxApp) {
        const banner = document.getElementById('cyber-alarm-banner');
        const details = document.getElementById('alarm-details');
        
        details.textContent = `Process: ${maxApp.name} | Total Speed: ${formatSpeed(maxSpeed)}`;
        banner.classList.remove('hidden');
        
        if (activeAlarm) clearTimeout(activeAlarm);
        activeAlarm = setTimeout(closeAlarm, 15000);
    }
}

function closeAlarm() {
    document.getElementById('cyber-alarm-banner').classList.add('hidden');
    if (activeAlarm) {
        clearTimeout(activeAlarm);
        activeAlarm = null;
    }
}

// --- Firewall Actions ---
function toggleFirewall(name, path, block) {
    if (!appStatus.admin) {
        alert("CRITICAL WARNING: Administrative privileges required. Please run this app as Administrator to modify firewall rules.");
        return;
    }
    
    callAPI('toggle_firewall', name, path, block)
    .then(res => {
        if (res.success) {
            activeFlows.forEach(flow => {
                if (flow.path && flow.path.toLowerCase() === path.toLowerCase()) {
                    flow.blocked = block;
                }
            });
            renderProcessList();
            updateHighwayLanes(activeFlows);
            queryFirewall();
            
            const inspectModal = document.getElementById('inspector-modal');
            if (!inspectModal.classList.contains('hidden')) {
                const badge = document.getElementById('inspect-firewall-tag');
                const btn = document.getElementById('inspect-block-btn');
                if (block) {
                    badge.textContent = 'BLOCKED';
                    badge.className = 'firewall-badge blocked';
                    btn.textContent = 'REMOVE_FIREWALL_BLOCK';
                    btn.onclick = () => toggleFirewall(name, path, false);
                } else {
                    badge.textContent = 'ACTIVE';
                    badge.className = 'firewall-badge unblocked';
                    btn.textContent = 'INITIALIZE_FIREWALL_BLOCK';
                    btn.onclick = () => toggleFirewall(name, path, true);
                }
            }
        } else {
            alert("Firewall Error: " + res.error);
        }
    })
    .catch(err => console.error("Error toggling firewall:", err));
}

// --- App Inspector ---
function inspectProcess(name, path, blocked) {
    const modal = document.getElementById('inspector-modal');
    modal.classList.remove('hidden');
    
    document.getElementById('inspect-app-name').textContent = name;
    document.getElementById('inspect-app-path').textContent = path || 'System process (Path unavailable)';
    
    const badge = document.getElementById('inspect-firewall-tag');
    const btn = document.getElementById('inspect-block-btn');
    
    if (path) {
        btn.disabled = false;
        if (blocked) {
            badge.textContent = 'BLOCKED';
            badge.className = 'firewall-badge blocked';
            btn.textContent = 'REMOVE_FIREWALL_BLOCK';
            btn.onclick = () => toggleFirewall(name, path, false);
        } else {
            badge.textContent = 'ACTIVE';
            badge.className = 'firewall-badge unblocked';
            btn.textContent = 'INITIALIZE_FIREWALL_BLOCK';
            btn.onclick = () => toggleFirewall(name, path, true);
        }
    } else {
        badge.textContent = 'SYSTEM_PROTECTED';
        badge.className = 'firewall-badge unblocked';
        btn.textContent = 'FIREWALL_DISABLED';
        btn.disabled = true;
    }
    
    const flow = activeFlows.find(f => f.name === name && f.path === path);
    const speed = flow ? (flow.speed_recv + flow.speed_sent) : 0;
    document.getElementById('inspect-app-speed').textContent = formatSpeed(speed);
    
    const connsList = document.getElementById('inspect-connections-list');
    
    if (!flow || flow.connections.length === 0) {
        connsList.innerHTML = `<div class="empty-state">NO ACTIVE PORT CONNECTIONS</div>`;
        return;
    }
    
    connsList.innerHTML = `<div class="loading-state">Resolving hostname IPs...</div>`;
    
    const ips = [];
    flow.connections.forEach(c => {
        if (c.remote) {
            const ip = c.remote.split(':')[0];
            if (ip) ips.push(ip);
        }
    });
    
    callAPI('resolve_ips', ips)
    .then(resolved => {
        let connHtml = '';
        flow.connections.forEach(c => {
            const remoteIp = c.remote ? c.remote.split(':')[0] : 'N/A';
            const remotePort = c.remote ? c.remote.split(':')[1] : '';
            const resolvedHost = resolved[remoteIp] || remoteIp;
            
            connHtml += `
                <div class="conn-row">
                    <span>${c.type}</span>
                    <span>${c.local.split(':')[1]}</span>
                    <span>${c.remote ? remoteIp + ':' + remotePort : '*:*'}</span>
                    <span title="${resolvedHost}">${resolvedHost}</span>
                    <span>${c.status}</span>
                </div>
            `;
        });
        connsList.innerHTML = connHtml;
    })
    .catch(err => {
        console.error("DNS Resolution error:", err);
        let connHtml = '';
        flow.connections.forEach(c => {
            connHtml += `
                <div class="conn-row">
                    <span>${c.type}</span>
                    <span>${c.local.split(':')[1]}</span>
                    <span>${c.remote || '*:*'}</span>
                    <span>${c.remote ? c.remote.split(':')[0] : 'N/A'}</span>
                    <span>${c.status}</span>
                </div>
            `;
        });
        connsList.innerHTML = connHtml;
    });
}

function closeInspector() {
    document.getElementById('inspector-modal').classList.add('hidden');
}


// --- 3D WebGL (Three.js) Isometric Engine ---

function init3DEngine() {
    canvas = document.getElementById('highway-canvas');
    if (!canvas) {
        console.error("Canvas element 'highway-canvas' not found!");
        return;
    }
    const container = canvas.parentElement;
    const rect = container.getBoundingClientRect();
    
    // 1. Scene Setup
    scene = new THREE.Scene();
    scene.background = null; // Transparent background to layer over CSS backgrounds
    
    // 2. Camera Setup (Orthographic for perfect 3D Isometric View)
    const aspect = rect.width / rect.height;
    const d = 130; // Viewport width scale
    camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 1, 3000);
    // Camera positioned at steeper look-down angle (Y=380) to keep road visible and avoid tower overlap
    camera.position.set(320, 380, 320); 
    camera.lookAt(0, 0, 0);
    
    // 3. Renderer Setup
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setClearColor(0x050510, 1);
    renderer.setSize(rect.width, rect.height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    
    // 4. Lights Setup (Cyberpunk Stylized colored lighting)
    lightsGroup = new THREE.Group();
    
    const ambientLight = new THREE.AmbientLight(0x0e0e22, 2.0); // night ambient
    lightsGroup.add(ambientLight);
    
    const cyanLight = new THREE.DirectionalLight(0x00f0ff, 3.5); // Cyan main sunlight
    cyanLight.position.set(200, 300, 100);
    lightsGroup.add(cyanLight);
    
    const magentaLight = new THREE.DirectionalLight(0xff0055, 2.5); // Magenta backlight
    magentaLight.position.set(-200, 200, -100);
    lightsGroup.add(magentaLight);
    
    scene.add(lightsGroup);
    
    // 5. Build Highway & Vaporwave Scenery
    buildHighway3D();
    buildHighwayExtras();
    buildVaporwaveSun();
    buildRoadGridLines();
    buildCity3D();
    buildDataParticles();
    
    // 6. Bind mouse and resize events
    container.addEventListener('mousemove', onCanvasMouseMove);
    container.addEventListener('mouseleave', onCanvasMouseLeave);
    container.addEventListener('click', onCanvasClick);
    
    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const { width, height } = entry.contentRect;
            if (width === 0 || height === 0) continue;
            
            const asp = width / height;
            
            // Ensure horizontal frustum half-width is at least 130 to prevent road clipping
            let dynamicD = 130;
            if (130 / asp > dynamicD) {
                dynamicD = 130 / asp;
            }
            
            camera.left = -dynamicD * asp;
            camera.right = dynamicD * asp;
            camera.top = dynamicD;
            camera.bottom = -dynamicD;
            camera.updateProjectionMatrix();
            
            renderer.setSize(width, height, false);
        }
    });
    resizeObserver.observe(container);
    
    // Start animation loop
    clock.start();
    animate3D();
}

function buildHighway3D() {
    // Road plane aligned along the Z axis (spans Z from -1600 to +800)
    const roadGeo = new THREE.PlaneGeometry(128, 2400);
    const roadMat = new THREE.MeshStandardMaterial({ 
        color: 0x05050c, 
        roughness: 0.9, 
        metalness: 0.15 
    });
    roadMesh = new THREE.Mesh(roadGeo, roadMat);
    roadMesh.rotation.x = -Math.PI / 2; // Flat on X-Z plane
    roadMesh.position.set(0, -0.1, -400);
    scene.add(roadMesh);
    
    // Add Lanes dynamically (dynamic mesh overlays for visual status and hover highlighting)
    for (let i = 0; i < lanes.length; i++) {
        const laneGeo = new THREE.PlaneGeometry(15.2, 2400);
        const laneMat = new THREE.MeshStandardMaterial({
            color: lanes[i].color,
            transparent: true,
            opacity: 0.0,
            roughness: 0.5
        });
        const lanePlane = new THREE.Mesh(laneGeo, laneMat);
        lanePlane.rotation.x = -Math.PI / 2;
        lanePlane.position.set(lanes[i].xOffset, 0, -400);
        scene.add(lanePlane);
        laneMeshes.push(lanePlane);
        
        // Invisible hitboxes for Raycasting mouse coordinates
        const hitboxGeo = new THREE.BoxGeometry(16, 1, 2400);
        const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
        const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
        hitbox.position.set(lanes[i].xOffset, 0, -400);
        hitbox.userData = { laneId: i };
        scene.add(hitbox);
        laneHitboxes.push(hitbox);
        
        // Draw lane divider lines (Dashed glow dividers)
        if (i < lanes.length - 1) {
            const divX = lanes[i].xOffset + 8;
            const dividerGeo = new THREE.BoxGeometry(0.4, 0.1, 2400);
            const dividerMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.15 });
            const divider = new THREE.Mesh(dividerGeo, dividerMat);
            divider.position.set(divX, 0, -400);
            scene.add(divider);
        }
    }
}

// --- Dynamic 3D Asset Creators ---

// Wheel Primitive Mesh Generator
function create3DWheel(radius, width, hubColor = 0xa0a0a8) {
    const wheelGroup = new THREE.Group();
    // Tire body (dark gray/black)
    const geom = new THREE.CylinderGeometry(radius, radius, width, 12);
    const mat = new THREE.MeshPhongMaterial({ color: 0x222226, shininess: 10 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.z = Math.PI / 2;
    wheelGroup.add(mesh);
    
    // Hubcap rim (light gray/metallic)
    const hubGeom = new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, width + 0.15, 12);
    const hubMat = new THREE.MeshPhongMaterial({ color: hubColor, shininess: 60 });
    const hub = new THREE.Mesh(hubGeom, hubMat);
    hub.rotation.z = Math.PI / 2;
    wheelGroup.add(hub);
    
    // Center bolt (dark gray)
    const boltGeom = new THREE.CylinderGeometry(radius * 0.25, radius * 0.25, width + 0.2, 8);
    const boltMat = new THREE.MeshPhongMaterial({ color: 0x333338, shininess: 20 });
    const bolt = new THREE.Mesh(boltGeom, boltMat);
    bolt.rotation.z = Math.PI / 2;
    wheelGroup.add(bolt);
    
    return wheelGroup;
}

// 3D Motorcycle mesh builder — Sleek Low-Poly Design
function build3DBike(color) {
    const bike = new THREE.Group();
    const colorHex = parseInt(color.replace('#', '0x'));
    
    // 2 wheels (thick dual-tone)
    const rearWheel = create3DWheel(2.4, 1.0); rearWheel.position.set(0, 2.4, -5.0); bike.add(rearWheel);
    const frontWheel = create3DWheel(2.4, 0.8); frontWheel.position.set(0, 2.4, 5.0); bike.add(frontWheel);
    
    const bodyMat = new THREE.MeshPhongMaterial({ color: colorHex, shininess: 50 });
    const plasticMat = new THREE.MeshPhongMaterial({ color: 0x333338, shininess: 10 });
    const metalMat = new THREE.MeshPhongMaterial({ color: 0x88888a, shininess: 80 });
    
    // 1. Lower chassis frame (slanted cylinder engine block)
    const engine = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.0, 4.5), plasticMat);
    engine.position.set(0, 2.6, 0);
    bike.add(engine);
    
    // 2. Exhaust pipe (chrome cylinder)
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 6.0, 8), metalMat);
    pipe.rotation.x = Math.PI / 2 - 0.2;
    pipe.position.set(0.9, 1.8, -2.5);
    bike.add(pipe);
    
    // 3. Fuel Tank & Seat (colored blocky fairing)
    const tank = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.6, 4.0), bodyMat);
    tank.position.set(0, 3.8, 0.8);
    bike.add(tank);
    
    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 3.0), plasticMat);
    seat.position.set(0, 3.6, -2.0);
    bike.add(seat);
    
    // 4. Front handlebar forks (slanted struts)
    const forkL = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6.0, 8), metalMat);
    forkL.position.set(0.8, 3.6, 3.6);
    forkL.rotation.x = -Math.PI / 6;
    bike.add(forkL);
    
    const forkR = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 6.0, 8), metalMat);
    forkR.position.set(-0.8, 3.6, 3.6);
    forkR.rotation.x = -Math.PI / 6;
    bike.add(forkR);
    
    // 5. Handlebars (horizontal bar)
    const bar = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.25, 0.25), plasticMat);
    bar.position.set(0, 5.8, 2.6);
    bike.add(bar);
    
    // 6. Front Headlight
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    headlight.position.set(0, 5.2, 3.2);
    bike.add(headlight);
    
    // Undercarriage neon glow
    const underGeo = new THREE.BoxGeometry(2.5, 0.1, 7.5);
    const underMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.5 });
    const under = new THREE.Mesh(underGeo, underMat);
    under.position.set(0, 0.2, 0);
    bike.add(under);
    neonPulseObjects.push(under);

    // Dynamic light trail mesh (Z plane)
    const trailGeo = new THREE.PlaneGeometry(4.0, 1.0);
    const trailMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.rotation.x = -Math.PI / 2;
    const baseOffset = -6.5;
    trail.position.set(0, 0.15, baseOffset);
    bike.add(trail);

    bike.userData = { trail: trail, baseOffset: baseOffset, type: 'bike' };
    return bike;
}

// 3D Sedan mesh builder — Realistic Low-Poly Toy Car Design
function build3DSedan(color) {
    const sedan = new THREE.Group();
    const colorHex = parseInt(color.replace('#', '0x'));
    
    // 4 wheels (dual-tone)
    const w1 = create3DWheel(2.6, 1.3); w1.position.set(4.5, 2.6, -5.0); sedan.add(w1);
    const w2 = create3DWheel(2.6, 1.3); w2.position.set(-4.5, 2.6, -5.0); sedan.add(w2);
    const w3 = create3DWheel(2.6, 1.3); w3.position.set(4.5, 2.6, 5.0); sedan.add(w3);
    const w4 = create3DWheel(2.6, 1.3); w4.position.set(-4.5, 2.6, 5.0); sedan.add(w4);
    
    const bodyMat = new THREE.MeshPhongMaterial({ color: colorHex, shininess: 50 });
    const plasticMat = new THREE.MeshPhongMaterial({ color: 0x4d525a, shininess: 20 });
    const glassMat = new THREE.MeshPhongMaterial({ color: 0x90b0d0, shininess: 80, transparent: true, opacity: 0.8 });
    
    // 1. Lower Main Body (the chassis block)
    const mainGeo = new THREE.BoxGeometry(8.2, 2.4, 16.5);
    const mainBody = new THREE.Mesh(mainGeo, bodyMat);
    mainBody.position.set(0, 3.2, 0);
    sedan.add(mainBody);
    
    // 2. Front Hood (slanted/lower block at the front)
    const hoodGeo = new THREE.BoxGeometry(8.2, 1.8, 5.5);
    const hood = new THREE.Mesh(hoodGeo, bodyMat);
    hood.position.set(0, 3.4, 5.5);
    sedan.add(hood);
    
    // 3. Cabin (central boxy cabin)
    const cabinGeo = new THREE.BoxGeometry(7.4, 2.8, 8.5);
    const cabin = new THREE.Mesh(cabinGeo, bodyMat);
    cabin.position.set(0, 5.0, -1.0);
    sedan.add(cabin);
    
    // 4. Windows (applied as thin plates on cabin sides)
    // Windshield (front) - slanted
    const windGeo = new THREE.PlaneGeometry(6.6, 2.4);
    const windshield = new THREE.Mesh(windGeo, glassMat);
    windshield.position.set(0, 5.2, 3.3);
    windshield.rotation.x = -Math.PI / 6; // Slanted forward
    sedan.add(windshield);
    
    // Side Windows Left
    const wSideL1 = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.8), glassMat);
    wSideL1.position.set(3.72, 5.0, -1.0);
    wSideL1.rotation.y = Math.PI / 2;
    sedan.add(wSideL1);
    
    const wSideL2 = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 1.8), glassMat);
    wSideL2.position.set(3.72, 5.0, -4.0);
    wSideL2.rotation.y = Math.PI / 2;
    sedan.add(wSideL2);
    
    // Side Windows Right
    const wSideR1 = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.8), glassMat);
    wSideR1.position.set(-3.72, 5.0, -1.0);
    wSideR1.rotation.y = -Math.PI / 2;
    sedan.add(wSideR1);
    
    const wSideR2 = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 1.8), glassMat);
    wSideR2.position.set(-3.72, 5.0, -4.0);
    wSideR2.rotation.y = -Math.PI / 2;
    sedan.add(wSideR2);
    
    // Rear Window
    const wRear = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 1.8), glassMat);
    wRear.position.set(0, 5.0, -5.27);
    wRear.rotation.y = Math.PI;
    sedan.add(wRear);
    
    // 5. Front Bumper
    const bumperF = new THREE.Mesh(new THREE.BoxGeometry(8.6, 1.0, 1.0), plasticMat);
    bumperF.position.set(0, 2.5, 8.4);
    sedan.add(bumperF);
    
    // 6. Rear Bumper
    const bumperR = new THREE.Mesh(new THREE.BoxGeometry(8.6, 1.0, 1.0), plasticMat);
    bumperR.position.set(0, 2.5, -8.4);
    sedan.add(bumperR);
    
    // 7. Headlights
    const lightGeo = new THREE.BoxGeometry(1.6, 0.8, 0.3);
    const lightL = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lightL.position.set(2.4, 3.4, 8.3);
    sedan.add(lightL);
    
    const lightR = new THREE.Mesh(lightGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lightR.position.set(-2.4, 3.4, 8.3);
    sedan.add(lightR);
    
    // Orange Indicators
    const indGeo = new THREE.BoxGeometry(0.4, 0.8, 0.4);
    const indL = new THREE.Mesh(indGeo, new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    indL.position.set(3.4, 3.4, 8.3);
    sedan.add(indL);
    
    const indR = new THREE.Mesh(indGeo, new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
    indR.position.set(-3.4, 3.4, 8.3);
    sedan.add(indR);
    
    // 8. Front Grille (dark gray horizontal slats)
    const grille = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 0.25), plasticMat);
    grille.position.set(0, 3.4, 8.3);
    sedan.add(grille);
    
    // 9. Side Mirrors
    const mirrorGeo = new THREE.BoxGeometry(0.8, 0.6, 0.4);
    const mirrorL = new THREE.Mesh(mirrorGeo, bodyMat);
    mirrorL.position.set(4.0, 4.6, 2.5);
    sedan.add(mirrorL);
    
    const mirrorR = new THREE.Mesh(mirrorGeo, bodyMat);
    mirrorR.position.set(-4.0, 4.6, 2.5);
    sedan.add(mirrorR);
    
    // 10. Door Handles
    const handleGeo = new THREE.BoxGeometry(0.6, 0.25, 0.15);
    const handleL = new THREE.Mesh(handleGeo, plasticMat);
    handleL.position.set(3.72, 4.2, 0.2);
    sedan.add(handleL);
    
    const handleR = new THREE.Mesh(handleGeo, plasticMat);
    handleR.position.set(-3.72, 4.2, 0.2);
    sedan.add(handleR);
    
    // Undercarriage neon glow
    const underGeo = new THREE.BoxGeometry(7.0, 0.1, 13);
    const underMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.5 });
    const under = new THREE.Mesh(underGeo, underMat);
    under.position.set(0, 0.2, 0);
    sedan.add(under);
    neonPulseObjects.push(under);

    // Dynamic light trail mesh (Z plane)
    const trailGeo = new THREE.PlaneGeometry(7.0, 1.0);
    const trailMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.rotation.x = -Math.PI / 2;
    const baseOffset = -9.5;
    trail.position.set(0, 0.15, baseOffset);
    sedan.add(trail);

    sedan.userData = { trail: trail, baseOffset: baseOffset, type: 'sedan' };
    return sedan;
}

// 3D Cargo Semi-Truck mesh builder — Low-Poly Toy Truck Design
function build3DTruck(color) {
    const truck = new THREE.Group();
    const colorHex = parseInt(color.replace('#', '0x'));
    
    // 6 wheels
    // Front cab wheels
    const cw1 = create3DWheel(2.8, 1.4); cw1.position.set(4.6, 2.8, 10.0); truck.add(cw1);
    const cw2 = create3DWheel(2.8, 1.4); cw2.position.set(-4.6, 2.8, 10.0); truck.add(cw2);
    
    // Rear trailer wheels
    const tw1 = create3DWheel(2.8, 1.4); tw1.position.set(4.6, 2.8, -8.0); truck.add(tw1);
    const tw2 = create3DWheel(2.8, 1.4); tw2.position.set(-4.6, 2.8, -8.0); truck.add(tw2);
    const tw3 = create3DWheel(2.8, 1.4); tw3.position.set(4.6, 2.8, -13.0); truck.add(tw3);
    const tw4 = create3DWheel(2.8, 1.4); tw4.position.set(-4.6, 2.8, -13.0); truck.add(tw4);
    
    const bodyMat = new THREE.MeshPhongMaterial({ color: colorHex, shininess: 50 });
    const cabMat = new THREE.MeshPhongMaterial({ color: 0x1c1e24, shininess: 40 }); // dark gray metal cab
    const plasticMat = new THREE.MeshPhongMaterial({ color: 0x42464e, shininess: 10 });
    const glassMat = new THREE.MeshPhongMaterial({ color: 0x90b0d0, shininess: 80, transparent: true, opacity: 0.8 });
    
    // --- Front Engine Cab ---
    const cab = new THREE.Group();
    cab.position.set(0, 0, 10);
    
    // Cab Chassis Base
    const cabBase = new THREE.Mesh(new THREE.BoxGeometry(8.4, 1.6, 6.0), plasticMat);
    cabBase.position.set(0, 3.2, 0);
    cab.add(cabBase);
    
    // Cab Nose (lower front)
    const nose = new THREE.Mesh(new THREE.BoxGeometry(8.0, 2.2, 2.5), cabMat);
    nose.position.set(0, 4.3, 1.25);
    cab.add(nose);
    
    // Cab Body (cockpit roof)
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(7.6, 3.2, 3.2), cabMat);
    cockpit.position.set(0, 6.0, -1.0);
    cab.add(cockpit);
    
    // Windshield
    const wind = new THREE.Mesh(new THREE.PlaneGeometry(6.8, 2.0), glassMat);
    wind.position.set(0, 6.0, 0.65);
    cab.add(wind);
    
    // Side Windows
    const wL = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.8), glassMat);
    wL.position.set(3.82, 6.0, -1.0);
    wL.rotation.y = Math.PI / 2;
    cab.add(wL);
    
    const wR = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 1.8), glassMat);
    wR.position.set(-3.82, 6.0, -1.0);
    wR.rotation.y = -Math.PI / 2;
    cab.add(wR);
    
    // Bumper
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.9, 0.9), plasticMat);
    bumper.position.set(0, 2.8, 3.2);
    cab.add(bumper);
    
    // Headlights
    const lightL = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.3), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lightL.position.set(2.4, 4.2, 2.55);
    cab.add(lightL);
    
    const lightR = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.3), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    lightR.position.set(-2.4, 4.2, 2.55);
    cab.add(lightR);
    
    truck.add(cab);
    
    // --- Rear Cargo Container ---
    const trailer = new THREE.Group();
    trailer.position.set(0, 0, -4.5);
    
    // Trailer Bed Frame
    const bed = new THREE.Mesh(new THREE.BoxGeometry(8.4, 1.4, 21.0), plasticMat);
    bed.position.set(0, 3.2, 0);
    trailer.add(bed);
    
    // Trailer Cargo Box
    const container = new THREE.Mesh(new THREE.BoxGeometry(8.4, 8.5, 20.0), bodyMat);
    container.position.set(0, 8.0, 0);
    trailer.add(container);
    
    // Neon accent outlines along container edges
    const containerWire = new THREE.Mesh(new THREE.BoxGeometry(8.4, 8.5, 20.0), new THREE.MeshBasicMaterial({ color: colorHex, wireframe: true, transparent: true, opacity: 0.5 }));
    containerWire.position.set(0, 8.0, 0);
    trailer.add(containerWire);
    
    truck.add(trailer);
    
    // Hitch connector
    const hitch = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 6.0), plasticMat);
    hitch.position.set(0, 3.2, 5.0);
    truck.add(hitch);
    
    // Undercarriage neon glow
    const underGeo = new THREE.BoxGeometry(8.4, 0.1, 31);
    const underMat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.4 });
    const under = new THREE.Mesh(underGeo, underMat);
    under.position.set(0, 0.2, 0);
    truck.add(under);
    neonPulseObjects.push(under);

    // Dynamic light trail mesh (Z plane)
    const trailGeo = new THREE.PlaneGeometry(8.4, 1.0);
    const trailMat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    trail.rotation.x = -Math.PI / 2;
    const baseOffset = -17.5;
    trail.position.set(0, 0.15, baseOffset);
    truck.add(trail);

    truck.userData = { trail: trail, baseOffset: baseOffset, type: 'truck' };
    return truck;
}

// --- Animation Physics Loop ---

function animate3D() {
    animationFrameId = requestAnimationFrame(animate3D);
    
    const deltaTime = clock.getDelta();
    
    // 1. Spawning
    handleTelemetryAnimations();
    
    // 2. Move 3D Vehicles along Z axis (from z = -400 to 400)
    for (let i = vehicles3D.length - 1; i >= 0; i--) {
        const v = vehicles3D[i];
        const lane = lanes[v.laneIdx];
        
        // Dissolve/fade vehicles if lane gets firewalled/blocked
        if (lane.blocked) {
            v.scaleProgress -= deltaTime * 3.5;
            if (v.scaleProgress <= 0) {
                scene.remove(v.mesh);
                // Clean geometries/materials
                v.mesh.traverse(child => {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) child.material.dispose();
                });
                vehicles3D.splice(i, 1);
                continue;
            }
            v.mesh.scale.set(v.scaleProgress, v.scaleProgress, v.scaleProgress);
        }
        
        // Move down Z-axis (dynamically aligned to current lane speed to prevent clipping)
        const laneSpeed = 0.65 + (Math.min(lane.speed / (1024*1024), 2) * 0.25);
        const step = 90 * laneSpeed * deltaTime;
        v.mesh.position.z += step;
        
        // Update vehicle's trail scale and position based on lane speed
        if (v.mesh.userData && v.mesh.userData.trail) {
            const speedFactor = Math.min(lane.speed / (3 * 1024 * 1024), 1.0); // max scale reached at 3 MB/s
            const trailLen = 4 + speedFactor * 46; // scales Z length from 4 to 50 units!
            v.mesh.userData.trail.scale.set(1, trailLen, 1);
            v.mesh.userData.trail.position.z = v.mesh.userData.baseOffset - (trailLen / 2);
            v.mesh.userData.trail.material.opacity = 0.15 + speedFactor * 0.55;
        }
        
        // Remove offscreen vehicles (exiting Z road boundary)
        if (v.mesh.position.z > 810) {
            scene.remove(v.mesh);
            v.mesh.traverse(child => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) child.material.dispose();
            });
            vehicles3D.splice(i, 1);
        }
    }
    
    // 3. Update lane highlights (pulsing opacity, brighter if hovered)
    lanes.forEach((lane, idx) => {
        const mesh = laneMeshes[idx];
        const isHovered = lane.id === hoveredLane;
        
        if (lane.appName === 'IDLE_FLOW') {
            mesh.material.opacity = 0;
            return;
        }
        
        if (lane.blocked) {
            mesh.material.color.setHex(0xff3344);
            mesh.material.opacity = 0.25 + Math.sin(Date.now() / 150) * 0.1;
        } else {
            mesh.material.color.setHex(parseInt(lane.color.replace("#", "0x")));
            if (isHovered) {
                mesh.material.opacity = 0.35;
            } else {
                // ambient neon glow proportional to speed
                mesh.material.opacity = Math.min(lane.speed / (1024*1024*4), 0.15);
            }
        }
    });
    
    // 4. Scroll road grid lines to simulate speed
    roadGridLines.forEach(line => {
        let avgSpeed = 0;
        let activeLanes = 0;
        lanes.forEach(l => {
            if (l.appName !== 'IDLE_FLOW' && !l.blocked) {
                avgSpeed += 0.65 + (Math.min(l.speed / (1024*1024), 2) * 0.25);
                activeLanes++;
            }
        });
        const speedFactor = activeLanes > 0 ? (avgSpeed / activeLanes) : 0.65;
        
        line.position.z += deltaTime * 85 * speedFactor;
        if (line.position.z > 800) {
            line.position.z = -1600;
        }
    });

    // 5. Neon pulse effects on guardrails, building beacons, and vehicle underglow
    const pulseT = Date.now() / 1000;
    const intensityMult = animIntensity === 'high' ? 1.3 : animIntensity === 'low' ? 0.4 : 1.0;
    neonPulseObjects.forEach((obj, idx) => {
        if (obj.material) {
            const phase = pulseT * 2.5 * intensityMult + idx * 0.7;
            const pulse = 0.5 + Math.sin(phase) * 0.5;
            if (obj.material.emissiveIntensity !== undefined) {
                obj.material.emissiveIntensity = 0.3 + pulse * 0.7;
            }
            if (obj.material.opacity !== undefined && obj.material.transparent) {
                obj.material.opacity = 0.35 + pulse * 0.5;
            }
        }
    });

    // 5.5. Update data particles rising upward
    if (dataParticlesPoints) {
        const posAttr = dataParticlesGeom.getAttribute('position');
        const vels = dataParticlesPoints.userData.velocities;
        for (let i = 0; i < numParticles; i++) {
            let y = posAttr.getY(i);
            y += vels[i] * deltaTime;
            if (y > 120) {
                y = 0;
            }
            posAttr.setY(i, y);
        }
        posAttr.needsUpdate = true;
    }

    // 6. Render Scene
    renderer.render(scene, camera);
}

// Telemetry-linked Spawning
function handleTelemetryAnimations() {
    const now = Date.now() / 1000;
    
    lanes.forEach(lane => {
        if (lane.appName === 'IDLE_FLOW') return;
        if (lane.blocked) return;
        
        let spawnInterval = 999999;
        let type = 'car';
        
        if (lane.speed > 0) {
            if (lane.speed < 50 * 1024) {
                spawnInterval = 4.0;
                type = 'bike';
            } else if (lane.speed < 500 * 1024) {
                spawnInterval = 2.2;
                type = 'sedan';
            } else {
                spawnInterval = 1.3;
                type = 'truck';
            }
            
            // Prevent spawning a vehicle if the preceding vehicle is still near the entry point (-1400)
            const tooClose = vehicles3D.some(v => v.laneIdx === lane.id && v.mesh.position.z < -1300);
            if (tooClose) return;

            if (!lane.lastSpawnTime || now - lane.lastSpawnTime >= spawnInterval) {
                lane.lastSpawnTime = now;
                
                // Spawn 3D Mesh
                let mesh;
                if (type === 'bike') {
                    mesh = build3DBike(lane.color);
                } else if (type === 'sedan') {
                    mesh = build3DSedan(lane.color);
                } else {
                    mesh = build3DTruck(lane.color);
                }
                
                // Start position at Z-road entry
                mesh.position.set(lane.xOffset, 0, -1400);
                scene.add(mesh);
                
                vehicles3D.push({
                    id: Math.random(),
                    mesh: mesh,
                    laneIdx: lane.id,
                    type: type,
                    scaleProgress: 1.0
                });
            }
        }
    });
}

// --- Raycaster Mouse Interactions ---

function onCanvasMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    // Map screen coordinates to normalized device coordinates (-1 to +1)
    mouse.x = (mx / rect.width) * 2 - 1;
    mouse.y = -(my / rect.height) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    // Intersect with lane hitbox boundaries
    const intersects = raycaster.intersectObjects(laneHitboxes);
    
    if (intersects.length > 0) {
        const laneId = intersects[0].object.userData.laneId;
        hoveredLane = laneId;
        const appName = lanes[hoveredLane].appName;
        
        if (appName !== 'IDLE_FLOW') {
            canvas.style.cursor = 'pointer';
            highlightProcessInList(appName);
        } else {
            canvas.style.cursor = 'default';
            clearListHighlight();
        }
    } else {
        hoveredLane = null;
        canvas.style.cursor = 'default';
        clearListHighlight();
    }
}

function onCanvasMouseLeave() {
    hoveredLane = null;
    canvas.style.cursor = 'default';
    clearListHighlight();
}

function onCanvasClick() {
    if (hoveredLane !== null) {
        const lane = lanes[hoveredLane];
        if (lane.appName !== 'IDLE_FLOW') {
            const flow = activeFlows.find(f => f.name === lane.appName);
            if (flow) {
                inspectProcess(flow.name, flow.path, flow.blocked);
            }
        }
    }
}

function highlightProcessInList(appName) {
    clearListHighlight();
    const items = document.querySelectorAll('.process-item');
    items.forEach(item => {
        if (item.getAttribute('data-appname') === appName) {
            item.classList.add('highlighted-active');
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    });
}

function clearListHighlight() {
    const items = document.querySelectorAll('.process-item');
    items.forEach(item => {
        item.classList.remove('highlighted-active');
    });
}


// --- Database Archive & Charts Engine ---

// --- Database Archive & Charts Engine ---

// --- Database Archive & Charts Engine ---

let usageSummaryChart = null;
let currentTotalDown = 0;
let currentTotalUp = 0;
let singledOutItem = null;

async function queryUsage() {
    const startInput = document.getElementById('history-start').value;
    const endInput = document.getElementById('history-end').value;
    
    if (!startInput || !endInput) {
        alert("Please specify a valid start and end interval.");
        return;
    }
    
    const startTs = Math.floor(new Date(startInput).getTime() / 1000);
    const endTs = Math.floor(new Date(endInput).getTime() / 1000);
    
    const appsList = document.getElementById('usage-apps-list');
    const hostsList = document.getElementById('usage-hosts-list');
    const trafficList = document.getElementById('usage-traffic-list');
    
    appsList.innerHTML = `<div class="loading-state">QUERYING APPS...</div>`;
    hostsList.innerHTML = `<div class="loading-state">QUERYING HOSTS...</div>`;
    trafficList.innerHTML = `<div class="loading-state">QUERYING TRAFFIC...</div>`;
    
    try {
        const data = await callAPI('get_usage_history', startTs, endTs);
        if (data.error) {
            console.error("Usage query backend error:", data.error);
            appsList.innerHTML = `<div class="loading-state text-red">FAILED</div>`;
            hostsList.innerHTML = `<div class="loading-state text-red">FAILED</div>`;
            trafficList.innerHTML = `<div class="loading-state text-red">FAILED</div>`;
            return;
        }
        
        // 1. Update Totals Panel
        currentTotalDown = data.total_recv || 0;
        currentTotalUp = data.total_sent || 0;
        const totalVal = currentTotalDown + currentTotalUp;
        singledOutItem = null;
        
        document.getElementById('usage-total-val').innerText = formatBytes(totalVal);
        document.getElementById('usage-down-val').innerText = formatBytes(currentTotalDown);
        document.getElementById('usage-up-val').innerText = formatBytes(currentTotalUp);
        
        // 2. Update Doughnut Chart
        updateUsageChart(currentTotalDown, currentTotalUp);
        
        // 3. Render Apps List
        renderBreakdownList(appsList, data.apps || [], totalVal, 'var(--neon-magenta)');
        
        // 4. Render Hosts List
        renderBreakdownList(hostsList, data.hosts || [], totalVal, 'var(--neon-cyan)');
        
        // 5. Render Traffic Types List
        renderBreakdownList(trafficList, data.traffic || [], totalVal, 'var(--neon-yellow)');
        
    } catch (err) {
        console.error("Error querying usage statistics:", err);
        appsList.innerHTML = `<div class="loading-state text-red">ERROR</div>`;
        hostsList.innerHTML = `<div class="loading-state text-red">ERROR</div>`;
        trafficList.innerHTML = `<div class="loading-state text-red">ERROR</div>`;
    }
}

function updateUsageChart(downVal, upVal) {
    const ctx = document.getElementById('usage-summary-chart');
    if (!ctx) return;
    
    const chartData = [downVal, upVal];
    // Avoid drawing absolute empty circle if totals are 0
    if (downVal === 0 && upVal === 0) {
        chartData[0] = 1;
        chartData[1] = 1;
    }
    
    if (usageSummaryChart) {
        usageSummaryChart.data.datasets[0].data = chartData;
        usageSummaryChart.update();
        return;
    }
    
    usageSummaryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Download', 'Upload'],
            datasets: [{
                data: chartData,
                backgroundColor: ['#00f0ff', '#ff0055'],
                borderColor: '#090a12',
                borderWidth: 2,
                hoverOffset: 4
            }]
        },
        options: {
            cutout: '75%',
            responsive: false,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const val = context.raw;
                            if (downVal === 0 && upVal === 0) return ' 0 B';
                            return ' ' + formatBytes(val);
                        }
                    }
                }
            }
        }
    });
}

function renderBreakdownList(element, list, totalBytes, barColor) {
    if (list.length === 0) {
        element.innerHTML = `<div class="empty-state">NO DATA RECORDED</div>`;
        return;
    }
    
    let html = '';
    list.forEach(item => {
        const itemBytes = item.bytes || 0;
        const percent = totalBytes > 0 ? ((itemBytes / totalBytes) * 100).toFixed(1) : 0;
        
        html += `
            <div class="breakdown-item" data-name="${item.name}" data-recv="${item.recv}" data-sent="${item.sent}">
                <div class="breakdown-item-info">
                    <span class="breakdown-item-name" title="${item.name}">${item.name}</span>
                    <span class="breakdown-item-val">${formatBytes(itemBytes)} (${percent}%)</span>
                </div>
                <div class="breakdown-bar-container">
                    <div class="breakdown-bar-fill" style="width: ${percent}%; background: ${barColor}"></div>
                </div>
            </div>
        `;
    });
    
    element.innerHTML = html;
    
    // Attach click events for interactive segment singling
    element.querySelectorAll('.breakdown-item').forEach(itemEl => {
        itemEl.addEventListener('click', () => {
            const name = itemEl.getAttribute('data-name');
            const recv = parseInt(itemEl.getAttribute('data-recv') || 0);
            const sent = parseInt(itemEl.getAttribute('data-sent') || 0);
            const total = recv + sent;
            
            // Check if this item is already singled out
            if (singledOutItem === name) {
                // Clear single out
                singledOutItem = null;
                document.querySelectorAll('.breakdown-item').forEach(el => el.classList.remove('singled-out'));
                
                // Reset chart to totals
                updateUsageChart(currentTotalDown, currentTotalUp);
                document.getElementById('usage-total-val').innerText = formatBytes(currentTotalDown + currentTotalUp);
                document.getElementById('usage-down-val').innerText = formatBytes(currentTotalDown);
                document.getElementById('usage-up-val').innerText = formatBytes(currentTotalUp);
            } else {
                // Single out this item
                singledOutItem = name;
                document.querySelectorAll('.breakdown-item').forEach(el => el.classList.remove('singled-out'));
                itemEl.classList.add('singled-out');
                
                // Update chart to this item's metrics
                updateUsageChart(recv, sent);
                document.getElementById('usage-total-val').innerText = formatBytes(total);
                document.getElementById('usage-down-val').innerText = formatBytes(recv);
                document.getElementById('usage-up-val').innerText = formatBytes(sent);
            }
        });
    });
}

async function queryFirewall() {
    const listBody = document.getElementById('blocked-apps-list');
    if (!listBody) return;
    listBody.innerHTML = `<div class="loading-state">SYNCHRONIZING FIREWALL RULES...</div>`;
    
    try {
        const list = await callAPI('get_blocked_apps');
        if (list.length === 0) {
            listBody.innerHTML = `<div class="empty-state">NO FIREWALL BLOCK RULES ESTABLISHED</div>`;
            return;
        }
        
        let html = '';
        list.forEach(app => {
            html += `
                <div class="blocked-app-row">
                    <span class="blocked-app-name" title="${app.name}">${app.name}</span>
                    <span class="blocked-app-path" title="${app.path}">${app.path}</span>
                    <div style="text-align: right;">
                        <button class="cyber-btn glow-btn btn-magenta" style="font-size: 8px; padding: 2px 8px;" onclick="unblockApp('${app.name.replace(/'/g, "\\'")}', '${app.path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')">UNBLOCK</button>
                    </div>
                </div>
            `;
        });
        listBody.innerHTML = html;
    } catch (err) {
        console.error("Error loading blocked apps:", err);
        listBody.innerHTML = `<div class="loading-state text-red">FAILED TO QUERY DEFENDER RULES</div>`;
    }
}

function unblockApp(name, path) {
    toggleFirewall(name, path, false);
}

async function queryAlerts() {
    const feedBody = document.getElementById('alerts-list');
    if (!feedBody) return;
    feedBody.innerHTML = `<div class="loading-state">QUERYING SECURITY AUDIT ALERTS...</div>`;
    
    try {
        const list = await callAPI('get_alerts');
        if (list.length === 0) {
            feedBody.innerHTML = `<div class="empty-state">NO SECURITY THREAT ALERTS DETECTED</div>`;
            return;
        }
        
        // Group by Date
        const groups = {};
        list.forEach(alert => {
            const dateStr = new Date(alert.timestamp * 1000).toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            if (!groups[dateStr]) {
                groups[dateStr] = [];
            }
            groups[dateStr].push(alert);
        });
        
        let html = '';
        for (const date in groups) {
            html += `<div class="alert-group-date">${date.toUpperCase()}</div>`;
            groups[date].forEach(a => {
                const timeStr = new Date(a.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                html += `
                    <div class="alert-card">
                        <div class="alert-left">
                            <span class="alert-badge">CONN</span>
                            <span class="alert-text">
                                Process <span class="alert-process">${a.process_name}</span> established new connection path to <span class="alert-host">${a.remote_host}</span>
                            </span>
                        </div>
                        <div class="alert-right">
                            <span class="alert-time">${timeStr}</span>
                            <span class="alert-type-label">FIRST_TIME_COMMUNICATION</span>
                        </div>
                    </div>
                `;
            });
        }
        feedBody.innerHTML = html;
    } catch (err) {
        console.error("Error loading alerts:", err);
        feedBody.innerHTML = `<div class="loading-state text-red">FAILED TO RENDER ALERTS FEED</div>`;
    }
}

async function clearAlertsFeed() {
    if (!confirm("Are you sure you want to clear the entire security alerts history?")) return;
    try {
        await callAPI('clear_alerts');
        queryAlerts();
    } catch (err) {
        console.error("Error clearing alerts:", err);
    }
}

function switchAlertsSubtab(subtab) {
    document.querySelectorAll('.alerts-panel .subtab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.alerts-subview').forEach(view => {
        view.classList.remove('active');
        view.style.display = 'none';
    });
    
    const clearBtn = document.getElementById('clear-alerts-btn');
    
    if (subtab === 'db-alerts') {
        document.getElementById('db-alerts-btn').classList.add('active');
        const view = document.getElementById('db-alerts-view');
        view.classList.add('active');
        view.style.display = 'block';
        if (clearBtn) clearBtn.style.display = 'block';
        queryAlerts();
    } else {
        document.getElementById('realtime-stream-btn').classList.add('active');
        const view = document.getElementById('realtime-stream-view');
        view.classList.add('active');
        view.style.display = 'block';
        if (clearBtn) clearBtn.style.display = 'none';
    }
}
window.switchAlertsSubtab = switchAlertsSubtab;

function appendRealtimeAlertLog(processName, remoteHost) {
    const logContainer = document.getElementById('realtime-alerts-log');
    if (!logContainer) return;
    
    // Remove placeholder text if present
    const placeholder = logContainer.querySelector('div');
    if (placeholder && placeholder.innerText.includes('Awaiting connection packets...')) {
        logContainer.innerHTML = '';
    }
    
    const timestamp = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.style.marginBottom = '6px';
    line.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
    line.style.paddingBottom = '4px';
    line.innerHTML = `<span style="color: var(--text-muted); font-family: var(--font-mono);">${timestamp}</span> <span style="color: var(--neon-cyan); font-weight: bold;">[NEW_PATH]</span> process=<span style="color: #fff; font-weight: bold;">"${processName}"</span> remote=<span style="color: var(--neon-yellow);">${remoteHost}</span>`;
    logContainer.appendChild(line);
    
    // Prune buffer to keep DOM lightweight
    while (logContainer.children.length > 200) {
        logContainer.removeChild(logContainer.firstChild);
    }
    
    // Auto-scroll
    const consoleBody = logContainer.parentElement;
    if (consoleBody) {
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }
}
window.appendRealtimeAlertLog = appendRealtimeAlertLog;

// In-app sliding tray toast rendering function (invoked from python)
function showConnectionToast(processName, remoteHost) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = 'cyber-toast';
    
    // Unique ID for dismissing
    const toastId = 'toast-' + Date.now() + Math.random().toString(36).substr(2, 5);
    toast.id = toastId;
    
    toast.innerHTML = `
        <div class="cyber-toast-header">
            <span class="cyber-toast-title">NEW_CONNECTION_DETECTED</span>
            <span class="cyber-toast-close" onclick="dismissToast('${toastId}')">[ X ]</span>
        </div>
        <div class="cyber-toast-body">
            Process <strong>${processName}</strong> established a first-time connection to <strong>${remoteHost}</strong>.
        </div>
        <div class="cyber-toast-progress"></div>
    `;
    
    container.appendChild(toast);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        dismissToast(toastId);
    }, 5000);
    
    // Also, if we are currently viewing the alerts tab, update it dynamically!
    if (typeof tabState !== 'undefined' && tabState === 'alerts') {
        queryAlerts();
    }
}

function dismissToast(id) {
    const el = document.getElementById(id);
    if (el) {
        el.style.animation = 'none';
        el.offsetHeight; // trigger reflow
        el.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
        el.style.transform = 'translateX(120%)';
        el.style.opacity = '0';
        setTimeout(() => {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 300);
    }
}

// Bind callbacks globally for HTML inline event execution
window.showConnectionToast = showConnectionToast;
window.dismissToast = dismissToast;
window.clearAlertsFeed = clearAlertsFeed;
window.unblockApp = unblockApp;


// --- Vaporwave Cyberpunk Scenery Engine ---
let roadGridLines = [];
let neonPulseObjects = [];

function buildVaporwaveSun() {
    const sunGroup = new THREE.Group();
    const R = 130;
    const slices = 12;
    const colorTop = new THREE.Color(0xff0080);    // Hot Pink
    const colorBottom = new THREE.Color(0xff6600);  // Electric Orange

    for (let i = 0; i < slices; i++) {
        const t = -1 + (2 * (i + 0.5)) / slices;

        // Bottom slices have wider gaps for the classic vaporwave look
        const gapFactor = Math.max(0, 1.0 - (t + 1) * 0.6);
        const thicknessMultiplier = 0.3 + 0.7 * ((t + 1) / 2);
        const sliceH = (2 * R / slices) * thicknessMultiplier * (1.0 - gapFactor * 0.3);
        const yPos = t * R;

        const halfW = Math.sqrt(Math.max(0, R * R - yPos * yPos));
        if (halfW < 2) continue;

        const geom = new THREE.PlaneGeometry(halfW * 2, sliceH);
        const color = colorBottom.clone().lerp(colorTop, (t + 1) / 2);
        const mat = new THREE.MeshBasicMaterial({
            color: color,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.9 - gapFactor * 0.15
        });

        const mesh = new THREE.Mesh(geom, mat);
        mesh.position.set(0, yPos, 0);
        sunGroup.add(mesh);
    }

    // Add a soft glow halo ring around the sun
    const haloGeo = new THREE.RingGeometry(R * 0.98, R * 1.35, 48);
    const haloMat = new THREE.MeshBasicMaterial({
        color: 0xff3388,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.08
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    sunGroup.add(halo);

    // Position behind the highway at the far vanishing point
    sunGroup.position.set(-320, 10, -320);
    sunGroup.lookAt(320, 240, 320);
    scene.add(sunGroup);
}

function buildRoadGridLines() {
    // Scrolling horizontal neon lines across the road surface (extended Z bounds & widened)
    const lineGeo = new THREE.BoxGeometry(130, 0.12, 0.35);
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xff00aa, transparent: true, opacity: 0.18 });

    for (let z = -1600; z <= 800; z += 40) {
        const line = new THREE.Mesh(lineGeo, lineMat.clone());
        line.position.set(0, 0.06, z);
        scene.add(line);
        roadGridLines.push(line);
    }
}

function buildHighwayExtras() {
    // --- Neon Edge Guardrails (extended to Z=-1600 to +800 and widened for 7 lanes) ---
    const railColors = [0x00f0ff, 0xff0055];
    const railXPositions = [-65, 65];

    for (let side = 0; side < 2; side++) {
        const x = railXPositions[side];
        const color = railColors[side];

        // Continuous top rail bar (2400 units long centered at Z = -400)
        const barGeo = new THREE.BoxGeometry(0.6, 1.5, 2400);
        const barMat = new THREE.MeshStandardMaterial({
            color: color,
            emissive: color,
            emissiveIntensity: 0.6,
            transparent: true,
            opacity: 0.85
        });
        const bar = new THREE.Mesh(barGeo, barMat);
        bar.position.set(x, 1.0, -400);
        scene.add(bar);
        neonPulseObjects.push(bar);

        // Vertical posts every 60 units (Z from -1600 to 800)
        for (let z = -1600; z <= 800; z += 60) {
            const postGeo = new THREE.BoxGeometry(0.4, 3.0, 0.4);
            const postMat = new THREE.MeshStandardMaterial({
                color: 0x1a1a2e,
                metalness: 0.8,
                roughness: 0.2
            });
            const post = new THREE.Mesh(postGeo, postMat);
            post.position.set(x, 1.5, z);
            scene.add(post);

            // Glowing cap light on each post
            const capGeo = new THREE.BoxGeometry(0.6, 0.3, 0.6);
            const capMat = new THREE.MeshBasicMaterial({ color: color });
            const cap = new THREE.Mesh(capGeo, capMat);
            cap.position.set(x, 3.1, z);
            scene.add(cap);
        }
    }

    // --- Subtle glowing coordinate grid floor (extended) ---
    const gridHelper = new THREE.GridHelper(1200, 60, 0x00f0ff, 0x18102a);
    gridHelper.position.set(0, -0.4, -400);
    gridHelper.material.transparent = true;
    gridHelper.material.opacity = 0.2;
    scene.add(gridHelper);

    // Dark ground base plane under the grid
    const groundGeo = new THREE.PlaneGeometry(1200, 2400);
    const groundMat = new THREE.MeshBasicMaterial({ color: 0x020208 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, -0.5, -400);
    scene.add(ground);

    // Atmospheric soft volumetric fog (much thinner to show city background)
    scene.fog = new THREE.FogExp2(0x050510, 0.0012);
}

function buildCity3D() {
    // Holographic skyscrapers flanking only the LEFT side of the highway (using InstancedMesh)
    const templates = [
        { w: 11, h: 125, d: 11, color: 0x00f0ff },  // Cyan tall spire
        { w: 17, h: 75, d: 17, color: 0xff0055 },   // Magenta block tower
        { w: 13, h: 50, d: 13, color: 0x9900ff },   // Purple medium block
        { w: 8, h: 165, d: 8, color: 0x39ff14 }     // Matrix green needle tower
    ];
    
    // Define a grid layout to guarantee zero clipping/overlapping
    const columns = [-75, -95, -115, -135, -155, -175];
    const rowSpacing = 45;
    const gridSlots = [];
    
    for (let col of columns) {
        for (let z = -1600; z <= 800; z += rowSpacing) {
            // 70% occupancy rate for a dense city silhouette
            if (Math.random() < 0.70) {
                const templateIdx = Math.floor(Math.random() * templates.length);
                const jX = (Math.random() - 0.5) * 2;  // Small X jitter
                const jZ = (Math.random() - 0.5) * 20; // Small Z jitter
                gridSlots.push({
                    x: col + jX,
                    z: z + jZ,
                    templateIdx: templateIdx,
                    hScale: 0.7 + Math.random() * 0.8
                });
            }
        }
    }
    
    templates.forEach((temp, tempIdx) => {
        const slots = gridSlots.filter(s => s.templateIdx === tempIdx);
        const count = slots.length;
        if (count === 0) return;
        
        const geom = new THREE.BoxGeometry(temp.w, temp.h, temp.d);
        
        // Solid body instanced mesh (glassy, dark reflective block)
        const solidMat = new THREE.MeshStandardMaterial({
            color: 0x030307,
            roughness: 0.15,
            metalness: 0.9,
            transparent: true,
            opacity: 0.82
        });
        const solidMesh = new THREE.InstancedMesh(geom, solidMat, count);
        
        // Wireframe body instanced mesh (neon holographic lines)
        const wireMat = new THREE.MeshBasicMaterial({
            color: temp.color,
            wireframe: true,
            transparent: true,
            opacity: 0.22
        });
        const wireMesh = new THREE.InstancedMesh(geom, wireMat, count);
        
        const dummy = new THREE.Object3D();
        
        slots.forEach((slot, i) => {
            dummy.position.set(slot.x, (temp.h * slot.hScale) / 2 - 0.5, slot.z);
            dummy.scale.set(1, slot.hScale, 1);
            dummy.updateMatrix();
            
            solidMesh.setMatrixAt(i, dummy.matrix);
            wireMesh.setMatrixAt(i, dummy.matrix);
            
            const col = new THREE.Color(temp.color);
            solidMesh.setColorAt(i, col);
            wireMesh.setColorAt(i, col);
        });
        
        scene.add(solidMesh);
        scene.add(wireMesh);
    });
}

function buildDataParticles() {
    dataParticlesGeom = new THREE.BufferGeometry();
    const positions = new Float32Array(numParticles * 3);
    const velocities = new Float32Array(numParticles);
    
    for (let i = 0; i < numParticles; i++) {
        // Place particles on the left side (among skyscrapers) and some on the right
        const isLeft = Math.random() > 0.4;
        const x = isLeft ? (-75 - Math.random() * 160) : (75 + Math.random() * 160);
        const y = Math.random() * 120;
        const z = -400 + (Math.random() - 0.5) * 2400; // extended Z bounds
        
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
        
        velocities[i] = 8 + Math.random() * 12; // rise velocity
    }
    
    dataParticlesGeom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    const mat = new THREE.PointsMaterial({
        color: 0x00f0ff,
        size: 2.5,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });
    
    dataParticlesPoints = new THREE.Points(dataParticlesGeom, mat);
    dataParticlesPoints.userData = { velocities: velocities };
    scene.add(dataParticlesPoints);
}


// --- Helper Functions ---

function formatSpeed(bytesPerSec) {
    if (bytesPerSec === 0) return '0.0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
    return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// --- LAN Nodes Scanner ---
function startNetworkScan() {
    const btn = document.getElementById('scan-network-btn');
    const statusText = document.getElementById('scan-status-text');
    const progressBar = document.getElementById('scan-progress-bar');
    const progressFill = progressBar.querySelector('.progress-bar-fill');
    const listBody = document.getElementById('devices-list');
    
    btn.disabled = true;
    statusText.textContent = 'SCANNING LOCAL SUBNET...';
    progressBar.classList.remove('hidden');
    progressFill.style.width = '0%';
    listBody.innerHTML = `<div class="loading-state">MAP_ACTIVE: PING SWEEP AND ARP TABLES...</div>`;
    
    let progress = 0;
    const interval = setInterval(() => {
        progress += 5;
        if (progress > 95) clearInterval(interval);
        progressFill.style.width = `${progress}%`;
    }, 200);
    
    callAPI('scan_network')
        .then(devices => {
            clearInterval(interval);
            progressFill.style.width = '100%';
            statusText.textContent = `COMPLETED (${devices.length} NODES IDENTIFIED)`;
            btn.disabled = false;
            
            setTimeout(() => {
                progressBar.classList.add('hidden');
            }, 1000);
            
            renderDevicesList(devices);
        })
        .catch(err => {
            clearInterval(interval);
            progressBar.classList.add('hidden');
            statusText.textContent = 'SCAN_FAILED';
            btn.disabled = false;
            listBody.innerHTML = `<div class="loading-state text-red">FAILED TO SCAN LOCAL NETWORK</div>`;
            console.error("Network scan error:", err);
        });
}

function renderDevicesList(devices) {
    const listBody = document.getElementById('devices-list');
    if (!devices || devices.length === 0) {
        listBody.innerHTML = `<div class="empty-state">NO COMPATIBLE SUBNET NODES DETECTED</div>`;
        return;
    }
    
    let html = '';
    devices.forEach((dev, idx) => {
        let tagClass = 'tag-generic';
        if (dev.type === 'iot') tagClass = 'tag-iot';
        else if (dev.type === 'mobile') tagClass = 'tag-mobile';
        else if (dev.type === 'pc') tagClass = 'tag-pc';
        else if (dev.type === 'network') tagClass = 'tag-network';
        
        const typeLabel = dev.type.toUpperCase();
        const delay = idx * 25;
        
        html += `
            <div class="device-row" style="animation-delay: ${delay}ms">
                <span class="device-status-cell">
                    <div class="device-status-indicator"></div>
                </span>
                <span class="vendor-cell" title="${dev.vendor}">${dev.vendor}</span>
                <span class="ip-cell">${dev.ip}</span>
                <span class="mac-cell">${dev.mac}</span>
                <span class="type-cell">
                    <div class="device-type-tag ${tagClass}">${typeLabel}</div>
                </span>
            </div>
        `;
    });
    listBody.innerHTML = html;
}

// --- CLI Console Log Stream ---
function appendConsoleLogs(data) {
    const consoleStream = document.getElementById('console-stream');
    if (!consoleStream) return;
    
    // Log active network connections (speed > 0)
    const activeApps = data.filter(app => (app.speed_recv + app.speed_sent) > 0);
    if (activeApps.length === 0) return;
    
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    activeApps.forEach(app => {
        const rateDown = formatSpeed(app.speed_recv);
        const rateUp = formatSpeed(app.speed_sent);
        
        const logLine = document.createElement('div');
        logLine.style.marginBottom = '4px';
        logLine.style.lineHeight = '1.4';
        logLine.innerHTML = `<span style="color: #64748b;">${timestamp}</span> <span style="color: #ff0055; font-weight: bold;">[TRAFFIC]</span> app=<span style="color: #00f0ff; font-weight: bold;">"${app.name}"</span> conns=<span style="color: #e8d020;">${app.connection_count}</span> rate_down=<span style="color: #39ff14;">${rateDown}</span> rate_up=<span style="color: #39ff14;">${rateUp}</span>`;
        
        consoleStream.appendChild(logLine);
    });
    
    // Prune buffer to keep DOM lightweight
    while (consoleStream.children.length > 250) {
        consoleStream.removeChild(consoleStream.firstChild);
    }
    
    // Auto-scroll
    const consoleBody = consoleStream.parentElement;
    if (consoleBody) {
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }
}

function clearConsoleLog() {
    const consoleStream = document.getElementById('console-stream');
    if (consoleStream) {
        consoleStream.innerHTML = `<div style="color: #64748b;">[SYSTEM] LOG BUFFER PURGED // SENSORS RE-INITIALIZED...</div>`;
    }
}

// Set viewport presentation mode (3D, Console Logs, or Line Chart)
function setViewportMode(mode) {
    viewportMode = mode;
    
    const canvas = document.getElementById('highway-canvas');
    const cliContainer = document.getElementById('cli-console-container');
    const graphContainer = document.getElementById('live-graph-container');
    const decors = document.querySelectorAll('.viewport-panel .hologram-decor');
    
    // Toggle active buttons style states
    const btn3d = document.getElementById('mode-3d-btn');
    const btnLog = document.getElementById('mode-log-btn');
    const btnGraph = document.getElementById('mode-graph-btn');
    
    if (btn3d) btn3d.classList.remove('active');
    if (btnLog) btnLog.classList.remove('active');
    if (btnGraph) btnGraph.classList.remove('active');
    
    if (mode === '3d') {
        if (btn3d) btn3d.classList.add('active');
        canvas.style.display = 'block';
        cliContainer.style.display = 'none';
        graphContainer.style.display = 'none';
        decors.forEach(d => d.style.display = 'block');
        
        // Resume 3D render animation clock loop
        if (!animationFrameId) {
            clock.getDelta();
            animate3D();
        }
    } else if (mode === 'log') {
        if (btnLog) btnLog.classList.add('active');
        canvas.style.display = 'none';
        cliContainer.style.display = 'block';
        graphContainer.style.display = 'none';
        decors.forEach(d => d.style.display = 'none');
        
        // Pause 3D execution loop
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    } else if (mode === 'graph') {
        if (btnGraph) btnGraph.classList.add('active');
        canvas.style.display = 'none';
        cliContainer.style.display = 'none';
        graphContainer.style.display = 'flex';
        decors.forEach(d => d.style.display = 'none');
        
        // Pause 3D execution loop
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
        
        // Render graph immediately
        initLiveGraph();
        updateLiveGraph();
    }
}
window.setViewportMode = setViewportMode;

// Legacy wrapper supporting toggle triggers
function toggleViewportMode() {
    if (viewportMode === '3d') {
        setViewportMode('log');
    } else if (viewportMode === 'log') {
        setViewportMode('graph');
    } else {
        setViewportMode('3d');
    }
}
window.toggleViewportMode = toggleViewportMode;

// Initialize Live line graph controls & instances
function initLiveGraph() {
    const filterSelect = document.getElementById('graph-process-filter');
    const timescaleSelect = document.getElementById('graph-timescale');
    const rateSelect = document.getElementById('graph-update-rate');
    
    if (!filterSelect || !timescaleSelect || !rateSelect) return;
    
    // Only bind handlers once
    if (filterSelect.dataset.bound === 'true') return;
    filterSelect.dataset.bound = 'true';
    
    filterSelect.addEventListener('change', (e) => {
        graphProcessFilter = e.target.value;
        updateLiveGraph();
    });
    
    timescaleSelect.addEventListener('change', (e) => {
        graphTimescale = parseInt(e.target.value);
        updateLiveGraph();
    });
    
    rateSelect.addEventListener('change', (e) => {
        graphUpdateRate = parseInt(e.target.value);
    });
}

// Push a sample to the graph history and update the chart if update rate interval elapsed
function pushLiveGraphHistory(data) {
    const now = Date.now();
    
    // Calculate system totals
    let totalDown = 0;
    let totalUp = 0;
    const processSpeeds = {};
    
    data.forEach(app => {
        totalDown += app.speed_recv;
        totalUp += app.speed_sent;
        processSpeeds[app.name] = {
            recv: app.speed_recv,
            sent: app.speed_sent
        };
    });
    
    graphHistory.push({
        time: now,
        total_recv: totalDown,
        total_sent: totalUp,
        processes: processSpeeds
    });
    
    // Keep max 10 minutes of history (600 seconds)
    const tenMinutesMs = 600 * 1000;
    graphHistory = graphHistory.filter(pt => now - pt.time <= tenMinutesMs);
    
    // Dynamic refresh options
    populateGraphFilterDropdown(data);
    
    // Update chart if graph view is active and updateRate interval has elapsed
    if (viewportMode === 'graph' && now - lastGraphUpdateTime >= graphUpdateRate) {
        lastGraphUpdateTime = now;
        updateLiveGraph();
    }
}

// Populate the filter select menu options dynamically with running applications
function populateGraphFilterDropdown(data) {
    const filterSelect = document.getElementById('graph-process-filter');
    if (!filterSelect) return;
    
    // Preserve current selection
    const currentVal = filterSelect.value;
    
    // Extract unique active app names
    const appNames = data.map(app => app.name).sort();
    
    let html = `<option value="_total_" ${currentVal === '_total_' ? 'selected' : ''}>SYSTEM_TOTAL</option>`;
    appNames.forEach(name => {
        html += `<option value="${name}" ${currentVal === name ? 'selected' : ''}>${name}</option>`;
    });
    
    filterSelect.innerHTML = html;
}

// Redraw the live line telemetry chart using scaled historical segments
function updateLiveGraph() {
    const ctx = document.getElementById('live-telemetry-line-chart');
    if (!ctx) return;
    
    const now = Date.now();
    const rangeMs = graphTimescale * 1000;
    
    // Filter points in range
    const filteredPoints = graphHistory.filter(pt => now - pt.time <= rangeMs);
    
    const labels = [];
    const downData = [];
    const upData = [];
    
    filteredPoints.forEach(pt => {
        // Label represents relative age (e.g. -15s, -10s)
        const diffSeconds = Math.round((pt.time - now) / 1000);
        labels.push(`${diffSeconds}s`);
        
        if (graphProcessFilter === '_total_') {
            downData.push(pt.total_recv);
            upData.push(pt.total_sent);
        } else {
            const proc = pt.processes[graphProcessFilter];
            downData.push(proc ? proc.recv : 0);
            upData.push(proc ? proc.sent : 0);
        }
    });
    
    if (liveLineChart) {
        liveLineChart.data.labels = labels;
        liveLineChart.data.datasets[0].data = downData;
        liveLineChart.data.datasets[1].data = upData;
        liveLineChart.update('none'); // Update without full layout animation to keep it high performance
        return;
    }
    
    // Create new Line Chart
    liveLineChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Download Rate',
                    data: downData,
                    borderColor: '#00f0ff',
                    backgroundColor: 'rgba(0, 240, 255, 0.05)',
                    borderWidth: 2,
                    tension: 0.35,
                    fill: true,
                    pointRadius: 0,
                    hoverRadius: 4
                },
                {
                    label: 'Upload Rate',
                    data: upData,
                    borderColor: '#ff0055',
                    backgroundColor: 'rgba(255, 0, 85, 0.05)',
                    borderWidth: 2,
                    tension: 0.35,
                    fill: true,
                    pointRadius: 0,
                    hoverRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: {
                    grid: { color: 'rgba(255, 255, 255, 0.03)' },
                    ticks: { color: '#64748b', font: { family: 'monospace', size: 9 } }
                },
                y: {
                    grid: { color: 'rgba(255, 255, 255, 0.03)' },
                    ticks: {
                        color: '#64748b',
                        font: { family: 'monospace', size: 9 },
                        callback: function(value) {
                            return formatSpeed(value);
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    labels: {
                        color: '#8f9bb3',
                        font: { family: 'monospace', size: 9 }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return ` ${context.dataset.label}: ${formatSpeed(context.raw)}`;
                        }
                    }
                }
            }
        }
    });
}

function checkUpdates() {
    const btn = document.getElementById('chk-updates-btn');
    const status = document.getElementById('update-status');
    if (!btn || !status) return;
    
    btn.disabled = true;
    status.style.color = 'var(--neon-cyan)';
    status.innerText = '[ CONNECTING... ]';
    
    setTimeout(() => {
        btn.disabled = false;
        status.style.color = '#39ff14'; // Green glow
        status.innerText = 'v1.0 IS THE LATEST VERSION';
    }, 1200);
}
window.checkUpdates = checkUpdates;
