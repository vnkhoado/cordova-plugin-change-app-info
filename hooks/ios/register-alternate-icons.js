/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised
 *
 * Cordova before_compile hook (iOS).
 *
 * What it does:
 *   1. Reads ICON_CDN_URL from config.xml
 *   2. Fetches the CDN JSON (icon list)
 *   3. Downloads each PNG icon (must be 1024×1024)
 *   4. Saves them as flat files: platforms/ios/<AppName>/Resources/<name>@2x.png + @3x.png
 *   5. Updates *-Info.plist:
 *        - Adds UIApplicationSupportsAlternateIcons = true
 *        - Adds CFBundleAlternateIcons with flat CFBundleIconFiles (no path)
 *
 * FIX: iOS setAlternateIconName chỉ hoạt động khi icon là native bundle resource
 *      với tên phẳng (không có thư mục con). www/RuntimeIcons/ không được iOS dùng
 *      để render homescreen icon.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');

const {
  getConfigParser,
  ensureDirectoryExists,
  safeWriteFile,
  downloadFile,
  resizeImage,
  logWithTimestamp,
  logSection,
  logSectionComplete
} = require('../utils');

const TAG = 'RuntimeIconChanger iOS';

const ICON_VARIANTS = [
  { suffix: '@2x', size: 120 },
  { suffix: '@3x', size: 180 },
];

// ============================================================================
// Entry point
// ============================================================================

