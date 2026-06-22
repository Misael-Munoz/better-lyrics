import { reloadLyrics } from "@core/appState";

interface Setting {
  readonly type: "number" | "boolean" | "string";
  value: number | boolean | string;
  readonly defaultValue: number | boolean | string;
  readonly requiresLyricReload: boolean;
  getNumberValue(): number;
  getBooleanValue(): boolean;
  getStringValue(): string;
}

function createSetting(
  type: "number" | "boolean" | "string",
  value: number | boolean | string,
  defaultValue: number | boolean | string,
  requiresLyricReload: boolean
): Setting {
  return {
    type,
    value,
    defaultValue,
    requiresLyricReload,
    getNumberValue(this: Setting): number {
      return this.value as number;
    },
    getBooleanValue(this: Setting): boolean {
      return this.value as boolean;
    },
    getStringValue(this: Setting): string {
      return this.value as string;
    },
  };
}

function getSettingsMap(): Map<string, Setting> {
  let m = (registerThemeSetting as any)._map;
  if (!m) {
    m = new Map<string, Setting>();
    (registerThemeSetting as any)._map = m;
  }
  return m;
}

export function registerThemeSetting(
  key: string,
  defaultValue: number | boolean | string,
  requiresLyricReload: boolean = false
) {
  let type = typeof defaultValue;
  if (type !== "number" && type !== "boolean" && type !== "string") {
    throw new Error("Invalid type for theme setting");
  }
  let setting = createSetting(type, defaultValue, defaultValue, requiresLyricReload);
  getSettingsMap().set(key, setting);
  return setting;
}

export function setThemeSettings(map: Map<string, string>) {
  let needsLyricReload = false;
  const keyToSettingMap = getSettingsMap();

  map.forEach((value, key) => {
    let setting = keyToSettingMap.get(key);
    if (setting) {
      let lastValue = setting.value;
      if (setting.type === "number") {
        const parsed = parseFloat(value);
        if (isNaN(parsed)) {
          setting.value = setting.defaultValue;
        } else {
          setting.value = parsed;
        }
      } else if (setting.type === "boolean") {
        setting.value = value.toLowerCase() === "true";
      } else {
        setting.value = value;
      }

      if (setting.requiresLyricReload && lastValue !== setting.value) {
        needsLyricReload = true;
      }
    }
  });

  // second pass reset undefined values to their default values
  for (const [key, setting] of keyToSettingMap.entries()) {
    if (!map.has(key) && setting.value !== setting.defaultValue) {
      setting.value = setting.defaultValue;
      if (setting.requiresLyricReload) {
        needsLyricReload = true;
      }
    }
  }

  if (needsLyricReload) {
    reloadLyrics();
  }
}
