import Foundation
import UIKit

/**
 * RuntimeIconChanger.swift
 *
 * Native iOS implementation for changing the app icon at runtime.
 * - Reads ICON_CDN_URL from plugin preferences (config.xml)
 * - Fetches JSON from CDN, parses icon list
 * - Downloads PNG (1024x1024) and applies via UIApplication.setAlternateIconName
 *
 * iOS Requirements:
 *   - iOS 10.3+
 *   - The app's Info.plist must declare CFBundleAlternateIcons for each named icon
 *     (the hook hooks/ios/register-alternate-icons.js handles this automatically).
 */
@objc(RuntimeIconChanger)
class RuntimeIconChanger: CDVPlugin {

    private var cdnJsonUrl: String = ""
    private var cachedIconList: [[String: String]] = []

    // MARK: - Plugin lifecycle

    override func pluginInitialize() {
        super.pluginInitialize()
        cdnJsonUrl = commandDelegate.settings["icon_cdn_url"] as? String ?? ""
    }

    // MARK: - Cordova commands

    /// Returns the icon list fetched from CDN JSON.
    @objc(getIconList:)
    func getIconList(_ command: CDVInvokedUrlCommand) {
        guard !cdnJsonUrl.isEmpty, let url = URL(string: cdnJsonUrl) else {
            let result = CDVPluginResult(status: .error, messageAs: "ICON_CDN_URL is not configured in config.xml")
            commandDelegate.send(result, callbackId: command.callbackId)
            return
        }

        commandDelegate.run(inBackground: {
            self.fetchIconList(from: url) { icons, error in
                if let error = error {
                    let result = CDVPluginResult(status: .error, messageAs: error)
                    self.commandDelegate.send(result, callbackId: command.callbackId)
                    return
                }
                self.cachedIconList = icons ?? []
                let result = CDVPluginResult(status: .ok, messageAs: self.cachedIconList as [Any])
                self.commandDelegate.send(result, callbackId: command.callbackId)
            }
        })
    }

