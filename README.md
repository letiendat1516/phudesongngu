# Netflix Phụ Đề Song Ngữ (Netflix Bilingual Subtitles)

Extension trình duyệt giúp hiển thị phụ đề song ngữ trên Netflix.

## 🚀 Cài đặt

### Bước 1: Tạo icons
Mở file `generate-icons.html` trong trình duyệt, nhấn "Tải xuống tất cả icons".
Di chuyển các file `icon16.png`, `icon48.png`, `icon128.png` vào thư mục `icons/`.

### Bước 2: Cài đặt extension
1. Mở Chrome/Edge, vào `chrome://extensions/`
2. Bật **Developer mode** (góc phải trên)
3. Nhấn **Load unpacked**
4. Chọn thư mục `netflix-bilingual-subtitles/`

### Bước 3: Sử dụng
1. Mở [netflix.com](https://netflix.com), phát video bất kỳ
2. Bật phụ đề với ngôn ngữ chính (VD: tiếng Việt)
3. **Tạm thời chuyển** phụ đề sang ngôn ngữ thứ hai (VD: tiếng Anh) trong menu Netflix
4. Extension sẽ tự động ghi nhớ và hiển thị cả hai ngôn ngữ đồng thời
5. Mở popup extension để tùy chỉnh màu sắc, vị trí, kích thước

## 🎯 Tính năng

- ✅ Hiển thị phụ đề song ngữ đồng thời
- ✅ Tự động bắt dữ liệu phụ đề từ Netflix
- ✅ Tùy chỉnh màu chữ, kích thước, độ mờ
- ✅ Tùy chỉnh vị trí (trên/dưới phụ đề gốc)
- ✅ Hỗ trợ Netflix Việt Nam & quốc tế
- ✅ Hoạt động với Manifest V3

## 🛠 Cấu trúc thư mục

```
netflix-bilingual-subtitles/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker
├── content.js             # Content script chính (ISOLATED world)
├── inject.js              # Script trong page context (MAIN world)
├── content.css            # Style cho phụ đề overlay
├── lib/
│   └── ttml-parser.js     # Parser cho định dạng TTML/DFXP
├── popup/
│   ├── popup.html         # Giao diện popup
│   ├── popup.js           # Logic popup
│   └── popup.css          # Style popup
├── icons/                 # Thư mục chứa icons (tự tạo)
└── generate-icons.html    # Công cụ tạo icons
```

## 📝 Cách hoạt động

1. **inject.js** (chạy trong MAIN world) can thiệp `fetch` và `XMLHttpRequest` để bắt các response phụ đề từ Netflix
2. **content.js** (ISOLATED world) nhận dữ liệu, parse TTML và hiển thị phụ đề thứ hai dưới dạng overlay
3. **ttml-parser.js** parse định dạng TTML/DFXP mà Netflix sử dụng cho phụ đề
4. **background.js** quản lý cài đặt và giao tiếp
5. **popup/** cung cấp giao diện người dùng để cấu hình

## ⚠️ Lưu ý

- Extension này KHÔNG thu thập bất kỳ dữ liệu cá nhân nào
- Chỉ hoạt động trên `*.netflix.com`
- Mã nguồn mở, bạn có thể kiểm tra toàn bộ code