module.exports = function (context) {
  const root       = context.opts.projectRoot;
  const iosPlatDir = path.join(root, 'platforms', 'ios');

  if (!fs.existsSync(iosPlatDir)) return Promise.resolve();

  return new Promise(function (resolve) {
    try {
      const configPath = path.join(root, 'config.xml');
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
        .then(function (buf) {
          try { return JSON.parse(buf.toString('utf8')); }
          catch (e) { throw new Error('JSON parse error: ' + e.message); }
        })
        .then(function (json) {
          const icons = Array.isArray(json.icons) ? json.icons : [];
          if (!icons.length) {
            logWithTimestamp(`[${TAG}] No icons in JSON, skip`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] Found ${icons.length} icon(s): ${icons.map(i => i.name).join(', ')}`);

          const appFolderName = getAppNameFromXcodeProj(iosPlatDir);
          if (!appFolderName) {
            logWithTimestamp(`⚠️  [${TAG}] iOS app folder not found`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] App name from .xcodeproj: ${appFolderName}`);

          // Alternate icons phải là native bundle resources.
          // Lưu trực tiếp tại Resources/ với tên phẳng: <name>@2x.png, <name>@3x.png
          const bundleIconsDir = path.join(iosPlatDir, appFolderName, 'Resources');
          ensureDirectoryExists(bundleIconsDir);

          logWithTimestamp(`[${TAG}] bundle icon path: ${bundleIconsDir}`);

          return Promise.all(icons.map(icon =>
            downloadIconForIos(icon, bundleIconsDir)
          )).then(function (iconNames) {
            updateInfoPlist(iosPlatDir, appFolderName, iconNames);

            // Verify bundle resource files
            iconNames.forEach(function (name) {
              ICON_VARIANTS.forEach(function (v) {
                const bundlePath = path.join(bundleIconsDir, `${name}${v.suffix}.png`);
                logWithTimestamp(
                  `[${TAG}] VERIFY Resources/${name}${v.suffix}.png: ` +
                  (fs.existsSync(bundlePath) ? '✅' : '❌ MISSING')
                );
              });
            });

            logSectionComplete(`✅ [${TAG}] Registered: ${iconNames.join(', ')}`);
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

// ============================================================================
// App name detection
// ============================================================================

function getAppNameFromXcodeProj(iosPlatDir) {
  if (!fs.existsSync(iosPlatDir)) return null;
  const items = fs.readdirSync(iosPlatDir);

  for (const item of items) {
    if (!item.startsWith('.') && item.endsWith('.xcodeproj')) {
      return item.replace('.xcodeproj', '');
    }
  }

  const excluded = ['CordovaLib', 'www', 'cordova', 'build', 'DerivedData', 'Pods'];
  for (const item of items) {
    if (item.startsWith('.')) continue;
    try {
      const fullPath = path.join(iosPlatDir, item);
      if (fs.statSync(fullPath).isDirectory() && !excluded.includes(item)) return item;
    } catch (_) {}
  }
  return null;
}

// ============================================================================
// Download & resize — lưu flat: <name>@2x.png, <name>@3x.png trong bundleDir
// ============================================================================

function downloadIconForIos(icon, bundleDir) {
  const name = icon.name;

  logWithTimestamp(`[${TAG}] Downloading: ${name} ← ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    // Giữ bản 1024 để debug
    fs.writeFileSync(path.join(bundleDir, `${name}-1024.png`), buffer);

    return Promise.all(
      ICON_VARIANTS.map(function (v) {
        const fileName = `${name}${v.suffix}.png`;
        return resizeImage(buffer, path.join(bundleDir, fileName), v.size)
          .then(function () {
            logWithTimestamp(`[${TAG}]   ✔ ${name} — ${fileName} (${v.size}px)`);
          });
      })
    ).then(() => name);
  });
}

// ============================================================================
// Info.plist
// ============================================================================

function updateInfoPlist(iosPlatDir, appFolderName, iconNames) {
  const candidates = [
    path.join(iosPlatDir, appFolderName, appFolderName + '-Info.plist'),
    path.join(iosPlatDir, appFolderName, 'Info.plist'),
    path.join(iosPlatDir, appFolderName + '-Info.plist'),
    path.join(iosPlatDir, 'Info.plist'),
  ];

  let plistPath = candidates.find(p => fs.existsSync(p));
  if (!plistPath) {
    logWithTimestamp(`[${TAG}] Scanning for Info.plist...`);
    plistPath = scanForFile(iosPlatDir, ['Info.plist', '-Info.plist'], 3);
    if (plistPath) logWithTimestamp(`[${TAG}] Found: ${plistPath}`);
  }
  if (!plistPath) {
    logWithTimestamp(`⚠️  [${TAG}] Info.plist not found`);
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');

  // Đảm bảo UIApplicationSupportsAlternateIcons = true
  if (!plist.includes('UIApplicationSupportsAlternateIcons')) {
    plist = plist.replace(
      /(\s*)<\/dict>(\s*)<\/plist>\s*$/,
      '\n\t<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>\n</dict>\n</plist>\n'
    );
  } else {
    plist = plist.replace(
      /<key>UIApplicationSupportsAlternateIcons<\/key>\s*<false\/>/,
      '<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>'
    );
  }

  // Xoá block CFBundleIcons cũ để tránh duplicate
  plist = plist.replace(
    /<key>CFBundleIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );
  plist = plist.replace(
    /<key>CFBundleIcons~ipad<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );

  // CFBundleIconFiles dùng tên phẳng — KHÔNG có đường dẫn thư mục con
  // iOS sẽ tự tìm <name>@2x.png và <name>@3x.png trong bundle root
  const altDict = iconNames.map(name =>
    `\t\t\t<key>${name}</key>\n\t\t\t<dict>\n` +
    `\t\t\t\t<key>CFBundleIconFiles</key>\n` +
    `\t\t\t\t<array><string>${name}</string></array>\n` +
    `\t\t\t\t<key>UIPrerenderedIcon</key>\n\t\t\t\t<false/>\n` +
    `\t\t\t</dict>\n`
  ).join('');

  const makeBlock = key =>
    `\t<key>${key}</key>\n\t<dict>\n` +
    `\t\t<key>CFBundlePrimaryIcon</key>\n\t\t<dict>\n` +
    `\t\t\t<key>CFBundleIconName</key>\n` +
    `\t\t\t<string>AppIcon</string>\n` +
    `\t\t</dict>\n` +
    `\t\t<key>CFBundleAlternateIcons</key>\n\t\t<dict>\n` +
    altDict +
    `\t\t</dict>\n\t</dict>\n`;

  plist = plist.replace(
    /(\s*)<\/dict>(\s*)<\/plist>\s*$/,
    '\n' + makeBlock('CFBundleIcons') +
    makeBlock('CFBundleIcons~ipad') +
    '</dict>\n</plist>\n'
  );

  safeWriteFile(plistPath, plist);
  logWithTimestamp(`[${TAG}] ✔ Info.plist updated: ${plistPath}`);
}

// ============================================================================
// Utilities
// ============================================================================

function scanForFile(dir, patterns, maxDepth) {
  if (maxDepth <= 0) return null;
  const excluded = ['build', 'DerivedData', 'Pods', 'node_modules', '.git'];
  let items;
  try { items = fs.readdirSync(dir); } catch (_) { return null; }

  for (const item of items) {
    if (item.startsWith('.')) continue;
    const fullPath = path.join(dir, item);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (_) { continue; }
    if (stat.isFile()) {
      for (const pattern of patterns) {
        if (item === pattern || item.endsWith(pattern)) return fullPath;
      }
    } else if (stat.isDirectory() && !excluded.includes(item)) {
      const found = scanForFile(fullPath, patterns, maxDepth - 1);
      if (found) return found;
    }
  }
  return null;
}
