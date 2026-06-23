import {
  ANIMATING_CLASS,
  CURRENT_LYRICS_CLASS,
  PAUSED_CLASS,
  PRE_ANIMATING_CLASS,
  WORD_CLASS,
} from "@constants";
import { renderLyricsIntoContainer } from "@modules/lyrics/lyricsRenderer";
import type { Lyric } from "@modules/lyrics/providers/shared";
import { decompressString, isCompressed } from "@core/compression";

// Shell layout styles loaded from popup.css (via <link> in HTML).
// variables.css + lyrics.css + theme CSS are loaded asynchronously.

let port: chrome.runtime.Port | null = null;
let lyrics: Lyric[] = [];
let syncType: "richsync" | "synced" | "none" = "none";
let currentTime = 0;
let duration = 0;
let isPlaying = false;
let rafId: number | null = null;
let lyricsContainer: HTMLElement | null = null;
let lastActiveLineIndex = -1;

const container = document.getElementById("popup-lyrics-container")!;
const loadingEl = document.getElementById("popup-loading")!;
const songTitle = document.getElementById("popup-song-title")!;
const songArtist = document.getElementById("popup-song-artist")!;
const statusEl = document.getElementById("popup-status")!;
const root = document.getElementById("popup-root")!;
const playBtn = document.getElementById("popup-btn-play-pause")!;
const timeCurrent = document.getElementById("popup-time-current")!;
const timeTotal = document.getElementById("popup-time-total")!;
const progressFill = document.getElementById("popup-progress-fill")!;
const progressBar = document.getElementById("popup-progress-bar")!;

function updateStatus(msg: string): void {
  statusEl.textContent = msg;
}

function setSongInfo(song?: string, artist?: string): void {
  if (song) songTitle.textContent = song;
  if (artist) songArtist.textContent = artist;
}

function renderLyrics(): void {
  if (lyrics.length === 0) {
    loadingEl.style.display = "block";
    return;
  }

  try {
    loadingEl.style.display = "none";

    lyricsContainer = document.createElement("div");

    const rendered = renderLyricsIntoContainer(lyricsContainer, lyrics, {
      onSeek: (time) => {
        chrome.runtime.sendMessage({ action: "blyrics:seek", payload: { time } });
      },
    });

    syncType = rendered.syncType;
    container.replaceChildren(lyricsContainer);
    updateStatus(`Sync: ${syncType} — ${lyrics.length} lines`);
  } catch (err) {
    loadingEl.style.display = "block";
    loadingEl.textContent = `Render error: ${err}`;
    updateStatus(`Error rendering lyrics`);
  }
}