    /// Downloads the icon PNG from CDN and applies it as alternate icon.
    @objc(changeIcon:)
    func changeIcon(_ command: CDVInvokedUrlCommand) {
        guard let iconName = command.arguments.first as? String, !iconName.isEmpty else {
            let result = CDVPluginResult(status: .error, messageAs: "Icon name is required")
            commandDelegate.send(result, callbackId: command.callbackId)
            return
        }

        guard !cdnJsonUrl.isEmpty, let url = URL(string: cdnJsonUrl) else {
            let result = CDVPluginResult(status: .error, messageAs: "ICON_CDN_URL is not configured")
            commandDelegate.send(result, callbackId: command.callbackId)
            return
        }

        commandDelegate.run(inBackground: {
            let iconList = self.cachedIconList.isEmpty ? self.syncFetchIconList(from: url) : self.cachedIconList
            guard let iconEntry = iconList.first(where: { $0["name"] == iconName }),
                  let resourceUrlStr = iconEntry["resource"],
                  let resourceUrl = URL(string: resourceUrlStr) else {
                let result = CDVPluginResult(status: .error, messageAs: "Icon '\(iconName)' not found in CDN list")
                self.commandDelegate.send(result, callbackId: command.callbackId)
                return
            }

            self.downloadAndCacheIcon(name: iconName, from: resourceUrl) { localName, error in
                if let error = error {
                    let result = CDVPluginResult(status: .error, messageAs: error)
                    self.commandDelegate.send(result, callbackId: command.callbackId)
                    return
                }
                DispatchQueue.main.async {
                    if #available(iOS 10.3, *) {
                        let alternateIconName: String? = (localName == "default") ? nil : localName
                        UIApplication.shared.setAlternateIconName(alternateIconName) { err in
                            if let err = err {
                                let result = CDVPluginResult(status: .error, messageAs: err.localizedDescription)
                                self.commandDelegate.send(result, callbackId: command.callbackId)
                            } else {
                                UserDefaults.standard.set(iconName, forKey: "RuntimeIconChanger_currentIcon")
                                let result = CDVPluginResult(status: .ok, messageAs: "Icon changed to \(iconName)")
                                self.commandDelegate.send(result, callbackId: command.callbackId)
                            }
                        }
                    } else {
                        let result = CDVPluginResult(status: .error, messageAs: "Alternate icons require iOS 10.3+")
                        self.commandDelegate.send(result, callbackId: command.callbackId)
                    }
                }
            }
        })
    }

    /// Reset to the primary (default) icon.
    @objc(resetToDefault:)
    func resetToDefault(_ command: CDVInvokedUrlCommand) {
        DispatchQueue.main.async {
            if #available(iOS 10.3, *) {
                UIApplication.shared.setAlternateIconName(nil) { error in
                    if let error = error {
                        let result = CDVPluginResult(status: .error, messageAs: error.localizedDescription)
                        self.commandDelegate.send(result, callbackId: command.callbackId)
                    } else {
                        UserDefaults.standard.removeObject(forKey: "RuntimeIconChanger_currentIcon")
                        let result = CDVPluginResult(status: .ok, messageAs: "Icon reset to default")
                        self.commandDelegate.send(result, callbackId: command.callbackId)
                    }
                }
            } else {
                let result = CDVPluginResult(status: .error, messageAs: "Alternate icons require iOS 10.3+")
                self.commandDelegate.send(result, callbackId: command.callbackId)
            }
        }
    }

    /// Returns the currently active icon name.
    @objc(getCurrentIcon:)
    func getCurrentIcon(_ command: CDVInvokedUrlCommand) {
        let current = UserDefaults.standard.string(forKey: "RuntimeIconChanger_currentIcon") ?? "default"
        let result = CDVPluginResult(status: .ok, messageAs: current)
        commandDelegate.send(result, callbackId: command.callbackId)
    }

    // MARK: - Helpers

    private func fetchIconList(from url: URL, completion: @escaping ([[String: String]]?, String?) -> Void) {
        URLSession.shared.dataTask(with: url) { data, _, error in
            if let error = error {
                completion(nil, error.localizedDescription)
                return
            }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let icons = json["icons"] as? [[String: String]] else {
                completion(nil, "Invalid JSON format from CDN")
                return
            }
            completion(icons, nil)
        }.resume()
    }

    private func syncFetchIconList(from url: URL) -> [[String: String]] {
        var result: [[String: String]] = []
        let semaphore = DispatchSemaphore(value: 0)
        fetchIconList(from: url) { icons, _ in
            result = icons ?? []
            semaphore.signal()
        }
        semaphore.wait()
        return result
    }

    /**
     * Downloads the PNG from CDN, resizes to required icon sizes, saves to app's
     * Documents/RuntimeIcons directory, and returns the icon name to use with
     * UIApplication.setAlternateIconName.
     *
     * Note: iOS requires icons to be bundled in the app — this method caches them
     * to the app's documents folder and the hook registers them in Info.plist at
     * build time. At runtime we reference the pre-registered name directly.
     */
    private func downloadAndCacheIcon(name: String, from url: URL, completion: @escaping (String?, String?) -> Void) {
        URLSession.shared.dataTask(with: url) { data, _, error in
            if let error = error {
                completion(nil, "Download failed: \(error.localizedDescription)")
                return
            }
            guard let data = data, let image = UIImage(data: data) else {
                completion(nil, "Invalid image data from CDN")
                return
            }

            // Cache resized icons in Documents/RuntimeIcons/<name>/
            let sizes: [(String, CGFloat)] = [
                ("@2x", 120), ("@3x", 180),   // iPhone
                ("@2x~ipad", 152), ("@2x~ipadpro", 167), // iPad
                ("", 1024)  // App Store / source
            ]

            guard let docsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
                completion(nil, "Cannot access Documents directory")
                return
            }

            let iconDir = docsDir.appendingPathComponent("RuntimeIcons/\(name)", isDirectory: true)
            try? FileManager.default.createDirectory(at: iconDir, withIntermediateDirectories: true)

            for (suffix, size) in sizes {
                let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
                let resized = renderer.pngData { ctx in
                    image.draw(in: CGRect(x: 0, y: 0, width: size, height: size))
                }
                let fileURL = iconDir.appendingPathComponent("Icon\(suffix).png")
                try? resized.write(to: fileURL)
            }

            // Return the pre-registered alternate icon name (registered via hook)
            completion(name, nil)
        }.resume()
    }
}
