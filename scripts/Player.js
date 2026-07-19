/* Player.js – Audio engine, EQ, Media Session, Keyboard shortcuts */

// ── State ────────────────────────────────────────────────────────
let audio        = null;
let playing      = false;
let muted        = false;
let prevVol      = 0.8;
let loopMode     = 0;       // 0=none 1=queue 2=single
let shuffleOn    = false;
let isSeeking    = false;
let crossfadeSec = 0;
let speedVal     = 1;
const SKIP_AMT   = 10;

// ── Web Audio API EQ ─────────────────────────────────────────────
let audioCtx  = null;
let gainNode  = null;
let eqNodes   = [];
let srcNode   = null;

const EQ_BANDS = [
    { id:'eq-60',  freq:60,    type:'lowshelf'  },
    { id:'eq-250', freq:250,   type:'peaking'   },
    { id:'eq-1k',  freq:1000,  type:'peaking'   },
    { id:'eq-4k',  freq:4000,  type:'peaking'   },
    { id:'eq-16k', freq:16000, type:'highshelf' },
];

const EQ_PRESETS = {
    flat:       [ 0,  0,  0,  0,  0],
    bassboost:  [ 8,  5,  0, -1, -2],
    treble:     [-2, -1,  0,  4,  7],
    pop:        [ 2,  3,  4,  2, -1],
    rock:       [ 6,  4, -1,  3,  5],
    electronic: [ 5,  4,  0,  4,  5],
    classical:  [ 4,  2,  0,  2,  4],
    vocal:      [-2,  0,  4,  4, -1],
};

// Thumbnail cache shared across scripts (Search/Playlist/Player)
const thumbCache = globalThis.thumbCache || new Map();
globalThis.thumbCache = thumbCache;

// ── Audio Context Init ────────────────────────────────────────────
function ensureAudioCtx() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();

    eqNodes = EQ_BANDS.map(b => {
        const n = audioCtx.createBiquadFilter();
        n.type = b.type;
        n.frequency.value = b.freq;
        n.gain.value = 0;
        n.Q.value = 1.4;
        return n;
    });

    // Chain: src → eq[0] → eq[1] → … → gain → destination
    eqNodes.forEach((n, i) => {
        if (i > 0) eqNodes[i - 1].connect(n);
    });
    eqNodes[eqNodes.length - 1].connect(gainNode);
    gainNode.connect(audioCtx.destination);
}

function connectSrc(audioEl) {
    ensureAudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    if (srcNode) { try { srcNode.disconnect(); } catch (_) {} }
    srcNode = audioCtx.createMediaElementSource(audioEl);
    srcNode.connect(eqNodes[0]);
}

// ── Core Play ─────────────────────────────────────────────────────
function playSong(path) {
    if (audio) {
        audio.pause();
        audio.src = '';
    }

    audio = new Audio(path);
    audio.crossOrigin = 'anonymous';
    audio.volume      = muted ? 0 : (parseFloat(document.getElementById('volume-slider').value) || 0.8);
    audio.playbackRate = speedVal;

    audio.addEventListener('loadedmetadata', () => {
        const dur = audio.duration;
        document.getElementById('total-time').textContent = fmt(dur);
        document.getElementById('seek-bar').max = dur;
        const expTotal = document.getElementById('exp-total');
        const expBar   = document.getElementById('exp-seek-bar');
        if (expTotal) expTotal.textContent = fmt(dur);
        if (expBar)   expBar.max = dur;
        playing = true;
        updatePlayBtn();
        refreshMediaSession();
    });

    audio.addEventListener('timeupdate', () => {
        if (!isSeeking) updateSeekUI();
    });

    audio.addEventListener('ended', () => {
        if (loopMode === 2) {
            audio.currentTime = 0;
            audio.play();
        } else {
            nextSong();
        }
    });

    // Crossfade: start fading out a bit before end
    audio.addEventListener('timeupdate', () => {
        if (crossfadeSec > 0 && audio.duration - audio.currentTime < crossfadeSec) {
            const fade = (audio.duration - audio.currentTime) / crossfadeSec;
            gainNode && (gainNode.gain.value = Math.max(0, fade));
        } else if (gainNode && gainNode.gain.value < 1) {
            gainNode.gain.value = 1;
        }
    });

    try {
        connectSrc(audio);
    } catch (e) {
        // AudioContext not supported — playback still works without EQ
        console.warn('AudioContext unavailable:', e);
    }

    audio.play().catch(e => console.warn('Playback blocked:', e));
}

