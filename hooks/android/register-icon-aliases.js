/**
 * hooks/android/register-icon-aliases.js
 *
 * Cordova after_prepare hook for Android.
 * Reads ICON_CDN_URL from config.xml, fetches the CDN JSON,
 * downloads each PNG (1024x1024), resizes to all Android launcher densities,
 * copies them into the correct mipmap folders, and injects <activity-alias>
 * entries into AndroidManifest.xml so RuntimeIconChanger.java can switch icons
 * via PackageManager.setComponentEnabledSetting.
 *
 * Alias naming: <packageName>.MainActivity_<iconName>
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

  let iconCdnUrl = '';
  const prefEls = doc.findall('preference');
  for (const el of prefEls) {
    if (el.get('name') === 'ICON_CDN_URL') {
      iconCdnUrl = el.get('value') || '';
    }
  }

  if (!iconCdnUrl) {
    console.log('[RuntimeIconChanger] ICON_CDN_URL not set — skipping Android alias generation.');
    deferred.resolve();
    return deferred.promise;
  }

  console.log('[RuntimeIconChanger] Fetching icon list from: ' + iconCdnUrl);

  fetchJson(iconCdnUrl)
    .then(json => {
      const icons = json.icons;
      if (!Array.isArray(icons) || icons.length === 0) {
        deferred.resolve();
        return;
      }

      const androidPlatformDir = path.join(context.opts.projectRoot, 'platforms', 'android');
      const appDir = path.join(androidPlatformDir, 'app', 'src', 'main');
      const resDir = path.join(appDir, 'res');

      // Density → (folder suffix, size px)
      const densities = [
        { folder: 'mipmap-mdpi',    size: 48  },
        { folder: 'mipmap-hdpi',    size: 72  },
        { folder: 'mipmap-xhdpi',   size: 96  },
        { folder: 'mipmap-xxhdpi',  size: 144 },
        { folder: 'mipmap-xxxhdpi', size: 192 },
      ];

      const downloadPromises = icons.map(icon => {
        return downloadAndResizeIcon(icon, resDir, densities);
      });

      return Promise.all(downloadPromises).then(iconInfoList => {
        // Inject activity-alias entries into AndroidManifest.xml
        injectAliasesToManifest(appDir, iconInfoList);
        console.log('[RuntimeIconChanger] Android aliases registered for: ' +
          iconInfoList.map(i => i.name).join(', '));
        deferred.resolve();
      });
    })
    .catch(err => {
      console.warn('[RuntimeIconChanger] Android hook warning: ' + err.message);
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
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

function downloadAndResizeIcon(icon, resDir, densities) {
  return new Promise((resolve, reject) => {
    const name = icon.name;
    const resourceUrl = icon.resource;
    const lib = resourceUrl.startsWith('https') ? https : http;

    lib.get(resourceUrl, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        try {
          // eslint-disable-next-line
          const Jimp = require('jimp');
          Jimp.read(buffer).then(img => {
            const writes = densities.map(d => {
              const dir = path.join(resDir, d.folder);
              fs.mkdirSync(dir, { recursive: true });
              return img.clone()
                .resize(d.size, d.size)
                .writeAsync(path.join(dir, 'ic_launcher_' + name + '.png'));
            });
            return Promise.all(writes);
          }).then(() => {
            resolve({ name, mipmapName: 'ic_launcher_' + name });
          }).catch(() => {
            // Fallback: copy raw buffer
            densities.forEach(d => {
              const dir = path.join(resDir, d.folder);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, 'ic_launcher_' + name + '.png'), buffer);
            });
            resolve({ name, mipmapName: 'ic_launcher_' + name });
          });
        } catch (_) {
          densities.forEach(d => {
            const dir = path.join(resDir, d.folder);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'ic_launcher_' + name + '.png'), buffer);
          });
          resolve({ name, mipmapName: 'ic_launcher_' + name });
        }
      });
    }).on('error', reject);
  });
}

function injectAliasesToManifest(appDir, iconInfoList) {
  const manifestPath = path.join(appDir, 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[RuntimeIconChanger] AndroidManifest.xml not found at: ' + manifestPath);
    return;
  }

  let manifest = fs.readFileSync(manifestPath, 'utf8');

  // Read package name
  const pkgMatch = manifest.match(/package="([^"]+)"/);
  const packageName = pkgMatch ? pkgMatch[1] : '';

  // Remove previously injected aliases
  manifest = manifest.replace(
    /\s*<!-- RuntimeIconChanger aliases start -->[\s\S]*?<!-- RuntimeIconChanger aliases end -->/g,
    ''
  );

  // Build alias XML
  let aliases = '\n    <!-- RuntimeIconChanger aliases start -->';
  for (const info of iconInfoList) {
    const aliasName = packageName + '.MainActivity_' + info.name;
    const enabled = info.name === 'default' ? 'true' : 'false';
    aliases += `
    <activity-alias
        android:name="${aliasName}"
        android:enabled="${enabled}"
        android:exported="true"
        android:icon="@mipmap/${info.mipmapName}"
        android:targetActivity=".MainActivity">
        <intent-filter>
            <action android:name="android.intent.action.MAIN" />
            <category android:name="android.intent.category.LAUNCHER" />
        </intent-filter>
    </activity-alias>`;
  }
  aliases += '\n    <!-- RuntimeIconChanger aliases end -->';

  // Insert before </application>
  manifest = manifest.replace(/<\/application>/, aliases + '\n</application>');
  fs.writeFileSync(manifestPath, manifest, 'utf8');
}
