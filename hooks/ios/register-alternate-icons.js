/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised v4
 *
 * KEY FIX v4:
 * iOS alternate icons CANNOT use .imageset — they require .appiconset
 * with a proper Contents.json listing all required icon sizes.
 *
 * Structure created:
 *   Assets.xcassets/
 *     tet2026.appiconset/
 *       tet2026-20@2x.png    (40x40)
 *       tet2026-20@3x.png    (60x60)
 *       tet2026-29@2x.png    (58x58)
 *       tet2026-29@3x.png    (87x87)
 *       tet2026-40@2x.png    (80x80)
 *       tet2026-40@3x.png    (120x120)
 *       tet2026-60@2x.png    (120x120)
 *       tet2026-60@3x.png    (180x180)
 *       tet2026-1024.png     (1024x1024)
 *       Contents.json
 *
 * Info.plist CFBundleAlternateIcons[name].CFBundleIconName = "<name>"
 * (NOT CFBundleIconFiles — that's for flat PNGs)
 */

'use strict';

const path = require('path');
const fs   = require('fs');

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

// All sizes needed for a complete iOS appiconset
const APPICONSET_SIZES = [
  { filename: '20@2x', size: 40,   idiom: 'iphone', scale: '2x', iconWidth: 20 },
  { filename: '20@3x', size: 60,   idiom: 'iphone', scale: '3x', iconWidth: 20 },
  { filename: '29@2x', size: 58,   idiom: 'iphone', scale: '2x', iconWidth: 29 },
  { filename: '29@3x', size: 87,   idiom: 'iphone', scale: '3x', iconWidth: 29 },
  { filename: '40@2x', size: 80,   idiom: 'iphone', scale: '2x', iconWidth: 40 },
  { filename: '40@3x', size: 120,  idiom: 'iphone', scale: '3x', iconWidth: 40 },
  { filename: '60@2x', size: 120,  idiom: 'iphone', scale: '2x', iconWidth: 60 },
  { filename: '60@3x', size: 180,  idiom: 'iphone', scale: '3x', iconWidth: 60 },
  { filename: '20@1x', size: 20,   idiom: 'ipad',   scale: '1x', iconWidth: 20 },
  { filename: '20@2x-ipad', size: 40,  idiom: 'ipad', scale: '2x', iconWidth: 20 },
  { filename: '29@1x', size: 29,   idiom: 'ipad',   scale: '1x', iconWidth: 29 },
  { filename: '29@2x-ipad', size: 58, idiom: 'ipad', scale: '2x', iconWidth: 29 },
  { filename: '40@1x', size: 40,   idiom: 'ipad',   scale: '1x', iconWidth: 40 },
  { filename: '40@2x-ipad', size: 80, idiom: 'ipad', scale: '2x', iconWidth: 40 },
  { filename: '76@1x', size: 76,   idiom: 'ipad',   scale: '1x', iconWidth: 76 },
  { filename: '76@2x', size: 152,  idiom: 'ipad',   scale: '2x', iconWidth: 76 },
  { filename: '1024',  size: 1024, idiom: 'ios-marketing', scale: '1x', iconWidth: 1024 },
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
            logWithTimestamp(`[${TAG}] iOS app folder not found`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] App name from .xcodeproj: ${appFolderName}`);

          const xcassetsPath = findXcassetsPath(iosPlatDir, appFolderName);
          if (!xcassetsPath) {
            logWithTimestamp(`[${TAG}] .xcassets not found, skip`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] Using xcassets: ${xcassetsPath}`);

          return Promise.all(icons.map(icon =>
            downloadIconToAppiconset(icon, xcassetsPath)
          )).then(function (iconNames) {
            updateInfoPlist(iosPlatDir, appFolderName, iconNames);

            // Verify key sizes
            iconNames.forEach(function (name) {
              ['60@2x', '60@3x', '1024'].forEach(function (s) {
                const p = path.join(xcassetsPath, `${name}.appiconset`, `${name}-${s}.png`);
                logWithTimestamp(
                  `[${TAG}] VERIFY ${name}.appiconset/${name}-${s}.png: ` +
                  (fs.existsSync(p) ? '✅' : '❌ MISSING')
                );
              });
            });

            logSectionComplete(`[${TAG}] Registered: ${iconNames.join(', ')}`);
            resolve();
          });
        })
        .catch(function (err) {
          logWithTimestamp(`[${TAG}] Hook error (non-fatal): ${err.message}`);
          resolve();
        });

    } catch (err) {
      logWithTimestamp(`[${TAG}] Hook error (non-fatal): ${err.message}`);
      resolve();
    }
  });
};

// ============================================================================
// Find .xcassets directory
// ============================================================================

