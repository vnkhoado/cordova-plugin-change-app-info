# cordova-plugin-change-app-info

Cordova plugin to change app info (display name, version, icon) from CDN at build time. **Native config injection** for instant access to build configuration. **Optimized for OutSystems MABS**.

## Features

✅ **Native Config Injection** 🆕
- Build config automatically injected into `window.CORDOVA_BUILD_CONFIG`
- Available immediately after `deviceready` - no file loading needed
- Works with Java/Swift native code - no JavaScript loaders required
- Perfect for OutSystems `OnApplicationReady` integration

✅ **Dynamic App Configuration**
- Set app display name dynamically
- Configure version number and build code
- Download and set app icon from CDN URL (requires sharp or jimp)
- **Custom preferences support** - Inject any custom fields (TENANT_ID, etc.) 🆕

✅ **JSON Config Storage**
- Saves app info to multiple locations for redundancy
- **Native injection** - Config available in `window.CORDOVA_BUILD_CONFIG`
- Tracks build history (last 50 builds)
- **No sqlite needed!** Works on all cloud builds

✅ **UI Customization**
- **Splash screen color**: Custom background color for native splash screen
- **Webview background color**: Eliminate white flash on app launch
- **Red flash fix**: Enhanced hook to fix red/purple flash after splash screen
- **Works with OutSystems MABS**: Properly overrides theme colors

✅ **Build Success Notification**
- Send HTTP POST notification to API when build completes
- Configurable endpoint and bearer token
- Useful for CI/CD pipelines

## Requirements

- **Cordova**: >= 9.0.0
- **Node.js**: >= 14.0.0
- **npm**: >= 6.0.0

### Required Dependencies

✨ **NONE!** All dependencies auto-install on first build.

### Optional Dependencies

- **sharp**: Fast image resizing for CDN icon generation (⭐ **Recommended**)
  - `npm install sharp`
  - Faster and better quality than jimp
  - Requires native compilation (may need build tools)

- **jimp**: Fallback image processor (pure JavaScript)
  - `npm install jimp`
  - Works everywhere, slower than sharp

## Installation

### Quick Start (Recommended)

```bash
# 1. Add the plugin
cordova plugin add https://github.com/vnkhoado/cordova-plugin-change-app-info.git

# 2. Build (auto-installs dependencies!)
cordova build android ios
```

✨ The auto-install hook will:
- ✅ Check for optional dependencies (sharp, jimp)
- ✅ Install missing dependencies automatically
- ✅ Display clear status messages
- ✅ Continue build even if optional deps fail

## Configuration

### Basic App Configuration

| Preference | Description | Example |
|------------|-------------|----------|
| `APP_NAME` | App display name | `"MyApp"` |
| `VERSION_NUMBER` | Version string | `"1.0.0"` |
| `VERSION_CODE` | Build number | `"1"` |
| `CDN_ICON` | Icon URL (1024x1024 PNG) | `"https://cdn.com/icon.png"` |
| `ENVIRONMENT` | Environment name | `"production"` |
| `API_HOSTNAME` | API base URL | `"https://api.example.com"` |

### Custom Preferences 🆕

**Inject any custom data into your app config!** The plugin automatically detects preferences starting with:
- `TENANT_*` (e.g., `TENANT_ID`, `TENANT_NAME`)
- `CUSTOM_*` (e.g., `CUSTOM_FIELD_1`, `CUSTOM_API_KEY`)
- `CLIENT_*` (e.g., `CLIENT_ID`, `CLIENT_SECRET`)
- `APP_CUSTOM_*` (e.g., `APP_CUSTOM_CONFIG`)

**Example:**

```xml
<!-- config.xml -->
<preference name="TENANT_ID" value="1118" />
<preference name="TENANT_NAME" value="MyCompany" />
<preference name="CUSTOM_API_KEY" value="abc123" />
<preference name="CLIENT_DOMAIN" value="client.example.com" />
```

**Access in JavaScript:**

```javascript
document.addEventListener('deviceready', () => {
    const config = window.CORDOVA_BUILD_CONFIG;
    
    console.log('Tenant ID:', config.tenantId);        // "1118"
    console.log('Tenant Name:', config.tenantName);    // "MyCompany"
    console.log('API Key:', config.customApiKey);      // "abc123"
    console.log('Domain:', config.clientDomain);       // "client.example.com"
});
```

**Note:** Preference names are automatically converted to camelCase:
- `TENANT_ID` → `tenantId`
- `CUSTOM_FIELD_1` → `customField1`
- `CLIENT_API_KEY` → `clientApiKey`

### Splash Screen Color

**For OutSystems apps**, set ALL THREE:

```xml
<preference name="BackgroundColor" value="#001833" />
<preference name="SplashScreenBackgroundColor" value="#001833" />
<preference name="AndroidWindowSplashScreenBackground" value="#001833" />
```

