import { readFileSync } from "node:fs";
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { IMAGE_PROBE_DEFINITION, IMAGE_READ_DEFINITION, VIDEO_FRAMES_DEFINITION } from "./index.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQ6jgDAAJGAXf1GcCGAAAAAElFTkSuQmCC";

describe("Queqiao media", () => {
  it("keeps package manifest declarations synchronized with runtime tool definitions", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as any;
    const declarations = new Map(packageJson.queqiao.manifest.contributions.map((entry: any) => [entry.tool, entry]));
    const normalize = (value: any): any => Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema").sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, normalize(entry)]))
        : value;
    for (const definition of [IMAGE_PROBE_DEFINITION, IMAGE_READ_DEFINITION, VIDEO_FRAMES_DEFINITION]) {
      const declaration = declarations.get(definition.name) as any;
      expect(declaration, `missing manifest declaration for ${definition.name}`).toBeTruthy();
      expect({
        title: declaration.title,
        description: declaration.description,
        requiredCapabilities: declaration.requiredCapabilities,
        risk: declaration.risk,
        annotations: normalize(declaration.annotations),
        inputSchema: normalize(declaration.inputSchema),
      }).toEqual({
        title: definition.title,
        description: definition.description,
        requiredCapabilities: definition.requiredCapabilities,
        risk: definition.risk,
        annotations: normalize(definition.annotations),
        inputSchema: normalize(z.toJSONSchema(definition.inputSchema, { io: "input" })),
      });
    }
  });

  it("keeps the native ImageContent transport probe", async () => {
    const result = await IMAGE_PROBE_DEFINITION.execute({ workspaceId: "test" }, { workspaceId: "test" } as never) as any;
    expect(result.kind).toBe("mcp_tool_result");
    expect(result.result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("returns a probe PNG with valid chunk checksums and a decodable RGB scanline", async () => {
    const result = await IMAGE_PROBE_DEFINITION.execute({ workspaceId: "test" }, { workspaceId: "test" } as never) as any;
    const bytes = Buffer.from(result.result.content[0].data, "base64");
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const compressed: Buffer[] = [];
    const types: string[] = [];
    let offset = 8;
    while (offset < bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const end = offset + 8 + length;
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      expect(end + 4).toBeLessThanOrEqual(bytes.length);
      expect(crc32(bytes.subarray(offset + 4, end)), `${type} CRC`).toBe(bytes.readUInt32BE(end));
      const data = bytes.subarray(offset + 8, end);
      if (type === "IHDR") {
        expect(data.readUInt32BE(0)).toBe(1);
        expect(data.readUInt32BE(4)).toBe(1);
        expect([...data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
      }
      if (type === "IDAT") compressed.push(data);
      types.push(type);
      offset = end + 4;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(inflateSync(Buffer.concat(compressed))).toEqual(Buffer.from([0, 0x22, 0x88, 0xcc]));
  });

  it("reads a real workspace image through the bounded binary capability", async () => {
    const context = { workspaceId: "test", capabilities: { readBinaryFile: async () => ({ path: "sample.png", bytes: Buffer.from(png, "base64").length, data: png }) } } as never;
    const result = await IMAGE_READ_DEFINITION.execute({ workspaceId: "test", path: "sample.png" }, context) as any;
    expect(result.result.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: png });
  });

  it("samples and splits concatenated JPEG frames from managed base64 stdout", async () => {
    const jpeg1 = Buffer.from([0xff,0xd8,1,2,0xff,0xd9]);
    const jpeg2 = Buffer.from([0xff,0xd8,3,4,0xff,0xd9]);
    const payload = Buffer.concat([jpeg1, jpeg2]);
    let next = 0;
    const session = {
      next: async () => { if (next++) throw new Error("closed"); return { type: "stdout", data: payload.toString("base64") }; },
      closed: Promise.resolve({ exitCode: 0, signal: null, durationMs: 1, timedOut: false, aborted: false, outputLimitExceeded: false }),
    };
    const context = {
      workspaceId: "test",
      capabilities: {
        resolveExecutionDirectory: async () => "C:\\workspace",
        assertExecutionPathContained: async (value: string) => value,
      },
      runtime: { stdio: { open: async (request: any) => { expect(request.stdoutEncoding).toBe("base64"); return session; } } },
    } as never;
    const result = await VIDEO_FRAMES_DEFINITION.execute({ workspaceId: "test", path: "sample.mp4", intervalSeconds: 5, maxFrames: 2 }, context) as any;
    expect(result.result.content.filter((item: any) => item.type === "image")).toHaveLength(2);
    expect(result.result.content[0].data).toBe(jpeg1.toString("base64"));
  });

  it("limits concurrent ffmpeg video sampling to two processes per Worker", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    let opened = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];

    const context = {
      workspaceId: "test",
      capabilities: {
        resolveExecutionDirectory: async () => "C:\\workspace",
        assertExecutionPathContained: async (value: string) => value,
      },
      runtime: {
        stdio: {
          open: async () => {
            opened += 1;
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            let release!: () => void;
            const released = new Promise<void>((resolve) => { release = resolve; });
            releases.push(release);
            let emitted = false;
            return {
              next: async () => {
                await released;
                if (emitted) throw new Error("closed");
                emitted = true;
                return { type: "stdout", data: jpeg.toString("base64") };
              },
              closed: released.then(() => {
                inFlight -= 1;
                return { exitCode: 0, signal: null, durationMs: 1, timedOut: false, aborted: false, outputLimitExceeded: false };
              }),
            };
          },
        },
      },
    } as never;

    const input = { workspaceId: "test", path: "sample.mp4", intervalSeconds: 5, maxFrames: 1 };
    const calls = [1, 2, 3].map(() => VIDEO_FRAMES_DEFINITION.execute(input, context));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(opened).toBe(2);
    expect(maxInFlight).toBe(2);

    releases[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toBe(3);

    releases[1]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases[2]!();
    await Promise.all(calls);
    expect(maxInFlight).toBe(2);
  });
});
