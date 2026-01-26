#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { getConfigParser } = require('./utils');

/**
 * SIMPLIFIED: JSON-only config storage for native injection
 * 
 * Stores build configuration in:
 *   - www/.cordova-app-data/build-config.json (current config with nested structure)
 *   - www/cordova-build-config.json (flat structure for native plugin)
 *   - www/.cordova-app-data/build-history.json (build history - max 50)
 * 
 * Native plugins (CSSInjector.java / CSSInjector.swift) will read 
 * cordova-build-config.json and inject directly into window.CORDOVA_BUILD_CONFIG
 * 
 * ENHANCED:
 *   - Read hostname from OutSystems preferences (hostname, DefaultHostname)
 *   - Read from environment variables (MABS)
 *   - Support multiple config sources
 *   - Support custom preferences (TENANT_ID, etc.) ✨ NEW
 */

/**
 * Get config value from multiple sources (priority order)
 */
function getConfigValue(envName, prefNames, config, defaultValue = '') {
  // Ensure prefNames is an array
  if (typeof prefNames === 'string') {
    prefNames = [prefNames];
  }
  
  // 1. Try environment variable (MABS builds)
  if (process.env[envName]) {
    console.log(`   ✟ Found from env.${envName}: ${process.env[envName]}`);
    return process.env[envName];
  }
  
  // 2. Try each Cordova preference name in order
  for (const prefName of prefNames) {
    const prefValue = config.getPreference(prefName);
    if (prefValue) {
      console.log(`   ✟ Found from preference '${prefName}': ${prefValue}`);
      return prefValue;
    }
  }
  
  // 3. Default value
  if (defaultValue) {
    console.log(`   ⚠️  ${prefNames[0]} not found, using default: ${defaultValue}`);
  } else {
    console.log(`   ⚠️  ${prefNames[0]} not found, using empty string`);
  }
  return defaultValue;
}

/**
 * ✨ NEW: Get all custom preferences that start with specific prefixes
 * This allows dynamic custom fields without hardcoding
 */
function getCustomPreferences(config) {
  const customPrefs = {};
  
  // Define which prefixes to look for
  const customPrefixes = ['TENANT_', 'CUSTOM_', 'CLIENT_', 'APP_CUSTOM_'];
  
  try {
    // Get config.xml path and read it
    const configXml = config.doc;
    if (!configXml) return customPrefs;
    
    // Find all preference elements
    const preferences = configXml.findall('./preference');
    
    preferences.forEach(pref => {
      const name = pref.attrib.name;
      const value = pref.attrib.value;
      
      // Check if preference matches any custom prefix
      const isCustom = customPrefixes.some(prefix => name.startsWith(prefix));
      
      if (isCustom && value) {
        // Convert preference name to camelCase for consistency
        // TENANT_ID -> tenantId
        // CUSTOM_FIELD_1 -> customField1
        const camelCaseName = name.toLowerCase().replace(/_(.)/g, (_, char) => char.toUpperCase());
        customPrefs[camelCaseName] = value;
        console.log(`   ✨ Custom preference: ${name} = ${value}`);
      }
    });
  } catch (error) {
    console.log(`   ⚠️  Could not read custom preferences: ${error.message}`);
  }
  
  return customPrefs;
}

/**
 * Write JSON file with verification
 */
function writeJSONWithVerification(filePath, data, description) {
  try {
    const dir = path.dirname(filePath);
    
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`   📁 Created directory: ${dir}`);
    }
    
    // Write file
    const jsonString = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, jsonString, { encoding: 'utf8', flag: 'w' });
    
    // Immediate verification
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      
      if (content.length > 0 && stats.size > 0) {
        console.log(`   ✅ ${description}: ${stats.size} bytes`);
        return true;
      } else {
        console.error(`   ❌ ${description}: File is empty!`);
        return false;
      }
    } else {
      console.error(`   ❌ ${description}: File does not exist after write!`);
      console.error(`   📍 Path: ${filePath}`);
      return false;
    }
  } catch (error) {
    console.error(`   ❌ Error writing ${description}:`, error.message);
    console.error(`   📍 Path: ${filePath}`);
    return false;
  }
}

/**
 * Create JSON build config file in multiple locations
 */
