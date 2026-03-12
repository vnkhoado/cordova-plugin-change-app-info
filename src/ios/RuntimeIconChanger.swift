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
 * CDN, bundles them into www/RuntimeIcons/, and registers them in Info.plist.
 */
@objc(RuntimeIconChanger)
class RuntimeIconChanger: CDVPlugin {

    // MARK: - isSupported

    @objc(isSupported:)
    func isSupported(_ command: CDVInvokedUrlCommand) {
        if #available(iOS 10.3, *) {
            sendSuccess(true, callbackId: command.callbackId)
        } else {
            sendSuccess(false, callbackId: command.callbackId)
        }
    }

    // MARK: - changeIcon

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

        // ===== DIAGNOSTIC — xóa sau khi xác nhận bundle path đúng =====
        runDiagnostic(iconName: iconName)
        // ===== END DIAGNOSTIC =====

        let delegate       = self.commandDelegate!
        let callbackId     = command.callbackId!
        let altIconName: String? = (iconName == "default") ? nil : iconName

        DispatchQueue.main.async {
            UIApplication.shared.setAlternateIconName(altIconName) { err in
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

    // MARK: - resetToDefault

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

    // MARK: - getCurrentIcon

    @objc(getCurrentIcon:)
    func getCurrentIcon(_ command: CDVInvokedUrlCommand) {
        let current = UserDefaults.standard.string(forKey: "RIC_currentIcon") ?? "default"
        sendSuccess(current, callbackId: command.callbackId)
    }

    // MARK: - getIconList

    @objc(getIconList:)
    func getIconList(_ command: CDVInvokedUrlCommand) {
        if #available(iOS 10.3, *),
           let bundleIcons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any],
           let altIcons    = bundleIcons["CFBundleAlternateIcons"] as? [String: Any] {

            var icons: [[String: String]] = [["name": "default"]]
            for name in altIcons.keys.sorted() {
                icons.append(["name": name])
            }
            let result = CDVPluginResult(status: .ok, messageAs: icons)
            commandDelegate.send(result, callbackId: command.callbackId)
        } else {
            let result = CDVPluginResult(status: .ok, messageAs: [["name": "default"]])
            commandDelegate.send(result, callbackId: command.callbackId)
        }
    }

    // MARK: - Diagnostic

    private func runDiagnostic(iconName: String) {
        guard let bundlePath = Bundle.main.resourcePath else {
            print("[RIC] ❌ Cannot get bundle resourcePath")
            return
        }

        let fm = FileManager.default

        print("[RIC] ════════════════════════════════════")
        print("[RIC] Bundle path:", bundlePath)

        if #available(iOS 10.3, *) {
            print("[RIC] supportsAlternateIcons:", UIApplication.shared.supportsAlternateIcons)
        }

        // Kiểm tra CFBundleIcons trong Info.plist
        if let icons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any] {
            print("[RIC] ✅ CFBundleIcons in Info.plist:", icons)
        } else {
            print("[RIC] ❌ CFBundleIcons NOT found in Info.plist")
        }

        // Scan toàn bộ bundle root để xem có RuntimeIcons không
        let rootContents = (try? fm.contentsOfDirectory(atPath: bundlePath)) ?? []
        let hasWww           = rootContents.contains("www")
        let hasRuntimeIcons  = rootContents.contains("RuntimeIcons")
        print("[RIC] Bundle root contains www/:", hasWww)
        print("[RIC] Bundle root contains RuntimeIcons/:", hasRuntimeIcons)

        // Scan www/ nếu tồn tại
        if hasWww {
            let wwwPath = bundlePath + "/www"
            let wwwContents = (try? fm.contentsOfDirectory(atPath: wwwPath)) ?? []
            print("[RIC] www/ contents:", wwwContents)

            let runtimeInWww = bundlePath + "/www/RuntimeIcons"
            if fm.fileExists(atPath: runtimeInWww) {
                let runtimeContents = (try? fm.contentsOfDirectory(atPath: runtimeInWww)) ?? []
                print("[RIC] www/RuntimeIcons/ contents:", runtimeContents)
            } else {
                print("[RIC] ❌ www/RuntimeIcons/ NOT FOUND")
            }
        }

        // Check các path cụ thể
        let checkPaths = [
            "www/RuntimeIcons/\(iconName)/Icon@2x.png",
            "www/RuntimeIcons/\(iconName)/Icon@3x.png",
            "RuntimeIcons/\(iconName)/Icon@2x.png",
            "RuntimeIcons/\(iconName)/Icon@3x.png",
            "\(iconName)@2x.png",
            "\(iconName)@3x.png",
        ]

        print("[RIC] File existence check:")
        for p in checkPaths {
            let exists = fm.fileExists(atPath: bundlePath + "/" + p)
            print("[RIC]   \(exists ? "✅" : "❌") \(p)")
        }

        // Dump UIApplicationSupportsAlternateIcons từ Info.plist
        if let supports = Bundle.main.infoDictionary?["UIApplicationSupportsAlternateIcons"] {
            print("[RIC] UIApplicationSupportsAlternateIcons:", supports)
        } else {
            print("[RIC] ❌ UIApplicationSupportsAlternateIcons NOT in Info.plist")
        }

        print("[RIC] ════════════════════════════════════")
    }

    // MARK: - Helpers

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