function findXcassetsPath(iosPlatDir, appFolderName) {
  const appPath = path.join(iosPlatDir, appFolderName);
  if (!fs.existsSync(appPath)) return null;

  const candidates = fs.readdirSync(appPath)
    .filter(f => f.endsWith('.xcassets'))
    .sort((a, b) => {
      if (a === 'Assets.xcassets') return -1;
      if (b === 'Assets.xcassets') return 1;
      return 0;
    });

  if (!candidates.length) return null;
  return path.join(appPath, candidates[0]);
}

// ============================================================================
// Download icon and create .appiconset in Assets.xcassets
// ============================================================================

function downloadIconToAppiconset(icon, xcassetsPath) {
  const name          = icon.name;
  const appiconsetDir = path.join(xcassetsPath, `${name}.appiconset`);

  ensureDirectoryExists(appiconsetDir);
  logWithTimestamp(`[${TAG}] Downloading: ${name} <- ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    return Promise.all(
      APPICONSET_SIZES.map(function (s) {
        const fileName = `${name}-${s.filename}.png`;
        const filePath = path.join(appiconsetDir, fileName);
        return resizeImage(buffer, filePath, s.size)
          .then(function () {
            logWithTimestamp(`[${TAG}]   + ${fileName} (${s.size}x${s.size})`);
          });
      })
    ).then(function () {
      // Write Contents.json — appiconset format
      const images = APPICONSET_SIZES.map(function (s) {
        return {
          filename: `${name}-${s.filename}.png`,
          idiom: s.idiom,
          scale: s.scale,
          size: `${s.iconWidth}x${s.iconWidth}`
        };
      });

      const contentsJson = {
        images: images,
        info: {
          author: 'cordova-plugin-change-app-info',
          version: 1
        }
      };

      const contentsPath = path.join(appiconsetDir, 'Contents.json');
      fs.writeFileSync(contentsPath, JSON.stringify(contentsJson, null, 2), 'utf8');
      logWithTimestamp(`[${TAG}] Written Contents.json for ${name}.appiconset`);

      return name;
    });
  });
}

// ============================================================================
// App name detection
// ============================================================================

function getAppNameFromXcodeProj(iosPlatDir) {
  if (!fs.existsSync(iosPlatDir)) return null;
  const items = fs.readdirSync(iosPlatDir);
  for (const item of items) {
    if (!item.startsWith('.') && item.endsWith('.xcodeproj'))
      return item.replace('.xcodeproj', '');
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
// Info.plist — dùng CFBundleIconName (asset catalog) thay CFBundleIconFiles (flat PNG)
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
    plistPath = scanForFile(iosPlatDir, ['Info.plist', '-Info.plist'], 3);
    if (plistPath) logWithTimestamp(`[${TAG}] Found plist: ${plistPath}`);
  }
  if (!plistPath) { logWithTimestamp(`[${TAG}] Info.plist not found`); return; }

  let plist = fs.readFileSync(plistPath, 'utf8');

  // UIApplicationSupportsAlternateIcons = true
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

  // Remove old CFBundleIcons blocks
  plist = plist.replace(/<key>CFBundleIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, '');
  plist = plist.replace(/<key>CFBundleIcons~ipad<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, '');

  // KEY FIX: use CFBundleIconName (asset catalog name) NOT CFBundleIconFiles (flat PNG)
  const altDict = iconNames.map(name =>
    `\t\t\t<key>${name}</key>\n\t\t\t<dict>\n` +
    `\t\t\t\t<key>CFBundleIconName</key>\n` +
    `\t\t\t\t<string>${name}</string>\n` +
    `\t\t\t\t<key>UIPrerenderedIcon</key>\n\t\t\t\t<false/>\n` +
    `\t\t\t</dict>\n`
  ).join('');

  const makeBlock = key =>
    `\t<key>${key}</key>\n\t<dict>\n` +
    `\t\t<key>CFBundlePrimaryIcon</key>\n\t\t<dict>\n` +
    `\t\t\t<key>CFBundleIconName</key>\n\t\t\t<string>AppIcon</string>\n` +
    `\t\t</dict>\n` +
    `\t\t<key>CFBundleAlternateIcons</key>\n\t\t<dict>\n` +
    altDict +
    `\t\t</dict>\n\t</dict>\n`;

  plist = plist.replace(
    /(\s*)<\/dict>(\s*)<\/plist>\s*$/,
    '\n' + makeBlock('CFBundleIcons') + makeBlock('CFBundleIcons~ipad') +
    '</dict>\n</plist>\n'
  );

  safeWriteFile(plistPath, plist);
  logWithTimestamp(`[${TAG}] Info.plist updated: ${plistPath}`);
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
