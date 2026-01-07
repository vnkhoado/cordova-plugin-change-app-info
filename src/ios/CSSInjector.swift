import Foundation
import WebKit
import UIKit

@objc(CSSInjector)
class CSSInjector: CDVPlugin {
    
    private static let CSS_FILE_PATH = "www/assets/cdn-styles.css"
    private static let CONFIG_FILE_PATH = "www/cordova-build-config.json"
    private var cachedCSS: String?
    private var cachedConfig: [String: Any]?
    
    override func pluginInitialize() {
        super.pluginInitialize()
        
        // Read WEBVIEW_BACKGROUND_COLOR from preferences (with fallbacks)
        let bgColor = getBackgroundColor()
        
        if let color = bgColor {
            setWebViewBackgroundColor(colorString: color)
        }
        
        // Pre-load CSS and config
        cachedCSS = readCSSFromBundle()
        cachedConfig = readConfigFromBundle()
        
        // ⭐ KEY FIX: Install WKUserScripts immediately
        // This ensures CSS/config inject BEFORE page loads (no race condition)
        installUserScripts()
        
        print("[CSSInjector] Plugin initialized with WKUserScript injection")
    }
    
    // MARK: - WKUserScript Installation (Option C - Best Practice)
    
    /**
     * Install WKUserScripts for CSS and Config injection
     * Scripts run at .atDocumentStart = BEFORE page renders
     * Eliminates timing issues on fresh app install
     */
    private func installUserScripts() {
        DispatchQueue.main.async {
            guard let wkWebView = self.webView as? WKWebView else {
                print("[CSSInjector] WebView not available")
                return
            }
            
            let contentController = wkWebView.configuration.userContentController
            
            // 1. Install Config UserScript (highest priority)
            if let configScript = self.buildConfigUserScript() {
                contentController.addUserScript(configScript)
                print("[CSSInjector] ✅ Config UserScript installed")
            }
            
            // 2. Install Background Color UserScript
            if let bgColor = self.getBackgroundColor() {
                let bgScript = self.buildBackgroundUserScript(color: bgColor)
                contentController.addUserScript(bgScript)
                print("[CSSInjector] ✅ Background UserScript installed: \(bgColor)")
            }
            
            // 3. Install CSS UserScript
            if let cssScript = self.buildCSSUserScript() {
                contentController.addUserScript(cssScript)
                if let cssSize = self.cachedCSS?.count {
                    print("[CSSInjector] ✅ CSS UserScript installed (\(cssSize) bytes)")
                }
            }
            
            print("[CSSInjector] All UserScripts installed successfully")
        }
    }
    
    /**
     * Build Config injection UserScript
     * Injects window.CORDOVA_BUILD_CONFIG before page loads
     */
    private func buildConfigUserScript() -> WKUserScript? {
        guard var configDict = cachedConfig else {
            print("[CSSInjector] No config to inject")
            return nil
        }
        
        // Add background color to config
        if let bgColor = getBackgroundColor() {
            configDict["backgroundColor"] = bgColor
        }
        
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: configDict, options: [])
            guard let jsonString = String(data: jsonData, encoding: .utf8) else { return nil }
            
            let escapedJSON = jsonString
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
            
            let javascript = """
            (function() {
                try {
                    var config = JSON.parse("\(escapedJSON)");
                    window.CORDOVA_BUILD_CONFIG = config;
                    window.AppConfig = config;
                    console.log('[Native iOS UserScript] Config injected at document start');
                    
                    // Dispatch event when DOM is ready
                    if (document.readyState === 'loading') {
                        document.addEventListener('DOMContentLoaded', function() {
                            if (typeof CustomEvent !== 'undefined') {
                                window.dispatchEvent(new CustomEvent('cordova-config-ready', { detail: config }));
                            }
                        });
                    } else {
                        if (typeof CustomEvent !== 'undefined') {
                            window.dispatchEvent(new CustomEvent('cordova-config-ready', { detail: config }));
                        }
                    }
                } catch(e) {
                    console.error('[Native iOS UserScript] Config injection failed:', e);
                }
            })();
            """
            
