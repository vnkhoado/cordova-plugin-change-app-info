#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

module.exports = function (context) {
    const platformRoot = path.join(context.opts.projectRoot, 'platforms', 'ios');
    if (!fs.existsSync(platformRoot)) return;

    // Tìm file Info.plist
    const appName  = fs.readdirSync(platformRoot).find(f =>
        fs.statSync(path.join(platformRoot, f)).isDirectory() &&
        !['build', 'www', 'cordova'].includes(f)
    );
    if (!appName) return;

    const plistPath = path.join(platformRoot, appName, appName + '-Info.plist');
    if (!fs.existsSync(plistPath)) {
        console.log('[RIC Hook] Info.plist không tìm thấy:', plistPath);
        return;
    }

    // Quét www/RuntimeIcons/ để lấy danh sách icon
    const wwwRicPath = path.join(
        context.opts.projectRoot, 'www', 'RuntimeIcons'
    );
    if (!fs.existsSync(wwwRicPath)) {
        console.log('[RIC Hook] www/RuntimeIcons/ không tồn tại — bỏ qua');
        return;
    }

    const iconNames = fs.readdirSync(wwwRicPath).filter(f =>
        fs.statSync(path.join(wwwRicPath, f)).isDirectory()
    );

    if (iconNames.length === 0) {
        console.log('[RIC Hook] Không có icon nào trong www/RuntimeIcons/');
        return;
    }

    console.log('[RIC Hook] Tìm thấy icons:', iconNames.join(', '));

    // Sinh XML cho CFBundleAlternateIcons
    let altIconsXml = '';
    iconNames.forEach(name => {
        altIconsXml += `
        <key>${name}</key>
        <dict>
            <key>CFBundleIconFiles</key>
            <array>
                <!-- ✅ Phải có tiền tố www/ -->
                <string>www/RuntimeIcons/${name}/Icon</string>
            </array>
            <key>UIPrerenderedIcon</key>
            <false/>
        </dict>`;
    });

    const injection = `
    <key>CFBundleIcons</key>
    <dict>
        <key>CFBundleAlternateIcons</key>
        <dict>${altIconsXml}
        </dict>
        <key>CFBundlePrimaryIcon</key>
        <dict>
            <key>CFBundleIconFiles</key>
            <array/>
        </dict>
    </dict>
    <key>UIApplicationSupportsAlternateIcons</key>
    <true/>`;

    let plistContent = fs.readFileSync(plistPath, 'utf8');

    // Xoá entry cũ nếu đã có
    plistContent = plistContent
        .replace(/<key>CFBundleIcons<\/key>[\s\S]*?<\/dict>\s*(?=<key>|<\/dict>)/g, '')
        .replace(/<key>UIApplicationSupportsAlternateIcons<\/key>\s*<(true|false)\/>/g, '');

    // Inject vào trước </dict> cuối cùng
    plistContent = plistContent.replace(
        /(<\/dict>\s*<\/plist>)/,
        `${injection}\n$1`
    );

    fs.writeFileSync(plistPath, plistContent, 'utf8');
    console.log('[RIC Hook] Info.plist đã được cập nhật với', iconNames.length, 'icon(s)');
};
