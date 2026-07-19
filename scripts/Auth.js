/* Auth.js – Login / Register / Session management */

let currentUser = null; // null = guest

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    // Allow Enter key on auth forms
    ['login-user','login-pass'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') doLogin();
        });
    });
    ['reg-user','reg-pass'].forEach(id => {
        document.getElementById(id).addEventListener('keydown', e => {
            if (e.key === 'Enter') doRegister();
        });
    });
});

function checkSession() {
    fetch('./auth')
        .then(r => r.json())
        .then(data => {
            if (data.loggedIn) {
                currentUser = data.username;
                onLoggedIn();
            } else {
                showAuthModal();
            }
        })
        .catch(() => {
            // Server unreachable – fall back to guest
            continueAsGuest();
        });
}

// ── UI helpers ───────────────────────────────────────────────────
function showAuthModal() {
    document.getElementById('auth-modal').classList.remove('hidden');
}
function hideAuthModal() {
    document.getElementById('auth-modal').classList.add('hidden');
}

function showAuthTab(tab) {
    const isLogin = tab === 'login';
    document.getElementById('login-form').style.display    = isLogin ? '' : 'none';
    document.getElementById('register-form').style.display = isLogin ? 'none' : '';
    document.getElementById('login-tab-btn').classList.toggle('on', isLogin);
    document.getElementById('reg-tab-btn').classList.toggle('on', !isLogin);
    document.getElementById('login-err').textContent = '';
    document.getElementById('reg-err').textContent   = '';
}

// ── Actions ──────────────────────────────────────────────────────
function doLogin() {
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    document.getElementById('login-err').textContent = '';

    if (!u || !p) {
        document.getElementById('login-err').textContent = 'Please fill in all fields.';
        return;
    }

    const fd = new URLSearchParams();
    fd.append('action', 'login');
    fd.append('username', u);
    fd.append('password', p);

    fetch('./auth', { method: 'POST', body: fd, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                currentUser = data.username;
                onLoggedIn();
            } else {
                document.getElementById('login-err').textContent = data.error || 'Login failed.';
            }
        })
        .catch(() => {
            document.getElementById('login-err').textContent = 'Server error. Try again.';
        });
}

function doRegister() {
    const u = document.getElementById('reg-user').value.trim();
    const p = document.getElementById('reg-pass').value;
    document.getElementById('reg-err').textContent = '';

    if (!u || !p) {
        document.getElementById('reg-err').textContent = 'Please fill in all fields.';
        return;
    }

    const fd = new URLSearchParams();
    fd.append('action', 'register');
    fd.append('username', u);
    fd.append('password', p);

    fetch('./auth', { method: 'POST', body: fd, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                currentUser = data.username;
                onLoggedIn();
            } else {
                document.getElementById('reg-err').textContent = data.error || 'Registration failed.';
            }
        })
        .catch(() => {
            document.getElementById('reg-err').textContent = 'Server error. Try again.';
        });
}

function doLogout() {
    const fd = new URLSearchParams();
    fd.append('action', 'logout');
    fetch('./auth', { method: 'POST', body: fd, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(() => {
            currentUser = null;
            showToast('Logged out');
            renderUserArea();
            // Reset playlists to guest (localStorage)
            loadPlaylists();
        });
}

function continueAsGuest() {
    currentUser = null;
    hideAuthModal();
    renderUserArea();
    loadPlaylists();
}

// ── Post-login ───────────────────────────────────────────────────
function onLoggedIn() {
    hideAuthModal();
    renderUserArea();
    loadPlaylists(); // Load server playlists
    showToast(`Welcome, ${currentUser}! 🎵`, 'ok');
}

function renderUserArea() {
    const area = document.getElementById('sidebar-user-area');
    if (currentUser) {
        const initial = currentUser.charAt(0).toUpperCase();
        area.innerHTML = `
            <div class="user-card">
                <div class="user-avatar">${initial}</div>
                <span class="user-name">${escHtml(currentUser)}</span>
                <button class="logout-btn" onclick="doLogout()" title="Logout">⏏</button>
            </div>`;
    } else {
        area.innerHTML = `
            <button class="login-cta" onclick="showAuthModal()">Login / Register</button>`;
    }
}

function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

