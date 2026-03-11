/**
 * hooks/android/register-icon-aliases.js  — MABS-optimised
 *
 * Cordova after_prepare hook (Android).
 *
 * What it does:
 *   1. Reads ICON_CDN_URL from config.xml
 *   2. Fetches the CDN JSON icon list
 *   3. Downloads each PNG, resizes to Android mipmap densities
 *   4. Injects <activity-alias> entries into AndroidManifest.xml
 *
 * MABS constraints:
 *   - No npm dependencies (Node built-ins only; jimp is optional)
 *   - Idempotent: cleans up previous hook output before re-injecting
 *   - Follows MABS 9+ Android project layout (app/src/main/)
 *   - DONT_KILL_APP is handled in Java — not a build concern
 *   - The default alias starts ENABLED; all others start DISABLED
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const {
  getConfigParser,
  getAndroidPackageName,
  ensureDirectoryExists,
  safeWriteFile,
  downloadFile,
  resizeImage,
  logWithTimestamp,
  logSection,
  logSectionComplete
} = require('../utils');

const TAG = 'RuntimeIconChanger Android';

module.exports = function (context) {
  const platforms = context.opts.platforms || [];

  if (!platforms.includes('android')) {
    return Promise.resolve();
  }

  return new Promise(function (resolve) {
    try {
      const configPath = path.join(context.opts.projectRoot, 'config.xml');

      if (!fs.existsSync(configPath)) {
        logWithTimestamp(`[${TAG}] config.xml not found, skip`);
        resolve();
        return;
      }

      const config     = getConfigParser(context, configPath);
      const iconCdnUrl = config.getPreference('ICON_CDN_URL');

      if (!iconCdnUrl) {
        logWithTimestamp(`[${TAG}] ICON_CDN_URL not set, skip`);
        resolve();
        return;
      }

      logSection('RUNTIME ICON — Android');
      logWithTimestamp(`[${TAG}] Fetching icon list from: ${iconCdnUrl}`);

      downloadFile(iconCdnUrl)
        .then(function (buffer) {
          try {
            return JSON.parse(buffer.toString('utf8'));
          } catch (e) {
            throw new Error('JSON parse error: ' + e.message);
          }
        })
        .then(function (json) {
          const icons = Array.isArray(json.icons) ? json.icons : [];

          // default reuses ic_launcher từ CDN_ICON — không cần download lại
          const runtimeIcons = icons.filter(i => i && i.name && i.name !== 'default');

          logWithTimestamp(
            `[${TAG}] ${runtimeIcons.length} runtime icon(s)` +
            (runtimeIcons.length ? ': ' + runtimeIcons.map(i => i.name).join(', ') : '') +
            ' (default reuses CDN_ICON)'
          );

          const root   = context.opts.projectRoot;
          const appDir = path.join(root, 'platforms', 'android', 'app', 'src', 'main');
          const resDir = path.join(appDir, 'res');

          const densities = [
            { folder: 'mipmap-mdpi',    size: 48  },
            { folder: 'mipmap-hdpi',    size: 72  },
            { folder: 'mipmap-xhdpi',   size: 96  },
            { folder: 'mipmap-xxhdpi',  size: 144 },
            { folder: 'mipmap-xxxhdpi', size: 192 }
          ];

          return Promise.all(runtimeIcons.map(icon =>
            downloadIconForAndroid(icon, resDir, densities)
          )).then(function (iconInfos) {
            // Package name: ưu tiên build.gradle, fallback manifest
            const packageName = getAndroidPackageName(root) || getPackageFromManifest(appDir);
            injectAliases(appDir, iconInfos, packageName);
            logSectionComplete(
              `✅ [${TAG}] Aliases registered: default (ic_launcher)` +
              (iconInfos.length ? ', ' + iconInfos.map(i => i.name).join(', ') : '')
            );
            resolve();
          });
        })
        .catch(function (err) {
          logWithTimestamp(`⚠️  [${TAG}] Hook error (non-fatal): ${err.message}`);
          resolve();
        });

    } catch (err) {
      logWithTimestamp(`⚠️  [${TAG}] Hook error (non-fatal): ${err.message}`);
      resolve();
    }
  });
};

// ---------------------------------------------------------------------------

function getPackageFromManifest(appDir) {
  const manifestPath = path.join(appDir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) return '';
  const match = fs.readFileSync(manifestPath, 'utf8').match(/package="([^"]+)"/);
  return match ? match[1] : '';
}

function downloadIconForAndroid(icon, resDir, densities) {
  const name = icon.name;

  logWithTimestamp(`[${TAG}] Downloading: ${name} ← ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    return Promise.all(
      densities.map(d => {
        const dir     = path.join(resDir, d.folder);
        const outFile = path.join(dir, `ic_launcher_${name}.png`);
        ensureDirectoryExists(dir);
        return resizeImage(buffer, outFile, d.size)
          .then(() => logWithTimestamp(`[${TAG}]   ✔ ${name} — ${d.folder} (${d.size}px)`));
      })
    ).then(() => ({ name, mipmapName: `ic_launcher_${name}` }));
  });
}

function injectAliases(appDir, iconInfos, packageName) {
  const manifestPath = path.join(appDir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) {
    logWithTimestamp(`⚠️  [${TAG}] AndroidManifest.xml not found`);
    return;
  }

  let manifest = fs.readFileSync(manifestPath, 'utf8');

  // Xóa block cũ — idempotent
  manifest = manifest.replace(
    /\n?\s*<!-- RuntimeIconChanger:start -->[\s\S]*?<!-- RuntimeIconChanger:end -->\n?/g, ''
  );

  let block = '\n    <!-- RuntimeIconChanger:start -->';

  // Alias mặc định dùng ic_launcher từ CDN_ICON
  block += `
    <activity-alias
        android:name="${packageName}.MainActivity_default"
        android:enabled="true"
        android:exported="true"
        android:icon="@mipmap/ic_launcher"
        android:targetActivity=".MainActivity">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity-alias>`;

  iconInfos.forEach(function (info) {
    block += `
    <activity-alias
        android:name="${packageName}.MainActivity_${info.name}"
        android:enabled="false"
        android:exported="true"
        android:icon="@mipmap/${info.mipmapName}"
        android:targetActivity=".MainActivity">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity-alias>`;
  });

  block += '\n    <!-- RuntimeIconChanger:end -->';

  manifest = manifest.replace(/<\/application>/, block + '\n</application>');
  safeWriteFile(manifestPath, manifest);
  logWithTimestamp(`[${TAG}] ✔ AndroidManifest.xml updated`);
}
