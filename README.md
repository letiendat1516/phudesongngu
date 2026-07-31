# Phụ Đề Song Ngữ — Bilingual Subtitles

Tiện ích mở rộng (extension) cho trình duyệt, giúp hiển thị **phụ đề song ngữ** khi xem phim trên nền tảng phát trực tuyến. Tự động lấy phụ đề thứ hai và hiển thị song song với phụ đề gốc.

## ✨ Tính năng

- 🌐 **Phụ đề song ngữ** — Hiển thị hai ngôn ngữ đồng thời (VD: Tiếng Việt + Tiếng Anh)
- 🔄 **Tự động lấy phụ đề** — Tự động đọc danh sách track từ manifest và tải phụ đề thứ hai
- 🎨 **Tùy chỉnh hiển thị** — Màu chữ, cỡ chữ (×1 đến ×5), độ mờ, vị trí (trên/dưới)
- 🖱️ **Kéo thả** — Nhấn và kéo phụ đề thứ hai đến vị trí bất kỳ
- 📺 **Toàn màn hình** — Hoạt động ở cả chế độ cửa sổ và toàn màn hình
- 🔤 **Giữ xuống dòng** — Hỗ trợ phụ đề nhiều dòng, căn giữa từ giữa ra
- 🔄 **Tự chuyển tập** — Tự nhận diện khi sang tập mới, không cần refresh

## 🚀 Cài đặt (Development)

### Cách 1: Tải từ Chrome Web Store
*(Sắp ra mắt)*

### Cách 2: Cài đặt thủ công (Developer mode)
1. Tải source code về máy
2. Mở `chrome://extensions/`
3. Bật **Developer mode** (góc phải trên)
4. Nhấn **Load unpacked** → chọn thư mục source code

## 📖 Cách sử dụng

1. Mở nền tảng phát trực tuyến, phát video bất kỳ
2. Bật phụ đề ở ngôn ngữ tùy chọn
3. Extension tự động hiển thị phụ đề tiếng Việt song song
4. Mở popup extension để tùy chỉnh màu sắc, vị trí, kích thước
5. Kéo phụ đề thứ hai để di chuyển đến vị trí mong muốn

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
├── icons/                 # Icons
└── PRIVACY.md             # Chính sách bảo mật
```

## 🔒 Bảo mật & Quyền riêng tư

- ❌ **KHÔNG** thu thập thông tin cá nhân
- ❌ **KHÔNG** gửi dữ liệu đến máy chủ bên ngoài
- ❌ **KHÔNG** theo dõi hoạt động người dùng
- ✅ Tất cả xử lý phụ đề thực hiện **cục bộ trong trình duyệt**

Xem chi tiết: [PRIVACY.md](PRIVACY.md)

## 📝 Cách hoạt động

1. **inject.js** (MAIN world) đọc response phụ đề định dạng TTML từ trình duyệt
2. **content.js** (ISOLATED world) parse dữ liệu và hiển thị overlay
3. **ttml-parser.js** phân tích cú pháp TTML/DFXP (tick rate, line breaks, styling)
4. **popup** cung cấp giao diện cấu hình

## 📜 License

MIT License — Tự do sử dụng, chỉnh sửa và phân phối.

---

**Lưu ý:** Tiện ích này không liên kết, không được bảo trợ bởi bất kỳ nền tảng phát trực tuyến nào. Tên các nền tảng được nhắc đến chỉ nhằm mục đích mô tả tính năng.