function createBuildConfigJSON(buildInfo, configPath, root, wwwPath) {
  const data = {
    timestamp: new Date().toISOString(),
    version: '1.0',
    config: {
      appName: buildInfo.appName,
      appId: buildInfo.packageName,
      appVersion: buildInfo.versionNumber,
      appDescription: buildInfo.appDescription || '',
      platform: buildInfo.platform,
      author: buildInfo.author || '',
      buildDate: buildInfo.buildTime,
      buildTimestamp: buildInfo.buildTimestamp,
      environment: buildInfo.environment || 'production',
      apiHostname: buildInfo.apiHostname || '',
      cdnIcon: buildInfo.cdnIcon || '',
      // ✨ Include custom preferences
      ...buildInfo.customPreferences
    }
  };
  
  // Primary location: platforms/android/app/src/main/assets/www/.cordova-app-data/
  const success1 = writeJSONWithVerification(configPath, data, 'build-config.json (platforms)');
  
  // Backup location 1: root www/.cordova-app-data/
  const rootWwwDir = path.join(root, 'www', '.cordova-app-data');
  const rootConfigPath = path.join(rootWwwDir, 'build-config.json');
  const success2 = writeJSONWithVerification(rootConfigPath, data, 'build-config.json (root www)');
  
  // Backup location 2: directly in www/ for easy access
  const wwwConfigPath = path.join(wwwPath, 'build-config.json');
  const success3 = writeJSONWithVerification(wwwConfigPath, data, 'build-config.json (www root)');
  
  if (!success1 && !success2 && !success3) {
    throw new Error('Failed to create build-config.json in any location!');
  }
}

/**
 * NEW: Create flat config for native plugin injection
 */
function createNativeConfig(buildInfo, wwwPath) {
  const nativeConfig = {
    appName: buildInfo.appName,
    appId: buildInfo.packageName,
    appVersion: buildInfo.versionNumber,
    versionCode: buildInfo.versionCode,
    appDescription: buildInfo.appDescription || '',
    platform: buildInfo.platform,
    author: buildInfo.author || '',
    buildDate: buildInfo.buildTime,
    buildTimestamp: buildInfo.buildTimestamp,
    environment: buildInfo.environment || 'production',
    apiHostname: buildInfo.apiHostname || '',
    cdnIcon: buildInfo.cdnIcon || '',
    // ✨ Include all custom preferences
    ...buildInfo.customPreferences
  };
  
  const nativeConfigPath = path.join(wwwPath, 'cordova-build-config.json');
  return writeJSONWithVerification(nativeConfigPath, nativeConfig, 'cordova-build-config.json (native)');
}

/**
 * Update build history (max 50 entries)
 */
function updateBuildHistory(buildInfo, historyPath, root, wwwPath) {
  let history = [];
  
  // Load existing history
  if (fs.existsSync(historyPath)) {
    try {
      const content = fs.readFileSync(historyPath, 'utf8');
      const data = JSON.parse(content);
      history = data.history || [];
    } catch (error) {
      console.log('   ⚠️  Could not read history, starting fresh');
      history = [];
    }
  }
  
  // Add new entry
  history.push({
    timestamp: new Date().toISOString(),
    buildId: `build_${Date.now()}`,
    platform: buildInfo.platform,
    appVersion: buildInfo.versionNumber,
    appName: buildInfo.appName,
    environment: buildInfo.environment || 'production',
    success: true
  });
  
  // Keep only last 50
  if (history.length > 50) {
    history = history.slice(-50);
  }
  
  const data = {
    version: '1.0',
    count: history.length,
    lastUpdated: new Date().toISOString(),
    history: history
  };
  
  // Write to primary location
  const success1 = writeJSONWithVerification(historyPath, data, `build-history.json (${history.length} entries)`);
  
  // Write to backup locations
  const rootWwwDir = path.join(root, 'www', '.cordova-app-data');
  const rootHistoryPath = path.join(rootWwwDir, 'build-history.json');
  writeJSONWithVerification(rootHistoryPath, data, 'build-history.json (root www)');
  
  if (!success1) {
    console.log('   ⚠️  Primary build-history.json failed, but backup created');
  }
}

/**
 * Main inject function
 */
