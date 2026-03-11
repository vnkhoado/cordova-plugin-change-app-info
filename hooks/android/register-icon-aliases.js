/**
 * hooks/android/register-icon-aliases.js  — MABS-optimised
 *
 * Cordova after_prepare hook (Android).
 *
 * What it does:
 *   1. Reads ICON_CDN_URL from config.xml
 *   2. Fetches the CDN JSON icon list
 *   3. Downloads each PNG, resizes to Android mipmap densities
 *   4. Injects <activity-alias> entries into AndroidManifest.xml
 *
 * MABS constraints:
 *   - No npm dependencies (Node built-ins only; jimp is optional)
 *   - Idempotent: cleans up previous hook output before re-injecting
 *   - Follows MABS 9+ Android project layout (app/src/main/)
 *   - DONT_KILL_APP is handled in Java — not a build concern
 *   - The default alias starts ENABLED; all others start DISABLED
 */

'use strict';

const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

module.exports = function (context) {
  const Q         = context.requireCordovaModule('q');
  const deferred  = Q.defer();
  const et        = context.requireCordovaModule('elementtree');
  const platforms = context.opts.platforms || [];

  if (!platforms.includes('android')) {
    deferred.resolve();
    return deferred.promise;
  }

  const configPath = path.join(context.opts.projectRoot, 'config.xml');
  if (!fs.existsSync(configPath)) {
    deferred.resolve();
    return deferred.promise;
  }

  const doc        = et.parse(fs.readFileSync(configPath, 'utf8'));
  const iconCdnUrl = getPreference(doc, 'ICON_CDN_URL');

  if (!iconCdnUrl) {
    log('info', 'ICON_CDN_URL not set — skipping Android alias generation');
    deferred.resolve();
    return deferred.promise;
  }

  log('info', 'Fetching icon list from: ' + iconCdnUrl);

  fetchJson(iconCdnUrl)
    .then(function (json) {
      var icons = json.icons;
      if (!Array.isArray(icons) || !icons.length) {
        deferred.resolve();
        return;
      }

      // MABS Android project structure
      var appDir  = path.join(context.opts.projectRoot, 'platforms', 'android', 'app', 'src', 'main');
      var resDir  = path.join(appDir, 'res');

      var densities = [
        { folder: 'mipmap-mdpi',    size: 48  },
        { folder: 'mipmap-hdpi',    size: 72  },
        { folder: 'mipmap-xhdpi',   size: 96  },
        { folder: 'mipmap-xxhdpi',  size: 144 },
        { folder: 'mipmap-xxxhdpi', size: 192 },
      ];

      return Promise.all(icons.map(function (icon) {
        return downloadIconForAndroid(icon, resDir, densities);
      })).then(function (iconInfos) {
        injectAliases(appDir, iconInfos);
        log('info', 'Activity aliases registered: ' + iconInfos.map(function (i) { return i.name; }).join(', '));
        deferred.resolve();
      });
    })
    .catch(function (err) {
      log('warn', 'Hook error (non-fatal): ' + err.message);
      deferred.resolve();
    });

  return deferred.promise;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level, msg) {
  var prefix = '[RuntimeIconChanger Android] ';
  if (level === 'warn')  console.warn(prefix  + msg);
  else                   console.log(prefix   + msg);
}

function getPreference(doc, name) {
  var all = doc.findall('preference').concat(
    doc.findall('platform[@name="android"]/preference')
  );
  for (var i = 0; i < all.length; i++) {
    if ((all[i].get('name') || '').toUpperCase() === name.toUpperCase()) {
      return all[i].get('value') || '';
    }
  }
  return '';
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

function downloadIconForAndroid(icon, resDir, densities) {
  var name        = icon.name;
  var resourceUrl = icon.resource;

  return fetchBuffer(resourceUrl).then(function (buffer) {
    var Jimp;
    try { Jimp = require('jimp'); } catch (_) { Jimp = null; }

    if (Jimp) {
      return Jimp.read(buffer).then(function (img) {
        return Promise.all(densities.map(function (d) {
          var dir = path.join(resDir, d.folder);
          mkdirSafe(dir);
          return img.clone().resize(d.size, d.size)
            .writeAsync(path.join(dir, 'ic_launcher_' + name + '.png'));
        }));
      }).then(function () {
        return { name: name, mipmapName: 'ic_launcher_' + name };
      });
    }

    // Fallback: copy raw buffer to every density folder
    densities.forEach(function (d) {
      var dir = path.join(resDir, d.folder);
      mkdirSafe(dir);
      fs.writeFileSync(path.join(dir, 'ic_launcher_' + name + '.png'), buffer);
    });
    return { name: name, mipmapName: 'ic_launcher_' + name };
  });
}

function injectAliases(appDir, iconInfos) {
  var manifestPath = path.join(appDir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) {
    log('warn', 'AndroidManifest.xml not found — cannot inject aliases');
    return;
  }

  var manifest    = fs.readFileSync(manifestPath, 'utf8');
  var pkgMatch    = manifest.match(/package="([^"]+)"/);
  var packageName = pkgMatch ? pkgMatch[1] : '';

  // Remove previously injected block (idempotent)
  manifest = manifest.replace(
    /\n?\s*<!-- RuntimeIconChanger:start -->[\s\S]*?<!-- RuntimeIconChanger:end -->\n?/g,
    ''
  );

  // Build alias XML
  var block = '\n    <!-- RuntimeIconChanger:start -->';
  iconInfos.forEach(function (info) {
    var alias   = packageName + '.MainActivity_' + info.name;
    var enabled = info.name === 'default' ? 'true' : 'false';
    block +=
      '\n    <activity-alias' +
      '\n        android:name="'      + alias                 + '"' +
      '\n        android:enabled="'   + enabled               + '"' +
      '\n        android:exported="true"' +
      '\n        android:icon="@mipmap/' + info.mipmapName + '"' +
      '\n        android:targetActivity=".MainActivity">' +
      '\n        <intent-filter>' +
      '\n            <action android:name="android.intent.action.MAIN" />' +
      '\n            <category android:name="android.intent.category.LAUNCHER" />' +
      '\n        </intent-filter>' +
      '\n    </activity-alias>';
  });
  block += '\n    <!-- RuntimeIconChanger:end -->';

  manifest = manifest.replace(/<\/application>/, block + '\n</application>');
  fs.writeFileSync(manifestPath, manifest, 'utf8');
}
