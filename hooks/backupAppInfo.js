#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { getConfigParser } = require("./utils");

/**
 * Read app info from platform files
 */
function getOriginalAppInfo(context, platform) {
  const root = context.opts.projectRoot;
  const info = {
    platform: platform,
    appName: null,
    versionNumber: null,
    versionCode: null
  };

  if (platform === "android") {
    // Read AndroidManifest.xml
    const manifestPath = path.join(
      root,
      "platforms/android/app/src/main/AndroidManifest.xml"
    );
    
    if (fs.existsSync(manifestPath)) {
      const manifest = fs.readFileSync(manifestPath, "utf8");
      const versionName = manifest.match(/android:versionName="([^"]*)"/); 
      const versionCode = manifest.match(/android:versionCode="([^"]*)"/); 
      
      info.versionNumber = versionName ? versionName[1] : null;
      info.versionCode = versionCode ? versionCode[1] : null;
    }
    
    // Read strings.xml
    const stringsPath = path.join(
      root,
      "platforms/android/app/src/main/res/values/strings.xml"
    );
    
    if (fs.existsSync(stringsPath)) {
      const strings = fs.readFileSync(stringsPath, "utf8");
      const appName = strings.match(/<string name="app_name">(.*?)<\/string>/);
      info.appName = appName ? appName[1] : null;
    }
  } 
  else if (platform === "ios") {
    const platformPath = path.join(root, "platforms/ios");
    
    if (!fs.existsSync(platformPath)) {
      return info;
    }
    
    // Find iOS app folder
    const iosFolders = fs.readdirSync(platformPath).filter(f => {
      const fullPath = path.join(platformPath, f);
      return fs.statSync(fullPath).isDirectory() && 
             !["CordovaLib", "www", "cordova", "build"].includes(f);
    });
    
    if (iosFolders.length > 0) {
      const appFolderName = iosFolders[0];
      const plistPath = path.join(
        platformPath,
        appFolderName,
        `${appFolderName}-Info.plist`
      );
      
      if (fs.existsSync(plistPath)) {
        const plist = fs.readFileSync(plistPath, "utf8");
        const displayName = plist.match(/<key>CFBundleDisplayName<\/key>\s*<string>(.*?)<\/string>/);
        const versionNumber = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(.*?)<\/string>/);
        const buildNumber = plist.match(/<key>CFBundleVersion<\/key>\s*<string>(.*?)<\/string>/);
        
        info.appName = displayName ? displayName[1] : null;
        info.versionNumber = versionNumber ? versionNumber[1] : null;
        info.versionCode = buildNumber ? buildNumber[1] : null;
      }
    }
  }

  return info;
}

/**
 * Save backup to JSON file
 */
function saveBackup(root, backupData) {
  const backupDir = path.join(root, ".cordova-build-backup");
  
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  
  const backupFile = path.join(backupDir, "app-info-backup.json");
  fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2), "utf8");
  
  console.log("Backup saved: " + backupFile);
}

/**
 * Main hook - runs BEFORE changeAppInfo
 */
module.exports = function(context) {
  const root = context.opts.projectRoot;
  const platforms = context.opts.platforms;

  console.log("\n==================================");
  console.log("      BACKUP APP INFO HOOK        ");
  console.log("==================================");

  // Read config to get API_HOSTNAME and APP_NAME (from MABS)
  const config = getConfigParser(context, path.join(root, "config.xml"));
  
  // Try multiple ways to get hostname
  const apiHostname = config.getPreference("API_HOSTNAME");
  const serverUrl = config.getPreference("SERVER_URL");
  const hostname = config.getPreference("hostname");
  
  // Get MABS app name (before it gets overridden by APP_NAME preference)
  const mabsAppName = config.name() || config.getPreference("APP_NAME") || "";
  
  console.log("\n[DEBUG: READING CONFIG.XML]");
  console.log("  API_HOSTNAME: " + (apiHostname || "(not found)"));
  console.log("  SERVER_URL: " + (serverUrl || "(not found)"));
  console.log("  hostname: " + (hostname || "(not found)"));
  console.log("  MABS App Name: " + (mabsAppName || "(not found)"));
  console.log("  Widget ID: " + (config.packageName() || "(not found)"));
  
  // Use first available hostname
  const finalHostname = apiHostname || serverUrl || hostname || "";
  
  console.log("\n[CONFIG VALUES]");
  console.log("  Selected Hostname: " + (finalHostname || "(NONE - will use fallback)"));
  console.log("  MABS App Name: " + (mabsAppName || "(NONE)"));

  const backupData = {
    timestamp: new Date().toISOString(),
    apiHostname: finalHostname,
    mabsAppName: mabsAppName,
    platforms: {}
  };

  for (const platform of platforms) {
    console.log("\n[" + platform.toUpperCase() + "]");
    console.log("  Reading original values...");
    
    const originalInfo = getOriginalAppInfo(context, platform);
    backupData.platforms[platform] = originalInfo;
    
    console.log("  App Name: " + (originalInfo.appName || "N/A"));
    console.log("  Version: " + (originalInfo.versionNumber || "N/A") + " (" + (originalInfo.versionCode || "N/A") + ")");
  }

  // Save backup
  saveBackup(root, backupData);
  
  console.log("\n[BACKUP CONTENT]");
  console.log(JSON.stringify(backupData, null, 2));

  console.log("\n==================================");
  console.log("Backup completed!");
  console.log("==================================\n");
};