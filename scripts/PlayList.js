/* PlayList.js – Queue management, Playlist CRUD, Server sync */

// ── State ─────────────────────────────────────────────────────────
let queue     = [];   // [{name}]
let queueIdx  = -1;
let playlists = [];   // [{name, songs:[{name}]}]
let viewingPl = -1;   // playlist index currently shown in detail view

/**
 * When restoring from a saved server state, this holds the progress
 * (seconds) to resume from on the FIRST play of the restored song.
 * Consumed (reset to 0) inside loadAndStart().
 */
let _pendingRestoreProgress = 0;

// ── Boot ──────────────────────────────────────────────────────────
// loadPlaylists() is called by Auth.js after login / guest

function loadPlaylists() {
    if (currentUser) {
        // Load from server
        fetch('./playlists')
            .then(r => r.json())
            .then(data => {
                if (Array.isArray(data)) {
                    playlists = data.map(pl => ({
                        name:  pl.name,
                        songs: (pl.songs || []).map(s => ({ name: typeof s === 'string' ? s : s.name }))
                    }));
                } else {
                    playlists = [{ name: 'My Favorites', songs: [] }];
                }
                renderSidebar();
                // Load full player state from server (queue, volume, EQ …)
                loadStateFromServer();
            })
            .catch(() => {
                loadFromLocalStorage();
            });
    } else {
        loadFromLocalStorage();
    }
}

function loadFromLocalStorage() {
    try { playlists = JSON.parse(localStorage.getItem('playlists')) || [{ name: 'My Favorites', songs: [] }]; } catch (_) { playlists = [{ name: 'My Favorites', songs: [] }]; }
    try { queue    = JSON.parse(localStorage.getItem('queue'))     || []; }                                  catch (_) { queue    = []; }
    queueIdx = parseInt(localStorage.getItem('queueIdx') ?? '-1');
    renderSidebar();
    renderQueue();
}

function persist() {
    localStorage.setItem('queue',     JSON.stringify(queue));
    localStorage.setItem('queueIdx',  queueIdx);
    if (!currentUser) {
        localStorage.setItem('playlists', JSON.stringify(playlists));
    } else {
        // Sync playlists to server (debounced)
        clearTimeout(persist._t);
        persist._t = setTimeout(syncToServer, 1200);
        // Also sync full player state
        scheduleStateSync();
    }
}

function syncToServer() {
    if (!currentUser) return;
    fetch('./playlists?action=save', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(playlists)
    }).catch(() => {});
}

// ── Server State Load / Apply ─────────────────────────────────────

/**
 * Fetch player state from the server and apply it.
 * Falls back to localStorage queue if the request fails.
 */
function loadStateFromServer() {
    fetch('./state')
        .then(r => r.json())
        .then(state => {
            if (state.error) {
                restoreQueueFromLocalStorage();
                return;
            }
            applyServerState(state);
        })
        .catch(() => restoreQueueFromLocalStorage());
}

function restoreQueueFromLocalStorage() {
    const sq = localStorage.getItem('queue');
    if (sq) {
        try {
            queue    = JSON.parse(sq);
            queueIdx = parseInt(localStorage.getItem('queueIdx') ?? '-1');
        } catch (_) {}
    }
    renderQueue();
}

/**
 * Apply a full state snapshot returned by GET /state.
 * Wrapped in _suppressBroadcast so restoring your own saved state
 * doesn't disrupt other devices in the cluster.
 */
function applyServerState(state) {
    window._suppressBroadcast = true;
    try {
        _applyServerStateInner(state);
    } finally {
        window._suppressBroadcast = false;
    }
}

