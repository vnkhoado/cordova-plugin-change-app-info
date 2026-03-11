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
const crypto = require('crypto'); // built-in Node.js — không cần npm

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

// iOS alternate icon: chỉ cần @2x (120px) và @3x (180px)
// CFBundleIconFiles = "RuntimeIcons/<name>/Icon"
// iOS tự resolve → Icon@2x.png, Icon@3x.png
const ICON_VARIANTS = [
  { suffix: '@2x', size: 120 },
  { suffix: '@3x', size: 180 },
];

// ============================================================================
// Entry point
// ============================================================================

module.exports = function (context) {
  const platforms = context.opts.platforms || [];
  if (!platforms.includes('ios')) return Promise.resolve();

  return new Promise(function (resolve) {
    try {
      const root       = context.opts.projectRoot;
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
        .then(buf => {
          try { return JSON.parse(buf.toString('utf8')); }
          catch (e) { throw new Error('JSON parse error: ' + e.message); }
        })
        .then(json => {
          const icons = Array.isArray(json.icons) ? json.icons : [];
          if (!icons.length) {
            logWithTimestamp(`[${TAG}] No icons in JSON, skip`);
            resolve();
            return;
          }

          logWithTimestamp(`[${TAG}] Found ${icons.length} icon(s): ${icons.map(i => i.name).join(', ')}`);

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

          return Promise.all(icons.map(icon => downloadIconForIos(icon, resourcesDir)))
            .then(iconNames => {
              updateInfoPlist(iosPlatDir, appFolderName, iconNames);
              updatePbxproj(iosPlatDir, appFolderName, iconNames);
              logSectionComplete(`✅ [${TAG}] Registered: ${iconNames.join(', ')}`);
              resolve();
            });
        })
        .catch(err => {
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
// Download & resize
// ============================================================================

function downloadIconForIos(icon, resourcesDir) {
  const name    = icon.name;
  const iconDir = path.join(resourcesDir, name);
  ensureDirectoryExists(iconDir);

  logWithTimestamp(`[${TAG}] Downloading: ${name} ← ${icon.resource}`);

  return downloadFile(icon.resource).then(buffer => {
    // 1024 gốc giữ lại để debug — không được bundle vào ipa
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

  const altDict = iconNames.map(name =>
    `\t\t\t<key>${name}</key>\n\t\t\t<dict>\n` +
    `\t\t\t\t<key>CFBundleIconFiles</key>\n` +
    // Trỏ tới "RuntimeIcons/<name>/Icon" — iOS resolve @2x/@3x tự động
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
// project.pbxproj update — manual edit, không cần xcode npm package
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

  iconNames.forEach(iconName => {
    ICON_VARIANTS.forEach(v => {
      const fileName    = `Icon${v.suffix}.png`;
      // path trong pbxproj tương đối từ folder chứa .xcodeproj
      const pbxRelPath  = `${appFolderName}/Resources/RuntimeIcons/${iconName}/${fileName}`;
      const displayName = `RuntimeIcons/${iconName}/${fileName}`;

      // Đã tồn tại trong pbxproj chưa?
      if (pbx.includes(displayName) || pbx.includes(pbxRelPath)) {
        logWithTimestamp(`[${TAG}] Already in pbxproj: ${displayName}`);
        return;
      }

      // UUID dùng crypto để đảm bảo unique và deterministic
      const seed   = `${appFolderName}/${iconName}/${fileName}`;
      const uuid1  = deterministicUUID(seed + ':fileRef');
      const uuid2  = deterministicUUID(seed + ':buildFile');

      // PBXFileReference entry
      const fileRef =
        `\t\t${uuid1} /* ${fileName} */ = {\n` +
        `\t\t\tisa = PBXFileReference;\n` +
        `\t\t\tlastKnownFileType = image.png;\n` +
        `\t\t\tname = "${fileName}";\n` +
        `\t\t\tpath = "${pbxRelPath}";\n` +
        `\t\t\tsourceTree = "<absolute>";\n` +
        `\t\t};\n`;

      // PBXBuildFile entry
      const buildFile =
        `\t\t${uuid2} /* ${fileName} in Resources */ = {\n` +
        `\t\t\tisa = PBXBuildFile;\n` +
        `\t\t\tfileRef = ${uuid1} /* ${fileName} */;\n` +
        `\t\t};\n`;

      // Inject PBXFileReference section
      if (pbx.includes('/* End PBXFileReference section */')) {
        pbx = pbx.replace(
          '/* End PBXFileReference section */',
          fileRef + '\t\t/* End PBXFileReference section */'
        );
      } else {
        logWithTimestamp(`⚠️  [${TAG}] PBXFileReference section not found`);
        return;
      }

      // Inject PBXBuildFile section
      if (pbx.includes('/* End PBXBuildFile section */')) {
        pbx = pbx.replace(
          '/* End PBXBuildFile section */',
          buildFile + '\t\t/* End PBXBuildFile section */'
        );
      }

      // Inject vào Copy Bundle Resources phase
      // Tìm section PBXResourcesBuildPhase và thêm vào files list
      pbx = pbx.replace(
        /(isa = PBXResourcesBuildPhase;[\s\S]*?files = \()([\s\S]*?)(\);)/m,
        (match, before, middle, after) => {
          const newEntry = `\t\t\t\t${uuid2} /* ${fileName} in Resources */,\n`;
          return before + middle + newEntry + after;
        }
      );

      logWithTimestamp(`[${TAG}] Added to pbxproj: ${displayName}`);
      changed = true;
    });
  });

  if (changed) {
    safeWriteFile(pbxprojPath, pbx);
    logWithTimestamp(`[${TAG}] ✔ project.pbxproj updated (${iconNames.length * ICON_VARIANTS.length} files added)`);
  } else {
    logWithTimestamp(`[${TAG}] project.pbxproj — no changes needed`);
  }
}

// UUID deterministic: cùng input → cùng UUID → rebuild không tạo duplicate
function deterministicUUID(seed) {
  return crypto
    .createHash('md5')
    .update(seed)
    .digest('hex')
    .slice(0, 24)
    .toUpperCase();
}
