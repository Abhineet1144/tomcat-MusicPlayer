/* Devices.js – Multi-device sync via WebSocket (falls back to HTTP polling) */

// ── Constants ─────────────────────────────────────────────────────
const DEVICE_TIMEOUT = 30000;   // ms – no ping/heartbeat → offline
const WS_PING_MS     = 5000;    // state ping over WebSocket
const HTTP_POLL_MS   = 1500;    // HTTP heartbeat interval (fallback only)
const WS_RETRY_MS    = 3000;    // reconnect delay on WS close

// ── State ─────────────────────────────────────────────────────────
let myDeviceId          = null;
let connectedDevices    = [];
let _devicePanelOpen    = false;
let _receivingRemoteCmd = false;
let isolated            = false;

/**
 * The device that should produce audio.
 * null  → not yet determined (default: self)
 * id    → explicit active device
 *
 * Rules (evaluated in order):
 *   1. A device that sent isActive:true in its state ping.
 *   2. A device that has playing:true (first found).
 *   3. The first device in the list (connection order).
 *   4. myDeviceId (fallback when alone).
 */
let activeDeviceId = null;

// WebSocket handles
let _ws               = null;
let _wsPingTimer      = null;
let _wsReconnTimer    = null;

// HTTP fallback handles (used when WS is not connected)
let _httpTimer        = null;

// Volume broadcast debounce
let _volBcastTimer    = null;

// ── Controller mirror (keeps the player UI in sync when this device is a controller) ──
let _controllerMirrorTimer = null;
/**
 * Last state received from the active device.
 * { songName, progress, duration, playing, syncedAt }
 */
let _mirrorState = null;

// ── Device Identity ───────────────────────────────────────────────
function ensureDeviceId() {
    myDeviceId = localStorage.getItem('om_deviceId');
    if (!myDeviceId) {
        myDeviceId = 'dev-' + Math.random().toString(36).slice(2, 9) + '-' + Date.now().toString(36);
        localStorage.setItem('om_deviceId', myDeviceId);
    }
}

