package com.vnkhoado.cordova.changeappinfo;

import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.CordovaWebView;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

public class CSSInjector extends CordovaPlugin {

    private static final String TAG = "CSSInjector";
    private static final String CSS_FILE_PATH = "www/assets/cdn-styles.css";
    private static final String CONFIG_FILE_PATH = "www/cordova-build-config.json";
    
    private String cachedCSS = null;
    private JSONObject cachedConfig = null;
    private Handler handler;
    private String backgroundColor = null;
    private boolean initialInjectionDone = false;
    private Runnable periodicInjectionRunnable;

    @Override
    public void pluginInitialize() {
        super.pluginInitialize();
        
        // Read WEBVIEW_BACKGROUND_COLOR from preferences
        String bgColor = preferences.getString("WEBVIEW_BACKGROUND_COLOR", null);
        if (bgColor == null || bgColor.isEmpty()) {
            bgColor = preferences.getString("BackgroundColor", null);
        }
        if (bgColor == null || bgColor.isEmpty()) {
            bgColor = preferences.getString("SplashScreenBackgroundColor", null);
        }
        
        backgroundColor = bgColor;
        
        // Set WebView and Activity background
        final String finalBgColor = bgColor;
        cordova.getActivity().runOnUiThread(() -> {
            if (finalBgColor != null && !finalBgColor.isEmpty()) {
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
            }
        });
        
        // Pre-load CSS and config
        cachedCSS = readCSSFromAssets();
        cachedConfig = readConfigFromAssets();
        
        handler = new Handler(Looper.getMainLooper());
        
        // Setup WebViewClient to listen for page loads
        setupWebViewClient();
        
        // Setup periodic background re-injection as fallback
        setupPeriodicInjection();
        
        android.util.Log.d(TAG, "CSSInjector initialized with enhanced WebView monitoring");
    }

