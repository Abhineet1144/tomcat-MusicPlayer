/* Search.js – Real-time search with thumbnail extraction */

let searchDebounce = null;
let lastQuery      = '';

// ── Event handlers ────────────────────────────────────────────────
function handleSearch(val) {
    document.getElementById('search-clear').classList.toggle('visible', val.length > 0);
    clearTimeout(searchDebounce);
    if (!val.trim()) { closeSearch(); return; }
    searchDebounce = setTimeout(() => doSearch(val.trim()), 250);
}

function onSearchFocus() {
    const val = document.getElementById('search-input').value.trim();
    if (val) doSearch(val);
}

function clearSearch() {
    document.getElementById('search-input').value = '';
    document.getElementById('search-clear').classList.remove('visible');
    lastQuery = '';
    closeSearch();
}

function closeSearch() {
    document.getElementById('search-results').classList.remove('open');
    document.getElementById('search-results').innerHTML = '';
}

// Close on outside click
document.addEventListener('click', e => {
    if (!e.target.closest('.search-container')) closeSearch();
});

// ── Fetch ──────────────────────────────────────────────────────────
function doSearch(query) {
    lastQuery = query;   // always update so stale-check works

    const box = document.getElementById('search-results');
    box.innerHTML = '<p class="sr-empty">Searching…</p>';
    box.classList.add('open');

    fetch('./search?name=' + encodeURIComponent(query))
        .then(r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(songs => {
            if (query !== lastQuery) return; // superseded
            renderResults(songs, box);
        })
        .catch(err => {
            console.error('[Search] fetch/parse error:', err);
            if (query === lastQuery) {
                box.innerHTML = '<p class="sr-empty">Search failed – check the console (F12).</p>';
            }
        });
}

// ── Render ─────────────────────────────────────────────────────────
function renderResults(songs, box) {
    box.innerHTML = '';

    if (!Array.isArray(songs) || songs.length === 0) {
        box.innerHTML = '<p class="sr-empty">No songs found.</p>';
        return;
    }

    songs.forEach(song => {
        const name = (song.name || '').trim();
        if (!name) return;

        const div = document.createElement('div');
        div.className = 'sr-item';

        // ── Build HTML without any interpolated onclick (avoids & / ' issues) ──
        div.innerHTML = `
            <img class="sr-thumb" src="Img/music.png" alt="">
            <div class="sr-info">
                <p class="sr-name">${escHtml(name)}</p>
                <p class="sr-meta">FLAC</p>
            </div>
            <div class="sr-actions">
                <button class="sr-act-btn" data-act="play"  title="Play now">▶</button>
                <button class="sr-act-btn" data-act="next"  title="Play next">⏭</button>
                <button class="sr-act-btn" data-act="queue" title="Add to queue">＋</button>
                <button class="sr-act-btn" data-act="addpl" title="Add to playlist">♫</button>
            </div>
        `;

        // ── Wire up events via addEventListener (no HTML attribute injection) ──
        div.querySelector('.sr-info').addEventListener('click',  () => { play(name); closeSearch(); });
        div.querySelector('.sr-thumb').addEventListener('click', () => { play(name); closeSearch(); });

        div.querySelectorAll('.sr-act-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const act = btn.dataset.act;
                if      (act === 'play')  { play(name);       closeSearch(); }
                else if (act === 'next')  { playNext(name);   showToast(`"${name}" plays next`); }
                else if (act === 'queue') { addToQueue(name); }
                else if (act === 'addpl') { showAddPl(name);  }
            });
        });

        // Lazy-load real album art from FLAC metadata
        const img = div.querySelector('.sr-thumb');
        if (thumbCache.has(name)) {
            img.src = thumbCache.get(name);
        } else {
            extractThumb(name, url => { if (img) img.src = url; });
        }

        box.appendChild(div);
    });
}

// ── Helpers ───────────────────────────────────────────────────────
// Escape for HTML attributes (single-quoted)
function esc(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
