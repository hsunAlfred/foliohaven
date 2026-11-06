# Noto Sans TC Variable

Studio 使用的繁體中文字型，以靜態資產自託管；執行時不連線至字型供應商。

- 發布者：Fontsource。
- 套件：`@fontsource-variable/noto-sans-tc`，固定版本 `5.3.1`。
- 原始套件：https://registry.npmjs.org/@fontsource-variable/noto-sans-tc/-/noto-sans-tc-5.3.1.tgz
- 套件完整性：`sha512-gueh+AySNkihE+HvizXLHltxt5/xVFSvw6ISnKTlpb/lG5QQm6u/KwuempTJ/jDYMST3xwiERYTTyseoJ/Kxew==`，匯入前已用 SHA-512 核對。
- 官方說明：https://fontsource.org/fonts/noto-sans-tc/about
- 字型上游：https://github.com/notofonts/noto-cjk
- 上游授權：https://github.com/google/fonts/blob/main/ofl/notosanstc/OFL.txt
- 授權：SIL Open Font License 1.1；原套件 LICENSE 與上游版權宣告均保留於本目錄。

`font.css` 原自套件 `wght.css`，保留其 unicode-range、100–900 可變字重與 font-display: swap；僅採專案 Prettier 格式。`files/` 包含它引用的全部 WOFF2 檔，二進位內容未修改。瀏覽器只按實際文字載入所需子集；不依賴容器內安裝字型。

兩份授權文件亦放在 `studio/public/licenses/`，隨 Studio build 一起複製至工具產物，與 WOFF2 字型共同保留。
