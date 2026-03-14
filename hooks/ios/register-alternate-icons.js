/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised v6
 *
 * STRATEGY v6: resource-file placeholders + overwrite
 * ---------------------------------------------------
 * plugin.xml declares <resource-file> for each alternate icon placeholder.
 * Cordova prepare automatically:
 *   1. Copies placeholder PNGs → platforms/ios/<App>/Resources/
 *   2. Injects PBXFileReference + PBXBuildFile + PBXResourcesBuildPhase
 *      into project.pbxproj
 *
 * This hook runs at before_compile and:
 *   1. Reads ICON_CDN_URL from config.xml
 *   2. Fetches icon list JSON from CDN
 *   3. For each icon, downloads real PNG and OVERWRITES the placeholder
 *      that Cordova already registered in pbxproj
 *   4. Updates Info.plist with CFBundleIconFiles pointing to the real names
 *   5. Also adds real-named resource-file entries to pbxproj if not present
 *      (for icons whose name != placeholder)
 *
 * KEY INSIGHT (from EddyVerbruggen/cordova-plugin-app-icon-changer):
 *   - Icons must be in Resources/ AND referenced in pbxproj
 *   - CFBundleIconFiles uses flat name without @2x/@3x — iOS resolves automatically
 *   - Only 1 size needed; iOS scales down from largest
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
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

          logWithTimestamp(`[${TAG}] App name: ${appFolderName}`);

          const resourcesDir = path.join(iosPlatDir, appFolderName, 'Resources');
          ensureDirectoryExists(resourcesDir);
          logWithTimestamp(`[${TAG}] Resources dir: ${resourcesDir}`);

          return Promise.all(icons.map(icon =>
            downloadAndPlaceIcon(icon, resourcesDir, iosPlatDir, appFolderName)
          )).then(function (iconNames) {
            updateInfoPlist(iosPlatDir, appFolderName, iconNames);

            // Verify
            iconNames.forEach(function (name) {
              ICON_VARIANTS.forEach(function (v) {
                const p = path.join(resourcesDir, `${name}${v.suffix}.png`);
                logWithTimestamp(
                  `[${TAG}] VERIFY ${name}${v.suffix}.png: ` +
                  (fs.existsSync(p) ? '✅ (' + fs.statSync(p).size + ' bytes)' : '❌ MISSING')
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
// Download icon PNG and place in Resources/
// Also injects pbxproj if entry not already there
// ============================================================================

function downloadAndPlaceIcon(icon, resourcesDir, iosPlatDir, appFolderName) {
  const name = icon.name;
  logWithTimestamp(`[${TAG}] Downloading: ${name} <- ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    return Promise.all(
      ICON_VARIANTS.map(function (v) {
        const fileName = `${name}${v.suffix}.png`;
        const filePath = path.join(resourcesDir, fileName);
        return resizeImage(buffer, filePath, v.size)
          .then(function () {
            const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
            logWithTimestamp(`[${TAG}]   + ${fileName} (${v.size}px, ${size} bytes)`);
          });
      })
    ).then(function () {
      // Inject pbxproj entry for this icon name (Cordova only added placeholder)
      injectPbxprojIfNeeded(iosPlatDir, appFolderName, name);
      return name;
    });
  });
}

// ============================================================================
// Inject pbxproj entries for <name>@2x.png / <name>@3x.png
// Safe to call multiple times — checks UUID before inserting
// ============================================================================

function makePbxUuid(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24).toUpperCase();
}

function injectPbxprojIfNeeded(iosPlatDir, appFolderName, iconName) {
  const pbxprojPath = path.join(
    iosPlatDir,
    `${appFolderName}.xcodeproj`,
    'project.pbxproj'
  );
  if (!fs.existsSync(pbxprojPath)) return;

  let pbx = fs.readFileSync(pbxprojPath, 'utf8');

  const fileRefLines   = [];
  const buildFileLines = [];
  const buildFileUuids = [];

  ICON_VARIANTS.forEach(function (v) {
    const fileName     = `${iconName}${v.suffix}.png`;
    const fileRefUuid  = makePbxUuid('FileRef_'   + fileName);
    const buildUuid    = makePbxUuid('BuildFile_' + fileName);

    if (pbx.includes(fileRefUuid)) {
      logWithTimestamp(`[${TAG}] pbxproj: already has ${fileName}`);
      buildFileUuids.push({ uuid: buildUuid, fileName });
      return;
    }

    fileRefLines.push(
      `\t\t${fileRefUuid} /* ${fileName} */ = ` +
      `{isa = PBXFileReference; lastKnownFileType = image.png; ` +
      `name = "${fileName}"; path = "Resources/${fileName}"; sourceTree = "<group>"; };`
    );
    buildFileLines.push(
      `\t\t${buildUuid} /* ${fileName} in Resources */ = ` +
      `{isa = PBXBuildFile; fileRef = ${fileRefUuid} /* ${fileName} */; };`
    );
    buildFileUuids.push({ uuid: buildUuid, fileName });
    logWithTimestamp(`[${TAG}] pbxproj: queued ${fileName}`);
  });

  if (fileRefLines.length > 0) {
    pbx = pbx.replace(
      /(\/\* Begin PBXFileReference section \*\/)/,
      '$1\n' + fileRefLines.join('\n')
    );
    pbx = pbx.replace(
      /(\/\* Begin PBXBuildFile section \*\/)/,
      '$1\n' + buildFileLines.join('\n')
    );

    const phaseEntries = buildFileUuids
      .map(e => `\t\t\t\t${e.uuid} /* ${e.fileName} in Resources */,`)
      .join('\n');
    pbx = pbx.replace(
      /(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/,
      '$1\n' + phaseEntries
    );

    fs.writeFileSync(pbxprojPath, pbx, 'utf8');
    logWithTimestamp(`[${TAG}] pbxproj: updated for ${iconName}`);
  } else {
    logWithTimestamp(`[${TAG}] pbxproj: no changes needed for ${iconName}`);
  }
}

// ============================================================================
// Info.plist — CFBundleIconFiles (flat name, iOS resolves @2x/@3x)
// ============================================================================

function updateInfoPlist(iosPlatDir, appFolderName, iconNames) {
  const candidates = [
    path.join(iosPlatDir, appFolderName, `${appFolderName}-Info.plist`),
    path.join(iosPlatDir, appFolderName, 'Info.plist'),
    path.join(iosPlatDir, `${appFolderName}-Info.plist`),
    path.join(iosPlatDir, 'Info.plist'),
  ];

  let plistPath = candidates.find(p => fs.existsSync(p));
  if (!plistPath) {
    plistPath = scanForFile(iosPlatDir, ['Info.plist', '-Info.plist'], 3);
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

  // CFBundleIconFiles: flat name — iOS resolves @2x/@3x automatically from bundle root
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
// Helpers
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
