package com.vnkhoado.cordova.changeappinfo;

import android.graphics.Bitmap;
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
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;

public class CSSInjector extends CordovaPlugin {

    private static final String TAG = "CSSInjector";
    private static final String CSS_FILE_PATH = "www/assets/cdn-styles.css";
    private static final String CONFIG_FILE_PATH = "www/cordova-build-config.json";
    private static final int MAX_INJECTION_RETRIES = 3;
    
    private String cachedCSS = null;
    private JSONObject cachedConfig = null;
    private Handler handler;
    private String backgroundColor = null;
    private boolean initialInjectionDone = false;
    private int injectionRetryCount = 0;
    private WebViewClient originalClient = null;

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
        
        // Set WebView and Activity background IMMEDIATELY
        setWebViewBackground(bgColor);
        
        // Pre-load CSS and config in background thread
        new Thread(() -> {
            cachedCSS = readCSSFromAssets();
            cachedConfig = readConfigFromAssets();
            android.util.Log.d(TAG, "Assets pre-loaded");
        }).start();
        
        handler = new Handler(Looper.getMainLooper());
        
        // Inject EARLY - even before WebView is ready
        handler.postDelayed(() -> {
            android.util.Log.d(TAG, "Early injection triggered");
            injectBackgroundColorCSS(backgroundColor);
            injectBuildConfig();
        }, 50);
        
        // Setup interceptor with retry
        setupWebViewClientInterceptor();
        
