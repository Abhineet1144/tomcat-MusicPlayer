function search(name) {
    document.getElementById("search-result").style.display = "flex";
    if (!name) {
        document.getElementById("search-result").innerHTML = "";
        return;
    }

    fetch("./search?name=" + name)
    .then(res => res.json())
    .then(songs => {
        let songsDiv = document.getElementById("search-result");
        songsDiv.innerHTML = "";
        
        songs.forEach((song) => {
            let songDiv = document.createElement("div");
            songDiv.classList.add("song-item");
            
            songDiv.innerHTML = `
                <div class="song-info" onclick="play('${song.name}', '${song.thumbnail}')">
                    <img height="50px" width="50px" src="${song.thumbnail}" alt="thumbnail">
                    <p>${song.name}</p>
                    <div class="playlist-selector">
                        <button class="add-btn">Add to +</button>
                        <div class="playlist-dropdown" style="display:none;">
                            ${playLists.map((pl, index) => 
                                `<div onclick="addToSpecificPlaylist(${index}, '${song.name}', '${song.thumbnail}')">${pl.name}</div>`
                            ).join('')}
                        </div>
                    </div>
                </div>
            `;

            const addBtn = songDiv.querySelector(".add-btn");
            const dropdown = songDiv.querySelector(".playlist-dropdown");
            addBtn.onclick = (e) => {
                e.stopPropagation();
                document.querySelectorAll('.playlist-dropdown').forEach(d => d.style.display = 'none');
                dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
            };

            songsDiv.appendChild(songDiv);
        });
    });
}

function play(songName, imgPath) {
    const songIndex = queue.findIndex(s => s.name === songName);
    if (songIndex === -1) {
        queue.push({ name: songName, thumbnail: imgPath });
        currentIndex = queue.length - 1;
    } else {
        currentIndex = songIndex;
    }

    let path = "./Songs/" + songName + ".flac";
    document.getElementById("song-thumbnail").src = imgPath;
    document.getElementById("song-name").innerText = songName;
    
    updateLocalStorage();
    updateInUI();
    playSong(path);
}

function loadPlaylistToQueue(plIndex) {
    const selectedPlaylist = playLists[plIndex];
    if (selectedPlaylist.songs.length > 0) {
        queue = [...selectedPlaylist.songs];
        currentIndex = 0;
        play(queue[0].name, queue[0].thumbnail);
    } else {
        alert("This playlist is empty!");
    }
}

window.onclick = () => {
    document.querySelectorAll('.playlist-dropdown').forEach(d => d.style.display = 'none');
};