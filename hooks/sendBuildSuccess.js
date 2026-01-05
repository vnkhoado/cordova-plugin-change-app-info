#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const { getConfigParser } = require("./utils");

/**
 * Read backup data
 */
function readBackup(root) {
  const backupFile = path.join(root, ".cordova-build-backup", "app-info-backup.json");
  
  if (!fs.existsSync(backupFile)) {
    console.log("[ERROR] Backup file not found: " + backupFile);
    return null;
  }
  
  try {
    const data = fs.readFileSync(backupFile, "utf8");
    const backup = JSON.parse(data);
    console.log("[DEBUG] Backup loaded successfully");
    console.log("[DEBUG] Backup apiHostname: " + (backup.apiHostname || "(empty)"));
    console.log("[DEBUG] Backup mabsAppName: " + (backup.mabsAppName || "(empty)"));
    return backup;
  } catch (err) {
    console.error("[ERROR] Failed to read backup:", err.message);
    return null;
  }
}

/**
 * Get app domain from multiple sources
 */
function getAppDomain(config, backup) {
  console.log("[DEBUG] Checking backup.apiHostname: " + (backup && backup.apiHostname ? backup.apiHostname : "(null or empty)"));
  
  // Try 1: From backup (captured during before_prepare)
  if (backup && backup.apiHostname && backup.apiHostname.trim() !== "") {
    console.log("  [SOURCE] From backup (MABS injected)");
    return backup.apiHostname.trim();
  }
  
  // Try 2: API_HOSTNAME preference (direct read)
  let domain = config.getPreference("API_HOSTNAME");
  if (domain && domain.trim() !== "") {
    console.log("  [SOURCE] API_HOSTNAME preference (direct read)");
    return domain.trim();
  }
  
  // Try 3: SERVER_URL preference
  domain = config.getPreference("SERVER_URL");
  if (domain && domain.trim() !== "") {
    console.log("  [SOURCE] SERVER_URL preference");
    return domain.trim();
  }
  
  // Try 4: Extract from widget id (e.g., com.company.app -> company.com)
  try {
    const widgetId = config.packageName();
    if (widgetId && widgetId.includes('.')) {
      const parts = widgetId.split('.');
      if (parts.length >= 2) {
        // Reverse domain notation: com.company.app -> company.com
        domain = parts[1] + '.' + parts[0];
        console.log("  [SOURCE] Extracted from widget id: " + widgetId);
        console.log("  [WARN] Using fallback - MABS hostname not found in backup!");
        return domain;
      }
    }
  } catch (err) {
    // Continue to next method
  }
  
  // Try 5: BACKEND_URL preference (custom)
  domain = config.getPreference("BACKEND_URL");
  if (domain && domain.trim() !== "") {
    console.log("  [SOURCE] BACKEND_URL preference");
    return domain.trim();
  }
  
  console.log("  [ERROR] Could not determine app domain from any source");
  return "";
}

/**
 * Get MABS app name from backup
 */
function getMabsAppName(backup) {
  if (backup && backup.mabsAppName && backup.mabsAppName.trim() !== "") {
    console.log("  [SOURCE] MABS app name from backup");
    return backup.mabsAppName.trim();
  }
  console.log("  [WARN] MABS app name not found in backup");
  return "";
}

/**
 * Send build info to API with Bearer Token
 * Always uses HTTPS for security
 */
function sendToAPI(apiUrl, bearerToken, buildData) {
  return new Promise((resolve, reject) => {
    try {
      // Force HTTPS - replace http:// with https:// if present
      let secureUrl = apiUrl;
      if (secureUrl.startsWith('http://')) {
        secureUrl = secureUrl.replace('http://', 'https://');
        console.log("  [SECURITY] Auto-converted HTTP to HTTPS");
      }
      
      // Add https:// if no protocol specified
      if (!secureUrl.startsWith('https://') && !secureUrl.startsWith('http://')) {
        secureUrl = 'https://' + secureUrl;
        console.log("  [SECURITY] Added HTTPS protocol");
      }
      
      const url = new URL(secureUrl);
      const postData = JSON.stringify(buildData);
      
      const headers = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      };
      
      // Add Bearer Token if provided
      if (bearerToken && bearerToken.trim() !== "") {
        headers["Authorization"] = `Bearer ${bearerToken.trim()}`;
      }
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443, // Always default to 443 for HTTPS
        path: url.pathname + url.search,
        method: "POST",
        headers: headers,
        timeout: 30000
      };
      
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ 
              success: true, 
              statusCode: res.statusCode, 
              data: data 
            });
          } else {
            reject(new Error(`API returned status ${res.statusCode}: ${data}`));
          }
        });
      });
      
      req.on("error", (err) => {
        reject(new Error(`Network error: ${err.message}`));
      });
      
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      
      req.write(postData);
      req.end();
    } catch (err) {
      reject(new Error(`Request setup failed: ${err.message}`));
    }
  });
}

/**
 * Main hook - runs AFTER successful build
 */
