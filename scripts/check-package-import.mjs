import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(os.tmpdir(), "queqiao-media-package-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is required");
const runNpm = (args, options = {}) => execFileSync(process.execPath, [npmCli, ...args], options);

try {
  const pack = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  const tarball = path.join(temp, pack[0].filename);
  writeFileSync(path.join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
  runNpm(["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: temp, stdio: "pipe" });
  const probe = "const m=await import('@tibame201020/queqiao-media'); if(m.default?.manifest?.id!=='dev.queqiao.media') process.exit(2); console.log(m.default.manifest.version);";
  execFileSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: temp, stdio: "inherit" });
} finally {
  rmSync(temp, { recursive: true, force: true });
}