function _applyServerStateInner(state) {
    // ── Playback settings ────────────────────────────────────────
    if (state.volume != null) {
        document.getElementById('volume-slider').value = state.volume;
        // Call setVolume but skip the sync hook (no circular push)
        _applyVolumeNoSync(state.volume);
    }

    if (state.muted) {
        // toggleMute flips the flag; since muted starts false, one call sets it
        toggleMute();
    }

    if (state.loopMode != null) {
        applyLoopMode(state.loopMode);
    }

    if (state.shuffleOn != null) {
        applyShuffleState(state.shuffleOn);
    }

    if (state.speed != null) {
        speedVal = state.speed;
        document.getElementById('speed-slider').value = state.speed;
        if (audio) audio.playbackRate = state.speed;
        document.getElementById('speed-val').textContent = state.speed.toFixed(2) + 'x';
        localStorage.setItem('speed', state.speed);
    }

    if (state.crossfade != null) {
        crossfadeSec = state.crossfade;
        document.getElementById('crossfade-slider').value = state.crossfade;
        document.getElementById('crossfade-val').textContent = state.crossfade.toFixed(1) + 's';
        localStorage.setItem('crossfade', state.crossfade);
    }

    if (Array.isArray(state.eq) && state.eq.length === EQ_BANDS.length) {
        EQ_BANDS.forEach((b, i) => {
            document.getElementById(b.id).value = state.eq[i];
        });
        updateEQ(); // applies to audio nodes + DOM labels
        if (state.eqPreset) {
            document.querySelectorAll('.preset-btn').forEach(b => {
                b.classList.toggle('on', b.dataset.preset === state.eqPreset);
            });
            localStorage.setItem('eqPreset', state.eqPreset);
        }
    }

    // ── Queue ────────────────────────────────────────────────────
    if (Array.isArray(state.queue) && state.queue.length > 0) {
        queue    = state.queue;
        queueIdx = typeof state.queueIdx === 'number' ? state.queueIdx : -1;

        renderQueue();

        // Show current song in player UI (no autoplay)
        if (queueIdx >= 0 && queue[queueIdx]) {
            _pendingRestoreProgress = state.progress || 0;
            previewSongInPlayer(
                queue[queueIdx].name,
                state.progress || 0,
                state.duration || 0
            );
        }
    } else {
        // No saved queue – fall back to localStorage
        restoreQueueFromLocalStorage();
    }
}

/**
 * Set volume without triggering a server state sync.
 * Used internally during state restore to avoid an immediate push-back.
 */
function _applyVolumeNoSync(v) {
    if (audio && !muted) audio.volume = v;
    const pctStr = Math.round(v * 100) + '%';
    const icon   = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    document.getElementById('vol-pct').textContent    = pctStr;
    document.getElementById('mute-btn').textContent   = icon;
    const ev = document.getElementById('exp-vol-slider');
    if (ev) { ev.value = v; ev.style.background = `linear-gradient(to right,var(--accent2) ${v*100}%,var(--bg4) ${v*100}%)`; }
    const ep = document.getElementById('exp-vol-pct'); if (ep) ep.textContent = pctStr;
    const em = document.getElementById('exp-mute');    if (em) em.textContent = icon;
    updateVolSliderStyle();
    localStorage.setItem('volume', v);
}

/**
 * Populate the player UI with a song's info WITHOUT loading/playing audio.
 * Shows the seek bar at the saved progress position.
 */
function previewSongInPlayer(songName, progress, duration) {
    document.getElementById('player-song-name').textContent   = songName;
    document.getElementById('player-song-artist').textContent = qualityLabel();

    const expName   = document.getElementById('exp-name');
    const expArtist = document.getElementById('exp-artist');
    if (expName)   expName.textContent   = songName;
    if (expArtist) expArtist.textContent = qualityLabel();

    // Album art
    const savedThumb = (globalThis.thumbCache || new Map()).get(songName) || 'Img/music.png';
    document.getElementById('player-thumb').src = savedThumb;
    const et = document.getElementById('exp-thumb'); if (et) et.src = savedThumb;
    extractThumb(songName, url => {
        document.getElementById('player-thumb').src = url;
        const et2 = document.getElementById('exp-thumb'); if (et2) et2.src = url;
    });

    updateHeartBtn(songName);

    // Seek bar hint (visual only – no audio loaded yet)
    if (duration > 0) {
        const pct = (Math.min(progress, duration) / duration * 100).toFixed(2) + '%';
        document.getElementById('total-time').textContent  = fmt(duration);
        document.getElementById('curr-time').textContent   = fmt(progress);
        document.getElementById('seek-bar').max            = duration;
        document.getElementById('seek-bar').value          = progress;
        document.getElementById('seek-fill').style.width   = pct;

        const expTotal = document.getElementById('exp-total');
        const expBar   = document.getElementById('exp-seek-bar');
        const expCurr  = document.getElementById('exp-curr');
        const expFill  = document.getElementById('exp-seek-fill');
        if (expTotal) expTotal.textContent    = fmt(duration);
        if (expBar)   { expBar.max = duration; expBar.value = progress; }
        if (expCurr)  expCurr.textContent     = fmt(progress);
        if (expFill)  expFill.style.width      = pct;
    }
}