// ── Play Control ──────────────────────────────────────────────────
function swapPlayStatusAndUpdate() {
    if (!audio) return;
    playing = !playing;
    updatePlayBtn();
}

function updatePlayBtn() {
    const icon = playing ? '⏸' : '▶';
    document.getElementById('play-pause-btn').innerHTML = icon;
    const expPP = document.getElementById('exp-pp');
    if (expPP) expPP.innerHTML = icon;
    if (playing) {
        audio.play().catch(() => {});
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    } else {
        audio.pause();
        if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    }
}

// ── Seek ──────────────────────────────────────────────────────────
function onSeekInput() {
    isSeeking = true;
    updateSeekUI();
}

function onSeekChange() {
    if (!audio) return;
    audio.currentTime = parseFloat(document.getElementById('seek-bar').value);
    isSeeking = false;
    updateSeekUI();
}

// Expanded player seek
function onExpSeekInput() {
    isSeeking = true;
    const val = document.getElementById('exp-seek-bar').value;
    document.getElementById('seek-bar').value = val; // keep mini bar in sync while dragging
    updateSeekUI();
}

function onExpSeekChange() {
    if (!audio) return;
    audio.currentTime = parseFloat(document.getElementById('exp-seek-bar').value);
    isSeeking = false;
    updateSeekUI();
}

function updateSeekUI() {
    if (!audio) return;
    const cur = isSeeking
        ? parseFloat(document.getElementById('seek-bar').value)
        : audio.currentTime;
    const dur = audio.duration || 1;
    const pct = (cur / dur * 100).toFixed(2) + '%';
    const fmtCur = fmt(cur);

    document.getElementById('curr-time').textContent = fmtCur;
    document.getElementById('seek-fill').style.width = pct;
    if (!isSeeking) document.getElementById('seek-bar').value = cur;

    // Expanded player
    const expFill = document.getElementById('exp-seek-fill');
    const expBar  = document.getElementById('exp-seek-bar');
    const expCurr = document.getElementById('exp-curr');
    if (expFill) expFill.style.width = pct;
    if (expBar && !isSeeking) expBar.value = cur;
    if (expCurr) expCurr.textContent = fmtCur;
}

function skip(secs) {
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + secs));
    updateSeekUI();
}

// ── Volume ────────────────────────────────────────────────────────
function setVolume() {
    const v = parseFloat(document.getElementById('volume-slider').value);
    if (audio && !muted) audio.volume = v;
    const pctStr = Math.round(v * 100) + '%';
    const icon   = v === 0 ? '🔇' : v < 0.5 ? '🔉' : '🔊';
    document.getElementById('vol-pct').textContent = pctStr;
    document.getElementById('mute-btn').textContent = icon;
    // Expanded
    const ev = document.getElementById('exp-vol-slider');
    if (ev) { ev.value = v; ev.style.background = `linear-gradient(to right, var(--accent2) ${v*100}%, var(--bg4) ${v*100}%)`; }
    const ep = document.getElementById('exp-vol-pct'); if (ep) ep.textContent = pctStr;
    const em = document.getElementById('exp-mute');    if (em) em.textContent = icon;
    updateVolSliderStyle();
    localStorage.setItem('volume', v);
}

function syncVolFromExp(val) {
    document.getElementById('volume-slider').value = val;
    setVolume();
}

function toggleMute() {
    muted = !muted;
    if (muted) {
        prevVol = parseFloat(document.getElementById('volume-slider').value);
        if (audio) audio.volume = 0;
        document.getElementById('mute-btn').textContent = '🔇';
        const em = document.getElementById('exp-mute'); if (em) em.textContent = '🔇';
    } else {
        if (audio) audio.volume = prevVol;
        document.getElementById('mute-btn').textContent = '🔊';
        const em = document.getElementById('exp-mute'); if (em) em.textContent = '🔊';
    }
}

function updateVolSliderStyle() {
    const s   = document.getElementById('volume-slider');
    const pct = s.value * 100;
    const bg  = `linear-gradient(to right, var(--accent2) ${pct}%, var(--bg4) ${pct}%)`;
    s.style.background = bg;
    const ev = document.getElementById('exp-vol-slider');
    if (ev) ev.style.background = bg;
}

