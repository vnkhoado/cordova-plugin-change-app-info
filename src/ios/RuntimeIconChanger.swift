import Foundation
import UIKit

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

        let diag = buildDiagnostic(iconName: iconName)

        let earlyResult = CDVPluginResult(
            status: .ok,
            messageAs: "EARLY_DIAG: \(diag)"
        )
        earlyResult?.setKeepCallbackAs(true)
        self.commandDelegate.send(earlyResult, callbackId: command.callbackId)

        let delegate   = self.commandDelegate!
        let callbackId = command.callbackId!
        let altIconName: String? = (iconName == "default") ? nil : iconName

        DispatchQueue.main.async {
            UIApplication.shared.setAlternateIconName(altIconName) { err in
                DispatchQueue.main.async {
                    if let err = err {
                        let result = CDVPluginResult(
                            status: .error,
                            messageAs: "FAILED: \(err.localizedDescription) | DIAGNOSTIC: \(diag)"
                        )
                        delegate.send(result, callbackId: callbackId)
                    } else {
                        UserDefaults.standard.set(iconName, forKey: "RIC_currentIcon")
                        let result = CDVPluginResult(
                            status: .ok,
                            messageAs: "OK: Icon changed to \(iconName) | DIAGNOSTIC: \(diag)"
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

    private func buildDiagnostic(iconName: String) -> String {
        var lines: [String] = []
        let fm = FileManager.default

        guard let bundlePath = Bundle.main.resourcePath else {
            return "ERROR: Cannot get bundle resourcePath"
        }

        lines.append("bundlePath=\(bundlePath)")

        if #available(iOS 10.3, *) {
            lines.append("supportsAlternateIcons=\(UIApplication.shared.supportsAlternateIcons)")
        }

        if let icons = Bundle.main.infoDictionary?["CFBundleIcons"] as? [String: Any] {
            if let altIcons = icons["CFBundleAlternateIcons"] as? [String: Any] {
                lines.append("altIconKeys=\(altIcons.keys.sorted().joined(separator: ","))")
            } else {
                lines.append("CFBundleIcons=found_but_no_altIcons")
            }
        } else {
            lines.append("CFBundleIcons=MISSING_FROM_PLIST")
        }

        if let v = Bundle.main.infoDictionary?["UIApplicationSupportsAlternateIcons"] {
            lines.append("UIAppSupportsAltIcons=\(v)")
        } else {
            lines.append("UIAppSupportsAltIcons=MISSING_FROM_PLIST")
        }

        // CHECK: asset catalog (.car)
        let carPath = bundlePath + "/Assets.car"
        let hasAssetCar = fm.fileExists(atPath: carPath)
        lines.append("hasAssetsCar=\(hasAssetCar)")

        // CHECK: UIImage from asset catalog (works if imageset exists in .car)
        let assetImage = UIImage(named: iconName)
        lines.append("UIImage(named:\(iconName))=\(assetImage != nil ? "FOUND" : "NIL")")

        // CHECK: flat PNGs in bundle root
        for suffix in ["@2x", "@3x"] {
            let fileName = "\(iconName)\(suffix).png"
            let exists = fm.fileExists(atPath: bundlePath + "/" + fileName)
            lines.append("\(exists ? "YES" : "NO"):bundle/\(fileName)")
        }

        // LIST: all files at bundle root (first 30, excluding www)
        let rootContents = ((try? fm.contentsOfDirectory(atPath: bundlePath)) ?? [])
            .filter { !$0.hasPrefix("www") }
            .sorted()
        let hasWww = ((try? fm.contentsOfDirectory(atPath: bundlePath)) ?? []).contains("www")
        lines.append("hasWww=\(hasWww)")
        let preview = rootContents.prefix(30).joined(separator: ",")
        lines.append("bundleRootFiles=\(preview)")

        // CHECK: www/RuntimeIcons
        let wwwPath = bundlePath + "/www"
        if fm.fileExists(atPath: wwwPath) {
            let wwwContents = (try? fm.contentsOfDirectory(atPath: wwwPath)) ?? []
            lines.append("wwwHasRuntimeIcons=\(wwwContents.contains("RuntimeIcons"))")
        } else {
            lines.append("www=NOT_FOUND_IN_BUNDLE")
        }

        return lines.joined(separator: " || ")
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