function updateHighlighting(): void {
  if (!lyricsContainer || lyrics.length === 0) return;

  const lineEls = lyricsContainer.querySelectorAll<HTMLElement>(".blyrics--line");
  let activeLineIndex = -1;

  for (let i = lyrics.length - 1; i >= 0; i--) {
    const line = lyrics[i];
    if (currentTime >= line.startTimeMs / 1000) {
      activeLineIndex = i;
      break;
    }
  }

  lineEls.forEach((el, i) => {
    const isInstrumental = el.dataset.instrumental === "true";

    if (i === activeLineIndex) {
      el.classList.add(CURRENT_LYRICS_CLASS);

      if (isInstrumental) {
        const timeDelta = currentTime - parseFloat(el.dataset.time || "0");
        el.style.setProperty("--blyrics-anim-delay", -timeDelta + "s");
        el.classList.remove(PRE_ANIMATING_CLASS);
        el.classList.add(ANIMATING_CLASS);
        el.classList.toggle(PAUSED_CLASS, !isPlaying);
      }

      const words = el.querySelectorAll<HTMLElement>(`.${WORD_CLASS}`);
      words.forEach((word) => {
        const wordTime = parseFloat(word.dataset.time || "0") * 1000;
        const wordDur = parseFloat(word.dataset.duration || "0") * 1000;
        const wordEnd = wordTime + wordDur;

        if (currentTime * 1000 >= wordTime && currentTime * 1000 < wordEnd) {
          word.classList.add(ANIMATING_CLASS);
          word.classList.remove(PRE_ANIMATING_CLASS, PAUSED_CLASS);
        } else if (currentTime * 1000 < wordTime) {
          word.classList.remove(ANIMATING_CLASS, PAUSED_CLASS);
          word.classList.add(PRE_ANIMATING_CLASS);
        } else {
          word.classList.remove(PRE_ANIMATING_CLASS);
          word.classList.add(ANIMATING_CLASS);
          word.classList.add(PAUSED_CLASS);
        }
      });

      if (i !== lastActiveLineIndex) {
        lastActiveLineIndex = i;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } else {
      el.classList.remove(CURRENT_LYRICS_CLASS);

      if (isInstrumental) {
        if (i === activeLineIndex + 1) {
          el.style.setProperty("--blyrics-anim-delay", "0s");
          el.classList.remove(ANIMATING_CLASS, PAUSED_CLASS);
          el.classList.add(PRE_ANIMATING_CLASS);
        } else {
          el.classList.remove(ANIMATING_CLASS, PRE_ANIMATING_CLASS, PAUSED_CLASS);
          el.style.removeProperty("--blyrics-anim-delay");
          el.style.removeProperty("--blyrics-swipe-delay");
        }
      }

      const words = el.querySelectorAll<HTMLElement>(`.${WORD_CLASS}`);
      words.forEach((word) => {
        word.classList.remove(ANIMATING_CLASS, PRE_ANIMATING_CLASS, PAUSED_CLASS);
      });
    }
  });
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateControls(): void {
  if (!playBtn || !timeCurrent || !timeTotal || !progressFill) return;
  playBtn.textContent = isPlaying ? "⏸" : "▶";
  timeCurrent.textContent = formatTime(currentTime);
  timeTotal.textContent = formatTime(duration);
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;
  progressFill.style.width = `${Math.min(pct, 100)}%`;
}

function connectToBackground(): void {
  if (port) return;
  try {
    port = chrome.runtime.connect({ name: "blyrics:popup" });

    port.onMessage.addListener((msg: Record<string, unknown>) => {
      try {
        if (msg.type === "blyrics:state" && msg.state) {
          const s = msg.state as {
            lyrics?: Lyric[];
            syncType?: "richsync" | "synced" | "none";
            song?: string;
            artist?: string;
            videoId?: string;
            duration?: number;
          };
          if (s.lyrics && s.lyrics.length > 0) {
            lyrics = s.lyrics;
            syncType = s.syncType || "none";
            setSongInfo(s.song, s.artist);
            renderLyrics();
          }
          if (s.videoId) {
            root.style.setProperty("--blyrics-background-img", `url('https://i.ytimg.com/vi/${s.videoId}/hqdefault.jpg')`);
          }
          if (typeof s.duration === "number") {
            duration = s.duration;
          }
          if (typeof msg.currentTime === "number") {
            currentTime = msg.currentTime;
          }
          if (typeof msg.isPlaying === "boolean") {
            isPlaying = msg.isPlaying;
          }
        }

        if (msg.type === "blyrics:tick" && typeof msg.currentTime === "number") {
          currentTime = msg.currentTime;
          if (typeof msg.isPlaying === "boolean") {
            isPlaying = msg.isPlaying;
          }
        }

        if (msg.type === "blyrics:cleared") {
          lyrics = [];
          lyricsContainer = null;
          container.replaceChildren(loadingEl);
          loadingEl.style.display = "block";
          updateStatus("No lyrics loaded");
          root.style.removeProperty("--blyrics-background-img");
        }
      } catch (err) {
        updateStatus(`Error: ${err}`);
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      updateStatus("Disconnected. Reconnecting...");
      setTimeout(() => {
        connectToBackground();
        requestInitialState();
      }, 1500);
    });
  } catch (err) {
    updateStatus(`Connect error: ${err}`);
    setTimeout(() => connectToBackground(), 3000);
  }
}

function requestInitialState(): void {
  chrome.runtime.sendMessage({ action: "blyrics:getState" }, (response) => {
    if (response?.state?.lyrics && response.state.lyrics.length > 0) {
      lyrics = response.state.lyrics;
      syncType = response.state.syncType || "none";
      setSongInfo(response.state.song, response.state.artist);
      if (typeof response.currentTime === "number") {
        currentTime = response.currentTime;
      }
      renderLyrics();
      updateStatus("Loaded via getState");
      if (response.state.videoId) {
        root.style.setProperty("--blyrics-background-img", `url('https://i.ytimg.com/vi/${response.state.videoId}/hqdefault.jpg')`);
      }
      if (typeof response.state.duration === "number") {
        duration = response.state.duration;
      }
      if (typeof response.isPlaying === "boolean") {
        isPlaying = response.isPlaying;
      }
    }
  });
}

function animationLoop(): void {
  try {
    updateHighlighting();
    updateControls();
  } catch (err) {
    console.warn("[BetterLyrics] Animation loop error:", err);
  }
  rafId = requestAnimationFrame(animationLoop);
}

// --- Theme & CSS loading ---

async function loadPopupTheme(): Promise<void> {
  try {
    const syncData = (await chrome.storage.sync.get(["cssStorageType", "customCSS", "cssCompressed"])) as Record<string, unknown>;

    let css: string | null = null;
    let compressed = false;

    if (syncData.cssStorageType === "chunked") {
      const meta = (await chrome.storage.local.get(["customCSS_chunked", "customCSS_chunkCount"])) as Record<string, unknown>;
      if (meta.customCSS_chunked && meta.customCSS_chunkCount) {
        const count = meta.customCSS_chunkCount as number;
        const chunkKeys: string[] = [];
        for (let i = 0; i < count; i++) chunkKeys.push(`customCSS_chunk_${i}`);
        const chunksData = (await chrome.storage.local.get(chunkKeys)) as Record<string, string>;
        css = chunkKeys.map((k) => chunksData[k] ?? "").join("");
        compressed = (syncData.cssCompressed as boolean) || false;
      }
    } else if (syncData.cssStorageType === "local") {
      const localData = (await chrome.storage.local.get(["customCSS", "cssCompressed"])) as Record<string, unknown>;
      css = (localData.customCSS as string) ?? null;
      compressed = (localData.cssCompressed as boolean) || false;
    } else {
      css = (syncData.customCSS as string) ?? null;
      compressed = (syncData.cssCompressed as boolean) || false;
    }

    if (css) {
      if (compressed || isCompressed(css)) {
        css = decompressString(css);
      }
      let el = document.getElementById("blyrics-custom-style");
      if (!el) {
        el = document.createElement("style");
        el.id = "blyrics-custom-style";
        document.head.appendChild(el);
      }
      el.textContent = css;
    }
  } catch (err) {
    console.warn("[BetterLyrics] Failed to load popup theme CSS:", err);
  }
}

async function loadVariablesCSS(): Promise<void> {
  try {
    const id = "blyrics-popup-variables";
    if (document.getElementById(id)) return;
    const url = chrome.runtime.getURL("css/blyrics/variables.css");
    const resp = await fetch(url);
    const css = await resp.text();
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  } catch (err) {
    console.warn("[BetterLyrics] Failed to load variables CSS:", err);
  }
}

async function loadLyricsBaseCSS(): Promise<void> {
  try {
    const id = "blyrics-popup-lyrics";
    if (document.getElementById(id)) return;
    const url = chrome.runtime.getURL("css/blyrics/lyrics.css");
    const resp = await fetch(url);
    const css = await resp.text();
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  } catch (err) {
    console.warn("[BetterLyrics] Failed to load lyrics base CSS:", err);
  }
}

async function loadInstrumentalCSS(): Promise<void> {
  try {
    const id = "blyrics-popup-instrumental";
    if (document.getElementById(id)) return;
    const url = chrome.runtime.getURL("css/blyrics/instrumental.css");
    const resp = await fetch(url);
    const css = await resp.text();
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  } catch (err) {
    console.warn("[BetterLyrics] Failed to load instrumental CSS:", err);
  }
}

// --- Buttons ---

document.getElementById("popup-open-window")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "blyrics:openPopupWindow" }).catch(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL("action/index.html"),
      type: "popup",
      width: 420,
      height: 700,
    });
  });
});

