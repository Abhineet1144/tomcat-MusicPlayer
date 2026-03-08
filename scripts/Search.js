function search(name) {
    fetch("./search?name=" + name)
    .then(text => text.json())
    .then(songs => {
        let songsDiv = document.getElementById("search-result");
        songsDiv.innerHTML = "";
        songs.forEach((song) => {
            let songDiv = document.createElement("div");
            songDiv.classList.add("song-desc");
            songDiv.innerHTML = `
                    <img height="60px" width="60px" src="${song.thumbnail}" alt="thumbnail" id="thumbnail">
                    <p id="name">${song.name}</p>`;
            songDiv.addEventListener("click", () => {
                play(song.name, song.thumbnail);
            })
            songsDiv.appendChild(songDiv);
        })
    });
} 

function play(song, img) {
    let path = "./Songs/" + song + ".flac";
    document.getElementById("song-thumbnail").src = img;
    document.getElementById("song-name").innerText = song
    playSong(path)
}