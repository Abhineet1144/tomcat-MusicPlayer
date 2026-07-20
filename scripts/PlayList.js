/* PlayList.js – Queue management, Playlist CRUD, Server sync */

// ── State ─────────────────────────────────────────────────────────
let queue     = [];   // [{name}]
let queueIdx  = -1;
let playlists = [];   // [{name, songs:[{name}]}]
let viewingPl = -1;   // playlist index currently shown in detail view

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
                // Restore queue
                const sq = localStorage.getItem('queue');
                if (sq) try { queue = JSON.parse(sq); queueIdx = parseInt(localStorage.getItem('queueIdx') ?? '-1'); } catch (_) {}
                renderQueue();
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
        // Sync to server (debounced)
        clearTimeout(persist._t);
        persist._t = setTimeout(syncToServer, 1200);
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
    playSong(path);
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

