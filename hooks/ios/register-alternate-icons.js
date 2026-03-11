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

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

module.exports = function (context) {
  const Q          = context.requireCordovaModule('q');
  const deferred   = Q.defer();
  const et         = context.requireCordovaModule('elementtree');
  const platforms  = context.opts.platforms || [];

  if (!platforms.includes('ios')) {
    deferred.resolve();
    return deferred.promise;
  }

  const configPath = path.join(context.opts.projectRoot, 'config.xml');
  if (!fs.existsSync(configPath)) {
    log('warn', 'config.xml not found — skipping');
    deferred.resolve();
    return deferred.promise;
  }

  const doc = et.parse(fs.readFileSync(configPath, 'utf8'));
  const iconCdnUrl = getPreference(doc, 'ICON_CDN_URL');

  if (!iconCdnUrl) {
    log('info', 'ICON_CDN_URL not set — skipping iOS icon registration');
    deferred.resolve();
    return deferred.promise;
  }

  log('info', 'Fetching icon list from: ' + iconCdnUrl);

  fetchJson(iconCdnUrl)
    .then(function (json) {
      var icons = json.icons;
      if (!Array.isArray(icons) || !icons.length) {
        log('warn', 'No icons in CDN JSON');
        deferred.resolve();
        return;
      }

      var appName      = getAppName(context);
      var iosPlatDir   = path.join(context.opts.projectRoot, 'platforms', 'ios');
      var xcodeProjDir = path.join(iosPlatDir, appName);
      var resourcesDir = path.join(xcodeProjDir, 'Resources', 'RuntimeIcons');
      mkdirSafe(resourcesDir);

      // iOS icon sizes required (px)
      var iconSizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

      return Promise.all(icons.map(function (icon) {
        return downloadIconForIos(icon, resourcesDir, iconSizes);
      })).then(function (iconNames) {
        updateInfoPlist(xcodeProjDir, appName, iconNames);
        log('info', 'Registered alternate icons: ' + iconNames.join(', '));
        deferred.resolve();
      });
    })
    .catch(function (err) {
      // Non-fatal — log and continue so the build does not fail
      log('warn', 'Hook error (non-fatal): ' + err.message);
      deferred.resolve();
    });

  return deferred.promise;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level, msg) {
  var prefix = '[RuntimeIconChanger iOS] ';
  if (level === 'warn')  { console.warn(prefix  + msg); }
  else                   { console.log(prefix   + msg); }
}

function getPreference(doc, name) {
  // Check root-level and platform-level preferences (case-insensitive key match)
  var all = doc.findall('preference').concat(
    doc.findall('platform[@name="ios"]/preference')
  );
  for (var i = 0; i < all.length; i++) {
    if ((all[i].get('name') || '').toUpperCase() === name.toUpperCase()) {
      return all[i].get('value') || '';
    }
  }
  return '';
}

function getAppName(context) {
  var configPath = path.join(context.opts.projectRoot, 'config.xml');
  var et         = context.requireCordovaModule('elementtree');
  var doc        = et.parse(fs.readFileSync(configPath, 'utf8'));
  return (doc.findtext('name') || 'App').trim();
}

function mkdirSafe(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function fetchJson(url) {
  return new Promise(function (resolve, reject) {
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, { timeout: 15000 }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function fetchBuffer(url) {
  return new Promise(function (resolve, reject) {
    var lib = url.startsWith('https') ? https : http;
    var req = lib.get(url, { timeout: 30000 }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(); reject(new Error('Download timed out')); });
  });
}

function downloadIconForIos(icon, resourcesDir, sizes) {
  var name        = icon.name;
  var resourceUrl = icon.resource;
  var iconDir     = path.join(resourcesDir, name);
  mkdirSafe(iconDir);

  return fetchBuffer(resourceUrl).then(function (buffer) {
    // Save the 1024 source file
    fs.writeFileSync(path.join(iconDir, 'Icon-1024.png'), buffer);

    // Try jimp for accurate resizing; fall back to copying the 1024 source
    var Jimp;
    try { Jimp = require('jimp'); } catch (_) { Jimp = null; }

    if (Jimp) {
      return Jimp.read(buffer).then(function (img) {
        return Promise.all(
          sizes.filter(function (s) { return s !== 1024; }).map(function (size) {
            return img.clone().resize(size, size)
              .writeAsync(path.join(iconDir, 'Icon-' + size + '.png'));
          })
        );
      }).then(function () { return name; });
    }

    // Fallback: copy 1024 for all sizes (MABS will accept; not pixel-perfect)
    sizes.filter(function (s) { return s !== 1024; }).forEach(function (size) {
      fs.copyFileSync(
        path.join(iconDir, 'Icon-1024.png'),
        path.join(iconDir, 'Icon-' + size + '.png')
      );
    });
    return name;
  });
}

function updateInfoPlist(xcodeProjDir, appName, iconNames) {
  // Try both common plist paths used by different Cordova iOS versions
  var candidates = [
    path.join(xcodeProjDir, appName + '-Info.plist'),
    path.join(xcodeProjDir, 'Info.plist')
  ];
  var plistPath = candidates.find(function (p) { return fs.existsSync(p); });
  if (!plistPath) {
    log('warn', 'Info.plist not found — cannot register alternate icons');
    return;
  }

  var plist = fs.readFileSync(plistPath, 'utf8');

  // 1. Ensure UIApplicationSupportsAlternateIcons = true
  if (!plist.includes('UIApplicationSupportsAlternateIcons')) {
    plist = plist.replace(
      '</dict>\n</plist>',
      '\t<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>\n</dict>\n</plist>'
    );
  }

  // 2. Remove existing CFBundleAlternateIcons block
  plist = plist.replace(
    /<key>CFBundleAlternateIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>)/g,
    ''
  );

  // 3. Build new CFBundleAlternateIcons block
  var altBlock = '\t<key>CFBundleAlternateIcons</key>\n\t<dict>\n';
  iconNames.forEach(function (name) {
    altBlock += '\t\t<key>' + name + '</key>\n';
    altBlock += '\t\t<dict>\n';
    altBlock += '\t\t\t<key>CFBundleIconFiles</key>\n';
    altBlock += '\t\t\t<array><string>RuntimeIcons/' + name + '/Icon</string></array>\n';
    altBlock += '\t\t\t<key>UIPrerenderedIcon</key>\n\t\t\t<false/>\n';
    altBlock += '\t\t</dict>\n';
  });
  altBlock += '\t</dict>';

  plist = plist.replace('</dict>\n</plist>', altBlock + '\n</dict>\n</plist>');
  fs.writeFileSync(plistPath, plist, 'utf8');
}
