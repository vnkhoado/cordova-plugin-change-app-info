# Runtime Icon Changer

Tính năng này cho phép thay đổi icon launcher của ứng dụng (iOS & Android) trong lúc **runtime**, mà không cần rebuild. Danh sách icon được nạp từ một file JSON trên CDN.

## Cấu hình

### 1. Thêm preference vào `config.xml`

```xml
<preference name="ICON_CDN_URL"
    value="https://cdn.example.com/icons/icon-list.json" />
```

### 2. Cấu trúc file JSON trên CDN

File JSON phải có cấu trúc sau:

```json
{
  "icons": [
    {
      "name": "default",
      "resource": "https://cdn.example.com/icons/default.png"
    },
    {
      "name": "christmas",
      "resource": "https://cdn.example.com/icons/christmas.png"
    },
    {
      "name": "summer",
      "resource": "https://cdn.example.com/icons/summer.png"
    }
  ]
}
```

- `name`: tên định danh duy nhất cho icon (chỉ dùng chữ thường, số, dấu gạch nối)
- `resource`: link CDN trỏ đến file PNG, kích thước **1024 × 1024 px**

---

## Cách hoạt động

### Build time

| Platform | Hook | Việc làm |
|----------|------|-----------|
| iOS | `hooks/ios/register-alternate-icons.js` | Tải PNG từ CDN, resize về tất cả các kích thước cần thiết, copy vào Xcode project (`Resources/RuntimeIcons/<name>/`), đăng ký `CFBundleAlternateIcons` trong `*-Info.plist` |
| Android | `hooks/android/register-icon-aliases.js` | Tải PNG từ CDN, resize về các density `mipmap-*`, inject `<activity-alias>` vào `AndroidManifest.xml` với tên `<package>.MainActivity_<iconName>` |

> **Lưu ý quan trọng:** iOS yêu cầu icon phải được bundle bên trong app binary — không thể dùng icon tải về lúc runtime thuần tuý. Các icon từ CDN được download lúc `after_prepare` và đóng gói vào build.

### Runtime

- **iOS:** Dùng `UIApplication.setAlternateIconName(name)` (yêu cầu iOS 10.3+)
- **Android:** Dùng `PackageManager.setComponentEnabledSetting` để bật alias tương ứng và tắt các alias khác

---

## JavaScript API

```js
var RIC = cordova.plugins.RuntimeIconChanger;

// Lấy danh sách icon từ CDN JSON
RIC.getIconList(
  function(icons) {
    // icons = [ { name: 'default', resource: 'https://...' }, ... ]
    console.log(icons);
  },
  function(err) { console.error(err); }
);

// Đổi icon
RIC.changeIcon(
  'christmas',
  function(msg) { console.log('Thành công:', msg); },
  function(err) { console.error('Lỗi:', err); }
);

// Reset về icon mặc định
RIC.resetToDefault(
  function(msg) { console.log(msg); },
  function(err) { console.error(err); }
);

// Lấy icon đang active
RIC.getCurrentIcon(
  function(name) { console.log('Icon hiện tại:', name); },
  function(err) { console.error(err); }
);
```

---

## Yêu cầu Platform

| Platform | Điều kiện |
|----------|-----------|
| iOS | iOS 10.3+, `UIApplicationSupportsAlternateIcons: true` trong Info.plist (tự động thêm bởi hook) |
| Android | API 21+ (Android 5.0), phải khai báo `<activity-alias>` trong Manifest (tự động bởi hook) |

---

## Lưu ý

- Lần đầu build cần có kết nối internet để hook download icon từ CDN
- Nếu CDN URL không set hoặc JSON không hợp lệ, hook bỏ qua và không gây lỗi build
- Trên Android, việc đổi icon yêu cầu app restart (hệ điều hành tự làm điều này)
- `jimp` là dependency tùy chọn — nếu có thì icon được resize chính xác, nếu không hook sẽ copy file gốc 1024x1024

## Cài đặt jimp (khuyến nghị)

```bash
npm install jimp --save-dev
```
