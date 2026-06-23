import { LOG_PREFIX_BACKGROUND } from "@constants";
import { getLocalStorage, getSyncStorage } from "@core/storage";
import { initBackgroundAuth } from "@modules/auth/backgroundAuth";
import type { Lyric } from "@modules/lyrics/providers/shared";
import {
  getInstalledStoreThemes,
  installSymlinkedThemeFromMarketplace,
  performSilentUpdates,
  performUrlThemeUpdates,
  setActiveStoreTheme,
} from "./store/themeStoreManager";
import { fetchAllStoreThemes } from "./store/themeStoreService";

const THEME_UPDATE_ALARM = "theme-update-check";
const UPDATE_INTERVAL_MINUTES = 360; // 6 hours

const SYMLINKED_MIGRATION_KEY = "symlinkedMigrationVersion";
const SYMLINKED_MIGRATION_VERSION = 1;

const SYMLINKED_THEME_MAP: Record<string, string> = {
  Minimal: "minimal",
  "Dynamic Background": "dynamic-background",
  "Apple Music": "apple-music",
};

const SYNC_STORAGE_LIMIT = 7000;

// -- PopUp Bridge State --------------------------------

interface PopupCachedState {
  lyrics: Lyric[];
  syncType: "richsync" | "synced" | "none";
  videoId?: string;
  song?: string;
  artist?: string;
  album?: string;
  duration?: number;
  source?: string;
  sourceHref?: string;
}

let cachedState: PopupCachedState | null = null;
let cachedTime = 0;
let cachedPlaying = false;
const popupPorts = new Set<chrome.runtime.Port>();
let popupWindowId: number | null = null;

function broadcastToPorts(msg: unknown): void {
  for (const port of popupPorts) {
    try {
      port.postMessage(msg);
    } catch {
      popupPorts.delete(port);
    }
  }
}

function forwardToContentScript(action: string, payload: unknown): void {
  chrome.tabs.query({ url: "*://music.youtube.com/*" }, tabs => {
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, { action, payload }).catch(() => {});
      }
    }
  });
}

// -- Theme Management ----------------------------------

async function saveThemeCSS(css: string, title: string, creators: string[]): Promise<void> {
  const themeContent = `/* ${title}, a marketplace theme by ${creators.join(", ")} */\n\n${css}\n`;
  const cssSize = new Blob([themeContent]).size;

  if (cssSize <= SYNC_STORAGE_LIMIT) {
    await chrome.storage.sync.set({ customCSS: themeContent, cssStorageType: "sync", cssCompressed: false });
  } else {
    await chrome.storage.local.set({ customCSS: themeContent, cssCompressed: false });
    await chrome.storage.sync.set({ cssStorageType: "local", cssCompressed: false });
    await chrome.storage.sync.remove("customCSS");
  }
}

async function migrateSymlinkedThemes(): Promise<void> {
  try {
    const result = await getLocalStorage<{ [SYMLINKED_MIGRATION_KEY]?: number }>([SYMLINKED_MIGRATION_KEY]);
    if ((result[SYMLINKED_MIGRATION_KEY] ?? 0) >= SYMLINKED_MIGRATION_VERSION) return;

    const syncData = await getSyncStorage<{ themeName?: string }>(["themeName"]);
    const themeName = syncData.themeName;

    if (themeName && !themeName.startsWith("store:")) {
      const storeId = SYMLINKED_THEME_MAP[themeName];
      if (storeId) {
        console.log(LOG_PREFIX_BACKGROUND, `Migrating symlinked theme: ${themeName} → store:${storeId}`);
        await chrome.storage.sync.set({ themeName: `store:${storeId}` });
        await setActiveStoreTheme(storeId);
        const installed = await installSymlinkedThemeFromMarketplace(storeId);
        if (!installed) {
          await chrome.storage.sync.set({ themeName });
          await chrome.storage.sync.remove("activeStoreTheme");
          return;
        }
        await saveThemeCSS(installed.css, installed.title, installed.creators);
        console.log(LOG_PREFIX_BACKGROUND, `Migrated active theme: ${themeName} → store:${storeId}`);
      }
    }

    await chrome.storage.local.set({ [SYMLINKED_MIGRATION_KEY]: SYMLINKED_MIGRATION_VERSION });
  } catch (err) {
    console.warn(LOG_PREFIX_BACKGROUND, "Symlinked themes migration failed:", err);
  }
}

async function checkAndApplyThemeUpdates(): Promise<void> {
  try {
    const installed = await getInstalledStoreThemes();
    if (installed.length === 0) return;

    console.log(LOG_PREFIX_BACKGROUND, "Checking for theme updates...");
    const storeThemes = await fetchAllStoreThemes();
    const marketplaceUpdatedIds = await performSilentUpdates(storeThemes);
    const urlUpdatedIds = await performUrlThemeUpdates();
    const updatedIds = [...marketplaceUpdatedIds, ...urlUpdatedIds];

    if (updatedIds.length > 0) {
      console.log(LOG_PREFIX_BACKGROUND, `Updated ${updatedIds.length} theme(s):`, updatedIds.join(", "));
    }
  } catch (err) {
    console.warn(LOG_PREFIX_BACKGROUND, "Theme update check failed:", err);
  }
}