// ── Loop & Shuffle ────────────────────────────────────────────────
function cycleLoopMode() {
    loopMode = (loopMode + 1) % 3;
    const setLoop = (btn) => {
        if (!btn) return;
        if (loopMode === 0) { btn.textContent = '🔁'; btn.classList.remove('on'); btn.title = 'No Loop'; }
        else if (loopMode === 1) { btn.textContent = '🔁'; btn.classList.add('on'); btn.title = 'Loop Queue'; }
        else  { btn.textContent = '🔂'; btn.classList.add('on'); btn.title = 'Loop Song'; }
    };
    setLoop(document.getElementById('loop-btn'));
    setLoop(document.getElementById('exp-loop'));
    localStorage.setItem('loopMode', loopMode);
}

function toggleShuffle() {
    shuffleOn = !shuffleOn;
    document.getElementById('shuffle-btn').classList.toggle('on', shuffleOn);
    const es = document.getElementById('exp-shuffle'); if (es) es.classList.toggle('on', shuffleOn);
    showToast(shuffleOn ? '🔀 Shuffle on' : 'Shuffle off');
    localStorage.setItem('shuffle', shuffleOn);
}

// ── Speed & Crossfade ─────────────────────────────────────────────
function setSpeed() {
    speedVal = parseFloat(document.getElementById('speed-slider').value);
    if (audio) audio.playbackRate = speedVal;
    document.getElementById('speed-val').textContent = speedVal.toFixed(2) + 'x';
    localStorage.setItem('speed', speedVal);
}

function setCrossfade() {
    crossfadeSec = parseFloat(document.getElementById('crossfade-slider').value);
    document.getElementById('crossfade-val').textContent = crossfadeSec.toFixed(1) + 's';
    localStorage.setItem('crossfade', crossfadeSec);
}

// ── EQ ────────────────────────────────────────────────────────────
function updateEQ() {
    EQ_BANDS.forEach((b, i) => {
        const v = parseFloat(document.getElementById(b.id).value);
        document.getElementById(b.id + '-val').textContent = (v >= 0 ? '+' : '') + v + 'dB';
        if (eqNodes[i]) eqNodes[i].gain.value = v;
    });
    localStorage.setItem('eq', JSON.stringify(EQ_BANDS.map(b => document.getElementById(b.id).value)));
    // Remove active from all presets
    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('on'));
}

function applyPreset(name) {
    const vals = EQ_PRESETS[name] || EQ_PRESETS.flat;
    EQ_BANDS.forEach((b, i) => {
        document.getElementById(b.id).value = vals[i];
    });
    updateEQ();
    document.querySelectorAll('.preset-btn').forEach(b => {
        b.classList.toggle('on', b.dataset.preset === name);
    });
    localStorage.setItem('eqPreset', name);
}

function loadSavedEQ() {
    const saved = localStorage.getItem('eq');
    if (saved) {
        try {
            const vals = JSON.parse(saved);
            EQ_BANDS.forEach((b, i) => { document.getElementById(b.id).value = vals[i] ?? 0; });
            updateEQ();
            const preset = localStorage.getItem('eqPreset');
            if (preset) {
                document.querySelectorAll('.preset-btn').forEach(b => {
                    b.classList.toggle('on', b.dataset.preset === preset);
                });
            }
        } catch (_) {}
    }
}

// ── User Preferences ─────────────────────────────────────────────
const PREFS = {
    thumbs:       true,
    mediasession: true,
    quality:      'high',   // high | medium | low
};

// Build the URL used to load a song, respecting quality preference
function buildSongUrl(songName) {
    if (PREFS.quality === 'high') {
        return './Songs/' + encodeURIComponent(songName) + '.flac';
    }
    return './stream?name=' + encodeURIComponent(songName) + '&quality=' + PREFS.quality;
}

// Human-readable format label shown next to song artist
function qualityLabel() {
    if (PREFS.quality === 'medium') return 'Opus 128k';
    if (PREFS.quality === 'low')    return 'Opus 64k';
    return 'FLAC';
}

function savePref(key, value) {
    PREFS[key] = value;
    localStorage.setItem('pref_' + key, value);

    if (key === 'thumbs' && !value) {
        for (const [k, v] of thumbCache) {
            if (v !== 'Img/music.png') thumbCache.delete(k);
        }
        document.getElementById('player-thumb').src = 'Img/music.png';
    }
    if (key === 'thumbs' && value && queue[queueIdx]) {
        extractThumb(queue[queueIdx].name, url => {
            document.getElementById('player-thumb').src = url;
        });
    }

    if (key === 'mediasession' && !value) {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = null;
            navigator.mediaSession.playbackState = 'none';
        }
    }
    if (key === 'mediasession' && value && audio) {
        refreshMediaSession();
    }

    if (key === 'quality') {
        const el = document.getElementById('quality-select');
        if (el) el.value = value;
        // Update format badge in player if a song is loaded
        if (queue[queueIdx]) {
            document.getElementById('player-song-artist').textContent = qualityLabel();
        }
        showToast('Quality: ' + qualityLabel());
    }
}

