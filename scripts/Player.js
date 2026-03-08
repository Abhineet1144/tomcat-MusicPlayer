const CURR_TIME = document.getElementById("curr-timestamp");
const MAX_TIME = document.getElementById("max-timestamp");
const TIME_SEEK = document.getElementById("time-seek");
const SKIP_AMOUNT = 5;
const VOL_ADD_AMOUNT = 0.05;

let playing = false;
let song = null;

document.querySelector("body").addEventListener("keydown", function(event){
    // event.preventDefault();
    let key = event.key.toLowerCase();

    if (key == "t") {
        playSong();
    }

    if (key == " ") {
        playing = !playing;
        updatePlayStatus();
    } else if (key === "arrowright") {
        skip(SKIP_AMOUNT);
    } else if (key === "arrowleft") {
        skip(-SKIP_AMOUNT);
    } else if (key === "arrowup") {
        addVol(VOL_ADD_AMOUNT);
    } else if (key === "arrowdown") {
        addVol(-VOL_ADD_AMOUNT);
    }
});

function swapPlayStatusAndUpdate() {
    playing = !playing;
    updatePlayStatus();
}

function playSong(path) {
    if (song != null) {
        song.pause();
    }
    song = new Audio(path);
    
    song.addEventListener('ended', () => {
        nextSong();
    });

    song.addEventListener('loadedmetadata', function() {
        MAX_TIME.innerText = formatTime(song.duration);
        TIME_SEEK.max = song.duration; 
        setVolume();
        playing = true;
        updatePlayStatus();
        
        const current = queue[currentIndex];
        updateMediaSession(current.name, current.thumbnail);
    });
}

function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function setPercentage() {
    TIME_SEEK.value = song.currentTime;
}

function seek() {
    song.currentTime = TIME_SEEK.value;
    setPercentage();
}

function skip(skp) {
    if (song.currentTime + skp < song.duration) {
        song.currentTime += skp;
        
    } else {
        song.currentTime = track.duration;
    }
    setPercentage();
}

function updatePlayStatus() {
    let btn = document.getElementById("play-pause");
    if (!playing) {
        song.pause();
        btn.textContent = "►";
    } else{
        song.play();
        btn.textContent = "⏸";
    }
}

setInterval(() => {
    if (playing) {
        CURR_TIME.innerText = formatTime(song.currentTime);
        setPercentage();
    } 
}, 1000)

function addVol(amount) {
    song.volume += amount;
    document.getElementById("volume").value = (document.getElementById("volume").value * 1) + (amount * 1);
    setVolPercent();
}

function setVolPercent() {
    document.getElementById("vol-perc").innerText = Math.ceil(song.volume * 100) + "%";
    updateToLocalStorage();
}

function setVolume() {
    document.getElementById("vol-perc").innerText = Math.ceil(document.getElementById("volume").value * 100) + "%";
    if (song != null) {
        song.volume = document.getElementById("volume").value;
    }
    updateToLocalStorage();
}

function updateToLocalStorage() {
    localStorage.setItem("vol", document.getElementById("volume").value);
}

document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("volume").value = localStorage.getItem("vol");
    setVolPercent();
})

function updateMediaSession(songName, imgPath) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: songName,
            artist: "OurMusic Player",
            artwork: [{ src: imgPath, sizes: '512x512', type: 'image/png' }]
        });

        navigator.mediaSession.setActionHandler('play', () => { playing = true; updatePlayStatus(); });
        navigator.mediaSession.setActionHandler('pause', () => { playing = false; updatePlayStatus(); });
        
        navigator.mediaSession.setActionHandler('previoustrack', prevSong);
        navigator.mediaSession.setActionHandler('nexttrack', nextSong);
        
        navigator.mediaSession.setActionHandler('seekbackward', () => skip(-SKIP_AMOUNT));
        navigator.mediaSession.setActionHandler('seekforward', () => skip(SKIP_AMOUNT));
    }
}

function nextSong() {
    if (queue.length === 0) return;
    currentIndex++;
    const next = queue[currentIndex];
    queue.pop(queue.length);
    play(next.name, next.thumbnail);
}

function prevSong() {
    if (queue.length === 0) return;
    currentIndex = (currentIndex - 1 + queue.length) % queue.length;
    const prev = queue[currentIndex];
    play(prev.name, prev.thumbnail);
}