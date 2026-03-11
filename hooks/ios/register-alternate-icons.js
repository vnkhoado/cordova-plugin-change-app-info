/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised
 *
 * Cordova after_prepare hook (iOS).
 *
 * What it does:
 *   1. Reads ICON_CDN_URL from config.xml (set via OutSystems Extensibility
 *      Configurations > preferences > global)
 *   2. Fetches the CDN JSON (icon list)
 *   3. Downloads each PNG icon (must be 1024×1024)
 *   4. Saves them to platforms/ios/<AppName>/Resources/RuntimeIcons/<name>/
 *   5. Updates *-Info.plist:
 *        - Adds UIApplicationSupportsAlternateIcons = true
 *        - Adds CFBundleAlternateIcons entries
 *
 * MABS constraints:
 *   - No npm dependencies (uses only Node built-ins)
 *   - Graceful degradation: warnings, never build failures
 *   - Follows OutSystems MABS hook file path conventions
 *   - Works with MABS 9+ (Cordova iOS 6+)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const {
  getConfigParser,
  getIOSAppFolderName,
  getInfoPlistPath,
  ensureDirectoryExists,
  safeWriteFile,
  downloadFile,
  resizeImage,
  logWithTimestamp,
  logSection,
  logSectionComplete
} = require('../utils');

const TAG = 'RuntimeIconChanger iOS';

module.exports = function (context) {
  const platforms = context.opts.platforms || [];

  if (!platforms.includes('ios')) {
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

      logSection('RUNTIME ICON — iOS');
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
          if (!icons.length) {
            logWithTimestamp(`[${TAG}] No icons in JSON, skip`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] Found ${icons.length} icon(s): ${icons.map(i => i.name).join(', ')}`);

          const root          = context.opts.projectRoot;
          const iosPlatDir    = path.join(root, 'platforms', 'ios');
          const appFolderName = getIOSAppFolderName(root);

          if (!appFolderName) {
            logWithTimestamp(`⚠️  [${TAG}] iOS app folder not found`);
            resolve();
            return;
          }

          const xcodeProjDir = path.join(iosPlatDir, appFolderName);
          const resourcesDir = path.join(xcodeProjDir, 'Resources', 'RuntimeIcons');
          ensureDirectoryExists(resourcesDir);

          const iconSizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

          return Promise.all(icons.map(function (icon) {
            return downloadIconForIos(icon, resourcesDir, iconSizes);
          })).then(function (iconNames) {
            updateInfoPlist(iosPlatDir, appFolderName, iconNames);
            logSectionComplete(`✅ [${TAG}] Registered alternate icons: ${iconNames.join(', ')}`);
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

function downloadIconForIos(icon, resourcesDir, sizes) {
  const name     = icon.name;
  const iconDir  = path.join(resourcesDir, name);
  ensureDirectoryExists(iconDir);

  logWithTimestamp(`[${TAG}] Downloading: ${name} ← ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    // Lưu bản gốc 1024 (binary — dùng fs trực tiếp, không qua safeWriteFile utf8)
    fs.writeFileSync(path.join(iconDir, 'Icon-1024.png'), buffer);
    logWithTimestamp(`[${TAG}] ✔ ${name} — 1024px saved`);

    return Promise.all(
      sizes
        .filter(s => s !== 1024)
        .map(size =>
          resizeImage(buffer, path.join(iconDir, `Icon-${size}.png`), size)
            .then(() => logWithTimestamp(`[${TAG}]   ✔ ${name} — ${size}x${size}`))
        )
    ).then(() => name);
  });
}

function updateInfoPlist(iosPlatDir, appFolderName, iconNames) {
  // Thử getInfoPlistPath từ utils trước, fallback sang Info.plist
  let plistPath = getInfoPlistPath(iosPlatDir);
  if (!plistPath || !fs.existsSync(plistPath)) {
    plistPath = path.join(iosPlatDir, appFolderName, 'Info.plist');
  }

  if (!plistPath || !fs.existsSync(plistPath)) {
    logWithTimestamp(`⚠️  [${TAG}] Info.plist not found`);
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');

  // UIApplicationSupportsAlternateIcons
  if (!plist.includes('UIApplicationSupportsAlternateIcons')) {
    plist = plist.replace(
      '</dict>\n</plist>',
      '\t<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>\n</dict>\n</plist>'
    );
  } else {
    plist = plist.replace(
      /<key>UIApplicationSupportsAlternateIcons<\/key>\s*<false\/>/,
      '<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>'
    );
  }

  // Xóa block cũ để tránh duplicate
  plist = plist.replace(
    /<key>CFBundleIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );
  plist = plist.replace(
    /<key>CFBundleIcons~ipad<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );

  function buildAltDict(names) {
    return names.map(name =>
      `\t\t\t<key>${name}</key>\n\t\t\t<dict>\n` +
      `\t\t\t\t<key>CFBundleIconFiles</key>\n` +
      `\t\t\t\t<array><string>RuntimeIcons/${name}/Icon</string></array>\n` +
      `\t\t\t\t<key>UIPrerenderedIcon</key>\n\t\t\t\t<false/>\n` +
      `\t\t\t</dict>\n`
    ).join('');
  }

  const makeBlock = (key) =>
    `\t<key>${key}</key>\n\t<dict>\n` +
    `\t\t<key>CFBundleAlternateIcons</key>\n\t\t<dict>\n` +
    buildAltDict(iconNames) +
    `\t\t</dict>\n\t</dict>\n`;

  plist = plist.replace(
    '</dict>\n</plist>',
    makeBlock('CFBundleIcons') + makeBlock('CFBundleIcons~ipad') + '</dict>\n</plist>'
  );

  safeWriteFile(plistPath, plist);
  logWithTimestamp(`[${TAG}] ✔ Info.plist updated: ${plistPath}`);
}