// ── Main play entry point ─────────────────────────────────────────
function play(songName) {
    closeSidebar();
    // If already in queue, jump to it; else insert after current
    let idx = queue.findIndex(s => s.name === songName);
    if (idx === -1) {
        const insertAt = queueIdx + 1;
        queue.splice(insertAt, 0, { name: songName });
        idx = insertAt;
    }
    queueIdx = idx;
    loadAndStart(songName);
    renderQueue();
    persist();
}

function loadAndStart(songName) {
    // ── Controller routing ──────────────────────────────────────────
    // If this is a local user action (not a received command, not state restore)
    // and this device is NOT the active player, send the song to the active device.
    const _isCmd    = typeof _receivingRemoteCmd !== 'undefined' && _receivingRemoteCmd;
    const _suppress = !!window._suppressBroadcast;
    if (!_isCmd && !_suppress &&
        typeof amIActiveDevice !== 'undefined' && !amIActiveDevice()) {
        const startTime = _pendingRestoreProgress || 0;
        _pendingRestoreProgress = 0;
        const activeId = typeof getActiveDeviceId !== 'undefined' ? getActiveDeviceId() : null;
        if (activeId && typeof sendRemoteCommand !== 'undefined')
            sendRemoteCommand(activeId, 'playSong', { songName, progress: startTime });
        return;   // controller does not play locally
    }

    // ── Active device: play locally ─────────────────────────────────
    // Claim the active role if this is a local user action
    if (!_isCmd && !_suppress && typeof activeDeviceId !== 'undefined')
        activeDeviceId = typeof myDeviceId !== 'undefined' ? myDeviceId : activeDeviceId;

    const tCache = globalThis.thumbCache || new Map();
    document.getElementById('player-song-name').textContent   = songName;
    document.getElementById('player-song-artist').textContent = qualityLabel();

    const expName   = document.getElementById('exp-name');
    const expArtist = document.getElementById('exp-artist');
    if (expName)   expName.textContent   = songName;
    if (expArtist) expArtist.textContent = qualityLabel();

    const savedThumb = tCache.get(songName) || 'Img/music.png';
    document.getElementById('player-thumb').src = savedThumb;
    const expThumb = document.getElementById('exp-thumb');
    if (expThumb) expThumb.src = savedThumb;

    extractThumb(songName, url => {
        document.getElementById('player-thumb').src = url;
        const et = document.getElementById('exp-thumb'); if (et) et.src = url;
        refreshMediaSession();
        renderQueue();
    });

    updateHeartBtn(songName);

    const path = buildSongUrl(songName);

    // Use and consume any pending restore progress
    const startTime = _pendingRestoreProgress || 0;
    _pendingRestoreProgress = 0;

    playSong(path, startTime);
    // No cluster broadcast – peers learn about the new song via ping state updates
}

// ── Queue actions ─────────────────────────────────────────────────
function addToQueue(songName) {
    queue.push({ name: songName });
    persist();
    renderQueue();
    showToast(`Added "${songName}" to queue`);
}

function playNext(songName) {
    const insertAt = queueIdx + 1;
    queue.splice(insertAt, 0, { name: songName });
    persist();
    renderQueue();
    showToast(`"${songName}" will play next`);
}

