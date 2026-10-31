# 网页版借用的几个现成工具

原样从 npm 拷来，一个字没改；放在这里而不是走 CDN，是因为不少公司网络拦 CDN。用到时才加载。

| 文件 | 来源 | 干什么 | 许可 |
|---|---|---|---|
| `xlsx.full.min.js` | [xlsx 0.18.5](https://www.npmjs.com/package/xlsx/v/0.18.5)（SheetJS） | 放入数据库：读 .xlsx / .xls / 网页导出的表 | Apache-2.0 |
| `exceljs.min.js` | [exceljs 4.4.0](https://www.npmjs.com/package/exceljs/v/4.4.0) | 出表：带颜色、合并格子的 Excel | MIT |
| `jszip.min.js` | [jszip 3.10.1](https://www.npmjs.com/package/jszip/v/3.10.1) | 编号照片打包下载 | MIT（或 GPL-3.0） |
| `heic2any.min.js` | [heic2any 0.0.4](https://www.npmjs.com/package/heic2any/v/0.0.4) | 苹果的 HEIC 照片转成 JPG（浏览器自己不认时才加载） | MIT；里面带的 libheif 是 LGPL-3.0，源码见 [strukturag/libheif](https://github.com/strukturag/libheif) |
| `qrcode.js` | [qrcode-generator 1.4.4](https://www.npmjs.com/package/qrcode-generator/v/1.4.4)（Kazuhiko Arase） | 「手机传图」的二维码 | MIT |

换版本：`npm install 包名@版本`，把 `dist/` 下同名文件拷过来（qrcode-generator 在包的根目录），跑一遍 `web/test/e2e.py`。
