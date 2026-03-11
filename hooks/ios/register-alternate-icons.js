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

  // Không check context.opts.platforms — MABS có thể pass khác format
  // Detect bằng filesystem thay thế
  if (!fs.existsSync(iosPlatDir)) {
    return Promise.resolve();
  }

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

          // FIX: dùng getAppNameFromXcodeProj thay vì getIOSAppFolderName
          // để tránh MABS trả về .plugin-backup
          const appFolderName = getAppNameFromXcodeProj(iosPlatDir);
          if (!appFolderName) {
            logWithTimestamp(`⚠️  [${TAG}] iOS app folder not found`);
            resolve();
            return;
          }

          const xcodeProjDir = path.join(iosPlatDir, appFolderName);
          const resourcesDir = path.join(xcodeProjDir, 'Resources', 'RuntimeIcons');
          ensureDirectoryExists(resourcesDir);

          return Promise.all(icons.map(icon => downloadIconForIos(icon, resourcesDir)))
            .then(function (iconNames) {
              updateInfoPlist(iosPlatDir, appFolderName, iconNames);
              updatePbxproj(iosPlatDir, appFolderName, iconNames);
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
// App name detection — bỏ qua hidden folder (.plugin-backup, v.v.)
// ============================================================================

function getAppNameFromXcodeProj(iosPlatDir) {
  if (!fs.existsSync(iosPlatDir)) return null;

  const items = fs.readdirSync(iosPlatDir);

  // Ưu tiên: tìm .xcodeproj không phải hidden
  for (const item of items) {
    if (!item.startsWith('.') && item.endsWith('.xcodeproj')) {
      const name = item.replace('.xcodeproj', '');
      logWithTimestamp(`[${TAG}] App name from .xcodeproj: ${name}`);
      return name;
    }
  }

  // Fallback: tìm folder không phải hidden/system
  const excluded = ['CordovaLib', 'www', 'cordova', 'build', 'DerivedData', 'Pods'];
  for (const item of items) {
    if (item.startsWith('.')) continue;
    const fullPath = path.join(iosPlatDir, item);
    try {
      if (fs.statSync(fullPath).isDirectory() && !excluded.includes(item)) {
        logWithTimestamp(`[${TAG}] App name from folder: ${item}`);
        return item;
      }
    } catch (_) {}
  }

  return null;
}

// ============================================================================
// Download & resize
// ============================================================================

function downloadIconForIos(icon, resourcesDir) {
  const name    = icon.name;
  const iconDir = path.join(resourcesDir, name);
  ensureDirectoryExists(iconDir);

  logWithTimestamp(`[${TAG}] Downloading: ${name} ← ${icon.resource}`);

  return downloadFile(icon.resource).then(function (buffer) {
    // Lưu bản 1024 gốc để debug
    fs.writeFileSync(path.join(iconDir, 'Icon-1024.png'), buffer);

    return Promise.all(
      ICON_VARIANTS.map(v =>
        resizeImage(buffer, path.join(iconDir, `Icon${v.suffix}.png`), v.size)
          .then(() => logWithTimestamp(`[${TAG}]   ✔ ${name} — Icon${v.suffix}.png (${v.size}px)`))
      )
    ).then(() => name);
  });
}

// ============================================================================
// Info.plist update
// ============================================================================

function updateInfoPlist(iosPlatDir, appFolderName, iconNames) {
  // Tìm Info.plist với nhiều path candidates
  const candidates = [
    path.join(iosPlatDir, appFolderName, appFolderName + '-Info.plist'),
    path.join(iosPlatDir, appFolderName, 'Info.plist'),
    path.join(iosPlatDir, appFolderName + '-Info.plist'),
    path.join(iosPlatDir, 'Info.plist'),
  ];

  let plistPath = candidates.find(p => fs.existsSync(p));

  // Fallback: scan filesystem
  if (!plistPath) {
    logWithTimestamp(`[${TAG}] Scanning for Info.plist...`);
    plistPath = scanForFile(iosPlatDir, ['Info.plist', '-Info.plist'], 3);
    if (plistPath) {
      logWithTimestamp(`[${TAG}] Found Info.plist at: ${plistPath}`);
    }
  }

  if (!plistPath) {
    logWithTimestamp(`⚠️  [${TAG}] Info.plist not found after scan`);
    return;
  }

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

  // Xóa block cũ tránh duplicate
  plist = plist.replace(
    /<key>CFBundleIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );
  plist = plist.replace(
    /<key>CFBundleIcons~ipad<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>\s*<\/plist>)/g, ''
  );

  // Build CFBundleAlternateIcons dict
  const altDict = iconNames.map(name =>
    `\t\t\t<key>${name}</key>\n\t\t\t<dict>\n` +
    `\t\t\t\t<key>CFBundleIconFiles</key>\n` +
    `\t\t\t\t<array><string>RuntimeIcons/${name}/Icon</string></array>\n` +
    `\t\t\t\t<key>UIPrerenderedIcon</key>\n\t\t\t\t<false/>\n` +
    `\t\t\t</dict>\n`
  ).join('');

  const makeBlock = key =>
    `\t<key>${key}</key>\n\t<dict>\n` +
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
// project.pbxproj update — manual, không cần xcode npm package
// ============================================================================

function updatePbxproj(iosPlatDir, appFolderName, iconNames) {
  const pbxprojPath = path.join(
    iosPlatDir,
    appFolderName + '.xcodeproj',
    'project.pbxproj'
  );

  if (!fs.existsSync(pbxprojPath)) {
    logWithTimestamp(`⚠️  [${TAG}] project.pbxproj not found: ${pbxprojPath}`);
    return;
  }

  let pbx     = fs.readFileSync(pbxprojPath, 'utf8');
  let changed = false;

  iconNames.forEach(function (iconName) {
    ICON_VARIANTS.forEach(function (v) {
      const fileName    = `Icon${v.suffix}.png`;
      const displayName = `RuntimeIcons/${iconName}/${fileName}`;
      // path tương đối từ SOURCE_ROOT (platforms/ios/)
      const pbxRelPath  = `${appFolderName}/Resources/RuntimeIcons/${iconName}/${fileName}`;

      if (pbx.includes(displayName)) {
        logWithTimestamp(`[${TAG}] Already in pbxproj: ${displayName}`);
        return;
      }

      const seed  = `${appFolderName}/${iconName}/${fileName}`;
      const uuid1 = deterministicUUID(seed + ':fileRef');
      const uuid2 = deterministicUUID(seed + ':buildFile');

      const fileRef =
        `\t\t${uuid1} /* ${fileName} */ = {\n` +
        `\t\t\tisa = PBXFileReference;\n` +
        `\t\t\tlastKnownFileType = image.png;\n` +
        `\t\t\tname = "${fileName}";\n` +
        `\t\t\tpath = "${pbxRelPath}";\n` +
        `\t\t\tsourceTree = "SOURCE_ROOT";\n` +
        `\t\t};\n`;

      const buildFile =
        `\t\t${uuid2} /* ${fileName} in Resources */ = {\n` +
        `\t\t\tisa = PBXBuildFile;\n` +
        `\t\t\tfileRef = ${uuid1} /* ${fileName} */;\n` +
        `\t\t};\n`;

      if (!pbx.includes('/* End PBXFileReference section */')) {
        logWithTimestamp(`⚠️  [${TAG}] PBXFileReference section not found`);
        return;
      }

      pbx = pbx.replace(
        '/* End PBXFileReference section */',
        fileRef + '\t\t/* End PBXFileReference section */'
      );
      pbx = pbx.replace(
        '/* End PBXBuildFile section */',
        buildFile + '\t\t/* End PBXBuildFile section */'
      );

      // Inject vào Copy Bundle Resources phase
      pbx = pbx.replace(
        /(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()([\s\S]*?)(\);)/m,
        (match, before, middle, after) =>
          before + middle + `\t\t\t\t${uuid2} /* ${fileName} in Resources */,\n` + after
      );

      logWithTimestamp(`[${TAG}] Added to pbxproj: ${displayName}`);
      changed = true;
    });
  });

  if (changed) {
    safeWriteFile(pbxprojPath, pbx);
    logWithTimestamp(`[${TAG}] ✔ project.pbxproj updated`);
  } else {
    logWithTimestamp(`[${TAG}] project.pbxproj — no changes needed`);
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * UUID deterministic từ seed — cùng input = cùng UUID
 * Rebuild nhiều lần không tạo duplicate entry trong pbxproj
 */
function deterministicUUID(seed) {
  return crypto
    .createHash('md5')
    .update(seed)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
}

/**
 * Scan đệ quy tìm file theo pattern
 * Bỏ qua hidden folders và system folders
 */
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