function removeFromQueue(idx) {
    if (idx === queueIdx) { nextSong(); return; }
    queue.splice(idx, 1);
    if (idx < queueIdx) queueIdx--;
    persist();
    renderQueue();
}

function clearQueue() {
    if (audio) { audio.pause(); audio.src = ''; playing = false; document.getElementById('play-pause-btn').innerHTML = '▶'; }
    queue    = [];
    queueIdx = -1;
    document.getElementById('player-song-name').textContent   = 'Not Playing';
    document.getElementById('player-song-artist').textContent = '—';
    document.getElementById('player-thumb').src = 'Img/music.png';
    persist();
    renderQueue();
}

function shuffleQueue() {
    if (queue.length < 2) return;
    // Keep current song in place, shuffle the rest
    const cur = queueIdx >= 0 ? queue.splice(queueIdx, 1)[0] : null;
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    if (cur) { queue.unshift(cur); queueIdx = 0; }
    persist();
    renderQueue();
    showToast('🔀 Queue shuffled');
}

function nextSong() {
    if (!queue.length) return;

    // Controller → forward to active device
    const _isCmd = typeof _receivingRemoteCmd !== 'undefined' && _receivingRemoteCmd;
    if (!_isCmd && typeof amIActiveDevice !== 'undefined' && !amIActiveDevice()) {
        const activeId = typeof getActiveDeviceId !== 'undefined' ? getActiveDeviceId() : null;
        if (activeId && typeof sendRemoteCommand !== 'undefined')
            sendRemoteCommand(activeId, 'next', {});
        return;
    }

    let next;
    if (shuffleOn) {
        next = Math.floor(Math.random() * queue.length);
    } else {
        next = queueIdx + 1;
        if (next >= queue.length) {
            if (loopMode === 1) next = 0;
            else return; // end of queue
        }
    }
    queueIdx = next;
    loadAndStart(queue[queueIdx].name);
    renderQueue();
    persist();
}

function prevSong() {
    if (!queue.length) return;

    // Controller → forward to active device
    const _isCmd = typeof _receivingRemoteCmd !== 'undefined' && _receivingRemoteCmd;
    if (!_isCmd && typeof amIActiveDevice !== 'undefined' && !amIActiveDevice()) {
        const activeId = typeof getActiveDeviceId !== 'undefined' ? getActiveDeviceId() : null;
        if (activeId && typeof sendRemoteCommand !== 'undefined')
            sendRemoteCommand(activeId, 'prev', {});
        return;
    }

    // If > 3s into song, restart; else go previous
    if (audio && audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    let prev = queueIdx - 1;
    if (prev < 0) prev = loopMode === 1 ? queue.length - 1 : 0;
    queueIdx = prev;
    loadAndStart(queue[queueIdx].name);
    renderQueue();
    persist();
}

// ── Playlist CRUD ─────────────────────────────────────────────────
function createPlaylist() {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;

    if (currentUser) {
        const fd = new URLSearchParams();
        fd.append('action', 'create');
        fd.append('name', name.trim());
        fetch('./playlists', { method: 'POST', body: fd, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.playlists) {
                    playlists = d.playlists.map(pl => ({
                        name: pl.name,
                        songs: (pl.songs || []).map(s => ({ name: typeof s === 'string' ? s : s.name }))
                    }));
                    renderSidebar();
                }
            });
    } else {
        playlists.push({ name: name.trim(), songs: [] });
        persist();
        renderSidebar();
    }
    showToast(`Created "${name.trim()}"`, 'ok');
}