function injectBuildInfo(context, platform) {
  const root = context.opts.projectRoot;
  const config = getConfigParser(context, path.join(root, 'config.xml'));
  
  console.log(`   📂 Project root: ${root}`);
  
  // Log all environment variables starting with API, APP, or MABS
  console.log('\n   🔍 Environment variables:');
  const relevantEnvVars = Object.keys(process.env)
    .filter(key => key.startsWith('API_') || key.startsWith('APP_') || key.startsWith('MABS_') || key.toUpperCase().includes('HOSTNAME'));
  
  if (relevantEnvVars.length > 0) {
    relevantEnvVars.forEach(key => {
      console.log(`   - ${key}: ${process.env[key]}`);
    });
  } else {
    console.log('   - (none found)');
  }
  
  // ✨ Get custom preferences
  console.log('\n   🔍 Custom preferences:');
  const customPreferences = getCustomPreferences(config);
  
  if (Object.keys(customPreferences).length === 0) {
    console.log('   - (none found)');
  }
  
  // Prepare build info with fallback chain
  const buildInfo = {
    appName: getConfigValue('APP_NAME', ['APP_NAME'], config, config.name() || 'Unknown'),
    versionNumber: getConfigValue('VERSION_NUMBER', ['VERSION_NUMBER'], config, config.version() || '0.0.0'),
    versionCode: getConfigValue('VERSION_CODE', ['VERSION_CODE'], config, '0'),
    packageName: config.packageName() || 'unknown',
    appDescription: getConfigValue('APP_DESCRIPTION', ['APP_DESCRIPTION'], config),
    author: getConfigValue('AUTHOR', ['AUTHOR'], config),
    platform: platform,
    buildTime: new Date().toISOString(),
    buildTimestamp: Date.now(),
    // Try multiple preference names for hostname (OutSystems compatibility)
    apiHostname: getConfigValue('API_HOSTNAME', ['hostname', 'DefaultHostname', 'API_HOSTNAME'], config),
    environment: getConfigValue('ENVIRONMENT', ['ENVIRONMENT'], config, 'production'),
    cdnIcon: getConfigValue('CDN_ICON', ['CDN_ICON'], config),
    // ✨ Include all custom preferences
    customPreferences: customPreferences
  };
  
  console.log('\n   📦 Build Info:');
  console.log(`   - appName: ${buildInfo.appName}`);
  console.log(`   - apiHostname: ${buildInfo.apiHostname || '(empty)'}`);
  console.log(`   - environment: ${buildInfo.environment}`);
  console.log(`   - platform: ${buildInfo.platform}`);
  
  // Log custom preferences
  if (Object.keys(customPreferences).length > 0) {
    console.log('\n   ✨ Custom preferences in build:');
    Object.keys(customPreferences).forEach(key => {
      console.log(`   - ${key}: ${customPreferences[key]}`);
    });
  }
  
  // Determine www path
  let wwwPath;
  if (platform === 'android') {
    wwwPath = path.join(root, 'platforms/android/app/src/main/assets/www');
  } else if (platform === 'ios') {
    wwwPath = path.join(root, 'platforms/ios/www');
  } else {
    console.log(`   ⚠️  Unknown platform: ${platform}`);
    return;
  }
  
  console.log(`   📂 WWW path: ${wwwPath}`);
  
  if (!fs.existsSync(wwwPath)) {
    console.log(`   ⚠️  www directory not found: ${wwwPath}`);
    return;
  }
  
  // Create config storage directory
  const cordovaDataDir = path.join(wwwPath, '.cordova-app-data');
  const configPath = path.join(cordovaDataDir, 'build-config.json');
  const historyPath = path.join(cordovaDataDir, 'build-history.json');
  
  console.log(`   📂 Config directory: ${cordovaDataDir}`);
  
  // Create JSON configs
  createBuildConfigJSON(buildInfo, configPath, root, wwwPath);
  updateBuildHistory(buildInfo, historyPath, root, wwwPath);
  
  // NEW: Create flat config for native injection
  const nativeConfigCreated = createNativeConfig(buildInfo, wwwPath);
  
  if (nativeConfigCreated) {
    console.log('   ✅ Config files created for native injection');
    console.log('   ℹ️  Native plugins will inject config into window.CORDOVA_BUILD_CONFIG');
    if (Object.keys(customPreferences).length > 0) {
      console.log('   ✨ Custom preferences included in config');
    }
  } else {
    console.log('   ⚠️  Native config creation may have failed - check manually');
  }
}

/**
 * Module export
 */
module.exports = function(context) {
  const platforms = context.opts.platforms;
  
  console.log('\n══════════════════════════════════════════════');
  console.log('  INJECT BUILD INFO (Native Injection Ready)');
  console.log('  ✨ With Custom Preferences Support');
  console.log('══════════════════════════════════════════════');
  
  for (const platform of platforms) {
    console.log(`\n📱 ${platform}...`);
    try {
      injectBuildInfo(context, platform);
    } catch (error) {
      console.error(`\n❌ Error:`, error.message);
      console.error(error.stack);
      throw error;
    }
  }
  
  console.log('\n══════════════════════════════════════════════');
  console.log('✅ Completed!\n');
};