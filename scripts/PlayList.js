let playLists = [];
let queue = [];

document.addEventListener("DOMContentLoaded", () => {
    playLists = JSON.parse(localStorage.getItem("playlists"));
    queue = JSON.parse(localStorage.getItem("queue"))
})

function updateInUI() {
    
}

function updateLocalStorage() {
    localStorage.setItem("playlists", JSON.stringify(playLists));
    localStorage.setItem("queue", JSON.stringify(queue));
}