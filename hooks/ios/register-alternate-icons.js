/**
 * hooks/ios/register-alternate-icons.js  — MABS-optimised v5
 *
 * STRATEGY v5: Xcode Run Script Build Phase
 * -----------------------------------------
 * All previous approaches (xcassets imageset/appiconset, flat Resources/)
 * fail because MABS runs actool AFTER our hook, wiping our changes.
 *
 * Solution: inject a "Run Script" build phase into .pbxproj.
 * This shell script runs INSIDE xcodebuild, AFTER actool,
 * and copies icon PNGs directly into $BUILT_PRODUCTS_DIR/$CONTENTS_FOLDER_PATH
 * (i.e. the .app bundle being assembled).
 *
 * The script:
 *   1. Downloads icon PNGs from CDN using curl (available on MABS macOS)
 *   2. Resizes with sips (built-in macOS tool, no extra deps)
 *   3. Copies to $BUILT_PRODUCTS_DIR/$CONTENTS_FOLDER_PATH/
 *
 * Info.plist uses CFBundleIconFiles (flat name) — iOS finds flat PNGs in bundle root.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const {
  getConfigParser,
  downloadFile,
  logWithTimestamp,
  logSection,
  logSectionComplete,
  safeWriteFile
} = require('../utils');

const TAG = 'RuntimeIconChanger iOS';

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

          // 1. Inject Run Script phase into pbxproj
          injectRunScriptPhase(iosPlatDir, appFolderName, icons);

          // 2. Update Info.plist with CFBundleIconFiles (flat PNG name)
          updateInfoPlist(iosPlatDir, appFolderName, icons.map(i => i.name));

          logSectionComplete(`[${TAG}] Run Script injected for: ${icons.map(i => i.name).join(', ')}`);
          resolve();
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
// Build the shell script that runs inside Xcode build
// Uses only curl + sips (both available on macOS, no npm deps needed)
// ============================================================================

function buildShellScript(icons) {
  const lines = [
    '#!/bin/bash',
    'set -e',
    'DEST="$BUILT_PRODUCTS_DIR/$CONTENTS_FOLDER_PATH"',
    'TMP=$(mktemp -d)',
    'echo "[AltIcon] Bundle dest: $DEST"',
    'echo "[AltIcon] Tmp dir: $TMP"',
    '',
  ];

  icons.forEach(function (icon) {
    const name = icon.name;
    const url  = icon.resource;
    lines.push(`# --- ${name} ---`);
    lines.push(`echo "[AltIcon] Downloading ${name}"`);
    lines.push(`curl -fsSL "${url}" -o "$TMP/${name}-src.png"`);
    // sips resize: 120x120 (@2x) and 180x180 (@3x)
    lines.push(`sips -z 120 120 "$TMP/${name}-src.png" --out "$DEST/${name}@2x.png"`);
    lines.push(`sips -z 180 180 "$TMP/${name}-src.png" --out "$DEST/${name}@3x.png"`);
    lines.push(`echo "[AltIcon] Copied ${name}@2x.png and ${name}@3x.png to bundle"`);
    lines.push('');
  });

  lines.push('rm -rf "$TMP"');
  lines.push('echo "[AltIcon] Done"');

  return lines.join('\n');
}

// ============================================================================
// Inject PBXShellScriptBuildPhase into .pbxproj
// ============================================================================

function injectRunScriptPhase(iosPlatDir, appFolderName, icons) {
  const pbxprojPath = path.join(
    iosPlatDir,
    `${appFolderName}.xcodeproj`,
    'project.pbxproj'
  );

  if (!fs.existsSync(pbxprojPath)) {
    logWithTimestamp(`[${TAG}] project.pbxproj not found: ${pbxprojPath}`);
    return;
  }

  let pbx = fs.readFileSync(pbxprojPath, 'utf8');

  // Deterministic UUID so we don't double-inject
  const scriptUuid = makePbxUuid('AltIconRunScript_v5');

  if (pbx.includes(scriptUuid)) {
    logWithTimestamp(`[${TAG}] Run Script already injected, skipping`);
    return;
  }

  const shellScript = buildShellScript(icons);
  // Escape for pbxproj string: backslash, quote, newline
  const escapedScript = shellScript
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  // PBXShellScriptBuildPhase entry
  const scriptPhaseEntry =
    `\t\t${scriptUuid} /* Copy Alt Icons */ = {\n` +
    `\t\t\tisa = PBXShellScriptBuildPhase;\n` +
    `\t\t\tbuildActionMask = 2147483647;\n` +
    `\t\t\tfiles = (\n\t\t\t);\n` +
    `\t\t\tinputFileListPaths = (\n\t\t\t);\n` +
    `\t\t\tinputPaths = (\n\t\t\t);\n` +
    `\t\t\tname = "Copy Alt Icons";\n` +
    `\t\t\toutputFileListPaths = (\n\t\t\t);\n` +
    `\t\t\toutputPaths = (\n\t\t\t);\n` +
    `\t\t\trunOnlyForDeploymentPostprocessing = 0;\n` +
    `\t\t\tshellPath = /bin/bash;\n` +
    `\t\t\tshellScript = "${escapedScript}";\n` +
    `\t\t\tshowEnvVarsInLog = 0;\n` +
    `\t\t};\n`;

  // 1. Inject into PBXShellScriptBuildPhase section
  if (pbx.includes('/* Begin PBXShellScriptBuildPhase section */')) {
    pbx = pbx.replace(
      /(\/\* Begin PBXShellScriptBuildPhase section \*\/)/,
      `$1\n${scriptPhaseEntry}`
    );
  } else {
    // No shell script section yet — add one before PBXSourcesBuildPhase
    pbx = pbx.replace(
      /(\/\* Begin PBXSourcesBuildPhase section \*\/)/,
      `/* Begin PBXShellScriptBuildPhase section */\n${scriptPhaseEntry}/* End PBXShellScriptBuildPhase section */\n\n$1`
    );
  }

  // 2. Add the UUID reference to the target's buildPhases array
  //    Find the main target's buildPhases list and append our UUID
  pbx = pbx.replace(
    /(buildPhases = \([\s\S]*?)(\);)/,
    `$1\t\t\t\t${scriptUuid} /* Copy Alt Icons */,\n\t\t\t$2`
  );

  fs.writeFileSync(pbxprojPath, pbx, 'utf8');
  logWithTimestamp(`[${TAG}] Run Script phase injected into: ${pbxprojPath}`);
}

// ============================================================================
// Info.plist — CFBundleIconFiles (flat PNG, no extension)
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

  // CFBundleIconFiles: flat name — iOS finds <name>@2x.png / <name>@3x.png in bundle root
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

function makePbxUuid(seed) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24).toUpperCase();
}

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
