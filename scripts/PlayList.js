let playLists = JSON.parse(localStorage.getItem("playlists")) || [{ name: "My Favorites", songs: [] }];
let queue = JSON.parse(localStorage.getItem("queue")) || [];
let currentIndex = -1;

document.addEventListener("DOMContentLoaded", () => {
    updateInUI();
});

function addToPlaylist(plIndex, songName, imgPath) {
    const exists = playLists[plIndex].songs.some(s => s.name === songName);
    if (!exists) {
        playLists[plIndex].songs.push({ name: songName, thumbnail: imgPath });
        updateLocalStorage();
        updateInUI();
    }
}

function updateInUI() {
    const playlistContainer = document.querySelector(".playlists");
    playlistContainer.innerHTML = ""; 
    playLists.forEach((pl, index) => {
        const plDiv = document.createElement("div");
        plDiv.className = "playlist-item";
        plDiv.innerHTML = `
            <span onclick="loadPlaylistToQueue(${index})">▶ ${pl.name} (${pl.songs.length})</span>
            <button onclick="viewPlaylist(${index})">View</button>
        `;
        playlistContainer.appendChild(plDiv);
    });

    const queueContainer = document.querySelector(".queue");
    queueContainer.innerHTML = "<h3>Next Up</h3>";
    queue.forEach((s, index) => {
        const qDiv = document.createElement("div");
        qDiv.className = `queue-item ${index === currentIndex ? 'active' : ''}`;
        qDiv.innerHTML = `
            <img src="${s.thumbnail}" width="40">
            <div>
                <p>${s.name}</p>
            </div>
        `;
        qDiv.onclick = () => {
            currentIndex = index;
            play(s.name, s.thumbnail);
        };
        queueContainer.appendChild(qDiv);
    });
}

function updateLocalStorage() {
    localStorage.setItem("playlists", JSON.stringify(playLists));
    localStorage.setItem("queue", JSON.stringify(queue));
}

function createPlaylist() {
    const name = prompt("Enter playlist name:");
    if (name && name.trim() !== "") {
        playLists.push({ name: name, songs: [] });
        updateLocalStorage();
        updateInUI();
    }
}

function shuffleQueue() {
    if (queue.length < 2) return;
    
    for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    
    currentIndex = 0;
    updateInUI();

    const first = queue[0];
    play(first.name, first.thumbnail);
}

function viewPlaylist(index) {
    const pl = playLists[index];
    const songsDiv = document.getElementById("search-result");
    document.getElementById("search").focus();
    songsDiv.innerHTML = `<h3>${pl.name}</h3>`;
    
    if (pl.songs.length === 0) {
        songsDiv.innerHTML += "<p>This playlist is empty.</p>";
        return;
    }

    pl.songs.forEach((song) => {
        let songDiv = document.createElement("div");
        songDiv.classList.add("song-desc");
        songDiv.innerHTML = `
            <img height="40px" width="40px" src="${song.thumbnail}">
            <p>${song.name}</p>
        `;
        songDiv.onclick = () => play(song.name, song.thumbnail);
        songsDiv.appendChild(songDiv);
    });
}

function addToSpecificPlaylist(plIndex, songName, imgPath) {
    const targetPlaylist = playLists[plIndex];
    
    const alreadyExists = targetPlaylist.songs.some(s => s.name === songName);
    
    if (!alreadyExists) {
        targetPlaylist.songs.push({
            name: songName,
            thumbnail: imgPath
        });
        
        updateLocalStorage();
        updateInUI();
        alert(`Added ${songName} to ${targetPlaylist.name}`);
    } else {
        alert("Song is already in this playlist!");
    }
}