function getMyDeviceName() {
    let name = localStorage.getItem('om_deviceName');
    if (name) return name;
    const ua   = navigator.userAgent;
    const mob  = /Mobi|Android|iPhone|iPad/i.test(ua);
    const tab  = /iPad|Tablet/i.test(ua) && !/Mobi/i.test(ua);
    const type = mob ? (tab ? 'Tablet' : 'Mobile') : 'Desktop';
    let br = 'Browser';
    if (/Edg\//i.test(ua))          br = 'Edge';
    else if (/OPR|Opera/i.test(ua)) br = 'Opera';
    else if (/Chrome/i.test(ua))    br = 'Chrome';
    else if (/Firefox/i.test(ua))   br = 'Firefox';
    else if (/Safari/i.test(ua))    br = 'Safari';
    name = `${br} on ${type}`;
    localStorage.setItem('om_deviceName', name);
    return name;
}

function deviceIcon(name) {
    const n = (name || '').toLowerCase();
    if (n.includes('mobile') || n.includes('android') || n.includes('iphone')) return '📱';
    if (n.includes('tablet') || n.includes('ipad')) return '📟';
    return '💻';
}

// ── Active-device helpers (used by Player.js & PlayList.js) ──────
/**
 * Returns the ID of the device that should produce audio.
 * Based purely on live playing:true state — no self-referential isActive flag.
 */
function getActiveDeviceId() {
    const now   = Date.now();
    const peers = connectedDevices.filter(d => now - d.lastSeen < DEVICE_TIMEOUT);
    if (!peers.length) return myDeviceId || null;

    // Whoever is reporting playing:true right now
    const playing = peers.find(d => d.state && d.state.playing);
    if (playing) return playing.id;

    // Fall back to last-known active (set when someone last started playing)
    if (activeDeviceId && peers.find(d => d.id === activeDeviceId)) return activeDeviceId;

    // Default: first in list
    return peers[0]?.id || myDeviceId;
}

/**
 * Returns true when THIS device should be the one producing audio.
 *
 * Logic (in order):
 *  1. Alone (≤1 peer)             → always active.
 *  2. My local audio is playing   → I'm the active device.
 *  3. Another peer is playing     → I'm a controller.
 *  4. Nobody playing              → use last-known activeDeviceId; null = assume active.
 */
function amIActiveDevice() {
    const now   = Date.now();
    const peers = connectedDevices.filter(d => now - d.lastSeen < DEVICE_TIMEOUT);
    if (peers.length <= 1) return true;   // alone → always active

    // My own audio is running → I'm the active device
    const iAmPlaying = typeof playing !== 'undefined' && playing &&
                       typeof audio   !== 'undefined' && audio !== null;
    if (iAmPlaying) return true;

    // Another peer is reporting playing:true → I'm a controller
    const otherPlaying = peers.find(d => d.id !== myDeviceId && d.state && d.state.playing);
    if (otherPlaying) return false;

    // Nobody playing → last-known wins; null means "unknown → assume I'm active"
    if (activeDeviceId === null) return true;
    return activeDeviceId === myDeviceId;
}

// ── Controller UI Mirroring ───────────────────────────────────────
/**
 * Called every time a device-list update arrives.
 * If this device is a controller, copies the active device's state
 * into the local player UI so the user sees what's playing.
 */
function _syncMirrorStateFromActive() {
    if (amIActiveDevice()) {
        _stopControllerMirror();
        _mirrorState = null;
        return;
    }
    const activeId  = getActiveDeviceId();
    if (!activeId) return;
    const activeDev = connectedDevices.find(d => d.id === activeId);
    if (!activeDev || !activeDev.state) return;

    const s           = activeDev.state;
    const prevSong    = _mirrorState ? _mirrorState.songName : null;
    const songChanged = prevSong !== s.songName;

    _mirrorState = {
        songName: s.songName  || null,
        progress: s.progress  || 0,
        duration: s.duration  || 0,
        playing:  !!s.playing,
        syncedAt: Date.now()
    };

    _applyMirrorStaticUI(songChanged);
    if (s.playing) _startControllerMirror();
    else           { _stopControllerMirror(); _tickMirrorUI(); }
}

/** Update static elements: song name, thumbnail, duration, play-button icon. */
function _applyMirrorStaticUI(songChanged) {
    if (!_mirrorState) return;

    if (_mirrorState.songName) {
        const n = document.getElementById('player-song-name');
        if (n) n.textContent = _mirrorState.songName;
        const en = document.getElementById('exp-name');
        if (en) en.textContent = _mirrorState.songName;

        if (songChanged && typeof extractThumb !== 'undefined') {
            extractThumb(_mirrorState.songName, url => {
                const img = document.getElementById('player-thumb');
                if (img) img.src = url;
                const eimg = document.getElementById('exp-thumb');
                if (eimg) eimg.src = url;
            });
        }
    }

    if (_mirrorState.duration > 0 && typeof fmt !== 'undefined') {
        const tot = document.getElementById('total-time');
        if (tot) tot.textContent = fmt(_mirrorState.duration);
        const sb = document.getElementById('seek-bar');
        if (sb) sb.max = _mirrorState.duration;
        const etot = document.getElementById('exp-total');
        if (etot) etot.textContent = fmt(_mirrorState.duration);
        const esb = document.getElementById('exp-seek-bar');
        if (esb) esb.max = _mirrorState.duration;
    }

    const icon = _mirrorState.playing ? '⏸' : '▶';
    const pp = document.getElementById('play-pause-btn');
    if (pp) pp.innerHTML = icon;
    const epp = document.getElementById('exp-pp');
    if (epp) epp.innerHTML = icon;
}

/** Called every second while the active device is playing – interpolates progress. */
function _tickMirrorUI() {
    if (!_mirrorState || amIActiveDevice()) { _stopControllerMirror(); return; }

    let progress = _mirrorState.progress;
    if (_mirrorState.playing) {
        const elapsed = (Date.now() - _mirrorState.syncedAt) / 1000;
        progress = Math.min(_mirrorState.progress + elapsed, _mirrorState.duration || Infinity);
    }

    const dur = _mirrorState.duration;
    if (dur > 0 && typeof fmt !== 'undefined') {
        const pct  = (progress / dur * 100).toFixed(2) + '%';
        const seek = typeof isSeeking !== 'undefined' && isSeeking;

        const ct = document.getElementById('curr-time');  if (ct) ct.textContent = fmt(progress);
        const sf = document.getElementById('seek-fill');   if (sf) sf.style.width = pct;
        if (!seek) {
            const sb = document.getElementById('seek-bar'); if (sb) sb.value = progress;
        }

        const ef = document.getElementById('exp-seek-fill');  if (ef) ef.style.width = pct;
        const ec = document.getElementById('exp-curr');       if (ec) ec.textContent = fmt(progress);
        if (!seek) {
            const eb = document.getElementById('exp-seek-bar'); if (eb) eb.value = progress;
        }
    }
}

function _startControllerMirror() {
    if (_controllerMirrorTimer) return;
    _controllerMirrorTimer = setInterval(_tickMirrorUI, 1000);
}
function _stopControllerMirror() {
    clearInterval(_controllerMirrorTimer);
    _controllerMirrorTimer = null;
}

// ── Isolation ─────────────────────────────────────────────────────
function setIsolated(on) {
    isolated = !!on;
    localStorage.setItem('om_isolated', isolated);
    const cb  = document.getElementById('pref-isolated'); if (cb)  cb.checked = isolated;
    const btn = document.getElementById('devices-btn');   if (btn) btn.classList.toggle('isolated', isolated);

    if (isolated) {
        _disconnectWS();
        _stopHttpPoll();
        _stopControllerMirror();
        _mirrorState = null;
        closeDevicePanel();
        showToast('🔒 Device isolated — cluster sync off');
    } else {
        if (typeof currentUser !== 'undefined' && currentUser) _connectWS();
        showToast('🔗 Joined cluster', 'ok');
    }
}

// ── WebSocket (primary) ───────────────────────────────────────────
function _wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // /MusicPlayer/index.html → /MusicPlayer
    const ctx   = location.pathname.substring(0, location.pathname.lastIndexOf('/'));
    return `${proto}//${location.host}${ctx}/ws`;
}