### Webview Background

```xml
<preference name="WEBVIEW_BACKGROUND_COLOR" value="#001833" />
```

**Best Practice** - Match all colors for smooth transition:
```xml
<preference name="BackgroundColor" value="#001833" />
<preference name="SplashScreenBackgroundColor" value="#001833" />
<preference name="AndroidWindowSplashScreenBackground" value="#001833" />
<preference name="WEBVIEW_BACKGROUND_COLOR" value="#001833" />
```

## Reading Config from App

### 🆕 Native Injection (Recommended)

**The config is automatically injected by native code** - no file loading needed!

```javascript
// Cordova apps
document.addEventListener('deviceready', () => {
    const config = window.CORDOVA_BUILD_CONFIG;
    
    console.log('App Name:', config.appName);
    console.log('Version:', config.appVersion);
    console.log('API Hostname:', config.apiHostname);
    console.log('Environment:', config.environment);
    console.log('Platform:', config.platform);
    
    // Custom preferences
    console.log('Tenant ID:', config.tenantId);
});
```

**OutSystems Integration:**

```javascript
// In OnApplicationReady event
document.addEventListener('deviceready', function() {
    var config = window.CORDOVA_BUILD_CONFIG || {};
    
    console.log('[OutSystems] Config loaded:', config);
    
    // Use in your app
    $parameters.ClientVar_ApiHostname = config.apiHostname;
    $parameters.ClientVar_Environment = config.environment;
    $parameters.ClientVar_TenantId = config.tenantId; // Custom field!
});
```

**Config Structure:**

```javascript
{
  "appName": "My App",
  "appId": "com.example.app",
  "appVersion": "1.0.0",
  "versionCode": "1",
  "appDescription": "My awesome app",
  "platform": "android",
  "author": "Your Name",
  "buildDate": "2025-12-25T11:00:00.000Z",
  "buildTimestamp": 1735128000000,
  "environment": "production",
  "apiHostname": "https://api.example.com",
  "cdnIcon": "https://cdn.example.com/icon.png",
  "backgroundColor": "#FFFFFF",
  
  // Custom preferences (automatically included)
  "tenantId": "1118",
  "tenantName": "MyCompany",
  "customApiKey": "abc123",
  "clientDomain": "client.example.com"
}
```

### Alternative: Listen to Event

```javascript
window.addEventListener('cordova-config-ready', (event) => {
    const config = event.detail;
    console.log('Config ready:', config);
});
```

### Alternative: Get via Plugin

```javascript
cordova.exec(
    (config) => console.log('Config:', config),
    (error) => console.error('Error:', error),
    'CSSInjector',
    'getConfig',
    []
);
```

## Complete Example

```xml
<!-- config.xml -->
<?xml version='1.0' encoding='utf-8'?>
<widget id="com.example.app" version="1.0.0">
    <name>MyApp</name>
    <description>My App</description>
    <author email="dev@example.com" href="http://example.com">Developer</author>
    
    <!-- App Configuration -->
    <preference name="APP_NAME" value="MyApp" />
    <preference name="VERSION_NUMBER" value="1.0.0" />
    <preference name="VERSION_CODE" value="100" />
    <preference name="CDN_ICON" value="https://cdn.example.com/icon-1024.png" />
    <preference name="API_HOSTNAME" value="https://api.example.com" />
    <preference name="ENVIRONMENT" value="production" />
    
    <!-- Custom Preferences -->
    <preference name="TENANT_ID" value="1118" />
    <preference name="TENANT_NAME" value="MyCompany" />
    <preference name="CUSTOM_API_KEY" value="abc123" />
    
    <!-- Splash Screen Color -->
    <preference name="BackgroundColor" value="#001833" />
    <preference name="SplashScreenBackgroundColor" value="#001833" />
    <preference name="AndroidWindowSplashScreenBackground" value="#001833" />
    <preference name="SplashScreenDelay" value="3000" />
    
    <!-- Webview -->
    <preference name="WEBVIEW_BACKGROUND_COLOR" value="#001833" />
    
    <!-- Plugin -->
    <plugin name="cordova-plugin-change-app-info" spec="https://github.com/vnkhoado/cordova-plugin-change-app-info.git" />
</widget>
```

## OutSystems Integration

### Extensibility Configurations

