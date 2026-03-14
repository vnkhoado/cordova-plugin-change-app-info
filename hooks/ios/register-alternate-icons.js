/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised
 *
 * Cordova before_compile hook (iOS).
 *
 * What it does:
 *   1. Reads ICON_CDN_URL from config.xml
 *   2. Fetches the CDN JSON (icon list)
 *   3. Downloads each PNG icon (must be 1024x1024)
 *   4. Saves flat files: platforms/ios/<AppName>/Resources/<name>@2x.png + @3x.png
 *   5. Injects PBXFileReference + PBXBuildFile + PBXResourcesBuildPhase into .pbxproj
 *      so Xcode copies the PNGs into the app bundle
 *   6. Updates *-Info.plist:
 *        - UIApplicationSupportsAlternateIcons = true
 *        - CFBundleAlternateIcons with flat CFBundleIconFiles (no path)
 *
 * ROOT CAUSE FIX: iOS setAlternateIconName requires icons to be in the app bundle.
 *   Writing to Resources/ is not enough — Xcode must know about the files via .pbxproj.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

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
            logWithTimestamp(`[${TAG}] iOS app folder not found`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] App name from .xcodeproj: ${appFolderName}`);

          const bundleIconsDir = path.join(iosPlatDir, appFolderName, 'Resources');
          ensureDirectoryExists(bundleIconsDir);
          logWithTimestamp(`[${TAG}] bundle icon path: ${bundleIconsDir}`);

          return Promise.all(icons.map(icon =>
            downloadIconForIos(icon, bundleIconsDir)
          )).then(function (iconNames) {

            // Build list of all PNG filenames to inject
            const pngFiles = [];
            iconNames.forEach(function (name) {
              ICON_VARIANTS.forEach(function (v) {
                pngFiles.push(`${name}${v.suffix}.png`);
              });
            });

            // Inject into .pbxproj so Xcode copies PNGs into .app bundle
            injectIntoPbxproj(iosPlatDir, appFolderName, pngFiles);

            updateInfoPlist(iosPlatDir, appFolderName, iconNames);

            // Verify
            iconNames.forEach(function (name) {
              ICON_VARIANTS.forEach(function (v) {
                const p = path.join(bundleIconsDir, `${name}${v.suffix}.png`);
                logWithTimestamp(
                  `[${TAG}] VERIFY Resources/${name}${v.suffix}.png: ` +
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
// .pbxproj injection
// Adds PBXFileReference, PBXBuildFile, and PBXResourcesBuildPhase entries
// so Xcode copies the icon PNGs into the .app bundle at compile time.
// ============================================================================

function makePbxUuid(seed) {
  // Deterministic 24-char uppercase hex UUID from a seed string
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24).toUpperCase();
}

function injectIntoPbxproj(iosPlatDir, appFolderName, pngFiles) {
  const pbxprojPath = path.join(
    iosPlatDir,
    appFolderName + '.xcodeproj',
    'project.pbxproj'
  );

  if (!fs.existsSync(pbxprojPath)) {
    logWithTimestamp(`[${TAG}] project.pbxproj not found: ${pbxprojPath}`);
    return;
  }

  let pbx = fs.readFileSync(pbxprojPath, 'utf8');

  const fileRefLines  = [];
  const buildFileLines = [];
  const buildFileUuids = [];

  pngFiles.forEach(function (fileName) {
    const fileRefUuid  = makePbxUuid('FileRef_'  + fileName);
    const buildFileUuid = makePbxUuid('BuildFile_' + fileName);

    // Skip if already present
    if (pbx.includes(fileRefUuid)) {
      logWithTimestamp(`[${TAG}] Already in pbxproj: ${fileName}`);
      buildFileUuids.push(buildFileUuid);
      return;
    }

    fileRefLines.push(
      `\t\t${fileRefUuid} /* ${fileName} */ = ` +
      `{isa = PBXFileReference; lastKnownFileType = image.png; ` +
      `name = "${fileName}"; path = "Resources/${fileName}"; ` +
      `sourceTree = "<group>"; };`
    );

    buildFileLines.push(
      `\t\t${buildFileUuid} /* ${fileName} in Resources */ = ` +
      `{isa = PBXBuildFile; fileRef = ${fileRefUuid} /* ${fileName} */; };`
    );

    buildFileUuids.push(buildFileUuid);
    logWithTimestamp(`[${TAG}] Queued pbxproj entry: ${fileName}`);
  });

  // 1. Inject PBXFileReference entries after the first PBXFileReference block marker
  if (fileRefLines.length > 0) {
    pbx = pbx.replace(
      /(\/\* Begin PBXFileReference section \*\/)/,
      '$1\n' + fileRefLines.join('\n')
    );

    // 2. Inject PBXBuildFile entries
    pbx = pbx.replace(
      /(\/\* Begin PBXBuildFile section \*\/)/,
      '$1\n' + buildFileLines.join('\n')
    );
  }

  // 3. Inject into PBXResourcesBuildPhase files list
  //    Find the Resources build phase and append our UUIDs to its files array
  if (buildFileUuids.length > 0) {
    const resourcesPhaseEntries = buildFileUuids
      .map(uuid => `\t\t\t\t${uuid} /* ${pngFiles[buildFileUuids.indexOf(uuid)]} in Resources */,`)
      .join('\n');

    // Match the Resources build phase by its name
    pbx = pbx.replace(
      /(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/,
      '$1\n' + resourcesPhaseEntries
    );
  }

  fs.writeFileSync(pbxprojPath, pbx, 'utf8');
  logWithTimestamp(`[${TAG}] project.pbxproj updated: ${pbxprojPath}`);
}

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
// Download & resize
// ============================================================================

function downloadIconForIos(icon, bundleDir) {
  const name = icon.name;
  logWithTimestamp(`[${TAG}] Downloading: ${name} <- ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    fs.writeFileSync(path.join(bundleDir, `${name}-1024.png`), buffer);

    return Promise.all(
      ICON_VARIANTS.map(function (v) {
        const fileName = `${name}${v.suffix}.png`;
        return resizeImage(buffer, path.join(bundleDir, fileName), v.size)
          .then(function () {
            logWithTimestamp(`[${TAG}]   + ${name} - ${fileName} (${v.size}px)`);
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
    plistPath = scanForFile(iosPlatDir, ['Info.plist', '-Info.plist'], 3);
    if (plistPath) logWithTimestamp(`[${TAG}] Found plist: ${plistPath}`);
  }
  if (!plistPath) {
    logWithTimestamp(`[${TAG}] Info.plist not found`);
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');

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

  plist = plist.replace(
    /<key>CFBundleIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );
  plist = plist.replace(
    /<key>CFBundleIcons~ipad<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );

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
