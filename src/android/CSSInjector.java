package com.vnkhoado.cordova.changeappinfo;

import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.CordovaWebView;
import org.apache.cordova.engine.SystemWebView;
import org.apache.cordova.engine.SystemWebViewClient;
import org.apache.cordova.engine.SystemWebViewEngine;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public class CSSInjector extends CordovaPlugin {

    private static final String TAG = "CSSInjector";
    private static final String CSS_FILE_PATH = "www/assets/cdn-styles.css";
    private static final String CONFIG_FILE_PATH = "www/cordova-build-config.json";
    private static final String INDEX_HTML_PATH = "www/index.html";
    
    private String cachedCSS = null;
    private JSONObject cachedConfig = null;
    private Handler handler;
    private String backgroundColor = null;
    private boolean initialInjectionDone = false;
    private boolean isFirstPageLoad = true;
    private String configScript = null;
    private String cssInlineScript = null;
    private int injectionAttempts = 0;
    private static final int MAX_INJECTION_ATTEMPTS = 10;

    @Override
    public void pluginInitialize() {
        super.pluginInitialize();
        
        android.util.Log.d(TAG, "=== CSSInjector pluginInitialize START ===");
        
        // Read WEBVIEW_BACKGROUND_COLOR from preferences
        String bgColor = preferences.getString("WEBVIEW_BACKGROUND_COLOR", null);
        if (bgColor == null || bgColor.isEmpty()) {
            bgColor = preferences.getString("BackgroundColor", null);
        }
        if (bgColor == null || bgColor.isEmpty()) {
            bgColor = preferences.getString("SplashScreenBackgroundColor", null);
        }
        
        // Default to white if no color specified
        if (bgColor == null || bgColor.isEmpty()) {
            bgColor = "#FFFFFF";
        }
        
        backgroundColor = bgColor;
        android.util.Log.d(TAG, "Background color: " + backgroundColor);
        
        // Set WebView and Activity background
        final String finalBgColor = bgColor;
        cordova.getActivity().runOnUiThread(() -> {
            try {
                int color = parseHexColor(finalBgColor);
                cordova.getActivity().getWindow().setBackgroundDrawable(
                    new android.graphics.drawable.ColorDrawable(color)
                );
                cordova.getActivity().getWindow().getDecorView().setBackgroundColor(color);
                if (webView != null && webView.getView() != null) {
                    webView.getView().setBackgroundColor(color);
                }
                android.util.Log.d(TAG, "Background set to: " + finalBgColor);
            } catch (IllegalArgumentException e) {
                android.util.Log.e(TAG, "Invalid color: " + finalBgColor, e);
            }
        });
        
        // Pre-load CSS and config
        android.util.Log.d(TAG, "Reading CSS and config from assets...");
        cachedCSS = readCSSFromAssets();
        cachedConfig = readConfigFromAssets();
        
        if (cachedCSS != null) {
            android.util.Log.d(TAG, "CSS loaded: " + cachedCSS.length() + " bytes");
        } else {
            android.util.Log.e(TAG, "CSS NOT loaded - file missing or error");
        }
        
        if (cachedConfig != null) {
            android.util.Log.d(TAG, "Config loaded: " + cachedConfig.toString());
        } else {
            android.util.Log.e(TAG, "Config NOT loaded - file missing or error");
        }
        
        // Pre-build inline scripts for HTML injection
        buildConfigScript();
        buildCSSInlineScript();
        
        handler = new Handler(Looper.getMainLooper());
        
        // Start aggressive polling injection
        startPollingInjection();
        
        android.util.Log.d(TAG, "=== CSSInjector pluginInitialize END ===");
    }

    /**
     * Start polling-based injection to ensure CSS/config loads
     * This runs every 200ms until successful or max attempts reached
     */
    private void startPollingInjection() {
        handler.post(new Runnable() {
            @Override
            public void run() {
                if (injectionAttempts < MAX_INJECTION_ATTEMPTS) {
                    android.util.Log.d(TAG, "[Polling] Injection attempt #" + (injectionAttempts + 1));
                    
                    // Try to inject
                    injectBuildConfig();
                    injectBackgroundColorCSS(backgroundColor);
                    injectCSSIntoWebView();
                    
                    injectionAttempts++;
                    
                    // Schedule next attempt
                    handler.postDelayed(this, 200);
                } else {
                    android.util.Log.d(TAG, "[Polling] Stopped after " + MAX_INJECTION_ATTEMPTS + " attempts");
                }
            }
        });
    }

    /**
     * Build config script that will be injected into HTML <head>
     */
    private void buildConfigScript() {
        try {
            JSONObject config = cachedConfig;
            if (config == null) {
                config = readConfigFromAssets();
                cachedConfig = config;
            }
            
            if (config == null) {
                android.util.Log.e(TAG, "Cannot build config script - no config available");
                // Create empty config as fallback
                config = new JSONObject();
                config.put("error", "Config file not found");
            }
            
            // Add background color to config
            if (backgroundColor != null && !backgroundColor.isEmpty()) {
                config.put("backgroundColor", backgroundColor);
            }
            
            String configJSON = config.toString();
            
            // Build inline script that runs IMMEDIATELY
            configScript = "<script type='text/javascript'>" +
                "(function(){" +
                "try{" +
                "var config=" + configJSON + ";" +
                "window.CORDOVA_BUILD_CONFIG=config;" +
                "window.AppConfig=config;" +
                "console.log('[Inline-Config] Injected:',config);" +
                "}catch(e){" +
                "console.error('[Inline-Config] Failed:',e);" +
                "}" +
                "})();" +
                "</script>";
            
            android.util.Log.d(TAG, "✓ Config script built (" + configScript.length() + " bytes)");
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to build config script", e);
        }
    }

    /**
     * Build CSS inline script that will be injected into HTML <head>
     */
    private void buildCSSInlineScript() {
        try {
            String cssContent = cachedCSS;
            if (cssContent == null || cssContent.isEmpty()) {
                cssContent = readCSSFromAssets();
                cachedCSS = cssContent;
            }
            
            if (cssContent == null || cssContent.isEmpty()) {
                android.util.Log.e(TAG, "Cannot build CSS script - no CSS content");
                return;
            }
            
            // Encode CSS to base64 for safe inline injection
            byte[] cssBytes = cssContent.getBytes(StandardCharsets.UTF_8);
            String base64CSS = Base64.encodeToString(cssBytes, Base64.NO_WRAP);
            
            // Build inline script
            cssInlineScript = "<script type='text/javascript'>" +
                "(function(){" +
                "try{" +
                "var b64='" + base64CSS + "';" +
                "var css=decodeURIComponent(escape(atob(b64)));" +
                "var s=document.createElement('style');" +
                "s.id='cdn-styles-inline';" +
                "s.textContent=css;" +
                "(document.head||document.getElementsByTagName('head')[0]).appendChild(s);" +
                "console.log('[Inline-CSS] Injected',css.length,'bytes');" +
                "}catch(e){" +
                "console.error('[Inline-CSS] Failed:',e);" +
                "}" +
                "})();" +
                "</script>";
            
            android.util.Log.d(TAG, "✓ CSS inline script built (" + cssContent.length() + " bytes CSS)");
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to build CSS inline script", e);
        }
    }

    /**
     * Read HTML file from assets (www/index.html)
     */
    private String readHTMLFromAssets() {
        StringBuilder content = new StringBuilder();
        try {
            InputStream inputStream = cordova.getActivity().getAssets().open(INDEX_HTML_PATH);
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(inputStream, StandardCharsets.UTF_8)
            );
            
            String line;
            while ((line = reader.readLine()) != null) {
                content.append(line).append("\n");
            }
            
            reader.close();
            inputStream.close();
            
            android.util.Log.d(TAG, "Read HTML from assets: " + content.length() + " chars");
            return content.toString();
            
        } catch (IOException e) {
            android.util.Log.e(TAG, "Failed to read HTML from assets: " + INDEX_HTML_PATH, e);
            return null;
        }
    }

    /**
     * Read InputStream to String
     */
    private String readStream(InputStream is) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            sb.append(line).append("\n");
        }
        return sb.toString();
    }

    @Override
    public void onResume(boolean multitasking) {
        super.onResume(multitasking);
        
        if (!initialInjectionDone) {
            // Inject immediately
            injectBuildConfig();
            injectBackgroundColorCSS(backgroundColor);
            injectCSSIntoWebView();
            initialInjectionDone = true;
            android.util.Log.d(TAG, "onResume - immediate injection");
        }
        
        android.util.Log.d(TAG, "onResume");
    }

    /**
     * Inject build config from JSON file into window variable
     */
    private void injectBuildConfig() {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                JSONObject config = cachedConfig;
                if (config == null) {
                    config = readConfigFromAssets();
                    cachedConfig = config;
                }
                
                if (config == null) {
                    android.util.Log.w(TAG, "No config found, skipping injection");
                    return;
                }
                
                if (backgroundColor != null && !backgroundColor.isEmpty()) {
                    config.put("backgroundColor", backgroundColor);
                }
                
                String configJSON = config.toString();
                String escapedJSON = configJSON
                    .replace("\\", "\\\\")
                    .replace("'", "\\'")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n");
                
                CordovaWebView cordovaWebView = this.webView;
                if (cordovaWebView != null) {
                    String javascript = "(function() {" +
                        "  try {" +
                        "    if (typeof window === 'undefined') return;" +
                        "    var config = JSON.parse(\"" + escapedJSON + "\");" +
                        "    window.CORDOVA_BUILD_CONFIG = config;" +
                        "    window.AppConfig = config;" +
                        "    console.log('[Native-JS] Build config injected:', config);" +
                        "    " +
                        "    if (typeof CustomEvent !== 'undefined') {" +
                        "      window.dispatchEvent(new CustomEvent('cordova-config-ready', { detail: config }));" +
                        "    }" +
                        "  } catch(e) {" +
                        "    console.error('[Native-JS] Config injection failed:', e);" +
                        "  }" +
                        "})();";
                    
                    cordovaWebView.loadUrl("javascript:" + javascript);
                    android.util.Log.d(TAG, "[JS] Config injected");
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to inject build config", e);
            }
        });
    }

    /**
     * Read config JSON from assets
     */
    private JSONObject readConfigFromAssets() {
        StringBuilder content = new StringBuilder();
        
        try {
            InputStream inputStream = cordova.getActivity().getAssets().open(CONFIG_FILE_PATH);
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(inputStream, StandardCharsets.UTF_8)
            );
            
            String line;
            while ((line = reader.readLine()) != null) {
                content.append(line);
            }
            
            reader.close();
            inputStream.close();
            
            return new JSONObject(content.toString());
            
        } catch (IOException e) {
            android.util.Log.e(TAG, "Config file not found: " + CONFIG_FILE_PATH, e);
            return null;
        } catch (JSONException e) {
            android.util.Log.e(TAG, "Failed to parse config JSON", e);
            return null;
        }
    }

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        if (action.equals("injectCSS")) {
            injectCSSIntoWebView();
            callbackContext.success("CSS injected");
            return true;
        } else if (action.equals("getConfig")) {
            JSONObject config = cachedConfig != null ? cachedConfig : readConfigFromAssets();
            if (config != null) {
                callbackContext.success(config);
            } else {
                callbackContext.error("Config not available");
            }
            return true;
        } else if (action.equals("injectBackground")) {
            if (backgroundColor != null && !backgroundColor.isEmpty()) {
                injectBackgroundColorCSS(backgroundColor);
                callbackContext.success("Background injected: " + backgroundColor);
            } else {
                callbackContext.error("No background color configured");
            }
            return true;
        }
        return false;
    }

    private int parseHexColor(String hexColor) throws IllegalArgumentException {
        String hex = hexColor.trim();
        if (hex.startsWith("#")) {
            hex = hex.substring(1);
        }
        if (hex.length() != 6 && hex.length() != 8) {
            throw new IllegalArgumentException("Hex must be 6 or 8 chars");
        }
        try {
            if (hex.length() == 6) {
                return Color.parseColor("#FF" + hex);
            } else {
                return Color.parseColor("#" + hex);
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid color: " + hexColor, e);
        }
    }

    /**
     * Inject background color CSS
     */
    private void injectBackgroundColorCSS(final String bgColor) {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                if (webView != null && webView.getView() != null) {
                    try {
                        int color = parseHexColor(bgColor);
                        webView.getView().setBackgroundColor(color);
                    } catch (Exception e) {
                        android.util.Log.e(TAG, "Failed to set native bg", e);
                    }
                }
                
                CordovaWebView cordovaWebView = this.webView;
                if (cordovaWebView != null) {
                    String css = "html, body, #root, #app, .app-container, .screen, .page-wrapper { " +
                        "background-color: " + bgColor + " !important; " +
                        "background: " + bgColor + " !important; " +
                        "margin: 0; padding: 0; " +
                        "}";
                    
                    String javascript = "(function() {" +
                        "  try {" +
                        "    if (typeof document === 'undefined') return;" +
                        "    if (document.documentElement) {" +
                        "      document.documentElement.style.backgroundColor = '" + bgColor + "';" +
                        "    }" +
                        "    if (document.body) {" +
                        "      document.body.style.backgroundColor = '" + bgColor + "';" +
                        "    }" +
                        "    " +
                        "    var target = document.head || document.getElementsByTagName('head')[0];" +
                        "    if (target) {" +
                        "      var s = document.getElementById('cordova-bg');" +
                        "      if (!s) {" +
                        "        s = document.createElement('style');" +
                        "        s.id = 'cordova-bg';" +
                        "        s.textContent = '" + css.replace("'", "\\'") + "';" +
                        "        target.insertBefore(s, target.firstChild);" +
                        "        console.log('[Native-BG] CSS injected: " + bgColor + "');" +
                        "      }" +
                        "    }" +
                        "  } catch(e) { console.error('[Native-BG] Failed:', e); }" +
                        "})();";
                    
                    cordovaWebView.loadUrl("javascript:" + javascript);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Background CSS failed", e);
            }
        });
    }

    private void injectCSSIntoWebView() {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                String cssContent = cachedCSS;
                if (cssContent == null || cssContent.isEmpty()) {
                    cssContent = readCSSFromAssets();
                    cachedCSS = cssContent;
                }
                
                if (cssContent != null && !cssContent.isEmpty()) {
                    CordovaWebView cordovaWebView = this.webView;
                    if (cordovaWebView != null) {
                        String javascript = buildCSSInjectionScript(cssContent);
                        cordovaWebView.loadUrl("javascript:" + javascript);
                        android.util.Log.d(TAG, "[JS] CSS injected (" + cssContent.length() + " bytes)");
                    }
                } else {
                    android.util.Log.e(TAG, "Cannot inject CSS - content is empty or null");
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "CSS injection failed", e);
            }
        });
    }

    private String readCSSFromAssets() {
        StringBuilder cssContent = new StringBuilder();
        try {
            InputStream inputStream = cordova.getActivity().getAssets().open(CSS_FILE_PATH);
            BufferedReader reader = new BufferedReader(
                new InputStreamReader(inputStream, StandardCharsets.UTF_8)
            );
            String line;
            while ((line = reader.readLine()) != null) {
                cssContent.append(line).append("\n");
            }
            reader.close();
            inputStream.close();
            return cssContent.toString();
        } catch (IOException e) {
            android.util.Log.e(TAG, "Failed to read CSS from: " + CSS_FILE_PATH, e);
            return null;
        }
    }

    private String buildCSSInjectionScript(String cssContent) {
        try {
            byte[] cssBytes = cssContent.getBytes(StandardCharsets.UTF_8);
            String base64CSS = Base64.encodeToString(cssBytes, Base64.NO_WRAP);
            
            return "(function() {" +
                   "  function inject() {" +
                   "    try {" +
                   "      if (typeof document === 'undefined') return;" +
                   "      var target = document.head || document.getElementsByTagName('head')[0] || document.documentElement;" +
                   "      if (!target) {" +
                   "        setTimeout(inject, 100);" +
                   "        return;" +
                   "      }" +
                   "      if (!document.getElementById('cdn-styles')) {" +
                   "        var b64 = '" + base64CSS + "';" +
                   "        var css = decodeURIComponent(escape(atob(b64)));" +
                   "        var s = document.createElement('style');" +
                   "        s.id = 'cdn-styles';" +
                   "        s.textContent = css;" +
                   "        target.appendChild(s);" +
                   "        console.log('[Native-CSS] Loaded (" + cssContent.length() + " bytes)');" +
                   "      }" +
                   "    } catch(e) { console.error('[Native-CSS] Failed:', e); }" +
                   "  }" +
                   "  if (document.readyState === 'loading') {" +
                   "    document.addEventListener('DOMContentLoaded', inject);" +
                   "  } else {" +
                   "    inject();" +
                   "  }" +
                   "})();";
        } catch (Exception e) {
            return buildFallbackInjectionScript(cssContent);
        }
    }

    private String buildFallbackInjectionScript(String cssContent) {
        String escaped = cssContent
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "")
            .replace("\t", "\\t");
        
        return "(function() {" +
               "  function inject() {" +
               "    try {" +
               "      if (typeof document === 'undefined') return;" +
               "      var target = document.head || document.getElementsByTagName('head')[0] || document.documentElement;" +
               "      if (!target) {" +
               "        setTimeout(inject, 100);" +
               "        return;" +
               "      }" +
               "      if (!document.getElementById('cdn-styles')) {" +
               "        var s = document.createElement('style');" +
               "        s.id = 'cdn-styles';" +
               "        s.textContent = '" + escaped + "';" +
               "        target.appendChild(s);" +
               "        console.log('[Native-CSS] Loaded');" +
               "      }" +
               "    } catch(e) { console.error('[Native-CSS] Failed:', e); }" +
               "  }" +
               "  if (document.readyState === 'loading') {" +
               "    document.addEventListener('DOMContentLoaded', inject);" +
               "  } else {" +
               "    inject();" +
               "  }" +
               "})();";
    }
}