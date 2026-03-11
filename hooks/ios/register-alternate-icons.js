/**
 * hooks/ios/register-alternate-icons.js
 *
 * Cordova after_prepare hook for iOS.
 * Reads ICON_CDN_URL from config.xml, fetches the CDN JSON,
 * downloads each PNG icon (1024x1024), resizes to all required iOS sizes,
 * copies them into the Xcode project's Resources/RuntimeIcons/<name>/ folder,
 * and registers them as CFBundleAlternateIcons in the app's *-Info.plist.
 *
 * This is required because iOS only allows alternate icons that are
 * pre-bundled inside the app binary — runtime-only icon swapping via
 * downloaded files is NOT supported by UIKit.
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

module.exports = function (context) {
  const Q = context.requireCordovaModule('q');
  const deferred = Q.defer();

  const et = context.requireCordovaModule('elementtree');
  const configPath = path.join(context.opts.projectRoot, 'config.xml');
  const xmlContent = fs.readFileSync(configPath, 'utf8');
  const doc = et.parse(xmlContent);

  // Read ICON_CDN_URL from config.xml preference
  let iconCdnUrl = '';
  const prefEls = doc.findall('preference');
  for (const el of prefEls) {
    if (el.get('name') === 'ICON_CDN_URL') {
      iconCdnUrl = el.get('value') || '';
    }
  }

  if (!iconCdnUrl) {
    console.log('[RuntimeIconChanger] ICON_CDN_URL not set — skipping iOS icon registration.');
    deferred.resolve();
    return deferred.promise;
  }

  console.log('[RuntimeIconChanger] Fetching icon list from: ' + iconCdnUrl);

  fetchJson(iconCdnUrl)
    .then(json => {
      const icons = json.icons;
      if (!Array.isArray(icons) || icons.length === 0) {
        console.log('[RuntimeIconChanger] No icons in CDN JSON.');
        deferred.resolve();
        return;
      }

      // Locate the Xcode project directory
      const iosPlatformDir = path.join(context.opts.projectRoot, 'platforms', 'ios');
      const appName = getAppName(context);
      const xcodeProjDir = path.join(iosPlatformDir, appName);
      const resourcesDir = path.join(xcodeProjDir, 'Resources', 'RuntimeIcons');
      fs.mkdirSync(resourcesDir, { recursive: true });

      const iconSizes = [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024];

      const downloadPromises = icons.map(icon => {
        return downloadIcon(icon, resourcesDir, iconSizes);
      });

      return Promise.all(downloadPromises).then(iconNames => {
        // Update *-Info.plist to register alternate icons
        registerAlternateIconsInPlist(xcodeProjDir, appName, iconNames);
        console.log('[RuntimeIconChanger] iOS alternate icons registered: ' + iconNames.join(', '));
        deferred.resolve();
      });
    })
    .catch(err => {
      console.warn('[RuntimeIconChanger] iOS hook warning: ' + err.message);
      // Non-fatal — do not fail the build
      deferred.resolve();
    });

  return deferred.promise;
};

// ---- Helpers ----

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

function downloadIcon(icon, resourcesDir, sizes) {
  return new Promise((resolve, reject) => {
    const name = icon.name;
    const resourceUrl = icon.resource;
    const iconDir = path.join(resourcesDir, name);
    fs.mkdirSync(iconDir, { recursive: true });

    const lib = resourceUrl.startsWith('https') ? https : http;
    lib.get(resourceUrl, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        // Save the full 1024 source
        fs.writeFileSync(path.join(iconDir, 'Icon-1024.png'), buffer);

        // Try to resize using jimp if available; otherwise just copy the source.
        try {
          // eslint-disable-next-line
          const Jimp = require('jimp');
          Jimp.read(buffer).then(img => {
            const writePromises = sizes
              .filter(s => s !== 1024)
              .map(size => {
                return img.clone()
                  .resize(size, size)
                  .writeAsync(path.join(iconDir, 'Icon-' + size + '.png'));
              });
            return Promise.all(writePromises);
          }).then(() => resolve(name)).catch(() => {
            // Fallback: copy source for all sizes
            sizes.filter(s => s !== 1024).forEach(size => {
              fs.copyFileSync(
                path.join(iconDir, 'Icon-1024.png'),
                path.join(iconDir, 'Icon-' + size + '.png')
              );
            });
            resolve(name);
          });
        } catch (_) {
          // Jimp not available — copy source for all sizes
          sizes.filter(s => s !== 1024).forEach(size => {
            fs.copyFileSync(
              path.join(iconDir, 'Icon-1024.png'),
              path.join(iconDir, 'Icon-' + size + '.png')
            );
          });
          resolve(name);
        }
      });
    }).on('error', reject);
  });
}

function registerAlternateIconsInPlist(xcodeProjDir, appName, iconNames) {
  const plistPath = path.join(xcodeProjDir, appName + '-Info.plist');
  if (!fs.existsSync(plistPath)) {
    console.warn('[RuntimeIconChanger] Info.plist not found at: ' + plistPath);
    return;
  }

  let plist = fs.readFileSync(plistPath, 'utf8');

  // Remove any existing CFBundleAlternateIcons block
  plist = plist.replace(
    /<key>CFBundleAlternateIcons<\/key>[\s\S]*?<\/dict>\s*(?=<\/dict>)/,
    ''
  );

  // Build alternate icons XML block
  let altIconsXml = '<key>CFBundleAlternateIcons</key>\n\t\t<dict>\n';
  for (const name of iconNames) {
    altIconsXml += `\t\t\t<key>${name}</key>\n`;
    altIconsXml += `\t\t\t<dict>\n`;
    altIconsXml += `\t\t\t\t<key>CFBundleIconFiles</key>\n`;
    altIconsXml += `\t\t\t\t<array>\n`;
    altIconsXml += `\t\t\t\t\t<string>RuntimeIcons/${name}/Icon</string>\n`;
    altIconsXml += `\t\t\t\t</array>\n`;
    altIconsXml += `\t\t\t\t<key>UIPrerenderedIcon</key>\n`;
    altIconsXml += `\t\t\t\t<false/>\n`;
    altIconsXml += `\t\t\t</dict>\n`;
  }
  altIconsXml += '\t\t</dict>';

  // Insert before the closing </dict></plist>
  plist = plist.replace(
    /<\/dict>\s*<\/plist>/,
    `\t${altIconsXml}\n</dict>\n</plist>`
  );

  fs.writeFileSync(plistPath, plist, 'utf8');
}

function getAppName(context) {
  const configPath = path.join(context.opts.projectRoot, 'config.xml');
  const et = context.requireCordovaModule('elementtree');
  const xml = fs.readFileSync(configPath, 'utf8');
  const doc = et.parse(xml);
  return doc.findtext('name') || 'App';
}