function _wsIsOpen() {
    return _ws && _ws.readyState === WebSocket.OPEN;
}

function _connectWS() {
    if (isolated || !currentUser || !myDeviceId) return;
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(_wsReconnTimer);
    _ws = new WebSocket(_wsUrl());

    _ws.onopen = () => {
        _stopHttpPoll();                         // WS is up — stop the HTTP fallback
        clearTimeout(_wsReconnTimer);
        _wsSend({ type: 'hello', deviceId: myDeviceId, name: getMyDeviceName() });
        _startWsPing();
    };

    _ws.onmessage = e => {
        try { _handleWsMsg(JSON.parse(e.data)); } catch (_) {}
    };

    _ws.onclose = () => {
        _stopWsPing();
        if (!isolated && currentUser) {
            _startHttpPoll();                    // fall back to HTTP while reconnecting
            _wsReconnTimer = setTimeout(_connectWS, WS_RETRY_MS);
        }
    };

    _ws.onerror = () => _ws.close();
}

function _disconnectWS() {
    clearTimeout(_wsReconnTimer);
    _stopWsPing();
    if (_ws) { _ws.close(); _ws = null; }
}

function _wsSend(obj) {
    if (_wsIsOpen()) { _ws.send(JSON.stringify(obj)); return true; }
    return false;
}

// ── WS Ping (keeps device-list fresh) ────────────────────────────
function _startWsPing() {
    _stopWsPing();
    _sendWsPing();
    _wsPingTimer = setInterval(_sendWsPing, WS_PING_MS);
}

function _stopWsPing() { clearInterval(_wsPingTimer); _wsPingTimer = null; }

