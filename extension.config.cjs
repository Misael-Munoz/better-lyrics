module.exports = {
  dev: {
    browser: "chrome",
  },
  browser: {
    chrome: {
      preferences: { theme: "dark" },
      excludeBrowserFlags: [ // this appears to not work
        '--hide-scrollbars', // Allow scrollbars to be visible
        '--mute-audio', // Allow audio to play
        '--disable-component-extensions-with-background-pages' // Allow component extensions to load
      ],
      browserFlags: [
        "--remote-debugging-port",
        "9222",
        "https://music.youtube.com/watch?v=D_3nlLlPMxA&list=RDAMVMEmq17wn71jA",
      ],
      profile: "dist/chrome-profile",
    },
    firefox: {
      preferences: { theme: "dark" },
      excludeBrowserFlags: [
        '--hide-scrollbars', // Allow scrollbars to be visible
        '--disable-component-extensions-with-background-pages' // Allow component extensions to load
      ],
      browserFlags: [
        "https://music.youtube.com/watch?v=Emq17wn71jA&list=RDAMVMxe9j9hPn6Bc",
      ],
      profile: "dist/firefox-profile",
    },
  },
  config: (config) => {
    const isCanaryRelease = process.env.RELEASE_TYPE === "canary";
    const isDevelopment = config.mode !== "production";
    const isReleaseBuild = !!process.env.RELEASE_TYPE;

    if (!isDevelopment) {
      console.log("\x1b[31m[BetterLyrics]\x1b[0m Building for", isCanaryRelease ? "canary release" : "standard release");

      // Minify locale JSON files for prod builds
      config.plugins.push({
        apply: (compiler) => {
          compiler.hooks.emit.tap("MinifyLocales", (compilation) => {
            for (const [name, asset] of Object.entries(compilation.assets)) {
              if (name.startsWith("_locales/") && name.endsWith(".json")) {
                const source = asset.source();
                const minified = JSON.stringify(JSON.parse(source));
                compilation.assets[name] = {
                  source: () => minified,
                  size: () => minified.length,
                };
              }
            }
          });
        },
      });
    }

    // Strip the `key` field from manifest for local dev/test builds
    // so Chrome assigns a random extension ID (avoids ID mismatch with publicPath).
    // Release builds (RELEASE_TYPE=canary or =release) keep the key for the store.
    if (!isReleaseBuild) {
      config.plugins.push({
        apply: (compiler) => {
          compiler.hooks.emit.tap("StripManifestKey", (compilation) => {
            const manifest = compilation.assets["manifest.json"];
            if (manifest) {
              const source = manifest.source();
              const json = JSON.parse(source);
              delete json.key;
              const newSource = JSON.stringify(json, null, "\t");
              compilation.assets["manifest.json"] = {
                source: () => newSource,
                size: () => newSource.length,
              };
            }
          });
        },
      });
    }

    config.devtool = (isDevelopment || isCanaryRelease) ? "source-map" : false;

    if (isReleaseBuild) {
      // Production builds use the CWS store extension ID for webpack chunk paths
      config.output = {
        ...config.output,
        publicPath: "chrome-extension://effdbpeggelllpfkjppbokhmmiinhlmg/",
      };
    }

    return config;
  }
};