            // ⭐ atDocumentStart = inject BEFORE page loads (key to fix timing issue)
            return WKUserScript(
                source: javascript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        } catch {
            print("[CSSInjector] Failed to build config script: \(error)")
            return nil
        }
    }
    
    /**
     * Build Background Color UserScript
     * Sets background color before page renders (prevents white flash)
     */
    private func buildBackgroundUserScript(color: String) -> WKUserScript {
        let css = "html, body, #root, #app, .app-container { background-color: \(color) !important; background: \(color) !important; margin: 0; padding: 0; }"
        let escapedCSS = css.replacingOccurrences(of: "'", with: "\\'")
        
        let javascript = """
        (function() {
            try {
                // Set inline styles immediately
                if (document.documentElement) {
                    document.documentElement.style.backgroundColor = '\(color)';
                }
                
                // Create style tag
                var style = document.createElement('style');
                style.id = 'cordova-bg-color';
                style.textContent = '\(escapedCSS)';
                (document.head || document.documentElement).appendChild(style);
                
                console.log('[Native iOS UserScript] Background color injected: \(color)');
            } catch(e) {
                console.error('[Native iOS UserScript] Background injection failed:', e);
            }
        })();
        """
        
        return WKUserScript(
            source: javascript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }
    
    /**
     * Build CSS injection UserScript
     * Injects CDN CSS before page renders
     */
    private func buildCSSUserScript() -> WKUserScript? {
        guard let css = cachedCSS, !css.isEmpty else {
            print("[CSSInjector] No CSS to inject")
            return nil
        }
        
        guard let base64CSS = encodeToBase64(cssContent: css) else {
            print("[CSSInjector] Failed to encode CSS to Base64")
            return buildFallbackCSSUserScript(cssContent: css)
        }
        
        let javascript = """
        (function() {
            try {
                if (!document.getElementById('cdn-injected-styles')) {
                    var base64CSS = '\(base64CSS)';
                    var decodedCSS = decodeURIComponent(escape(atob(base64CSS)));
                    var style = document.createElement('style');
                    style.id = 'cdn-injected-styles';
                    style.textContent = decodedCSS;
                    (document.head || document.documentElement).appendChild(style);
                    console.log('[Native iOS UserScript] CDN CSS injected (\(css.count) bytes)');
                }
            } catch(e) {
                console.error('[Native iOS UserScript] CSS injection failed:', e);
            }
        })();
        """
        
        // ⭐ atDocumentStart = CSS ready BEFORE page renders
        return WKUserScript(
            source: javascript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }
    
    /**
     * Fallback CSS UserScript (if Base64 encoding fails)
     */
    private func buildFallbackCSSUserScript(cssContent: String) -> WKUserScript? {
        let escapedCSS = cssContent
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\t", with: "\\t")
        
        let javascript = """
        (function() {
            try {
                if (!document.getElementById('cdn-injected-styles')) {
                    var style = document.createElement('style');
                    style.id = 'cdn-injected-styles';
                    style.textContent = '\(escapedCSS)';
                    (document.head || document.documentElement).appendChild(style);
                    console.log('[Native iOS UserScript] CSS injected (fallback method)');
                }
            } catch(e) {
                console.error('[Native iOS UserScript] CSS injection failed:', e);
            }
        })();
        """
        
        return WKUserScript(
            source: javascript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
    }
    
    // MARK: - Plugin Methods (for manual JS calls)
    
    @objc(injectCSS:)
    func injectCSS(command: CDVInvokedUrlCommand) {
        // Manual injection via JS call (fallback)
        injectCSSViaEvaluateJavaScript()
        
        let pluginResult = CDVPluginResult(
            status: CDVCommandStatus_OK,
            messageAs: "CSS injected"
        )
        self.commandDelegate.send(pluginResult, callbackId: command.callbackId)
    }
    
    @objc(getConfig:)
    func getConfig(command: CDVInvokedUrlCommand) {
        var config = cachedConfig
        if config == nil {
            config = readConfigFromBundle()
            cachedConfig = config
        }
        
        if let configDict = config {
            let pluginResult = CDVPluginResult(
                status: CDVCommandStatus_OK,
                messageAs: configDict
            )
            self.commandDelegate.send(pluginResult, callbackId: command.callbackId)
        } else {
            let pluginResult = CDVPluginResult(
                status: CDVCommandStatus_ERROR,
                messageAs: "Config not available"
            )
            self.commandDelegate.send(pluginResult, callbackId: command.callbackId)
        }
    }
    
    // MARK: - Helper Methods
    
    /**
     * Get background color from preferences (with fallbacks)
     */
    private func getBackgroundColor() -> String? {
        if let color = self.commandDelegate.settings["webview_background_color"] as? String {
            return color
        } else if let color = self.commandDelegate.settings["backgroundcolor"] as? String {
            return color
        } else if let color = self.commandDelegate.settings["splashscreenbackgroundcolor"] as? String {
            return color
        }
        return nil
    }
    
    /**
     * Read config JSON from bundle
     */
    private func readConfigFromBundle() -> [String: Any]? {
        guard let bundlePath = Bundle.main.path(forResource: "www", ofType: nil) else {
            print("[CSSInjector] www bundle path not found")
            return nil
        }
        
        let configPath = (bundlePath as NSString).appendingPathComponent("cordova-build-config.json")
        
        do {
            let jsonData = try Data(contentsOf: URL(fileURLWithPath: configPath))
            let config = try JSONSerialization.jsonObject(with: jsonData, options: []) as? [String: Any]
            return config
        } catch {
            print("[CSSInjector] Failed to read config: \(error.localizedDescription)")
            return nil
        }
    }
    
    /**
     * Read CSS content from bundle www/assets/cdn-styles.css with UTF-8 encoding
     */
    private func readCSSFromBundle() -> String? {
        guard let bundlePath = Bundle.main.path(forResource: "www", ofType: nil) else {
            print("[CSSInjector] www bundle path not found")
            return nil
        }
        
        let cssPath = (bundlePath as NSString).appendingPathComponent("assets/cdn-styles.css")
        
        do {
            let cssContent = try String(contentsOfFile: cssPath, encoding: .utf8)
            return cssContent
        } catch {
            print("[CSSInjector] Failed to read CSS file: \(error.localizedDescription)")
            return nil
        }
    }
    
    /**
     * Encode CSS content to Base64
     */
    private func encodeToBase64(cssContent: String) -> String? {
        guard let data = cssContent.data(using: .utf8) else {
            print("[CSSInjector] Failed to encode CSS to UTF-8")
            return nil
        }
        
        return data.base64EncodedString(options: [])
    }
    
    // MARK: - WebView Background Color (Native)
    
    /**
     * Set WebView background color to prevent white flash
     */
    private func setWebViewBackgroundColor(colorString: String) {
        DispatchQueue.main.async {
            guard let webView = self.webView as? WKWebView else {
                print("[CSSInjector] WebView not available for background color")
                return
            }
            
            // Parse hex color
            if let color = self.hexStringToUIColor(hex: colorString) {
                webView.backgroundColor = color
                webView.isOpaque = false
                webView.scrollView.backgroundColor = color
                print("[CSSInjector] Native WebView background set to: \(colorString)")
            } else {
                // Fallback to clear
                webView.backgroundColor = .clear
                webView.isOpaque = false
                print("[CSSInjector] Invalid color format, using clear: \(colorString)")
            }
        }
    }
    
    /**
     * Convert hex string to UIColor
     */
    private func hexStringToUIColor(hex: String) -> UIColor? {
        var hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")
        
        var rgb: UInt64 = 0
        
        guard Scanner(string: hexSanitized).scanHexInt64(&rgb) else {
            return nil
        }
        
        let length = hexSanitized.count
        
        if length == 6 {
            let r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
            let g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
            let b = CGFloat(rgb & 0x0000FF) / 255.0
            return UIColor(red: r, green: g, blue: b, alpha: 1.0)
        } else if length == 8 {
            let r = CGFloat((rgb & 0xFF000000) >> 24) / 255.0
            let g = CGFloat((rgb & 0x00FF0000) >> 16) / 255.0
            let b = CGFloat((rgb & 0x0000FF00) >> 8) / 255.0
            let a = CGFloat(rgb & 0x000000FF) / 255.0
            return UIColor(red: r, green: g, blue: b, alpha: a)
        }
        
        return nil
    }
    
    // MARK: - Fallback: Manual Injection (via evaluateJavaScript)
    
    /**
     * Fallback CSS injection via evaluateJavaScript
     * Used only when called manually from JS or as backup
     */
    private func injectCSSViaEvaluateJavaScript() {
        DispatchQueue.main.async {
            guard let wkWebView = self.webView as? WKWebView else {
                print("[CSSInjector] WKWebView not available")
                return
            }
            
            var cssContent = self.cachedCSS
            if cssContent == nil || cssContent!.isEmpty {
                cssContent = self.readCSSFromBundle()
                self.cachedCSS = cssContent
            }
            
            guard let css = cssContent, !css.isEmpty else {
                print("[CSSInjector] CSS file not found or empty")
                return
            }
            
            guard let base64CSS = self.encodeToBase64(cssContent: css) else {
                print("[CSSInjector] Failed to encode CSS")
                return
            }
            
            let javascript = """
            (function() {
                try {
                    if (!document.getElementById('cdn-injected-styles')) {
                        var base64CSS = '\(base64CSS)';
                        var decodedCSS = decodeURIComponent(escape(atob(base64CSS)));
                        var style = document.createElement('style');
                        style.id = 'cdn-injected-styles';
                        style.textContent = decodedCSS;
                        (document.head || document.documentElement).appendChild(style);
                        console.log('[Native iOS Fallback] CSS injected');
                    }
                } catch(e) {
                    console.error('[Native iOS Fallback] CSS injection failed:', e);
                }
            })();
            """
            
            wkWebView.evaluateJavaScript(javascript) { (_, error) in
                if let error = error {
                    print("[CSSInjector] Fallback CSS injection failed: \(error.localizedDescription)")
                } else {
                    print("[CSSInjector] Fallback CSS injected successfully")
                }
            }
        }
    }
}