function setupThemeUpdateAlarm(): void {
  chrome.alarms.get(THEME_UPDATE_ALARM, existingAlarm => {
    if (!existingAlarm) {
      chrome.alarms.create(THEME_UPDATE_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: UPDATE_INTERVAL_MINUTES,
      });
      console.log(LOG_PREFIX_BACKGROUND, "Theme update alarm created");
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  setupThemeUpdateAlarm();
  await migrateSymlinkedThemes();
  checkAndApplyThemeUpdates();
});

chrome.runtime.onStartup.addListener(async () => {
  setupThemeUpdateAlarm();
  await migrateSymlinkedThemes();
  checkAndApplyThemeUpdates();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === THEME_UPDATE_ALARM) {
    checkAndApplyThemeUpdates();
  }
});

// -- PopUp Bridge Messaging ----------------------------

chrome.windows.onRemoved.addListener((windowId: number) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name === "blyrics:popup") {
    popupPorts.add(port);

    // Send initial state immediately
    port.postMessage({
      type: "blyrics:state",
      state: cachedState,
      currentTime: cachedTime,
    });

    port.onDisconnect.addListener(() => {
      popupPorts.delete(port);
    });
  }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle "applyStyles" (existing)
  if (request.action === "applyStyles") {
    chrome.tabs.query({ url: "*://music.youtube.com/*" }, tabs => {
      tabs.forEach(tab => {
        if (tab.id != null) {
          chrome.tabs.sendMessage(tab.id, { action: "applyStyles", ricsSource: request.ricsSource }).catch(err => {
            console.warn(LOG_PREFIX_BACKGROUND, `Failed to send message to tab ${tab.id}:`, err);
          });
        }
      });
    });
    return true;
  }

  // PopUp Bridge messages
  if (request.action === "blyrics:state" && request.payload) {
    cachedState = {
      lyrics: request.payload.lyrics,
      syncType: request.payload.syncType,
      videoId: request.payload.videoId,
      song: request.payload.song,
      artist: request.payload.artist,
      album: request.payload.album,
      duration: request.payload.duration,
      source: request.payload.source,
      sourceHref: request.payload.sourceHref,
    };
    broadcastToPorts({ type: "blyrics:state", state: cachedState, currentTime: cachedTime });
    return false;
  }

  if (request.action === "blyrics:tick" && request.payload) {
    cachedTime = request.payload.currentTime;
    cachedPlaying = typeof request.payload.isPlaying === "boolean" ? request.payload.isPlaying : cachedPlaying;
    if (request.payload.state) {
      cachedState = request.payload.state;
    }
    broadcastToPorts({ type: "blyrics:tick", currentTime: cachedTime, isPlaying: cachedPlaying });
    return false;
  }

  if (request.action === "blyrics:cleared") {
    cachedState = null;
    cachedTime = 0;
    broadcastToPorts({ type: "blyrics:cleared" });
    return false;
  }

  if (request.action === "blyrics:getState") {
    sendResponse({ state: cachedState, currentTime: cachedTime, isPlaying: cachedPlaying });
    return true;
  }

  if (request.action === "blyrics:seek" && request.payload) {
    forwardToContentScript("blyrics:seek", request.payload);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "blyrics:switchToLyricsTab") {
    forwardToContentScript("blyrics:switchToLyricsTab", null);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "blyrics:togglePlay") {
    forwardToContentScript("blyrics:togglePlay", null);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "blyrics:nextSong") {
    forwardToContentScript("blyrics:nextSong", null);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "blyrics:previousSong") {
    forwardToContentScript("blyrics:previousSong", null);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "blyrics:openPopupWindow") {
    (async () => {
      sendResponse(await findOrCreatePopupWindow());
    })();
    return true;
  }

  return false;
});

async function findOrCreatePopupWindow(): Promise<{ created: boolean; windowId: number }> {
  const url = chrome.runtime.getURL("action/index.html") + "?standalone";

  if (popupWindowId !== null) {
    try {
      const win = await chrome.windows.get(popupWindowId);
      if (win) {
        await chrome.windows.update(popupWindowId, { focused: true });
        return { created: false, windowId: popupWindowId };
      }
    } catch {
      popupWindowId = null;
    }
  }

  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    if (win.tabs?.some(tab => tab.url?.startsWith(url))) {
      popupWindowId = win.id ?? null;
      if (popupWindowId !== null) {
        await chrome.windows.update(popupWindowId, { focused: true });
      }
      return { created: false, windowId: popupWindowId ?? -1 };
    }
  }

  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 420,
    height: 700,
  });
  popupWindowId = win?.id ?? null;
  return { created: true, windowId: popupWindowId ?? -1 };
}

initBackgroundAuth();
