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
const fs = require('fs');
const https = require('https');
const http = require('http');

module.exports = function (context) {
  const platforms = context.opts.platforms || [];

  if (!platforms.includes('ios')) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      const et = context.requireCordovaModule('elementtree');
      const configPath = path.join(context.opts.projectRoot, 'config.xml');

      if (!fs.existsSync(configPath)) {
        console.log('[RuntimeIconChanger iOS] config.xml not found, skip');
        resolve();
        return;
      }

      const doc = et.parse(fs.readFileSync(configPath, 'utf8'));
      const iconCdnUrl = getPreference(doc, 'ICON_CDN_URL');

      if (!iconCdnUrl) {
        console.log('[RuntimeIconChanger iOS] ICON_CDN_URL not set, skip');
        resolve();
        return;
      }

      fetchJson(iconCdnUrl)
        .then(function (json) {
          const icons = Array.isArray(json.icons) ? json.icons : [];
          if (!icons.length) {
            resolve();
            return;
          }

          const appName = getAppName(context);
          const iosPlatDir = path.join(context.opts.projectRoot, 'platforms', 'ios');
          const xcodeProjDir = path.join(iosPlatDir, appName);
          const resourcesDir = path.join(xcodeProjDir, 'Resources', 'RuntimeIcons');
          mkdirSafe(resourcesDir);

          const iconSizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

          return Promise.all(icons.map(function (icon) {
            return downloadIconForIos(icon, resourcesDir, iconSizes);
          })).then(function (iconNames) {
            updateInfoPlist(xcodeProjDir, appName, iconNames);
            console.log('[RuntimeIconChanger iOS] Registered alternate icons: ' + iconNames.join(', '));
            resolve();
          });
        })
        .catch(function (err) {
          console.warn('[RuntimeIconChanger iOS] Hook error (non-fatal): ' + err.message);
          resolve();
        });
    } catch (err) {
      console.warn('[RuntimeIconChanger iOS] Hook error (non-fatal): ' + err.message);
      resolve();
    }
  });
};

function getPreference(doc, name) {
  const all = doc.findall('preference').concat(
    doc.findall('platform[@name="ios"]/preference')
  );
  for (let i = 0; i < all.length; i++) {
    if ((all[i].get('name') || '').toUpperCase() === name.toUpperCase()) {
      return all[i].get('value') || '';
    }
  }
  return '';
}

function getAppName(context) {
  const et = context.requireCordovaModule('elementtree');
  const configPath = path.join(context.opts.projectRoot, 'config.xml');
  const doc = et.parse(fs.readFileSync(configPath, 'utf8'));
  return (doc.findtext('name') || 'App').trim();
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

function downloadIconForIos(icon, resourcesDir, sizes) {
  const name = icon.name;
  const resourceUrl = icon.resource;
  const iconDir = path.join(resourcesDir, name);
  mkdirSafe(iconDir);

  return fetchBuffer(resourceUrl).then(function (buffer) {
    fs.writeFileSync(path.join(iconDir, 'Icon-1024.png'), buffer);

    let Jimp;
    try { Jimp = require('jimp'); } catch (_) { Jimp = null; }

    if (Jimp) {
      return Jimp.read(buffer).then(function (img) {
        return Promise.all(
          sizes.filter(function (s) { return s !== 1024; }).map(function (size) {
            return img.clone()
              .resize(size, size)
              .writeAsync(path.join(iconDir, 'Icon-' + size + '.png'));
          })
        );
      }).then(function () {
        return name;
      });
    }

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
  const candidates = [
    path.join(xcodeProjDir, appName + '-Info.plist'),
    path.join(xcodeProjDir, 'Info.plist')
  ];
  const plistPath = candidates.find(function (p) { return fs.existsSync(p); });

  if (!plistPath) {
    console.warn('[RuntimeIconChanger iOS] Info.plist not found');
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');

  if (!plist.includes('UIApplicationSupportsAlternateIcons')) {
    plist = plist.replace(
      '</dict>\n</plist>',
      '\t<key>UIApplicationSupportsAlternateIcons</key>\n\t<true/>\n</dict>\n</plist>'
    );
  }

  plist = plist.replace(
    /<key>CFBundleAlternateIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>)/g,
    ''
  );

  let altBlock = '\t<key>CFBundleAlternateIcons</key>\n\t<dict>\n';
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