function loadPrefs() {
    ['thumbs', 'mediasession'].forEach(k => {
        const saved = localStorage.getItem('pref_' + k);
        if (saved !== null) PREFS[k] = saved === 'true';
        const el = document.getElementById('pref-' + k);
        if (el) el.checked = PREFS[k];
    });
    const savedQ = localStorage.getItem('pref_quality');
    if (savedQ) PREFS.quality = savedQ;
    const qEl = document.getElementById('quality-select');
    if (qEl) qEl.value = PREFS.quality;
}

// ── Thumbnail Extraction (native FLAC PICTURE block parser) ──────
// Calls cb(dataURL | 'Img/music.png') asynchronously.
function extractThumb(songName, cb) {
    if (thumbCache.has(songName)) { cb(thumbCache.get(songName)); return; }

    // If user disabled album art, use default immediately and cache it
    if (!PREFS.thumbs) {
        thumbCache.set(songName, 'Img/music.png');
        cb('Img/music.png');
        return;
    }

    const url = './Songs/' + encodeURIComponent(songName) + '.flac';

    fetch(url, { headers: { 'Range': 'bytes=0-524287' } })   // first 512 KB covers all metadata
        .then(r => (r.ok || r.status === 206) ? r.arrayBuffer() : Promise.reject())
        .then(buf => {
            const pic = parseFlacPicture(buf);
            const result = pic || 'Img/music.png';
            thumbCache.set(songName, result);
            cb(result);
        })
        .catch(() => {
            thumbCache.set(songName, 'Img/music.png');
            cb('Img/music.png');
        });
}

// Parse the FLAC metadata blocks and return a data-URL for the first
// embedded PICTURE block, or null if none found.
function parseFlacPicture(buffer) {
    const u8   = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // FLAC magic: f L a C  (0x66 4C 61 43)
    if (u8[0] !== 0x66 || u8[1] !== 0x4C || u8[2] !== 0x61 || u8[3] !== 0x43) return null;

    let offset = 4;
    while (offset + 4 <= buffer.byteLength) {
        const hdr      = view.getUint8(offset);
        const isLast   = (hdr & 0x80) !== 0;
        const blockType = hdr & 0x7F;
        const blockLen = (view.getUint8(offset + 1) << 16) |
                         (view.getUint8(offset + 2) <<  8) |
                          view.getUint8(offset + 3);
        offset += 4;

        if (blockType === 6) {   // METADATA_BLOCK_PICTURE
            let p = offset;

            p += 4;  // picture type (e.g. 3 = front cover)

            const mimeLen = view.getUint32(p, false); p += 4;
            const mime    = new TextDecoder().decode(u8.subarray(p, p + mimeLen)); p += mimeLen;

            const descLen = view.getUint32(p, false); p += 4;
            p += descLen;   // skip description

            p += 16;  // skip width (4) + height (4) + color depth (4) + num-colors (4)

            const dataLen = view.getUint32(p, false); p += 4;

            if (p + dataLen <= buffer.byteLength) {
                const bytes = u8.subarray(p, p + dataLen);
                // btoa in chunks to avoid call-stack overflow on large images
                const CHUNK = 8192;
                let binary = '';
                for (let i = 0; i < bytes.length; i += CHUNK) {
                    binary += String.fromCharCode.apply(
                        null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
                    );
                }
                return `data:${mime};base64,${btoa(binary)}`;
            }
        }

        if (isLast || offset + blockLen > buffer.byteLength) break;
        offset += blockLen;
    }
    return null;
}