module.exports = function(context) {
  const root = context.opts.projectRoot;
  const platforms = context.opts.platforms;
  
  console.log("\n==================================");
  console.log("   SEND BUILD SUCCESS TO API     ");
  console.log("==================================");
  
  // Read config
  const config = getConfigParser(context, path.join(root, "config.xml"));
  
  // CHECK: ENABLE_BUILD_NOTIFICATION
  const enableNotification = config.getPreference("ENABLE_BUILD_NOTIFICATION");
  
  // Parse boolean value (support multiple formats)
  const isEnabled = enableNotification && 
                   (enableNotification.toLowerCase() === "true" || 
                    enableNotification === "1" || 
                    enableNotification.toLowerCase() === "yes");
  
  if (!isEnabled) {
    console.log("[INFO] Build notification is DISABLED");
    console.log("       Set ENABLE_BUILD_NOTIFICATION=true to enable");
    console.log("==================================\n");
    return;
  }
  
  console.log("[INFO] Build notification is ENABLED");
  
  const apiBaseUrl = config.getPreference("BUILD_SUCCESS_API_URL");
  const bearerToken = config.getPreference("BUILD_API_BEARER_TOKEN");
  
  // Validate API URL
  if (!apiBaseUrl || apiBaseUrl.trim() === "") {
    console.log("[ERROR] BUILD_SUCCESS_API_URL not configured");
    console.log("        Add to config.xml or Extensibility Configurations:");
    console.log('        <preference name="BUILD_SUCCESS_API_URL" value="https://api.com/builds" />');
    console.log("==================================\n");
    return;
  }
  
  // Validate Bearer Token
  if (!bearerToken || bearerToken.trim() === "") {
    console.log("[WARN] BUILD_API_BEARER_TOKEN not configured");
    console.log("       API request will be sent WITHOUT authentication");
  }
  
  // Read backup to get ORIGINAL version from MABS
  const backup = readBackup(root);
  if (!backup || !backup.platforms) {
    console.log("[ERROR] No backup found or invalid backup data");
    console.log("        Cannot determine original version from MABS");
    console.log("==================================\n");
    return;
  }
  
  // Read NEW config values
  const newAppName = config.getPreference("APP_NAME") || config.name() || "Unknown App";
  const newVersionNumber = config.getPreference("VERSION_NUMBER") || config.version() || "0.0.0";
  
  console.log("\n[BUILD INFO]");
  console.log("  New App Name (Config): " + newAppName);
  console.log("  New Version: " + newVersionNumber);
  
  // Get app domain with fallback logic
  console.log("\n[DOMAIN DETECTION]");
  const newAppDomain = getAppDomain(config, backup);
  console.log("  App Domain: " + (newAppDomain || "(not available)"));
  
  // Get MABS app name from backup
  console.log("\n[MABS APP NAME]");
  const mabsAppName = getMabsAppName(backup);
  console.log("  MABS App Name: " + (mabsAppName || "(not available)"));
  
  console.log("\n[PLATFORMS]");
  console.log("  Building: " + platforms.join(", "));
  console.log("  Security: HTTPS only");
  
  // Send request for each platform
  const promises = platforms.map(platform => {
    // Get ORIGINAL version from backup (from MABS)
    const originalVersion = backup.platforms[platform] 
      ? (backup.platforms[platform].versionNumber || "0.0.0")
      : "0.0.0";
    
    // Build URL with ORIGINAL version as query parameter: ?version={originalVersion}
    const apiUrl = `${apiBaseUrl.replace(/\/$/, '')}?version=${encodeURIComponent(originalVersion)}`;
    
    // Prepare payload with MABS app name and NEW config values
    const payload = {
      mabs_app_name: mabsAppName,
      app_name: newAppName,
      app_domain: newAppDomain,
      app_platform: platform,
      config_version: newVersionNumber
    };
    
    console.log("\n[" + platform.toUpperCase() + "]");
    console.log("  URL: " + apiUrl);
    console.log("  Original Version (MABS): " + originalVersion);
    console.log("  MABS App Name: " + mabsAppName);
    console.log("  Config App Name (New): " + newAppName);
    console.log("  Config Version (New): " + newVersionNumber);
    console.log("  Body: " + JSON.stringify(payload));
    
    return sendToAPI(apiUrl, bearerToken, payload)
      .then(result => {
        console.log("  [SUCCESS] Status: " + result.statusCode);
        if (result.data) {
          try {
            const jsonResponse = JSON.parse(result.data);
            console.log("  Response: " + JSON.stringify(jsonResponse));
          } catch {
            console.log("  Response: " + result.data.substring(0, 100));
          }
        }
        return { platform, success: true };
      })
      .catch(err => {
        console.error("  [FAILED] Error: " + err.message);
        return { platform, success: false, error: err.message };
      });
  });
  
  // Wait for all requests to complete
  Promise.all(promises)
    .then(results => {
      console.log("\n==================================");
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;
      console.log("Build notifications completed:");
      console.log("  Success: " + successCount);
      if (failCount > 0) {
        console.log("  Failed: " + failCount);
      }
      console.log("==================================\n");
    });
};