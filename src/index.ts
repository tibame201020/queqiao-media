import path from "node:path";
import { z } from "zod";
import type {
  QueqiaoExtension,
  ToolDefinition,
  WorkerExtensionContext,
} from "@tibame201020/queqiao/extension";

const EXTENSION_ID = "dev.queqiao.media";
const EXTENSION_VERSION = "0.2.4";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_FRAMES = 4;
const MAX_CONCURRENT_VIDEO_PROCESSES = 2;

function mcpToolResult(result: unknown) {
  return { kind: "mcp_tool_result" as const, result };
}

let activeVideoProcesses = 0;
const videoProcessWaiters: Array<() => void> = [];

async function acquireVideoProcessSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw new Error("Video sampling was aborted");
  if (activeVideoProcesses >= MAX_CONCURRENT_VIDEO_PROCESSES) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const waiter = () => {
        if (settled) return;
        settled = true;
        cleanup();
        activeVideoProcesses += 1;
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const index = videoProcessWaiters.indexOf(waiter);
        if (index >= 0) videoProcessWaiters.splice(index, 1);
        cleanup();
        reject(new Error("Video sampling was aborted"));
      };
      videoProcessWaiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  } else {
    activeVideoProcesses += 1;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeVideoProcesses -= 1;
    videoProcessWaiters.shift()?.();
  };
}

async function withVideoProcessSlot<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
  const release = await acquireVideoProcessSlot(signal);
  try {
    return await task();
  } finally {
    release();
  }
}

// Valid RGB PNG: chunk CRCs and the compressed scanline are verified in tests.
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ6jgDAAJGAXf1GcCGAAAAAElFTkSuQmCC";

type BinaryRead = { path: string; bytes: number; data: string };
type MediaCapabilities = WorkerExtensionContext["capabilities"] & {
  readBinaryFile(path: string): Promise<BinaryRead>;
};
type MediaStdio = WorkerExtensionContext["runtime"]["stdio"] & {
  open(input: {
    executable: string;
    args?: readonly string[];
    cwd?: string;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    stdoutEncoding?: "utf8" | "base64";
  }): Promise<Awaited<ReturnType<WorkerExtensionContext["runtime"]["stdio"]["open"]>>>;
};

function mediaCapabilities(context: WorkerExtensionContext): MediaCapabilities {
  return context.capabilities as MediaCapabilities;
}
function mediaStdio(context: WorkerExtensionContext): MediaStdio {
  return context.runtime.stdio as MediaStdio;
}
function detectImageMime(data: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("Unsupported image format; supported formats are PNG, JPEG, and WebP");
}
function splitJpegs(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]), cursor);
    if (start < 0) break;
    const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    frames.push(buffer.subarray(start, end + 2));
    cursor = end + 2;
  }
  return frames;
}

export const IMAGE_PROBE_DEFINITION: ToolDefinition<WorkerExtensionContext> = {
  name: "image_probe",
  title: "Image transport probe",
  description: "Return a tiny synthetic PNG as native MCP ImageContent to verify media transport.",
  inputSchema: z.object({ workspaceId: z.string().min(1).max(64) }),
  requiredCapabilities: [],
  risk: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  async execute() {
    return mcpToolResult({ content: [
      { type: "image", data: PNG_1X1_BASE64, mimeType: "image/png" },
      { type: "text", text: "QUEQIAO_MEDIA_IMAGE_PROBE_OK" },
    ] });
  },
};

export const IMAGE_READ_DEFINITION: ToolDefinition<WorkerExtensionContext> = {
  name: "image_read",
  title: "Read workspace image",
  description: "Read a bounded PNG, JPEG, or WebP from the selected Workspace and return native MCP ImageContent.",
  inputSchema: z.object({ workspaceId: z.string().min(1).max(64), path: z.string().min(1).max(4096) }),
  requiredCapabilities: ["workspace:read"],
  risk: "read",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  async execute(input, context) {
    const parsed = z.object({ workspaceId: z.string(), path: z.string() }).parse(input);
    const file = await mediaCapabilities(context).readBinaryFile(parsed.path);
    if (file.bytes > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
    const bytes = Buffer.from(file.data, "base64");
    const mimeType = detectImageMime(bytes);
    return mcpToolResult({ content: [
      { type: "image", data: file.data, mimeType },
      { type: "text", text: `QUEQIAO_MEDIA_IMAGE_OK path=${file.path} bytes=${file.bytes}` },
    ] });
  },
};

export const VIDEO_FRAMES_DEFINITION: ToolDefinition<WorkerExtensionContext> = {
  name: "video_frames",
  title: "Sample workspace video",
  description: "Sample a bounded set of JPEG frames from a Workspace video through Worker-managed ffmpeg and return them as native MCP ImageContent.",
  inputSchema: z.object({
    workspaceId: z.string().min(1).max(64),
    path: z.string().min(1).max(4096),
    intervalSeconds: z.number().int().min(1).max(60).default(5),
    maxFrames: z.number().int().min(1).max(MAX_VIDEO_FRAMES).default(MAX_VIDEO_FRAMES),
  }),
  requiredCapabilities: ["workspace:read", "workspace:exec"],
  risk: "execute",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  async execute(input, context) {
    const parsed = z.object({
      workspaceId: z.string(), path: z.string(),
      intervalSeconds: z.number().int().min(1).max(60).default(5),
      maxFrames: z.number().int().min(1).max(MAX_VIDEO_FRAMES).default(MAX_VIDEO_FRAMES),
    }).parse(input);
    const root = await context.capabilities.resolveExecutionDirectory(".");
    const candidate = path.resolve(root, parsed.path);
    const source = await context.capabilities.assertExecutionPathContained(candidate);
    const { chunks, errors, closed } = await withVideoProcessSlot(context.signal, async () => {
      const session = await mediaStdio(context).open({
        executable: "ffmpeg",
        args: [
          "-hide_banner", "-loglevel", "error", "-i", source,
          "-vf", `fps=1/${parsed.intervalSeconds},scale=640:-2:force_original_aspect_ratio=decrease`,
          "-frames:v", String(parsed.maxFrames), "-q:v", "7",
          "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
        ],
        cwd: ".",
        timeoutMs: 30_000,
        stdoutEncoding: "base64",
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const chunks: Buffer[] = [];
      const errors: string[] = [];
      while (true) {
        try {
          const event = await session.next();
          if (event.type === "stdout") chunks.push(Buffer.from(event.data, "base64"));
          else errors.push(event.data);
        } catch {
          break;
        }
      }
      const closed = await session.closed;
      return { chunks, errors, closed };
    });    const frames = splitJpegs(Buffer.concat(chunks));
    if (!frames.length) throw new Error("ffmpeg produced no decodable JPEG frames");
    return mcpToolResult({ content: [
      ...frames.map((frame) => ({ type: "image" as const, data: frame.toString("base64"), mimeType: "image/jpeg" as const })),
      { type: "text", text: `QUEQIAO_MEDIA_VIDEO_OK path=${parsed.path} frames=${frames.length} intervalSeconds=${parsed.intervalSeconds}` },
    ] });
  },
};

const extension = {
  manifest: { id: EXTENSION_ID, version: EXTENSION_VERSION, displayName: "Queqiao Media", supportedEnvironments: ["windows", "linux", "darwin"] },
  activate(api) {
    api.registerTool(IMAGE_PROBE_DEFINITION);
    api.registerTool(IMAGE_READ_DEFINITION);
    api.registerTool(VIDEO_FRAMES_DEFINITION);
  },
} satisfies QueqiaoExtension<WorkerExtensionContext>;

export default extension;
