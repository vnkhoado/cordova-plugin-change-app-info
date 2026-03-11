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
          try { return JSON.parse(buffer.toString('utf8')); }
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

          return Promise.all(icons.map(function (icon) {
            return downloadIconForIos(icon, resourcesDir);
          })).then(function (iconNames) {
            updateInfoPlist(iosPlatDir, appFolderName, iconNames);
            addResourceFilesToXcodeProject(iosPlatDir, appFolderName, resourcesDir, iconNames);
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
// Download & resize
// ---------------------------------------------------------------------------

// iOS alternate icon naming convention: Icon@2x.png (120px), Icon@3x.png (180px)
// CFBundleIconFiles trỏ tới "RuntimeIcons/<name>/Icon"
// iOS tự tìm Icon@2x.png và Icon@3x.png
const ICON_VARIANTS = [
  { suffix: '@2x', size: 120 },
  { suffix: '@3x', size: 180 },
];

function downloadIconForIos(icon, resourcesDir) {
  const name    = icon.name;
  const iconDir = path.join(resourcesDir, name);
  ensureDirectoryExists(iconDir);

  logWithTimestamp(`[${TAG}] Downloading: ${name} ← ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    // Lưu bản gốc 1024 (tham chiếu, không dùng trực tiếp)
    fs.writeFileSync(path.join(iconDir, 'Icon-1024.png'), buffer);

    return Promise.all(
      ICON_VARIANTS.map(v =>
        resizeImage(
          buffer,
          path.join(iconDir, `Icon${v.suffix}.png`),
          v.size
        ).then(() => logWithTimestamp(`[${TAG}]   ✔ ${name} — Icon${v.suffix}.png (${v.size}px)`))
      )
    ).then(() => name);
  });
}

// ---------------------------------------------------------------------------
// Xcode project — add resource files vào Copy Bundle Resources
// ---------------------------------------------------------------------------

function addResourceFilesToXcodeProject(iosPlatDir, appFolderName, resourcesDir, iconNames) {
  let xcode;
  try { xcode = require('xcode'); } catch (e) {
    logWithTimestamp(`⚠️  [${TAG}] xcode package not found — icons may not be bundled (run: npm install xcode)`);
    return;
  }

  const pbxprojPath = path.join(
    iosPlatDir,
    appFolderName + '.xcodeproj',
    'project.pbxproj'
  );

  if (!fs.existsSync(pbxprojPath)) {
    logWithTimestamp(`⚠️  [${TAG}] project.pbxproj not found: ${pbxprojPath}`);
    return;
  }

  const proj = xcode.project(pbxprojPath);
  proj.parseSync();

  let changed = false;

  iconNames.forEach(function (iconName) {
    const iconDir = path.join(resourcesDir, iconName);
    if (!fs.existsSync(iconDir)) return;

    ICON_VARIANTS.forEach(function (v) {
      const fileName  = `Icon${v.suffix}.png`;
      const fullPath  = path.join(iconDir, fileName);
      if (!fs.existsSync(fullPath)) return;

      // Path tương đối từ Xcode project root
      const relPath = path.join('Resources', 'RuntimeIcons', iconName, fileName);

      // Kiểm tra đã add chưa để tránh duplicate
      const refs = proj.pbxFileReferenceSection();
      const alreadyAdded = Object.values(refs).some(
        f => f && typeof f === 'object' && f.path &&
             f.path.replace(/"/g, '') === relPath.replace(/\\/g, '/')
      );

      if (alreadyAdded) {
        logWithTimestamp(`[${TAG}] Already in project: ${relPath}`);
        return;
      }

      proj.addResourceFile(relPath);
      logWithTimestamp(`[${TAG}] Added to Xcode project: ${relPath}`);
      changed = true;
    });
  });

  if (changed) {
    fs.writeFileSync(pbxprojPath, proj.writeSync());
    logWithTimestamp(`[${TAG}] ✔ project.pbxproj updated`);
  } else {
    logWithTimestamp(`[${TAG}] project.pbxproj — no changes needed`);
  }
}

// ---------------------------------------------------------------------------
// Info.plist update
// ---------------------------------------------------------------------------

function updateInfoPlist(iosPlatDir, appFolderName, iconNames) {
  const candidates = [
    path.join(iosPlatDir, appFolderName, appFolderName + '-Info.plist'),
    path.join(iosPlatDir, appFolderName, 'Info.plist')
  ];
  const plistPath = candidates.find(p => fs.existsSync(p));

  if (!plistPath) {
    logWithTimestamp(`⚠️  [${TAG}] Info.plist not found`);
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');

  // UIApplicationSupportsAlternateIcons = true
  if (!plist.includes('UIApplicationSupportsAlternateIcons')) {
    plist = plist.replace(
      /\s*<\/dict>\s*\n?\s*<\/plist>\s*$/,
      '\n\t<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>\n</dict>\n</plist>'
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
      // CFBundleIconFiles trỏ tới "RuntimeIcons/<name>/Icon"
      // iOS tự tìm Icon@2x.png và Icon@3x.png trong cùng folder
      `\t\t\t\t<key>CFBundleIconFiles</key>\n` +
      `\t\t\t\t<array><string>RuntimeIcons/${name}/Icon</string></array>\n` +
      `\t\t\t\t<key>UIPrerenderedIcon</key>\n\t\t\t\t<false/>\n` +
      `\t\t\t</dict>\n`
    ).join('');
  }

  const makeBlock = key =>
    `\t<key>${key}</key>\n\t<dict>\n` +
    `\t\t<key>CFBundleAlternateIcons</key>\n\t\t<dict>\n` +
    buildAltDict(iconNames) +
    `\t\t</dict>\n\t</dict>\n`;

  plist = plist.replace(
    /\s*<\/dict>\s*\n?\s*<\/plist>\s*$/,
    '\n' + makeBlock('CFBundleIcons') +
    makeBlock('CFBundleIcons~ipad') +
    '</dict>\n</plist>'
  );

  safeWriteFile(plistPath, plist);
  logWithTimestamp(`[${TAG}] ✔ Info.plist updated: ${plistPath}`);
}