document.getElementById("popup-open-options")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// --- Media controls ---

document.getElementById("popup-btn-previous")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "blyrics:previousSong" }).catch(() => {});
});

document.getElementById("popup-btn-play-pause")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "blyrics:togglePlay" }).catch(() => {});
});

document.getElementById("popup-btn-next")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "blyrics:nextSong" }).catch(() => {});
});

progressBar?.addEventListener("click", (e) => {
  const rect = progressBar.getBoundingClientRect();
  const ratio = (e.clientX - rect.left) / rect.width;
  const seekTime = ratio * duration;
  chrome.runtime.sendMessage({ action: "blyrics:seek", payload: { time: seekTime } }).catch(() => {});
});

// --- Init ---

const isStandalone = window.location.search.includes("standalone");

if (!isStandalone) {
  console.log("[BetterLyrics] Elevating popup to standalone window...");
  chrome.runtime.sendMessage({ action: "blyrics:openPopupWindow" }).catch(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL("action/index.html") + "?standalone",
      type: "popup",
      width: 420,
      height: 700,
    });
  });
  window.close();
} else {
  (async () => {
    console.log("[BetterLyrics] Popup starting...");
    await Promise.all([loadPopupTheme(), loadLyricsBaseCSS(), loadInstrumentalCSS(), loadVariablesCSS()]);
    const overrideStyle = document.createElement("style");
    overrideStyle.id = "blyrics-popup-font-override";
    overrideStyle.textContent = `:root { --blyrics-font-size: clamp(14px, 4vh, 26px); }`;
    document.head.appendChild(overrideStyle);
    console.log("[BetterLyrics] Theme CSS loaded");
    updateStatus("Connecting...");
    connectToBackground();
    requestInitialState();
    chrome.runtime.sendMessage({ action: "blyrics:switchToLyricsTab" }).catch(() => {});
    rafId = requestAnimationFrame(animationLoop);
    console.log("[BetterLyrics] Popup initialized");
  })();
}