function _sendWsPing() {
    if (isolated || !_wsIsOpen()) return;
    _wsSend({ type: 'ping', state: _myState() });
}

// ── HTTP Heartbeat (fallback when WS is down) ─────────────────────
function _startHttpPoll() {
    if (_httpTimer) return;             // already running
    _sendHttpHeartbeat();
    _httpTimer = setInterval(_sendHttpHeartbeat, HTTP_POLL_MS);
}

function _stopHttpPoll() { clearInterval(_httpTimer); _httpTimer = null; }

function _sendHttpHeartbeat() {
    if (isolated || !currentUser || !myDeviceId || _wsIsOpen()) { _stopHttpPoll(); return; }
    fetch('./devices', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'heartbeat', deviceId: myDeviceId,
                                  name: getMyDeviceName(), state: _myState() })
    })
    .then(r => r.json())
    .then(data => {
        if (Array.isArray(data.devices)) {
            connectedDevices = data.devices;
            const playing = connectedDevices.find(d => d.state && d.state.playing);
            if (playing) activeDeviceId = playing.id;
            _syncMirrorStateFromActive();
            if (_devicePanelOpen) renderDeviceList();
        }
        if (!isolated && Array.isArray(data.commands) && data.commands.length)
            _processHttpCmds(data.commands);
    })
    .catch(() => {});
}

// ── WebSocket Message Handler ─────────────────────────────────────
function _handleWsMsg(msg) {
    switch (msg.type) {
        case 'devices':
            connectedDevices = (msg.list || []).map(d => ({
                id:       d.id,
                name:     d.name,
                lastSeen: d.lastSeen || Date.now(),
                state:    d.state   || {}
            }));
            // Update activeDeviceId based purely on who is playing right now.
            // If nobody is playing we keep whatever we had (preserves paused-active state).
            {
                const playing = connectedDevices.find(d => d.state && d.state.playing);
                if (playing) activeDeviceId = playing.id;
            }
            // Mirror active device state into controller UI
            _syncMirrorStateFromActive();
            if (_devicePanelOpen) renderDeviceList();
            break;

        case 'cmd':
            if (!isolated) _processWsCmd(msg);
            break;
    }
}

// ── State Snapshot ────────────────────────────────────────────────
function _myState() {
    const q  = typeof queue    !== 'undefined' ? queue    : [];
    const qi = typeof queueIdx !== 'undefined' ? queueIdx : -1;
    return {
        playing:     typeof playing   !== 'undefined' ? playing   : false,
        songName:    (qi >= 0 && q[qi]) ? q[qi].name : null,
        progress:    typeof audio !== 'undefined' && audio ? audio.currentTime   : 0,
        duration:    typeof audio !== 'undefined' && audio ? (audio.duration||0) : 0,
        volume:      parseFloat(document.getElementById('volume-slider')?.value || '0.8'),
        muted:       typeof muted     !== 'undefined' ? muted     : false,
        queueIdx:    qi,
        queueLength: q.length,
        loopMode:    typeof loopMode  !== 'undefined' ? loopMode  : 0,
        shuffleOn:   typeof shuffleOn !== 'undefined' ? shuffleOn : false
        // Note: no isActive field – active device is determined from playing:true in real-time
    };
}

function _myFullState() {
    return { ..._myState(), queue: typeof queue !== 'undefined' ? queue : [] };
}

// ── Cluster Broadcast ─────────────────────────────────────────────
/**
 * Broadcast a player action to every peer.
 * Guards: _receivingRemoteCmd, _suppressBroadcast, isolated.
 *
 * Primary:  single WS "broadcast" message → server fans out in-memory, ~10 ms.
 * Fallback: individual HTTP POST per peer (polling mode).
 */
function broadcastPlayerAction(cmd, params = {}) {
    if (_receivingRemoteCmd)        return;
    if (window._suppressBroadcast) return;
    if (isolated || !currentUser || !myDeviceId) return;

    if (_wsSend({ type: 'broadcast', cmd, params })) return;

    // HTTP fallback
    connectedDevices.filter(d => d.id !== myDeviceId)
                    .forEach(d => _httpCmd(d.id, cmd, params));
}

