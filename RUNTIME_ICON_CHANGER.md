# Runtime Icon Changer

Cho phép thay đổi icon launcher của ứng dụng **(iOS & Android)** trong lúc **runtime**, không cần rebuild. Tương thích đầy đủ với **OutSystems MABS 9+**.

---

## Cấu hình OutSystems (MABS)

Thêm vào **Extensibility Configurations** của ứng dụng:

```json
{
  "preferences": {
    "global": [
      {
        "name": "ICON_CDN_URL",
        "value": "https://cdn.example.com/icons/icon-list.json"
      }
    ]
  },
  "plugin": {
    "url": "https://github.com/vnkhoado/cordova-plugin-change-app-info.git#feature/runtime-icon-update"
  }
}
```

> **Quan trọng:** Dùng `preferences.global` — KHÔNG dùng `plugin.variables`.

---

## Cấu hình Cordova thuần

```xml
<!-- config.xml -->
<preference name="ICON_CDN_URL"
    value="https://cdn.example.com/icons/icon-list.json" />
```

---

## Cấu trúc CDN JSON

```json
{
  "icons": [
    { "name": "default",   "resource": "https://cdn.example.com/icons/default.png" },
    { "name": "christmas", "resource": "https://cdn.example.com/icons/christmas.png" },
    { "name": "summer",    "resource": "https://cdn.example.com/icons/summer.png" }
  ]
}
```

| Trường | Yêu cầu |
|--------|---------|
| `name` | Duy nhất, chỉ dùng chữ thường + số + dấu gạch ngang |
| `resource` | URL công khai, CORS bật, Content-Type: `image/png` |
| Kích thước ảnh | **1024 × 1024 px**, nền đặc (không trong suốt) |

---

## Cơ chế hoạt động

### Build time — Hook tự động

| Platform | Hook | Việc làm |
|----------|------|-----------|
| iOS | `hooks/ios/register-alternate-icons.js` | Download PNG → resize → copy vào `Resources/RuntimeIcons/<name>/` → đăng ký `CFBundleAlternateIcons` + `UIApplicationSupportsAlternateIcons` trong `*-Info.plist` |
| Android | `hooks/android/register-icon-aliases.js` | Download PNG → resize → copy vào `mipmap-*` → inject `<activity-alias>` vào `AndroidManifest.xml` |

> **Giới hạn iOS:** Apple yêu cầu alternate icon phải được bundle trong binary. Hook download icon từ CDN lúc `after_prepare` để đóng gói vào build — sau đó runtime chỉ gọi `UIApplication.setAlternateIconName`.

### Runtime — Native switching

| Platform | Cơ chế | Yêu cầu |
|----------|--------|---------|
| iOS | `UIApplication.setAlternateIconName(name)` | iOS 10.3+, icon phải đăng ký trong Info.plist |
| Android | `PackageManager.setComponentEnabledSetting` với `DONT_KILL_APP` | API 21+, `<activity-alias>` trong Manifest |

---

## JavaScript API

```js
var RIC = cordova.plugins.RuntimeIconChanger;

// Kiểm tra thiết bị có hỗ trợ không
RIC.isSupported(function(ok) {
  if (!ok) return; // iOS < 10.3

  // Lấy danh sách icon từ CDN
  RIC.getIconList(function(icons) {
    console.log(icons);
    // => [ {name:'default', resource:'...'}, {name:'christmas', resource:'...'} ]
  }, onError);

  // Đổi icon
  RIC.changeIcon('christmas', function(msg) {
    console.log('Thành công:', msg);
  }, onError);

  // Reset về icon mặc định
  RIC.resetToDefault(function(msg) {
    console.log(msg);
  }, onError);

  // Lấy tên icon đang active
  RIC.getCurrentIcon(function(name) {
    console.log('Icon hiện tại:', name); // 'default' hoặc 'christmas'
  }, onError);
});

function onError(err) { console.error('[RIC] Error:', err); }
```

---

## Yêu cầu platform

| Platform | Điều kiện |
|----------|-----------|
| iOS | iOS 10.3+, bundle alternate icons (tự động bởi hook) |
| Android | API 21+ (Android 5.0), AndroidX enabled, `<activity-alias>` (tự động bởi hook) |
| MABS | Version 9+ (Cordova iOS 6+, Cordova Android 10+) |

---

## MABS — Optimisations áp dụng

- **Không dùng `plugin.variables`** — đọc từ `preferences.getString()` (case-insensitive)
- **Không có npm dependencies bắt buộc** — `jimp` là tuỳ chọn; nếu không có, hook dùng fallback copy
- **Non-fatal hooks** — lỗi hook chỉ log cảnh báo, không bao giờ phá vỡ build
- **Idempotent** — hook dọn dẹp output cũ trước khi inject lại (tránh duplicate aliases)
- **Không ghi vào bundle** — iOS chỉ switch alternate icon đã bundle; không ghi file vào app bundle lúc runtime
- **`DONT_KILL_APP`** — Android switch icon không force restart
- **Case-insensitive key** — đọc cả `icon_cdn_url` lẫn `ICON_CDN_URL`

---

## Kiểm tra build log

Trong MABS build log bạn sẽ thấy:

```
[RuntimeIconChanger iOS] Fetching icon list from: https://...
[RuntimeIconChanger iOS] Registered alternate icons: default, christmas, summer

[RuntimeIconChanger Android] Fetching icon list from: https://...
[RuntimeIconChanger Android] Activity aliases registered: default, christmas, summer
```

## Lưu ý

- Lần đầu build cần internet để hook download icon
- Nếu CDN trả về lỗi, hook bỏ qua (build vẫn thành công) nhưng tính năng đổi icon sẽ không hoạt động
- Cài `jimp` (`npm install jimp --save-dev`) để icon được resize chính xác theo density
- Trên Android, việc đổi icon yêu cầu icon đã được đăng ký trong Manifest lúc build
