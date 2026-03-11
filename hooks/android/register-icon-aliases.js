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

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

module.exports = function (context) {
  const platforms = context.opts.platforms || [];

  if (!platforms.includes('android')) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      const et = context.requireCordovaModule('elementtree');
      const configPath = path.join(context.opts.projectRoot, 'config.xml');

      if (!fs.existsSync(configPath)) {
        console.log('[RuntimeIconChanger Android] config.xml not found, skip');
        resolve();
        return;
      }

      const doc = et.parse(fs.readFileSync(configPath, 'utf8'));
      const iconCdnUrl = getPreference(doc, 'ICON_CDN_URL');

      if (!iconCdnUrl) {
        console.log('[RuntimeIconChanger Android] ICON_CDN_URL not set, skip');
        resolve();
        return;
      }

      fetchJson(iconCdnUrl)
        .then(function (json) {
          const icons = Array.isArray(json.icons) ? json.icons : [];
          const runtimeIcons = icons.filter(function (icon) {
            return icon && icon.name && icon.name !== 'default';
          });

          const appDir = path.join(
            context.opts.projectRoot,
            'platforms',
            'android',
            'app',
            'src',
            'main'
          );
          const resDir = path.join(appDir, 'res');

          const densities = [
            { folder: 'mipmap-mdpi', size: 48 },
            { folder: 'mipmap-hdpi', size: 72 },
            { folder: 'mipmap-xhdpi', size: 96 },
            { folder: 'mipmap-xxhdpi', size: 144 },
            { folder: 'mipmap-xxxhdpi', size: 192 }
          ];

          return Promise.all(runtimeIcons.map(function (icon) {
            return downloadIconForAndroid(icon, resDir, densities);
          })).then(function (iconInfos) {
            injectAliases(appDir, iconInfos);
            console.log(
              '[RuntimeIconChanger Android] Activity aliases registered: default' +
              (iconInfos.length ? ', ' + iconInfos.map(i => i.name).join(', ') : '')
            );
            resolve();
          });
        })
        .catch(function (err) {
          console.warn('[RuntimeIconChanger Android] Hook error (non-fatal): ' + err.message);
          resolve();
        });
    } catch (err) {
      console.warn('[RuntimeIconChanger Android] Hook error (non-fatal): ' + err.message);
      resolve();
    }
  });
};

function getPreference(doc, name) {
  const all = doc.findall('preference').concat(
    doc.findall('platform[@name="android"]/preference')
  );
  for (let i = 0; i < all.length; i++) {
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
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000 }, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

function fetchBuffer(url) {
  return new Promise(function (resolve, reject) {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 30000 }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { resolve(Buffer.concat(chunks)); });
    });
    req.on('error', reject);
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('Download timed out'));
    });
  });
}

function downloadIconForAndroid(icon, resDir, densities) {
  const name = icon.name;
  const resourceUrl = icon.resource;

  return fetchBuffer(resourceUrl).then(function (buffer) {
    let Jimp;
    try { Jimp = require('jimp'); } catch (_) { Jimp = null; }

    if (Jimp) {
      return Jimp.read(buffer).then(function (img) {
        return Promise.all(densities.map(function (d) {
          const dir = path.join(resDir, d.folder);
          mkdirSafe(dir);
          return img.clone()
            .resize(d.size, d.size)
            .writeAsync(path.join(dir, 'ic_launcher_' + name + '.png'));
        }));
      }).then(function () {
        return { name: name, mipmapName: 'ic_launcher_' + name };
      });
    }

    densities.forEach(function (d) {
      const dir = path.join(resDir, d.folder);
      mkdirSafe(dir);
      fs.writeFileSync(path.join(dir, 'ic_launcher_' + name + '.png'), buffer);
    });

    return { name: name, mipmapName: 'ic_launcher_' + name };
  });
}

function injectAliases(appDir, iconInfos) {
  const manifestPath = path.join(appDir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[RuntimeIconChanger Android] AndroidManifest.xml not found');
    return;
  }

  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const pkgMatch = manifest.match(/package="([^"]+)"/);
  const packageName = pkgMatch ? pkgMatch[1] : '';

  manifest = manifest.replace(
    /\n?\s*<!-- RuntimeIconChanger:start -->[\s\S]*?<!-- RuntimeIconChanger:end -->\n?/g,
    ''
  );

  let block = '\n    <!-- RuntimeIconChanger:start -->';

  block += `
    <activity-alias
        android:name="${packageName}.MainActivity_default"
        android:enabled="true"
        android:exported="true"
        android:icon="@mipmap/ic_launcher"
        android:targetActivity=".MainActivity">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity-alias>`;

  iconInfos.forEach(function (info) {
    const alias = packageName + '.MainActivity_' + info.name;
    block += `
    <activity-alias
        android:name="${alias}"
        android:enabled="false"
        android:exported="true"
        android:icon="@mipmap/${info.mipmapName}"
        android:targetActivity=".MainActivity">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity-alias>`;
  });

  block += '\n    <!-- RuntimeIconChanger:end -->';

  manifest = manifest.replace(/<\/application>/, block + '\n</application>');
  fs.writeFileSync(manifestPath, manifest, 'utf8');
}