function scheduleBroadcastVolume(v) {
    clearTimeout(_volBcastTimer);
    _volBcastTimer = setTimeout(() => broadcastPlayerAction('setVolume', { volume: v }), 300);
}

// ── Command Processors ────────────────────────────────────────────

/** WS path – no ACK needed (TCP guarantees delivery). */
function _processWsCmd(msg) {
    _receivingRemoteCmd = true;
    try {
        executeDeviceCommand({ cmd: msg.cmd, params: msg.params || {} });
    } finally {
        _receivingRemoteCmd = false;
    }
}

/** HTTP fallback path – ACK prevents re-delivery. */
function _processHttpCmds(commands) {
    const ackIds = commands.map(c => c.id);
    _receivingRemoteCmd = true;
    try {
        commands.forEach(c => { try { executeDeviceCommand(c); } catch(e) { console.warn('[Devices]', c.cmd, e); } });
    } finally {
        _receivingRemoteCmd = false;
    }
    fetch('./devices', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'ack', deviceId: myDeviceId, commandIds: ackIds })
    }).catch(() => {});
}

/** Execute a command from any peer (WS or HTTP path). */
function executeDeviceCommand(cmd) {
    const p = cmd.params || {};
    switch (cmd.cmd) {
        case 'playSong':
            if (!p.songName) break;
            {
                const q  = typeof queue    !== 'undefined' ? queue    : [];
                const qi = typeof queueIdx !== 'undefined' ? queueIdx : -1;
                let idx = q.findIndex(s => s.name === p.songName);
                if (idx === -1) { const at = qi + 1; q.splice(at, 0, { name: p.songName }); idx = at; }
                queueIdx = idx;
                if (typeof _pendingRestoreProgress !== 'undefined') _pendingRestoreProgress = p.progress || 0;
                loadAndStart(p.songName); renderQueue(); persist();
            }
            break;
        case 'pause':
            // Direct — do not go through swapPlayStatusAndUpdate (avoids routing re-check)
            if (typeof audio !== 'undefined' && audio &&
                typeof playing !== 'undefined' && playing) {
                playing = false;
                if (typeof updatePlayBtn !== 'undefined') updatePlayBtn();
            }
            break;
        case 'resume':
            if (typeof audio !== 'undefined' && audio &&
                typeof playing !== 'undefined' && !playing) {
                playing = true;
                if (typeof updatePlayBtn !== 'undefined') updatePlayBtn();
            } else if (!audio && typeof queue !== 'undefined' && typeof queueIdx !== 'undefined' &&
                       queueIdx >= 0 && queue && queue[queueIdx]) {
                loadAndStart(queue[queueIdx].name);
            }
            break;
        case 'toggle':
            // "Flip" play/pause – sent by a controller device; active device executes directly.
            if (typeof audio !== 'undefined' && audio) {
                if (typeof playing !== 'undefined') playing = !playing;
                if (typeof updatePlayBtn !== 'undefined') updatePlayBtn();
            } else if (typeof queue !== 'undefined' && typeof queueIdx !== 'undefined' &&
                       queueIdx >= 0 && queue && queue[queueIdx]) {
                loadAndStart(queue[queueIdx].name);
            }
            break;
        case 'next':   nextSong(); break;
        case 'prev':   prevSong(); break;
        case 'seek':
            if (typeof audio !== 'undefined' && audio && p.position != null)
                { audio.currentTime = p.position; updateSeekUI(); }
            break;
        case 'skip':   skip(p.seconds || 10); break;
        case 'setVolume':
            if (p.volume != null) { const s = document.getElementById('volume-slider'); if (s) { s.value = p.volume; setVolume(); } } break;
        case 'setLoopMode':  if (p.mode != null) applyLoopMode(p.mode);   break;
        case 'setShuffleOn': if (p.on  != null) applyShuffleState(p.on);  break;
        case 'transferPlayback':
            if (!Array.isArray(p.queue) || !p.queue.length) break;
            queue = p.queue; queueIdx = typeof p.queueIdx === 'number' ? p.queueIdx : 0;
            if (typeof renderQueue !== 'undefined') renderQueue();
            if (typeof persist    !== 'undefined') persist();
            { const sn = queue[queueIdx]?.name; if (sn) { if (typeof _pendingRestoreProgress !== 'undefined') _pendingRestoreProgress = p.progress||0; loadAndStart(sn); } }
            showToast('▶ Playback transferred to this device', 'ok'); break;
    }
}

