#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { getConfigParser } = require("./utils");

/**
 * Get app name from config.xml
 */
function getAppNameFromConfig(context) {
  const root = context.opts.projectRoot;
  const configPath = path.join(root, "config.xml");
  
  try {
    const config = getConfigParser(context, configPath);
    return config.name() || null;
  } catch (err) {
    console.warn("  Warning: Cannot read app name from config.xml:", err.message);
    return null;
  }
}

/**
 * Get app name from MABS environment variables
 */
function getAppNameFromMABS() {
  // MABS có thể truyền app name qua các biến môi trường này
  const mabsAppName = process.env.APP_NAME || 
                      process.env.APPLICATION_NAME || 
                      process.env.MABS_APP_NAME ||
                      process.env.CORDOVA_APP_NAME;
  
  return mabsAppName || null;
}

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

  // Read config to get API_HOSTNAME (from MABS)
  const config = getConfigParser(context, path.join(root, "config.xml"));
  
  // Try multiple ways to get hostname
  const apiHostname = config.getPreference("API_HOSTNAME");
  const serverUrl = config.getPreference("SERVER_URL");
  const hostname = config.getPreference("hostname");
  
  console.log("\n[DEBUG: READING CONFIG.XML]");
  console.log("  API_HOSTNAME: " + (apiHostname || "(not found)"));
  console.log("  SERVER_URL: " + (serverUrl || "(not found)"));
  console.log("  hostname: " + (hostname || "(not found)"));
  console.log("  Widget ID: " + (config.packageName() || "(not found)"));
  
  // Use first available hostname
  const finalHostname = apiHostname || serverUrl || hostname || "";
  
  // Get app name with fallback priority: config.xml > MABS env > default
  console.log("\n[APP NAME DETECTION]");
  const configAppName = getAppNameFromConfig(context);
  const mabsAppName = getAppNameFromMABS();
  
  console.log("  From config.xml: " + (configAppName || "(not found)"));
  console.log("  From MABS env: " + (mabsAppName || "(not found)"));
  
  const backupAppName = configAppName || mabsAppName || "HelloCordova";
  console.log("  Selected App Name: " + backupAppName);
  
  console.log("\n[CONFIG VALUES]");
  console.log("  Selected Hostname: " + (finalHostname || "(NONE - will use fallback)"));

  const backupData = {
    timestamp: new Date().toISOString(),
    apiHostname: finalHostname,
    configAppName: backupAppName,
    platforms: {}
  };

  for (const platform of platforms) {
    console.log("\n[" + platform.toUpperCase() + "]");
    console.log("  Reading original values...");
    
    const originalInfo = getOriginalAppInfo(context, platform);
    
    // If platform doesn't have app name yet, use the backup app name
    if (!originalInfo.appName) {
      originalInfo.appName = backupAppName;
      console.log("  App Name (from backup): " + backupAppName);
    } else {
      console.log("  App Name (from platform): " + originalInfo.appName);
    }
    
    backupData.platforms[platform] = originalInfo;
    
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