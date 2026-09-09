# @tibame201020/queqiao-media

[English](README.md) | [繁體中文](README.zh-TW.md)

[Queqiao](https://github.com/tibame201020/Queqiao) 的受限 Media Extension。

## 能力

- `image_probe` — 以極小 PNG 驗證原生 MCP `ImageContent` 傳輸。
- `image_read` — 從授權 Workspace 讀取有大小上限的 PNG/JPEG/WebP。
- `video_frames` — 透過 Worker 管理的 `ffmpeg`，從 Workspace 影片最多抽取 4 張 JPEG frame。

## 安全與資源上限

- 圖片 payload：最多 2 MiB；
- 單次影片：最多 4 張 JPEG frame；
- `ffmpeg` 並行：每個 Worker 最多同時 2 個影片取樣 process，其他請求排隊；
- `ffmpeg` 由 Queqiao managed stdio 執行，不經 shell；
- process allowlist 僅允許 `ffmpeg`；
- outbound HTTP 關閉。

並行上限主要用來避免多個 agent 同時解碼影片時造成瞬間記憶體尖峰。

## 需求

- Queqiao `0.9.13` 或更新的 binary media runtime；
- Node.js `>=22.19 <25`；
- Worker 主機需可執行 `ffmpeg` 才能使用 `video_frames`。

## 安裝

```bash
queqiao extension install npm:@tibame201020/queqiao-media --attach-all
```

## 開發

```bash
npm ci
npm run check
npm pack --ignore-scripts --dry-run
```

CI 會在 Windows / Ubuntu 的 Node 22、24 驗證。npm release 採用與 `queqiao-http` / `queqiao-mcp` 相同方向：由 immutable `v<version>` GitHub Release 觸發 npm Trusted Publishing + provenance。

## License

MIT