// ── Send Command to One Device ────────────────────────────────────
function sendRemoteCommand(targetId, cmd, params = {}) {
    if (!currentUser || !myDeviceId) return;
    if (_wsSend({ type: 'cmd', to: targetId, cmd, params })) return;
    _httpCmd(targetId, cmd, params);
}

function _httpCmd(targetId, cmd, params) {
    fetch('./devices', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'command', targetDeviceId: targetId, cmd, params })
    }).catch(() => {});
}

// ── Playback Transfer ─────────────────────────────────────────────
function transferPlaybackHere(sourceId) {
    const src = connectedDevices.find(d => d.id === sourceId);
    if (!src?.state?.songName) { showToast('That device has nothing playing'); return; }
    const s = src.state;
    sendRemoteCommand(sourceId, 'pause', {});

    window._suppressBroadcast = true;
    try {
        if (Array.isArray(s.queue) && s.queue.length) {
            queue = s.queue; queueIdx = typeof s.queueIdx === 'number' ? s.queueIdx : 0;
            if (typeof renderQueue !== 'undefined') renderQueue();
            if (typeof persist    !== 'undefined') persist();
        }
        if (typeof _pendingRestoreProgress !== 'undefined') _pendingRestoreProgress = s.progress || 0;
        play(s.songName);
    } finally { window._suppressBroadcast = false; }

    // This device is now the active player — stop mirroring
    activeDeviceId = myDeviceId;
    _stopControllerMirror();
    _mirrorState = null;

    showToast('▶ Playing on this device', 'ok');
    renderDeviceList();
}

function transferPlaybackTo(targetId) {
    const state = _myFullState();
    if (!state.songName) { showToast('Nothing is playing to send'); return; }
    sendRemoteCommand(targetId, 'transferPlayback', state);
    if (typeof playing !== 'undefined' && playing) swapPlayStatusAndUpdate();
    showToast('📤 Playback sent to remote device', 'ok');
    renderDeviceList();
}

// ── Device Panel ──────────────────────────────────────────────────
function toggleDevicePanel() {
    _devicePanelOpen = !_devicePanelOpen;
    const panel = document.getElementById('device-panel');
    if (!panel) return;
    if (_devicePanelOpen) {
        panel.classList.remove('hidden');
        document.getElementById('devices-btn')?.classList.add('on');
        renderDeviceList();
        // Trigger an immediate state push so the list is fresh
        _wsIsOpen() ? _sendWsPing() : _sendHttpHeartbeat();
    } else {
        closeDevicePanel();
    }
}

function closeDevicePanel() {
    _devicePanelOpen = false;
    document.getElementById('device-panel')?.classList.add('hidden');
    document.getElementById('devices-btn')?.classList.remove('on');
}

