const CURR_TIME = document.getElementById("curr-timestamp");
const MAX_TIME = document.getElementById("max-timestamp");
const TIME_SEEK = document.getElementById("time-seek");
const SKIP_AMOUNT = 5;

let vol = 50;
let playing = false;
let song = new Audio('./Songs/Lonely Lies & GOLDKID$ - Interlinked.flac');

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
        song.volume += 0.1;
    } else if (key === "arrowdown") {
        song.volume -= 0.1;
    }
});

function playSong() {
    song = new Audio('./Songs/Lonely Lies & GOLDKID$ - Interlinked.flac');
    song.addEventListener('loadedmetadata', function() {
        MAX_TIME.innerText = formatTime(song.duration);
        TIME_SEEK.max = song.duration; 
        TIME_SEEK.value = 0;

        playing = true;
        updatePlayStatus();
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

function setVolume() {
    song.volume = document.getElementById("volume").value;
    document.getElementById("vol-perc").innerText = Math.ceil(song.volume * 100) + "%";
}
