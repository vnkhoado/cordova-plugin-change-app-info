#!/usr/bin/env node
/**
 * generateIconsFromManifest.js
 *
 * Downloads an app icon at build time from a CDN JSON manifest.
 *
 * config.xml preferences:
 *   CDN_ICON_MANIFEST  – URL of the JSON manifest file (required)
 *   CDN_ICON_ID        – id of the icon to use (optional);
 *                        if omitted, the first icon with active:true is used;
 *                        if no active icon, the first icon in the list is used.
 *
 * Expected manifest format:
 * {
 *   "version": "1.0",
 *   "icons": [
 *     {
 *       "id": "default",
 *       "name": "Default Icon",
 *       "url": "https://cdn.example.com/icons/default.png",
 *       "active": true
 *     },
 *     {
 *       "id": "tet2025",
 *       "name": "Tết 2025",
 *       "url": "https://cdn.example.com/icons/tet2025.png",
 *       "active": false
 *     }
 *   ]
 * }
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ─── HTTP helper ────────────────────────────────────────────────────────────
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadFile(response.headers.location).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0) return reject(new Error('Downloaded file is empty'));
        resolve(buffer);
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy();
      reject(new Error('Download timeout after 30s'));
    });
  });
}

// ─── Image processing ───────────────────────────────────────────────────────
let sharp = null;
let Jimp  = null;
let processor = null;

try {
  sharp = require('sharp');
  processor = 'sharp';
} catch (e) {
  try {
    Jimp = require('jimp');
    processor = 'jimp';
  } catch (e2) {
    processor = null;
  }
}

async function resizeImage(srcBuffer, dest, size) {
  try {
    if (sharp) {
      await sharp(srcBuffer)
        .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .png()
        .toFile(dest);
      return true;
    } else if (Jimp) {
      const image = await Jimp.read(srcBuffer);
      await image.resize(size, size).writeAsync(dest);
      return true;
    }
    return false;
  } catch (error) {
    console.log(`   ⚠️  Error resizing to ${size}x${size}:`, error.message);
    return false;
  }
}

// ─── Main hook ──────────────────────────────────────────────────────────────
module.exports = async function (context) {
  const ConfigParser = context.requireCordovaModule('cordova-common').ConfigParser;
  const config = new ConfigParser(path.join(context.opts.projectRoot, 'config.xml'));

  const platforms = context.opts.platforms;
  const root      = context.opts.projectRoot;

  console.log('\n══════════════════════════════════════════');
  console.log('     GENERATE ICONS FROM CDN MANIFEST     ');
  console.log('══════════════════════════════════════════');
  console.log('Platforms:', platforms.join(', '));

  if (!processor) {
    console.log('❌ No image processing library found');
    console.log('   💡 Install: npm install sharp   (recommended)');
    console.log('   💡 Or:     npm install jimp     (fallback)');
    console.log('══════════════════════════════════════════\n');
    return;
  }
  console.log(`✅ Image processor: ${processor}`);

  // ── Read preferences ───────────────────────────────────────────────────────
  const manifestUrl = (config.getPreference('CDN_ICON_MANIFEST') || '').trim();
  const iconId      = (config.getPreference('CDN_ICON_ID')       || '').trim();

  if (!manifestUrl) {
    console.log('ℹ️  CDN_ICON_MANIFEST not set – skipping manifest icon generation');
    console.log('══════════════════════════════════════════\n');
    return;
  }

  console.log('🌐 Manifest URL:', manifestUrl);
  console.log('🎯 Icon ID     :', iconId || '(not set – will use first active icon)');

  // ── Download manifest ──────────────────────────────────────────────────────
  console.log('\n📥 Fetching icon manifest...');
  let manifest;
  try {
    const buf = await downloadFile(manifestUrl);
    manifest  = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    console.log('❌ Failed to fetch/parse manifest:', err.message);
    console.log('══════════════════════════════════════════\n');
    return;
  }

  const icons = manifest.icons;
  if (!Array.isArray(icons) || icons.length === 0) {
    console.log('❌ Manifest contains no icons array or it is empty');
    console.log('   Expected: { "icons": [ { "id": "...", "url": "...", "active": true } ] }');
    console.log('══════════════════════════════════════════\n');
    return;
  }
  console.log(`✅ Manifest OK – ${icons.length} icon(s) available`);

  // Print icon list for visibility
  icons.forEach((icon, i) => {
    const flag = icon.active ? '🟢' : '⚪';
    console.log(`   ${flag} [${i}] id=${icon.id || 'n/a'}  name=${icon.name || ''}`);
  });

  // ── Select icon ────────────────────────────────────────────────────────────
  let targetIcon = null;

  if (iconId) {
    targetIcon = icons.find(ic => ic.id === iconId) || null;
    if (!targetIcon) {
      console.log(`⚠️  Icon id="${iconId}" not found – falling back to first active icon`);
    }
  }

  if (!targetIcon) {
    targetIcon = icons.find(ic => ic.active === true) || null;
  }

  if (!targetIcon) {
    console.log('⚠️  No active icon found – using first entry in list');
    targetIcon = icons[0];
  }

  if (!targetIcon || !targetIcon.url) {
    console.log('❌ Selected icon has no URL – aborting');
    console.log('══════════════════════════════════════════\n');
    return;
  }

  console.log(`\n🎨 Selected: [${targetIcon.id || '?'}] ${targetIcon.name || ''}`);
  console.log('🔗 Icon URL :', targetIcon.url);

  // ── Download icon image ────────────────────────────────────────────────────
  console.log('💾 Downloading icon image...');
  let iconBuffer;
  try {
    iconBuffer = await downloadFile(targetIcon.url);
    console.log(`✅ Downloaded ${(iconBuffer.length / 1024).toFixed(2)} KB`);
  } catch (err) {
    console.log('❌ Icon download failed:', err.message);
    console.log('══════════════════════════════════════════\n');
    return;
  }

  // ── Apply to each platform ─────────────────────────────────────────────────
  for (const platform of platforms) {
    console.log(`\n📱 Processing: ${platform}`);
    if (platform === 'android') {
      await generateAndroidIcons(root, iconBuffer);
    } else if (platform === 'ios') {
      await generateIOSIcons(root, iconBuffer);
    } else {
      console.log(`   ⚠️  Platform "${platform}" not supported for icon generation`);
    }
  }

  console.log('\n══════════════════════════════════════════');
  console.log('✅ CDN Manifest icon generation completed!');
  console.log('══════════════════════════════════════════\n');
};

// ─── Android ────────────────────────────────────────────────────────────────
async function generateAndroidIcons(root, iconBuffer) {
  const androidPath = path.join(root, 'platforms/android');
  if (!fs.existsSync(androidPath)) {
    console.log('   ❌ Android platform not found');
    return;
  }

  const resPaths = [
    path.join(androidPath, 'app/src/main/res'),
    path.join(androidPath, 'res')
  ];
  const resPath = resPaths.find(p => fs.existsSync(p));
  if (!resPath) {
    console.log('   ❌ Android res folder not found');
    return;
  }
  console.log('   📂 res:', resPath);

  const densities = [
    ['mipmap-ldpi',    36],
    ['mipmap-mdpi',    48],
    ['mipmap-hdpi',    72],
    ['mipmap-xhdpi',   96],
    ['mipmap-xxhdpi',  144],
    ['mipmap-xxxhdpi', 192]
  ];

  // Clean old icons
  let cleaned = 0;
  for (const [folder] of densities) {
    const iconPath = path.join(resPath, folder, 'ic_launcher.png');
    if (fs.existsSync(iconPath)) {
      try { fs.unlinkSync(iconPath); cleaned++; } catch (e) {}
    }
  }
  if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} old icon(s)`);

  let ok = 0;
  for (const [folder, size] of densities) {
    const dir = path.join(resPath, folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const output = path.join(dir, 'ic_launcher.png');
    if (await resizeImage(iconBuffer, output, size)) {
      if (fs.existsSync(output) && fs.statSync(output).size > 0) {
        console.log(`   ✅ ${folder}/ic_launcher.png (${size}x${size})`);
        ok++;
      }
    }
  }
  console.log(`   ✅ Android: generated ${ok}/${densities.length} icons`);
}

// ─── iOS ────────────────────────────────────────────────────────────────────
async function generateIOSIcons(root, iconBuffer) {
  const iosPath = path.join(root, 'platforms/ios');
  if (!fs.existsSync(iosPath)) {
    console.log('   ❌ iOS platform not found');
    return;
  }

  const SKIP = new Set(['CordovaLib', 'www', 'cordova', 'build', 'Pods']);
  const appFolders = fs.readdirSync(iosPath).filter(f => {
    return !SKIP.has(f) &&
           !f.endsWith('.xcodeproj') &&
           fs.statSync(path.join(iosPath, f)).isDirectory();
  });

  if (appFolders.length === 0) {
    console.log('   ❌ iOS app folder not found');
    return;
  }

  const appPath = path.join(iosPath, appFolders[0]);
  console.log('   📂 app:', appFolders[0]);

  const xcassetsFolder = fs.readdirSync(appPath).find(
    f => f.endsWith('.xcassets') && fs.statSync(path.join(appPath, f)).isDirectory()
  );
  if (!xcassetsFolder) {
    console.log('   ❌ .xcassets folder not found');
    return;
  }

  const appIconPath = path.join(appPath, xcassetsFolder, 'AppIcon.appiconset');
  if (!fs.existsSync(appIconPath)) fs.mkdirSync(appIconPath, { recursive: true });

  const sizes = [
    ['icon-20@2x.png',    40],  ['icon-20@3x.png',    60],
    ['icon-29@2x.png',    58],  ['icon-29@3x.png',    87],
    ['icon-40@2x.png',    80],  ['icon-40@3x.png',   120],
    ['icon-60@2x.png',   120],  ['icon-60@3x.png',   180],
    ['icon-20.png',       20],  ['icon-29.png',       29],
    ['icon-40.png',       40],  ['icon-76.png',       76],
    ['icon-76@2x.png',   152],  ['icon-83.5@2x.png', 167],
    ['icon-1024.png',   1024]
  ];

  // Clean old icons
  const old = fs.readdirSync(appIconPath).filter(f => f.endsWith('.png'));
  if (old.length > 0) {
    old.forEach(f => { try { fs.unlinkSync(path.join(appIconPath, f)); } catch (e) {} });
    console.log(`   🧹 Cleaned ${old.length} old icon(s)`);
  }

  let ok = 0;
  for (const [filename, size] of sizes) {
    const output = path.join(appIconPath, filename);
    if (await resizeImage(iconBuffer, output, size)) {
      if (fs.existsSync(output) && fs.statSync(output).size > 0) ok++;
    }
  }
  console.log(`   ✅ iOS: generated ${ok}/${sizes.length} icons`);

  // Write Contents.json
  const contentsJson = {
    images: [
      { size: '20x20',      idiom: 'iphone',        filename: 'icon-20@2x.png',    scale: '2x' },
      { size: '20x20',      idiom: 'iphone',        filename: 'icon-20@3x.png',    scale: '3x' },
      { size: '29x29',      idiom: 'iphone',        filename: 'icon-29@2x.png',    scale: '2x' },
      { size: '29x29',      idiom: 'iphone',        filename: 'icon-29@3x.png',    scale: '3x' },
      { size: '40x40',      idiom: 'iphone',        filename: 'icon-40@2x.png',    scale: '2x' },
      { size: '40x40',      idiom: 'iphone',        filename: 'icon-40@3x.png',    scale: '3x' },
      { size: '60x60',      idiom: 'iphone',        filename: 'icon-60@2x.png',    scale: '2x' },
      { size: '60x60',      idiom: 'iphone',        filename: 'icon-60@3x.png',    scale: '3x' },
      { size: '20x20',      idiom: 'ipad',          filename: 'icon-20.png',       scale: '1x' },
      { size: '29x29',      idiom: 'ipad',          filename: 'icon-29.png',       scale: '1x' },
      { size: '40x40',      idiom: 'ipad',          filename: 'icon-40.png',       scale: '1x' },
      { size: '76x76',      idiom: 'ipad',          filename: 'icon-76.png',       scale: '1x' },
      { size: '76x76',      idiom: 'ipad',          filename: 'icon-76@2x.png',    scale: '2x' },
      { size: '83.5x83.5',  idiom: 'ipad',          filename: 'icon-83.5@2x.png',  scale: '2x' },
      { size: '1024x1024',  idiom: 'ios-marketing', filename: 'icon-1024.png',     scale: '1x' }
    ],
    info: { version: 1, author: 'cordova-plugin-change-app-info' }
  };

  fs.writeFileSync(
    path.join(appIconPath, 'Contents.json'),
    JSON.stringify(contentsJson, null, 2)
  );
  console.log('   ✅ Contents.json updated');
}
