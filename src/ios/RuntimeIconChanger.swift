import Foundation
import UIKit

/**
 * RuntimeIconChanger.swift
 *
 * iOS native implementation — optimised for OutSystems MABS.
 *
 * MABS constraints respected:
 *   - No file-system writes to app bundle (read-only in MABS sandbox)
 *   - Reads ICON_CDN_URL from Cordova preferences (set via Extensibility
 *     Configurations > preferences > global in OutSystems)
 *   - No third-party Swift dependencies (MABS may reject unknown SPM packages)
 *   - Compiled with Swift 5, iOS deployment target 13.0+
 *   - UIApplication.setAlternateIconName requires iOS 10.3+
 *   - Icons MUST be pre-bundled; this class switches between them at runtime
 *
 * The build hook `hooks/ios/register-alternate-icons.js` downloads icons from
 * CDN, bundles them into the Xcode project, and registers them in Info.plist.
 */
@objc(RuntimeIconChanger)
class RuntimeIconChanger: CDVPlugin {

    // CDN JSON URL — read from config.xml / MABS Extensibility Configurations
    private var cdnJsonUrl: String = ""
    // Simple in-memory cache so we don't re-fetch on every call
    private var cachedIcons: [[String: String]] = []
    // Shared URLSession with sensible timeouts for mobile networks
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest  = 15
        cfg.timeoutIntervalForResource = 30
        return URLSession(configuration: cfg)
    }()

    // MARK: - Plugin lifecycle

    override func pluginInitialize() {
        super.pluginInitialize()
        // MABS stores preferences in lowercase keys
        cdnJsonUrl = (commandDelegate.settings["icon_cdn_url"] as? String)
                  ?? (commandDelegate.settings["ICON_CDN_URL"] as? String)
                  ?? ""
    }

    // MARK: - Public Cordova commands

    @objc(isSupported:)
    func isSupported(_ command: CDVInvokedUrlCommand) {
        // Check iOS version only — KHÔNG dùng supportsAlternateIcons
        // vì supportsAlternateIcons phụ thuộc Info.plist đúng cấu trúc CFBundleIcons,
        // nếu hook chưa chạy đúng sẽ trả false dù device đủ điều kiện
        if #available(iOS 10.3, *) {
            sendSuccess(true, callbackId: command.callbackId)
        } else {
            sendSuccess(false, callbackId: command.callbackId)
        }
    }

    @objc(getIconList:)
    func getIconList(_ command: CDVInvokedUrlCommand) {
        guard !cdnJsonUrl.isEmpty, let url = URL(string: cdnJsonUrl) else {
            sendError("ICON_CDN_URL not configured. Add it to Extensibility Configurations preferences.",
                      callbackId: command.callbackId)
            return
        }
        if !cachedIcons.isEmpty {
            let result = CDVPluginResult(status: .ok, messageAs: cachedIcons as [Any])
            commandDelegate.send(result, callbackId: command.callbackId)
            return
        }
        commandDelegate.run(inBackground: {
            self.fetchIconList(url: url) { icons, error in
                if let error = error {
                    self.sendError(error, callbackId: command.callbackId)
                    return
                }
                self.cachedIcons = icons ?? []
                let result = CDVPluginResult(status: .ok, messageAs: self.cachedIcons as [Any])
                self.commandDelegate.send(result, callbackId: command.callbackId)
            }
        })
    }

    @objc(changeIcon:)
    func changeIcon(_ command: CDVInvokedUrlCommand) {
        guard #available(iOS 10.3, *) else {
            sendError("Alternate icons require iOS 10.3+", callbackId: command.callbackId)
            return
        }

        guard let iconName = command.arguments.first as? String, !iconName.isEmpty else {
            sendError("iconName argument is required", callbackId: command.callbackId)
            return
        }

        // FIX 1: Bỏ guard supportsAlternateIcons — check version đủ rồi
        // FIX 2: Bỏ resolveIconEntry (CDN fetch) — icon đã bundle sẵn, không cần verify
        // FIX 3: Strong reference tránh commandDelegate bị release trước completion
        let delegate   = self.commandDelegate!
        let callbackId = command.callbackId!

        let alternateIconName: String? = (iconName == "default") ? nil : iconName

        DispatchQueue.main.async {
            UIApplication.shared.setAlternateIconName(alternateIconName) { err in
                // FIX 4: Completion handler chạy trên bất kỳ thread nào
                // → phải dispatch về main để gọi delegate an toàn
                DispatchQueue.main.async {
                    if let err = err {
                        let result = CDVPluginResult(
                            status: .error,
                            messageAs: "setAlternateIconName failed: \(err.localizedDescription)"
                        )
                        delegate.send(result, callbackId: callbackId)
                    } else {
                        UserDefaults.standard.set(iconName, forKey: "RIC_currentIcon")
                        let result = CDVPluginResult(
                            status: .ok,
                            messageAs: "Icon changed to \(iconName)"
                        )
                        delegate.send(result, callbackId: callbackId)
                    }
                }
            }
        }
    }

    @objc(resetToDefault:)
    func resetToDefault(_ command: CDVInvokedUrlCommand) {
        guard #available(iOS 10.3, *) else {
            sendError("Alternate icons require iOS 10.3+", callbackId: command.callbackId)
            return
        }

        let delegate   = self.commandDelegate!
        let callbackId = command.callbackId!

        DispatchQueue.main.async {
            UIApplication.shared.setAlternateIconName(nil) { err in
                DispatchQueue.main.async {
                    if let err = err {
                        let result = CDVPluginResult(
                            status: .error,
                            messageAs: err.localizedDescription
                        )
                        delegate.send(result, callbackId: callbackId)
                    } else {
                        UserDefaults.standard.removeObject(forKey: "RIC_currentIcon")
                        let result = CDVPluginResult(
                            status: .ok,
                            messageAs: "Icon reset to default"
                        )
                        delegate.send(result, callbackId: callbackId)
                    }
                }
            }
        }
    }

    @objc(getCurrentIcon:)
    func getCurrentIcon(_ command: CDVInvokedUrlCommand) {
        let current = UserDefaults.standard.string(forKey: "RIC_currentIcon") ?? "default"
        sendSuccess(current, callbackId: command.callbackId)
    }

    // MARK: - Private helpers

    private func fetchIconList(url: URL, completion: @escaping ([[String: String]]?, String?) -> Void) {
        session.dataTask(with: url) { data, _, error in
            if let error = error {
                completion(nil, error.localizedDescription)
                return
            }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let icons = json["icons"] as? [[String: String]] else {
                completion(nil, "Invalid or unexpected JSON format from CDN.")
                return
            }
            completion(icons, nil)
        }.resume()
    }

    // Overload cho Bool (dùng trong isSupported)
    private func sendSuccess(_ value: Bool, callbackId: String) {
        let result = CDVPluginResult(status: .ok, messageAs: value)
        commandDelegate.send(result, callbackId: callbackId)
    }

    private func sendSuccess(_ message: String, callbackId: String) {
        let result = CDVPluginResult(status: .ok, messageAs: message)
        commandDelegate.send(result, callbackId: callbackId)
    }

    private func sendError(_ message: String, callbackId: String) {
        let result = CDVPluginResult(status: .error, messageAs: message)
        commandDelegate.send(result, callbackId: callbackId)
    }
}
