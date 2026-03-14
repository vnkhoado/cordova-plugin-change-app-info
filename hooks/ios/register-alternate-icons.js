/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised v3
 *
 * Cordova before_compile hook (iOS).
 *
 * APPROACH v3: Assets.xcassets imageset (no pbxproj modification needed)
 * -----------------------------------------------------------------------
 * Instead of copying flat PNGs into Resources/ and injecting .pbxproj
 * (which is unreliable in MABS cloud builds), we create a proper
 * Named Image Set inside Assets.xcassets:
 *
 *   Assets.xcassets/
 *     tet2026.imageset/
 *       tet2026@2x.png   (120x120)
 *       tet2026@3x.png   (180x180)
 *       Contents.json
 *
 * Xcode automatically bundles everything inside .xcassets — no pbxproj touch.
 * iOS setAlternateIconName resolves named images from the asset catalog.
 *
 * Info.plist CFBundleIconFiles still uses the flat name ("tet2026"),
 * which iOS resolves against the asset catalog at runtime.
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

const ICON_VARIANTS = [
  { suffix: '@2x', size: 120, scale: '2x' },
  { suffix: '@3x', size: 180, scale: '3x' },
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

          // Find Assets.xcassets (prefer Assets.xcassets > Images.xcassets)
          const xcassetsPath = findXcassetsPath(iosPlatDir, appFolderName);
          if (!xcassetsPath) {
            logWithTimestamp(`[${TAG}] .xcassets not found, falling back to Resources/`);
            // Fallback: flat Resources + pbxproj (previous approach)
            return fallbackToResources(iosPlatDir, appFolderName, icons, resolve);
          }

          logWithTimestamp(`[${TAG}] Using xcassets: ${xcassetsPath}`);

          return Promise.all(icons.map(icon =>
            downloadIconToImageset(icon, xcassetsPath)
          )).then(function (iconNames) {
            updateInfoPlist(iosPlatDir, appFolderName, iconNames);

            // Verify imageset files
            iconNames.forEach(function (name) {
              ICON_VARIANTS.forEach(function (v) {
                const p = path.join(xcassetsPath, `${name}.imageset`, `${name}${v.suffix}.png`);
                logWithTimestamp(
                  `[${TAG}] VERIFY ${name}.imageset/${name}${v.suffix}.png: ` +
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
// Download icon and create Named Image Set in Assets.xcassets
//
// Creates:
//   <xcassetsPath>/<name>.imageset/
//     <name>@2x.png
//     <name>@3x.png
//     Contents.json
// ============================================================================

function downloadIconToImageset(icon, xcassetsPath) {
  const name        = icon.name;
  const imagesetDir = path.join(xcassetsPath, `${name}.imageset`);

  ensureDirectoryExists(imagesetDir);
  logWithTimestamp(`[${TAG}] Downloading: ${name} <- ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    return Promise.all(
      ICON_VARIANTS.map(function (v) {
        const fileName = `${name}${v.suffix}.png`;
        const filePath = path.join(imagesetDir, fileName);
        return resizeImage(buffer, filePath, v.size)
          .then(function () {
            logWithTimestamp(`[${TAG}]   + ${name} - ${fileName} (${v.size}px)`);
          });
      })
    ).then(function () {
      // Write Contents.json for this imageset
      const contentsJson = {
        images: ICON_VARIANTS.map(function (v) {
          return {
            idiom: 'iphone',
            scale: v.scale,
            filename: `${name}${v.suffix}.png`
          };
        }).concat(ICON_VARIANTS.map(function (v) {
          return {
            idiom: 'ipad',
            scale: v.scale,
            filename: `${name}${v.suffix}.png`
          };
        })),
        info: {
          author: 'cordova-plugin-change-app-info',
          version: 1
        }
      };

      const contentsPath = path.join(imagesetDir, 'Contents.json');
      fs.writeFileSync(contentsPath, JSON.stringify(contentsJson, null, 2), 'utf8');
      logWithTimestamp(`[${TAG}] Written Contents.json for ${name}.imageset`);

      return name;
    });
  });
}

// ============================================================================
// Fallback: flat Resources/ (for projects without .xcassets)
// ============================================================================

function fallbackToResources(iosPlatDir, appFolderName, icons, resolve) {
  const crypto = require('crypto');
  const bundleIconsDir = path.join(iosPlatDir, appFolderName, 'Resources');
  ensureDirectoryExists(bundleIconsDir);
  logWithTimestamp(`[${TAG}] Fallback bundle icon path: ${bundleIconsDir}`);

  return Promise.all(icons.map(function (icon) {
    const name = icon.name;
    logWithTimestamp(`[${TAG}] Downloading (fallback): ${name} <- ${icon.resource}`);
    return downloadFile(icon.resource).then(function (buffer) {
      return Promise.all(ICON_VARIANTS.map(function (v) {
        const fileName = `${name}${v.suffix}.png`;
        return resizeImage(buffer, path.join(bundleIconsDir, fileName), v.size)
          .then(() => logWithTimestamp(`[${TAG}]   + ${name} - ${fileName} (${v.size}px)`));
      })).then(() => name);
    });
  })).then(function (iconNames) {
    injectIntoPbxproj(iosPlatDir, appFolderName, iconNames, crypto);
    updateInfoPlist(iosPlatDir, appFolderName, iconNames);
    iconNames.forEach(function (name) {
      ICON_VARIANTS.forEach(function (v) {
        const p = path.join(bundleIconsDir, `${name}${v.suffix}.png`);
        logWithTimestamp(
          `[${TAG}] VERIFY Resources/${name}${v.suffix}.png: ` +
          (fs.existsSync(p) ? '✅' : '❌ MISSING')
        );
      });
    });
    logSectionComplete(`[${TAG}] Registered (fallback): ${iconNames.join(', ')}`);
    resolve();
  });
}

function injectIntoPbxproj(iosPlatDir, appFolderName, iconNames, crypto) {
  const pbxprojPath = path.join(iosPlatDir, appFolderName + '.xcodeproj', 'project.pbxproj');
  if (!fs.existsSync(pbxprojPath)) return;

  let pbx = fs.readFileSync(pbxprojPath, 'utf8');
  const makePbxUuid = seed =>
    crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24).toUpperCase();

  const pngFiles = [];
  iconNames.forEach(n => ICON_VARIANTS.forEach(v => pngFiles.push(`${n}${v.suffix}.png`)));

  const fileRefLines = [], buildFileLines = [], buildFileUuids = [];

  pngFiles.forEach(function (fileName) {
    const fileRefUuid   = makePbxUuid('FileRef_'   + fileName);
    const buildFileUuid = makePbxUuid('BuildFile_' + fileName);
    if (pbx.includes(fileRefUuid)) {
      buildFileUuids.push(buildFileUuid);
      return;
    }
    fileRefLines.push(
      `\t\t${fileRefUuid} /* ${fileName} */ = ` +
      `{isa = PBXFileReference; lastKnownFileType = image.png; ` +
      `name = "${fileName}"; path = "Resources/${fileName}"; sourceTree = "<group>"; };`
    );
    buildFileLines.push(
      `\t\t${buildFileUuid} /* ${fileName} in Resources */ = ` +
      `{isa = PBXBuildFile; fileRef = ${fileRefUuid} /* ${fileName} */; };`
    );
    buildFileUuids.push(buildFileUuid);
  });

  if (fileRefLines.length) {
    pbx = pbx.replace(/(\/\* Begin PBXFileReference section \*\/)/, '$1\n' + fileRefLines.join('\n'));
    pbx = pbx.replace(/(\/\* Begin PBXBuildFile section \*\/)/, '$1\n' + buildFileLines.join('\n'));
  }
  if (buildFileUuids.length) {
    const entries = buildFileUuids
      .map((uuid, i) => `\t\t\t\t${uuid} /* ${pngFiles[i]} in Resources */,`)
      .join('\n');
    pbx = pbx.replace(/(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()/, '$1\n' + entries);
  }

  fs.writeFileSync(pbxprojPath, pbx, 'utf8');
  logWithTimestamp(`[${TAG}] project.pbxproj updated (fallback)`);
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

  // CFBundleIconFiles: flat name — iOS resolves from asset catalog automatically
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
