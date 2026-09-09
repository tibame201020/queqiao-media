# @tibame201020/queqiao-media

[English](README.md) | [繁體中文](README.zh-TW.md)

Bounded media extension for [Queqiao](https://github.com/tibame201020/Queqiao).

## Capabilities

- `image_probe` — verifies native MCP `ImageContent` transport with a tiny synthetic PNG.
- `image_read` — reads bounded PNG/JPEG/WebP files from an authorized Workspace.
- `video_frames` — samples up to 4 JPEG frames from a Workspace video with Worker-managed `ffmpeg`.

## Safety bounds

- image payload: at most 2 MiB;
- video output: at most 4 sampled JPEG frames per call;
- `ffmpeg` concurrency: at most 2 active video sampling processes per Worker; additional calls queue;
- `ffmpeg` is launched through Queqiao managed stdio, not a shell;
- the extension process allowlist contains only `ffmpeg`;
- outbound HTTP is disabled.

The concurrency gate exists to limit transient decoder/encoder memory spikes when multiple agents inspect videos at the same time.

## Requirements

- Queqiao `0.9.13` or newer binary media runtime;
- Node.js `>=22.19 <25`;
- `ffmpeg` available on the Worker host for `video_frames`.

## Install

```bash
queqiao extension install npm:@tibame201020/queqiao-media --attach-all
```

## Development

```bash
npm ci
npm run check
npm pack --ignore-scripts --dry-run
```

CI validates Node 22/24 on Windows and Ubuntu. npm releases are intended to be published from immutable `v<version>` GitHub Releases through npm Trusted Publishing with provenance.

## License

MIT