```json
{
  "plugin": {
    "url": "https://github.com/vnkhoado/cordova-plugin-change-app-info.git#feature/custom-preferences-injection"
  },
  "preferences": {
    "global": [
      {
        "name": "APP_NAME",
        "value": "MyApp"
      },
      {
        "name": "VERSION_NUMBER",
        "value": "1.0.0"
      },
      {
        "name": "VERSION_CODE",
        "value": "100"
      },
      {
        "name": "hostname",
        "value": "https://api.example.com"
      },
      {
        "name": "CDN_ICON",
        "value": "https://cdn.example.com/icon-1024.png"
      },
      {
        "name": "ENVIRONMENT",
        "value": "production"
      },
      {
        "name": "TENANT_ID",
        "value": "1118"
      },
      {
        "name": "TENANT_NAME",
        "value": "MyCompany"
      },
      {
        "name": "BackgroundColor",
        "value": "#001833"
      },
      {
        "name": "SplashScreenBackgroundColor",
        "value": "#001833"
      },
      {
        "name": "AndroidWindowSplashScreenBackground",
        "value": "#001833"
      },
      {
        "name": "WEBVIEW_BACKGROUND_COLOR",
        "value": "#001833"
      }
    ]
  }
}
```

### Usage in OutSystems

See detailed guide: **[OUTSYSTEMS_INTEGRATION.md](OUTSYSTEMS_INTEGRATION.md)**

**Quick Example:**

```javascript
// In OnApplicationReady
define("MyApp.OnApplicationReady", [], function() {
    return {
        onReady: function($parameters, $actions) {
            document.addEventListener('deviceready', function() {
                var config = window.CORDOVA_BUILD_CONFIG || {};
                
                // Store in Client Variables
                $parameters.ClientVar_ApiHostname = config.apiHostname;
                $parameters.ClientVar_AppName = config.appName;
                $parameters.ClientVar_Environment = config.environment;
                
                // Custom preferences
                $parameters.ClientVar_TenantId = config.tenantId;
                $parameters.ClientVar_TenantName = config.tenantName;
                
                console.log('[MyApp] Config initialized:', config);
                console.log('[MyApp] Tenant ID:', config.tenantId);
            });
        }
    };
});
```

## Documentation

- **[NATIVE_CONFIG_INJECTION.md](NATIVE_CONFIG_INJECTION.md)** - Native config injection guide
- **[OUTSYSTEMS_INTEGRATION.md](OUTSYSTEMS_INTEGRATION.md)** - OutSystems integration guide
- **[CHANGELOG.md](CHANGELOG.md)** - Detailed version history

## Troubleshooting

### Config is undefined

```javascript
// Always wait for deviceready
document.addEventListener('deviceready', () => {
    if (!window.CORDOVA_BUILD_CONFIG) {
        console.error('Config not available!');
        
        // Try getting via plugin
        cordova.exec(
            (config) => window.CORDOVA_BUILD_CONFIG = config,
            null,
            'CSSInjector',
            'getConfig',
            []
        );
    }
});
```

### Check logs

**Android:**
```bash
adb logcat | grep CSSInjector
```

You should see:
```
[CSSInjector] Plugin initialized
[CSSInjector] Build config injected: {...}
```

**iOS:**
Check Xcode console for `[CSSInjector]` logs.

### Verify config file exists

- Android: `platforms/android/app/src/main/assets/www/cordova-build-config.json`
- iOS: `platforms/ios/www/cordova-build-config.json`

### Verify custom preferences in build output

During build, you should see:
```
✨ Custom preferences:
   - TENANT_ID = 1118
   - TENANT_NAME = MyCompany

✨ Custom preferences in build:
   - tenantId: 1118
   - tenantName: MyCompany
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed version history.

### v2.11.0 (2026-01-26) 🎉 CUSTOM PREFERENCES SUPPORT
- **NEW**: Custom preferences injection (TENANT_ID, etc.)
- **NEW**: Automatic detection of custom fields (TENANT_*, CUSTOM_*, CLIENT_*, APP_CUSTOM_*)
- **NEW**: Dynamic field support - no hardcoding needed
- **NEW**: CamelCase conversion for preference names
- **DOCS**: Examples for custom preferences usage
- **IMPROVED**: Enhanced build logging for custom fields

### v2.10.0 (2025-12-25) 🚀 NATIVE CONFIG INJECTION
- **NEW**: Native config injection via Java/Swift plugins
- **NEW**: Config available in `window.CORDOVA_BUILD_CONFIG` immediately after deviceready
- **NEW**: OutSystems integration guide
- **REMOVED**: File-based config loaders (no longer needed)
- **IMPROVED**: Faster, more reliable config access
- **DOCS**: Comprehensive guides for native injection and OutSystems

### v2.9.13 (2025-12-25) 🎉 RED FLASH FIX
- **NEW**: Enhanced hook to fix red/purple flash after splash screen
- **FEATURE**: Double protection (MainActivity patch + Theme-based background)
- **DOCS**: Comprehensive troubleshooting guide for red flash issues

## License

MIT

## Author

vnkhoado

## Repository

https://github.com/vnkhoado/cordova-plugin-change-app-info