// ── Media Session ─────────────────────────────────────────────────
function refreshMediaSession() {
    if (!PREFS.mediasession) return;
    if (!('mediaSession' in navigator) || queueIdx < 0 || !queue[queueIdx]) return;
    const song = queue[queueIdx];
    const thumb = thumbCache.get(song.name) || 'Img/music.png';

    navigator.mediaSession.metadata = new MediaMetadata({
        title:   song.name,
        artist:  'OurMusic',
        album:   '',
        artwork: [{ src: thumb, sizes: '512x512', type: 'image/jpeg' }]
    });
    navigator.mediaSession.setActionHandler('play',          () => { playing = true;  updatePlayBtn(); });
    navigator.mediaSession.setActionHandler('pause',         () => { playing = false; updatePlayBtn(); });
    navigator.mediaSession.setActionHandler('previoustrack', prevSong);
    navigator.mediaSession.setActionHandler('nexttrack',     nextSong);
    navigator.mediaSession.setActionHandler('seekbackward',  d  => skip(-(d.seekOffset || SKIP_AMT)));
    navigator.mediaSession.setActionHandler('seekforward',   d  => skip(d.seekOffset  || SKIP_AMT));
    navigator.mediaSession.setActionHandler('seekto',        d  => { if (audio) { audio.currentTime = d.seekTime; updateSeekUI(); } });
}

// ── Helpers ───────────────────────────────────────────────────────
function fmt(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// ── Expanded player open / close ─────────────────────────────────
function openPlayerExp() {
    document.getElementById('player-exp').classList.add('open');
}
function closePlayerExp() {
    document.getElementById('player-exp').classList.remove('open');
}
function openSettings() {
    document.getElementById('settings-modal').classList.remove('hidden');
    document.getElementById('eq-btn').classList.add('on');
}
function closeSettings() {
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('eq-btn').classList.remove('on');
}

// ── Sidebar toggle (mobile) ───────────────────────────────────────
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sb-overlay').classList.add('on');
}
function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sb-overlay').classList.remove('on');
}

// ── Toast ─────────────────────────────────────────────────────────
function showToast(msg, type = '') {
    const box   = document.getElementById('toast-box');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = msg;
    box.appendChild(toast);
    setTimeout(() => toast.remove(), 3100);
}

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
        case ' ':          e.preventDefault(); if (audio) swapPlayStatusAndUpdate(); break;
        case 'ArrowRight': e.preventDefault(); skip(SKIP_AMT);       break;
        case 'ArrowLeft':  e.preventDefault(); skip(-SKIP_AMT);      break;
        case 'ArrowUp':    e.preventDefault(); adjustVol(0.05);      break;
        case 'ArrowDown':  e.preventDefault(); adjustVol(-0.05);     break;
        case 'n': case 'N': nextSong(); break;
        case 'p': case 'P': prevSong(); break;
        case 'm': case 'M': toggleMute(); break;
        case 'l': case 'L': cycleLoopMode(); break;
        case 's': case 'S': toggleShuffle(); break;
    }
});

function adjustVol(delta) {
    const s = document.getElementById('volume-slider');
    s.value = Math.max(0, Math.min(1, parseFloat(s.value) + delta));
    setVolume();
}

// ── DOMContentLoaded init ─────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Volume
    const vol = localStorage.getItem('volume') ?? '0.8';
    document.getElementById('volume-slider').value = vol;
    setVolume();

    // Loop
    const saved = parseInt(localStorage.getItem('loopMode') || '0');
    if (saved > 0) { loopMode = saved - 1; cycleLoopMode(); }

    // Shuffle
    if (localStorage.getItem('shuffle') === 'true') {
        shuffleOn = false; toggleShuffle();
    }

    // Speed
    const sp = parseFloat(localStorage.getItem('speed') || '1');
    document.getElementById('speed-slider').value = sp;
    speedVal = sp;
    document.getElementById('speed-val').textContent = sp.toFixed(2) + 'x';

    // Crossfade
    const cf = parseFloat(localStorage.getItem('crossfade') || '0');
    document.getElementById('crossfade-slider').value = cf;
    crossfadeSec = cf;
    document.getElementById('crossfade-val').textContent = cf.toFixed(1) + 's';

    // EQ
    loadSavedEQ();

    // User prefs (must be last so checkboxes exist)
    loadPrefs();

    // ── Mobile: tap mini-player → expand; swipe down → close ─────
    document.getElementById('player').addEventListener('click', e => {
        if (window.innerWidth > 768) return;
        if (e.target.closest('button') || e.target.closest('input')) return;
        openPlayerExp();
    });

    const exp = document.getElementById('player-exp');
    let _ty0 = 0;
    exp.addEventListener('touchstart', e => { _ty0 = e.touches[0].clientY; }, { passive: true });
    exp.addEventListener('touchend',   e => {
        if (e.changedTouches[0].clientY - _ty0 > 72) closePlayerExp();
    }, { passive: true });
});