function renderDeviceList() {
    const container = document.getElementById('device-list');
    if (!container) return;
    const now    = Date.now();
    const active = connectedDevices.filter(d => now - d.lastSeen < DEVICE_TIMEOUT);

    if (!active.length) {
        const who = typeof currentUser !== 'undefined' && currentUser ? escHtml(currentUser) : 'you';
        container.innerHTML = `
          <div class="dev-empty">
            <div class="dev-empty-ico">📡</div>
            <p>No other devices connected.</p>
            <p class="dev-empty-sub">Sign in as <strong>${who}</strong> on another device.</p>
          </div>`;
        return;
    }

    // Show WS/HTTP connection mode badge
    const mode = _wsIsOpen() ? '⚡ Live' : '🔄 Polling';
    container.innerHTML = `<div class="dev-mode-badge">${mode}</div>`;

    active.forEach(device => {
        const isMe      = device.id === myDeviceId;
        const isActive  = device.id === (activeDeviceId || getActiveDeviceId());
        const s         = device.state || {};
        const vol       = typeof s.volume === 'number' ? s.volume : 0.8;
        const volPct    = Math.round(vol * 100);
        const label     = s.songName
            ? `${s.playing ? '▶' : '⏸'} <span class="dev-song">${escHtml(s.songName)}</span> · ${fmt(s.progress||0)} / ${fmt(s.duration||0)}`
            : '<span class="dev-idle">Idle</span>';

        const badge = isMe
            ? `<span class="dev-badge dev-badge-me">This device</span>` +
              `<span class="dev-badge ${isActive ? 'dev-badge-active' : 'dev-badge-ctrl'}">${isActive ? '▶ Active' : '🎛 Controller'}</span>`
            : (isActive ? '<span class="dev-badge dev-badge-active">▶ Active</span>' : '');

        const controls = isMe ? '' : `
          <div class="dev-controls">
            <div class="dev-transfer-row">
              <button class="dev-transfer-btn" onclick="transferPlaybackHere('${device.id}')">📥 Play here</button>
              <button class="dev-transfer-btn" onclick="transferPlaybackTo('${device.id}')">📤 Send there</button>
            </div>
            <div class="dev-vol-row">
              <span class="dev-vol-ico">🔊</span>
              <input type="range" class="dev-volbar" min="0" max="1" step="0.01" value="${vol}"
                oninput="onRemoteVolChange('${device.id}',this)">
              <span class="dev-vol-pct">${volPct}%</span>
            </div>
          </div>`;

        const div = document.createElement('div');
        div.className = 'dev-item' + (isMe ? ' dev-me' : '') + (isActive ? ' dev-active' : '');
        div.dataset.id = device.id;
        div.innerHTML = `
          <div class="dev-hdr">
            <span class="dev-icon">${deviceIcon(device.name)}</span>
            <div class="dev-meta">
              <div class="dev-nameline">
                <span class="dev-name">${escHtml(device.name)}</span>
                ${badge}
                <span class="dev-dot${s.playing ? ' pulsing' : ''}">●</span>
              </div>
              <div class="dev-status">${label}</div>
            </div>
          </div>${controls}`;
        container.appendChild(div);
    });
}

// ── Remote Volume (debounced) ─────────────────────────────────────
let _remoteDebounce = {};
function onRemoteVolChange(deviceId, input) {
    const v = parseFloat(input.value);
    const p = input.parentElement?.querySelector('.dev-vol-pct');
    if (p) p.textContent = Math.round(v * 100) + '%';
    clearTimeout(_remoteDebounce['vl_' + deviceId]);
    _remoteDebounce['vl_' + deviceId] = setTimeout(
        () => sendRemoteCommand(deviceId, 'setVolume', { volume: v }), 200);
}

// ── Lifecycle ─────────────────────────────────────────────────────
function onDevicesLoggedIn() {
    ensureDeviceId();
    isolated = localStorage.getItem('om_isolated') === 'true';
    const cb  = document.getElementById('pref-isolated'); if (cb) cb.checked = isolated;
    document.getElementById('devices-btn')?.classList.toggle('isolated', isolated);
    if (!isolated) _connectWS();
}

function onDevicesLoggedOut() {
    _disconnectWS();
    _stopHttpPoll();
    connectedDevices = [];
    closeDevicePanel();
}

// Close panel on outside click
document.addEventListener('click', e => {
    if (!_devicePanelOpen) return;
    const panel = document.getElementById('device-panel');
    const btn   = document.getElementById('devices-btn');
    if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) closeDevicePanel();
});