        android.util.Log.d(TAG, "CSSInjector initialized with background: " + backgroundColor);
    }

    /**
     * Set WebView and Activity background color
     */
    private void setWebViewBackground(String bgColor) {
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
                android.util.Log.d(TAG, "Native background set: " + finalBgColor);
            } catch (IllegalArgumentException e) {
                android.util.Log.e(TAG, "Invalid color: " + finalBgColor, e);
            }
        });
    }

    /**
     * Setup WebViewClient interceptor using reflection + wrapper
     */
    private void setupWebViewClientInterceptor() {
        // Retry multiple times with increasing delays
        handler.postDelayed(new Runnable() {
            int attempt = 0;
            @Override
            public void run() {
                attempt++;
                android.util.Log.d(TAG, "Attempting to intercept WebViewClient, attempt " + attempt);
                
                if (interceptWebViewClient()) {
                    android.util.Log.d(TAG, "✅ WebViewClient intercepted successfully");
                    return;
                }
                
                if (attempt < 10) {
                    handler.postDelayed(this, 100 * attempt); // 100ms, 200ms, 300ms...
                } else {
                    android.util.Log.e(TAG, "❌ Failed to intercept WebViewClient after 10 attempts");
                }
            }
        }, 100);
    }

    /**
     * Intercept WebViewClient using reflection
     */
    private boolean interceptWebViewClient() {
        try {
            if (webView == null || webView.getView() == null) {
                return false;
            }
            
            WebView androidWebView = (WebView) webView.getView();
            
            // Get current WebViewClient via reflection
            Field clientField = WebView.class.getDeclaredField("mWebViewClient");
            clientField.setAccessible(true);
            originalClient = (WebViewClient) clientField.get(androidWebView);
            
            if (originalClient == null) {
                android.util.Log.w(TAG, "WebViewClient is null, retrying...");
                return false;
            }
            
            android.util.Log.d(TAG, "Found WebViewClient: " + originalClient.getClass().getName());
            
            // Create wrapper client
            WebViewClient wrapperClient = new WebViewClient() {
                @Override
                public void onPageStarted(WebView view, String url, Bitmap favicon) {
                    android.util.Log.d(TAG, "🔥 onPageStarted intercepted: " + url);
                    
                    // Call original
                    if (originalClient != null) {
                        originalClient.onPageStarted(view, url, favicon);
                    }
                    
                    // Set native background
                    if (backgroundColor != null) {
                        try {
                            int color = parseHexColor(backgroundColor);
                            view.setBackgroundColor(color);
                        } catch (Exception e) {
                            android.util.Log.e(TAG, "Failed to set bg", e);
                        }
                    }
                    
                    // Inject IMMEDIATELY
                    handler.post(() -> {
                        injectBackgroundColorCSS(backgroundColor);
                        injectBuildConfig();
                    });
                }
                
                @Override
                public void onPageFinished(WebView view, String url) {
                    android.util.Log.d(TAG, "🔥 onPageFinished intercepted: " + url);
                    
                    // Call original
                    if (originalClient != null) {
                        originalClient.onPageFinished(view, url);
                    }
                    
                    // Inject with retries
                    handler.post(() -> injectAllContentWithRetry());
                }
                
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    if (originalClient != null) {
                        return originalClient.shouldOverrideUrlLoading(view, url);
                    }
                    return false;
                }
            };
            
            // Set wrapper client
            androidWebView.setWebViewClient(wrapperClient);
            android.util.Log.d(TAG, "Wrapper WebViewClient installed");
            
            return true;
            
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to intercept WebViewClient", e);
            return false;
        }
    }

    @Override
    public void onResume(boolean multitasking) {
        super.onResume(multitasking);
        
        android.util.Log.d(TAG, "onResume called");
        
        // Backup injection
        if (!initialInjectionDone) {
            handler.postDelayed(() -> {
                injectAllContentWithRetry();
                initialInjectionDone = true;
            }, 200);
        }
    }

    /**
     * Inject all content with retry mechanism
     */
    private void injectAllContentWithRetry() {
        if (injectionRetryCount >= MAX_INJECTION_RETRIES) {
            return;
        }
        
        injectionRetryCount++;
        android.util.Log.d(TAG, "Injection retry " + injectionRetryCount);
        
        injectAllContent();
        
        // Retry
        if (injectionRetryCount < MAX_INJECTION_RETRIES) {
            handler.postDelayed(() -> injectAllContent(), 300 * injectionRetryCount);
        }
    }

    /**
     * Inject all content
     */
    private void injectAllContent() {
        injectBuildConfig();
        
        if (backgroundColor != null) {
            injectBackgroundColorCSS(backgroundColor);
        }
        
        handler.postDelayed(() -> injectCSSIntoWebView(), 50);
    }

    /**
     * Inject build config
     */
    private void injectBuildConfig() {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                JSONObject config = cachedConfig != null ? cachedConfig : readConfigFromAssets();
                if (config == null) return;
                
                if (backgroundColor != null) {
                    config.put("backgroundColor", backgroundColor);
                }
                
                String configJSON = config.toString()
                    .replace("\\", "\\\\")
                    .replace("'", "\\'")
                    .replace("\"", "\\\"")
                    .replace("\n", "\\n");
                
                CordovaWebView cordovaWebView = this.webView;
                if (cordovaWebView != null) {
                    String js = "(function() {" +
                        "try {" +
                        "  var config = JSON.parse(\"" + configJSON + "\");" +
                        "  window.CORDOVA_BUILD_CONFIG = config;" +
                        "  window.AppConfig = config;" +
                        "  console.log('[Native] Config injected');" +
                        "  if (typeof CustomEvent !== 'undefined') {" +
                        "    window.dispatchEvent(new CustomEvent('cordova-config-ready', {detail: config}));" +
                        "  }" +
                        "} catch(e) {" +
                        "  console.error('[Native] Config failed:', e);" +
                        "}" +
                        "})();";
                    
                    cordovaWebView.loadUrl("javascript:" + js);
                    android.util.Log.d(TAG, "Config injected");
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "Config injection failed", e);
            }
        });
    }

    /**
     * Read config from assets
     */
    private JSONObject readConfigFromAssets() {
        try {
            InputStream is = cordova.getActivity().getAssets().open(CONFIG_FILE_PATH);
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();
            is.close();
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            android.util.Log.w(TAG, "Config not found");
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
            if (backgroundColor != null) {
                injectBackgroundColorCSS(backgroundColor);
                callbackContext.success("Background injected");
            } else {
                callbackContext.error("No background color");
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
        if (hex.length() == 6) {
            return Color.parseColor("#FF" + hex);
        } else if (hex.length() == 8) {
            return Color.parseColor("#" + hex);
        }
        throw new IllegalArgumentException("Invalid color");
    }

    /**
     * Inject background CSS
     */
    private void injectBackgroundColorCSS(final String bgColor) {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                // Set native
                if (webView != null && webView.getView() != null) {
                    try {
                        int color = parseHexColor(bgColor);
                        webView.getView().setBackgroundColor(color);
                    } catch (Exception e) {}
                }
                
                CordovaWebView cordovaWebView = this.webView;
                if (cordovaWebView != null) {
                    String css = "html,body,#root,#app,.app-container,.screen,.page-wrapper,.layout{" +
                        "background-color:" + bgColor + "!important;" +
                        "background:" + bgColor + "!important;" +
                        "margin:0!important;padding:0!important;}";
                    
                    String js = "(function(){" +
                        "try{" +
                        "if(document.documentElement){" +
                        "document.documentElement.style.setProperty('background-color','" + bgColor + "','important');" +
                        "document.documentElement.style.setProperty('background','" + bgColor + "','important');" +
                        "}" +
                        "if(document.body){" +
                        "document.body.style.setProperty('background-color','" + bgColor + "','important');" +
                        "document.body.style.setProperty('background','" + bgColor + "','important');" +
                        "}" +
                        "var t=document.head||document.getElementsByTagName('head')[0]||document.documentElement;" +
                        "if(t){" +
                        "var s=document.getElementById('cordova-bg');" +
                        "if(!s){" +
                        "s=document.createElement('style');" +
                        "s.id='cordova-bg';" +
                        "s.textContent='" + css.replace("'", "\\'") + "';" +
                        "if(t.firstChild){t.insertBefore(s,t.firstChild);}else{t.appendChild(s);}" +
                        "console.log('[Native] BG CSS: " + bgColor + "');" +
                        "}" +
                        "}" +
                        "}catch(e){console.error('[Native] BG failed:',e);}" +
                        "})();";
                    
                    cordovaWebView.loadUrl("javascript:" + js);
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "BG CSS failed", e);
            }
        });
    }

    private void injectCSSIntoWebView() {
        cordova.getActivity().runOnUiThread(() -> {
            try {
                String css = cachedCSS != null ? cachedCSS : readCSSFromAssets();
                if (css == null || css.isEmpty()) return;
                
                CordovaWebView cordovaWebView = this.webView;
                if (cordovaWebView != null) {
                    String js = buildCSSInjectionScript(css);
                    cordovaWebView.loadUrl("javascript:" + js);
                    android.util.Log.d(TAG, "CDN CSS injected");
                }
            } catch (Exception e) {
                android.util.Log.e(TAG, "CSS injection failed", e);
            }
        });
    }

    private String readCSSFromAssets() {
        try {
            InputStream is = cordova.getActivity().getAssets().open(CSS_FILE_PATH);
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
            reader.close();
            is.close();
            return sb.toString();
        } catch (Exception e) {
            android.util.Log.e(TAG, "Failed to read CSS", e);
            return null;
        }
    }

    private String buildCSSInjectionScript(String css) {
        try {
            byte[] bytes = css.getBytes(StandardCharsets.UTF_8);
            String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            
            return "(function(){" +
                   "function inject(){" +
                   "try{" +
                   "var t=document.head||document.getElementsByTagName('head')[0]||document.documentElement;" +
                   "if(!t){setTimeout(inject,50);return;}" +
                   "if(!document.getElementById('cdn-styles')){" +
                   "var css=decodeURIComponent(escape(atob('" + b64 + "')));" +
                   "var s=document.createElement('style');" +
                   "s.id='cdn-styles';" +
                   "s.textContent=css;" +
                   "t.appendChild(s);" +
                   "console.log('[Native] CDN CSS loaded');" +
                   "}" +
                   "}catch(e){console.error('[Native] CDN failed:',e);}" +
                   "}" +
                   "inject();" +
                   "if(document.readyState==='loading'){" +
                   "document.addEventListener('DOMContentLoaded',inject);" +
                   "}" +
                   "})();";
        } catch (Exception e) {
            return buildFallbackInjectionScript(css);
        }
    }

    private String buildFallbackInjectionScript(String css) {
        String escaped = css
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "")
            .replace("\t", "\\t");
        
        return "(function(){" +
               "function inject(){" +
               "try{" +
               "var t=document.head||document.getElementsByTagName('head')[0]||document.documentElement;" +
               "if(!t){setTimeout(inject,50);return;}" +
               "if(!document.getElementById('cdn-styles')){" +
               "var s=document.createElement('style');" +
               "s.id='cdn-styles';" +
               "s.textContent='" + escaped + "';" +
               "t.appendChild(s);" +
               "console.log('[Native] CDN CSS loaded');" +
               "}" +
               "}catch(e){console.error('[Native] Failed:',e);}" +
               "}" +
               "inject();" +
               "if(document.readyState==='loading'){" +
               "document.addEventListener('DOMContentLoaded',inject);" +
               "}" +
               "})();";
    }
}