import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
mkdirSync(`${root}/build`, { recursive: true });
function run(bin, args) {
  const r = spawnSync(bin, args, { cwd: root, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status) process.exit(r.status);
}
if (process.platform === "win32") {
  run("cmake", ["-S", ".", "-B", "build", "-A", "x64"]);
  run("cmake", ["--build", "build", "--config", "Release"]);
} else
  for (const [source, name] of [
    ["native/src/worker.cpp", "beam-worker"],
    ["native/tests/core.cpp", "beam-tests"],
  ])
    run(process.env.CXX || "c++", [
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wpedantic",
      "-I",
      "native/include",
      source,
      "-o",
      `build/${name}`,
    ]);