    /**
     * Setup WebViewClient to intercept page load events
     */
    private void setupWebViewClient() {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                if (webView != null && webView.getView() instanceof WebView) {
                    WebView androidWebView = (WebView) webView.getView();
                    
                    // Get existing WebViewClient
                    final WebViewClient existingClient = new WebViewClient();
                    
                    // Create custom WebViewClient
                    WebViewClient customClient = new WebViewClient() {
                        @Override
                        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                            super.onPageStarted(view, url, favicon);
                            android.util.Log.d(TAG, "Page started: " + url);
                            
                            // Inject background immediately when page starts
                            if (backgroundColor != null && !backgroundColor.isEmpty()) {
                                handler.post(() -> injectBackgroundColorCSS(backgroundColor));
                            }
                        }
                        
                        @Override
                        public void onPageFinished(WebView view, String url) {
                            super.onPageFinished(view, url);
                            android.util.Log.d(TAG, "Page finished: " + url);
                            
                            // Re-inject all content after page loads
                            handler.postDelayed(() -> injectAllContent(), 50);
                        }
                    };
                    
                    androidWebView.setWebViewClient(customClient);
                    android.util.Log.d(TAG, "Custom WebViewClient installed");
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Failed to setup WebViewClient", e);
            }
        });
    }

    /**
     * Setup periodic background injection as fallback
     */
    private void setupPeriodicInjection() {
        periodicInjectionRunnable = new Runnable() {
            @Override
            public void run() {
                if (backgroundColor != null && !backgroundColor.isEmpty()) {
                    injectBackgroundColorCSS(backgroundColor);
                }
                // Re-schedule every 2 seconds
                handler.postDelayed(this, 2000);
            }
        };
        
        // Start periodic injection after initial delay
        handler.postDelayed(periodicInjectionRunnable, 3000);
    }

    @Override
    public void onResume(boolean multitasking) {
        super.onResume(multitasking);
        
        // ALWAYS inject on resume to handle navigation
        handler.postDelayed(() -> {
            injectAllContent();
        }, 100);
        
        if (!initialInjectionDone) {
            initialInjectionDone = true;
        }
        
        android.util.Log.d(TAG, "onResume - re-injecting content");
    }

    @Override
    public void onPause(boolean multitasking) {
        super.onPause(multitasking);
        // Stop periodic injection when paused
        if (periodicInjectionRunnable != null) {
            handler.removeCallbacks(periodicInjectionRunnable);
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        // Clean up handler callbacks
        if (handler != null && periodicInjectionRunnable != null) {
            handler.removeCallbacks(periodicInjectionRunnable);
        }
    }

    /**
     * Inject all content: config, background CSS, CDN CSS
     */
    private void injectAllContent() {
        // 1. Inject build config into window FIRST (most important)
        injectBuildConfig();
        
        // 2. Inject background color CSS
        if (backgroundColor != null && !backgroundColor.isEmpty()) {
            handler.postDelayed(() -> injectBackgroundColorCSS(backgroundColor), 100);
        }
        
        // 3. Inject CDN CSS
        handler.postDelayed(() -> injectCSSIntoWebView(), 200);
        
        android.util.Log.d(TAG, "All content injection scheduled");
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
                
                // Add background color to config
                if (backgroundColor != null && !backgroundColor.isEmpty()) {
                    config.put("backgroundColor", backgroundColor);
                }
                
                // Convert to JSON string and escape for JavaScript
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
                        "    var config = JSON.parse(\"" + escapedJSON + "\");" +
                        "    window.CORDOVA_BUILD_CONFIG = config;" +
                        "    window.AppConfig = config;" +
                        "    console.log('[Native] Build config injected:', config);" +
                        "    " +
                        "    if (typeof CustomEvent !== 'undefined') {" +
                        "      window.dispatchEvent(new CustomEvent('cordova-config-ready', { detail: config }));" +
                        "    }" +
                        "  } catch(e) {" +
                        "    console.error('[Native] Config injection failed:', e);" +
                        "  }" +
                        "})();";
                    
                    cordovaWebView.loadUrl("javascript:" + javascript);
                    android.util.Log.d(TAG, "Build config injected: " + config.toString());
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
            android.util.Log.w(TAG, "Config file not found: " + CONFIG_FILE_PATH);
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
            // Allow JS to get config on demand
            JSONObject config = cachedConfig != null ? cachedConfig : readConfigFromAssets();
            if (config != null) {
                callbackContext.success(config);
            } else {
                callbackContext.error("Config not available");
            }
            return true;
        } else if (action.equals("injectBackground")) {
            // Allow JS to manually trigger background injection
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
     * Inject background color CSS - ENHANCED VERSION
     * More aggressive with inline styles and higher specificity
     */
    private void injectBackgroundColorCSS(final String bgColor) {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                // Set native WebView background FIRST
                if (webView != null && webView.getView() != null) {
                    try {
                        int color = parseHexColor(bgColor);
                        webView.getView().setBackgroundColor(color);
                    } catch (Exception e) {
                        android.util.Log.e(TAG, "Failed to set native bg", e);
                    }
                }
                
                // Then inject CSS
                CordovaWebView cordovaWebView = this.webView;
                if (cordovaWebView != null) {
                    // More aggressive CSS with higher specificity and multiple selectors
                    String css = "html, body, #root, #app, .app-container, .screen, .page-wrapper { " +
                        "background-color: " + bgColor + " !important; " +
                        "background: " + bgColor + " !important; " +
                        "margin: 0; padding: 0; " +
                        "}";
                    
                    String javascript = "(function() {" +
                        "  function inject() {" +
                        "    try {" +
                        "      if (document.documentElement) {" +
                        "        document.documentElement.style.backgroundColor = '" + bgColor + "';" +
                        "        document.documentElement.style.background = '" + bgColor + "';" +
                        "      }" +
                        "      if (document.body) {" +
                        "        document.body.style.backgroundColor = '" + bgColor + "';" +
                        "        document.body.style.background = '" + bgColor + "';" +
                        "      }" +
                        "      " +
                        "      var target = document.head || document.getElementsByTagName('head')[0] || document.documentElement;" +
                        "      if (!target) {" +
                        "        setTimeout(inject, 50);" +
                        "        return;" +
                        "      }" +
                        "      var s = document.getElementById('cordova-bg');" +
                        "      if (s) s.remove();" +
                        "      s = document.createElement('style');" +
                        "      s.id = 'cordova-bg';" +
                        "      s.textContent = '" + css.replace("'", "\\'") + "';" +
                        "      target.insertBefore(s, target.firstChild);" +
                        "      console.log('[Native] Background CSS injected: " + bgColor + "');" +
                        "    } catch(e) { console.error('[Native] BG failed:', e); }" +
                        "  }" +
                        "  inject();" +
                        "  setTimeout(inject, 100);" +
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
                        android.util.Log.d(TAG, "CDN CSS injected (" + cssContent.length() + " bytes)");
                    }
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
        } catch (IOException e) {
            android.util.Log.e(TAG, "Failed to read CSS", e);
            return null;
        }
        return cssContent.toString();
    }

    private String buildCSSInjectionScript(String cssContent) {
        try {
            byte[] cssBytes = cssContent.getBytes(StandardCharsets.UTF_8);
            String base64CSS = Base64.encodeToString(cssBytes, Base64.NO_WRAP);
            
            return "(function() {" +
                   "  function inject() {" +
                   "    try {" +
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
                   "        console.log('[Native] CDN CSS loaded');" +
                   "      }" +
                   "    } catch(e) { console.error('[Native] CDN CSS failed:', e); }" +
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
               "        console.log('[Native] CDN CSS loaded');" +
               "      }" +
               "    } catch(e) { console.error('[Native] CSS failed:', e); }" +
               "  }" +
               "  if (document.readyState === 'loading') {" +
               "    document.addEventListener('DOMContentLoaded', inject);" +
               "  } else {" +
               "    inject();" +
               "  }" +
               "})();";
    }
}