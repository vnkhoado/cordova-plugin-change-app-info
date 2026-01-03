#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

module.exports = function (ctx) {
  const platform = "android";
  if (!ctx.opts.platforms.includes(platform)) {
    return;
  }

  const rootDir = ctx.opts.projectRoot;

  // Thư mục resource trong Android Gradle
  const resDest = path.join(rootDir, "platforms", "android", "app", "src", "main", "res");

  // Các density Android
  const densities = ["ldpi", "mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];

  console.log("Cordova hook: Copying icons → ic_launcher.png");

  densities.forEach((dpi) => {
    // Ưu tiên res/android, fallback sang source/res/android
    const srcCandidates = [
      path.join(rootDir, "res", "android", `drawable-${dpi}`, "icon.png"),
      path.join(rootDir, "source", "res", "android", `drawable-${dpi}`, "icon.png"),
    ];

    const src = srcCandidates.find((f) => fs.existsSync(f));
    const dest = path.join(resDest, `drawable-${dpi}`, `ic_launcher.png`);

    if (src) {
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        console.log(`Copied: ${src} → ${dest}`);
      } catch (err) {
        console.error(`Error copying ${src} → ${dest}:`, err);
      }
    } else {
      console.warn(`Not found: ${srcCandidates.join(" or ")}`);
    }
  });

  console.log("Hook completed.");
};
