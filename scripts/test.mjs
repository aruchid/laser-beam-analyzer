import { spawnSync } from "node:child_process";
const binary =
  process.platform === "win32"
    ? "build/Release/beam-tests.exe"
    : "./build/beam-tests";
for (const [bin, args] of [
  [process.execPath, ["scripts/build.mjs"]],
  [binary, []],
  [process.execPath, ["--test", "tests/transport.test.mjs"]],
]) {
  const r = spawnSync(bin, args, { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status) process.exit(r.status);
}