function deletePlaylist(idx) {
    const pl = playlists[idx];
    if (!pl || !confirm(`Delete "${pl.name}"?`)) return;

    if (currentUser) {
        const fd = new URLSearchParams();
        fd.append('action', 'delete');
        fd.append('index', idx);
        fetch('./playlists', { method: 'POST', body: fd, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
            .then(r => r.json())
            .then(d => {
                if (d.success && d.playlists) {
                    playlists = d.playlists.map(pl => ({
                        name: pl.name,
                        songs: (pl.songs || []).map(s => ({ name: typeof s === 'string' ? s : s.name }))
                    }));
                    renderSidebar();
                    if (viewingPl === idx) showQueueView();
                }
            });
    } else {
        playlists.splice(idx, 1);
        persist();
        renderSidebar();
        if (viewingPl === idx) showQueueView();
    }
}

function addSongToPlaylist(plIdx, songName) {
    const pl = playlists[plIdx];
    if (!pl) return;
    if (pl.songs.some(s => s.name === songName)) {
        showToast('Already in playlist');
        return;
    }
    pl.songs.push({ name: songName });
    persist();
    if (viewingPl === plIdx) renderPlaylistView(plIdx);
    showToast(`Added to "${pl.name}"`, 'ok');
}

function removeSongFromPlaylist(plIdx, songIdx) {
    playlists[plIdx].songs.splice(songIdx, 1);
    persist();
    renderPlaylistView(plIdx);
}

// ── Favorites shortcut ────────────────────────────────────────────
function toggleFavorite() {
    if (!queue[queueIdx]) return;
    const name = queue[queueIdx].name;
    let favPl = playlists.find(p => p.name === 'My Favorites');
    if (!favPl) { favPl = { name: 'My Favorites', songs: [] }; playlists.unshift(favPl); }

    const idx = favPl.songs.findIndex(s => s.name === name);
    if (idx === -1) {
        favPl.songs.push({ name });
        showToast(`Added "${name}" to Favorites ❤`, 'ok');
    } else {
        favPl.songs.splice(idx, 1);
        showToast(`Removed from Favorites`);
    }
    persist();
    updateHeartBtn(name);
}

function updateHeartBtn(songName) {
    const favPl = playlists.find(p => p.name === 'My Favorites');
    const isFav = favPl && favPl.songs.some(s => s.name === songName);
    [document.getElementById('heart-btn'), document.getElementById('exp-heart')].forEach(btn => {
        if (!btn) return;
        btn.classList.toggle('fav', isFav);
        btn.textContent = isFav ? '♥' : '♡';
    });
}

// ── Load playlist to queue ────────────────────────────────────────
function loadPlaylistToQueue(idx) {
    const pl = playlists[idx];
    if (!pl || !pl.songs.length) { showToast('Playlist is empty'); return; }
    queue    = pl.songs.map(s => ({ name: s.name }));
    queueIdx = 0;
    loadAndStart(queue[0].name);
    renderQueue();
    persist();
    showQueueView();
}

function playCurrentPlaylist() {
    loadPlaylistToQueue(viewingPl);
}

function shuffleCurrentPlaylist() {
    const pl = playlists[viewingPl];
    if (!pl || !pl.songs.length) return;
    queue = [...pl.songs.map(s => ({ name: s.name }))];
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    queueIdx = 0;
    loadAndStart(queue[0].name);
    renderQueue();
    persist();
    showQueueView();
}

// ── Add-to-playlist modal ─────────────────────────────────────────
let pendingSong = null;

function showAddPl(songName) {
    pendingSong = songName;
    const list = document.getElementById('add-pl-list');
    list.innerHTML = '';
    playlists.forEach((pl, i) => {
        const d = document.createElement('div');
        d.className = 'pl-opt';
        d.innerHTML = `<div class="pl-opt-ico">♫</div><span>${escHtml(pl.name)} <small style="color:var(--text3)">(${pl.songs.length})</small></span>`;
        d.onclick = () => { addSongToPlaylist(i, songName); closeAddPl(); };
        list.appendChild(d);
    });
    document.getElementById('add-pl-modal').classList.remove('hidden');
}
function closeAddPl() {
    document.getElementById('add-pl-modal').classList.add('hidden');
    pendingSong = null;
}

// ── Views ─────────────────────────────────────────────────────────
function showQueueView() {
    document.getElementById('queue-view').style.display    = '';
    document.getElementById('playlist-view').style.display = 'none';
    viewingPl = -1;
    document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('active'));
}

function showPlaylistView(idx) {
    viewingPl = idx;
    document.getElementById('queue-view').style.display    = 'none';
    document.getElementById('playlist-view').style.display = '';
    renderPlaylistView(idx);
    document.querySelectorAll('.pl-item').forEach((el, i) => el.classList.toggle('active', i === idx));
}

// ── Render helpers ────────────────────────────────────────────────
function renderSidebar() {
    const list = document.getElementById('playlist-list');
    list.innerHTML = '';
    playlists.forEach((pl, i) => {
        const div = document.createElement('div');
        div.className = 'pl-item' + (viewingPl === i ? ' active' : '');
        div.innerHTML = `
            <div class="pl-ico">♫</div>
            <span class="pl-name">${escHtml(pl.name)}</span>
            <span class="pl-count">${pl.songs.length}</span>
            <button class="pl-del" onclick="event.stopPropagation();deletePlaylist(${i})" title="Delete">✕</button>
        `;
        div.onclick = () => showPlaylistView(i);
        list.appendChild(div);
    });
}

function renderQueue() {
    const tCache = globalThis.thumbCache || new Map();
    const container = document.getElementById('queue-list');
    if (!queue.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-ico">🎶</div>
                <p class="empty-title">Your queue is empty</p>
                <p class="empty-sub">Search for a song and hit play to get started.</p>
            </div>`;
        return;
    }
    container.innerHTML = '';
    queue.forEach((s, i) => {
        const isNow = i === queueIdx;
        const div   = document.createElement('div');
        div.className = 'q-item' + (isNow ? ' now-playing' : '');
        const thumb = tCache.get(s.name) || 'Img/music.png';
        div.innerHTML = `
            <span class="q-num">${i + 1}</span>
            <div class="q-now-ico"><div class="soundwave"><span></span><span></span><span></span></div></div>
            <img class="q-thumb" src="${thumb}" alt="">
            <div class="q-info">
                <p class="q-name">${escHtml(s.name)}</p>
                <p class="q-meta">FLAC</p>
            </div>
            <button class="q-remove" onclick="event.stopPropagation();removeFromQueue(${i})" title="Remove">✕</button>
        `;
        div.onclick = () => { queueIdx = i; loadAndStart(s.name); renderQueue(); persist(); };

        // Lazy-load thumbnail
        if (!tCache.has(s.name)) {
            extractThumb(s.name, url => {
                const img = div.querySelector('.q-thumb');
                if (img) img.src = url;
            });
        }

        container.appendChild(div);
    });

    // Scroll playing item into view
    const playing = container.querySelector('.now-playing');
    if (playing) playing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderPlaylistView(idx) {
    const tCache = globalThis.thumbCache || new Map();
    const pl = playlists[idx];
    if (!pl) return;
    document.getElementById('pl-view-title').textContent = pl.name;
    const list = document.getElementById('pl-songs-list');
    if (!pl.songs.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-ico">🎵</div><p class="empty-title">No songs yet</p><p class="empty-sub">Search for songs and use the "Add" button to build this playlist.</p></div>`;
        return;
    }
    list.innerHTML = '';
    pl.songs.forEach((s, i) => {
        const thumb = tCache.get(s.name) || 'Img/music.png';
        const div   = document.createElement('div');
        div.className = 'pl-song';
        div.innerHTML = `
            <span class="pl-song-num">${i + 1}</span>
            <img class="pl-song-thumb" src="${thumb}" alt="">
            <div class="pl-song-info">
                <p class="pl-song-name">${escHtml(s.name)}</p>
                <p class="pl-song-meta">FLAC</p>
            </div>
            <button class="pl-song-rem" onclick="event.stopPropagation();removeSongFromPlaylist(${idx},${i})" title="Remove">✕</button>
        `;
        div.onclick = () => play(s.name);

        if (!tCache.has(s.name)) {
            extractThumb(s.name, url => {
                const img = div.querySelector('.pl-song-thumb');
                if (img) img.src = url;
            });
        }

        list.appendChild(div);
    });
}
