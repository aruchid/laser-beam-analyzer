import http from "node:http";
import { zip } from "./session-archive.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export async function startServer(port = 0) {
  const binary =
    process.platform === "win32"
      ? ["build/Release/beam-worker.exe", "build/beam-worker.exe"]
          .map((p) => join(root, p))
          .find(existsSync)
      : join(root, "build/beam-worker");
  if (!binary || !existsSync(binary)) throw Error("Build the C++ worker first");
  const directory = await mkdtemp(join(tmpdir(), "beam-workbench-"));
  const path = join(directory, "frame.map");
  const file = await open(path, "wx+", 0o600);
  const staging = join(directory, "input.pgm");
  const worker = spawn(binary, [path, staging], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const workerClosed = new Promise((resolve) => worker.once("close", resolve));
  let waiter = null,
    dead = false,
    closing = false,
    depth = 0,
    tail = Promise.resolve(),
    stderr = "";
  const fail = (error) => {
    dead = true;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      waiter = null;
    }
  };
  worker.stdin.on("error", fail);
  worker.on("error", fail);
  worker.on("exit", () =>
    fail(Error(`C++ worker stopped ${stderr.slice(-200)}`)),
  );
  worker.stderr.on("data", (b) => (stderr += b.toString()));
  createInterface({ input: worker.stdout }).on("line", (line) => {
    if (!waiter) return;
    const current = waiter;
    waiter = null;
    clearTimeout(current.timer);
    try {
      const result = JSON.parse(line);
      if (!result.ok) current.reject(Error(result.error));
      else current.resolve(result);
    } catch (error) {
      current.reject(error);
    }
  });
  function command(line) {
    return new Promise((resolve, reject) => {
      if (dead) return reject(Error("C++ worker unavailable"));
      const timer = setTimeout(() => {
        fail(Error("C++ worker timed out"));
        worker.kill();
      }, 5000);
      waiter = { resolve, reject, timer };
      worker.stdin.write(line + "\n", (error) => {
        if (error) fail(error);
      });
    });
  }
  // The entire command + snapshot is serialized. The producer stays idle until the copy finishes.
  function serial(action) {
    if (depth >= 8) throw Error("Request queue full");
    depth++;
    const result = tail.then(action);
    tail = result.catch(() => {}).finally(() => depth--);
    return result;
  }
  async function snapshot(metadata) {
    async function readAt(buffer, position) {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          offset,
          buffer.length - offset,
          position + offset,
        );
        if (!bytesRead) throw Error("Incomplete frame");
        offset += bytesRead;
      }
    }
    const header = Buffer.alloc(32);
    await readAt(header, 0);
    const width = header.readUInt32LE(12),
      height = header.readUInt32LE(16),
      payload = header.readUInt32LE(28);
    if (
      header.readUInt32LE(0) !== 0x314d4142 ||
      header.readUInt32LE(4) !== 1 ||
      header.readUInt32LE(8) !== metadata.sequence ||
      width !== metadata.width ||
      height !== metadata.height ||
      width < 1 ||
      height < 1 ||
      width > 2048 ||
      height > 2048 ||
      header.readUInt32LE(20) !== width * 4 ||
      header.readUInt32LE(24) !== 1 ||
      payload !== width * height * 4
    )
      throw Error("Invalid shared frame");
    const bytes = Buffer.alloc(32 + payload);
    header.copy(bytes);
    await readAt(bytes.subarray(32), 32);
    return bytes;
  }
  let sourceRecord = null,
    darkRecord = null;
  const archive = new Map();
  let archiveBytes = 0;
  function measureConfig(body) {
    const roi = body.roi ?? [0, 0, 0, 0],
      mode = body.mode ?? 1,
      pitch = body.pitch ?? 5.5;
    if (
      !Array.isArray(roi) ||
      roi.length !== 4 ||
      roi.some((v) => !Number.isInteger(v) || v < 0 || v > 2048) ||
      ![0, 1, 2].includes(mode) ||
      typeof pitch !== "number" ||
      !Number.isFinite(pitch) ||
      pitch <= 0 ||
      pitch > 100
    )
      throw Error("Invalid measurement settings");
    return { roi, mode, pitch };
  }
  function frameResponse(res, metadata, bytes) {
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Beam-Metadata", JSON.stringify(metadata));
    res.end(bytes);
  }
  const settings = {
    sigmaX: [2, 65, 25],
    sigmaY: [2, 65, 14],
    angle: [-180, 180, 23],
    background: [0, 200, 3],
    subtract: [0, 1200, 3],
    cx: [0, 383, 191.5],
    cy: [0, 287, 143.5],
    pitch: [0.01, 100, 5.5],
  };
  function validateFrame(body) {
    const result = {};
    for (const [key, [min, max, fallback]] of Object.entries(settings)) {
      const v = body[key] ?? fallback;
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
        throw Error(`Invalid ${key}: expected ${min}..${max}`);
      result[key] = v;
    }
    return result;
  }
  async function bodyJSON(req, limit = 65536) {
    let chunks = [],
      length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) throw Error("Request body too large");
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw Error("Expected JSON object");
    return data;
  }
  const assets = new Map([
    ["/", "index.html"],
    ["/app.js", "app.js"],
    ["/style.css", "style.css"],
    ...["/measurement", "/surface", "/statistics", "/scan", "/events"].map(
      (path) => [path, "index.html"],
    ),
    ["/surface.js", "surface.js"],
    ["/caustic.js", "caustic.js"],
    ["/vendor/three.module.js", "../node_modules/three/build/three.module.js"],
    ["/vendor/three.core.js", "../node_modules/three/build/three.core.js"],
    [
      "/vendor/OrbitControls.js",
      "../node_modules/three/examples/jsm/controls/OrbitControls.js",
    ],
  ]);
  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address(),
        host = `127.0.0.1:${address.port}`,
        origin = `http://${host}`;
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
      );
      if (
        req.headers.host !== host ||
        (req.headers.origin && req.headers.origin !== origin)
      ) {
        res.writeHead(403);
        return res.end("Origin rejected");
      }
      const url = new URL(req.url, origin);
      if (req.method === "GET" && assets.has(url.pathname)) {
        const name = assets.get(url.pathname);
        res.setHeader(
          "Content-Type",
          name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : name.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        );
        const contents = await readFile(join(root, "web", name));
        return res.end(
          name.endsWith("OrbitControls.js")
            ? contents
                .toString()
                .replace(/from 'three'/g, 'from "/vendor/three.module.js"')
            : contents,
        );
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            ok: !dead,
            protocol: 1,
            transport: "MAP_SHARED + acknowledged snapshot",
            source: sourceRecord ? "file" : "disconnected",
            camera_connected: false,
            platform: process.platform,
          }),
        );
      }
      if (req.method === "POST" && url.pathname === "/api/session") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          throw Error("Expected application/json");
        const manifest = await bodyJSON(req, 4 * 1024 * 1024);
        if (
          manifest.schema !== "beamlab.session/0.2" ||
          !manifest.measurement?.source_record
        )
          throw Error("Invalid session manifest");
        const references = new Set(
          [
            ...archive.keys(),
            manifest.measurement.source_record.sha256,
            manifest.measurement.dark_record?.sha256,
            ...(manifest.statistics || []).map((r) => r.sha256),
            ...(manifest.scan || []).map((r) => r.sha256),
          ].filter(Boolean),
        );
        for (const hash of references)
          if (!archive.has(hash))
            throw Error("Referenced source not available in this session");
        const bytes = await serial(async () => {
          const entries = [
            [
              "manifest.json",
              Buffer.from(
                JSON.stringify(
                  {
                    ...manifest,
                    raw_files: [...references].map((hash) => `raw/${hash}.pgm`),
                  },
                  null,
                  2,
                ),
              ),
            ],
          ];
          for (const hash of references)
            entries.push([
              `raw/${hash}.pgm`,
              await readFile(archive.get(hash)),
            ]);
          return zip(entries);
        });
        res.setHeader("Content-Type", "application/zip");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="beam-session.zip"',
        );
        return res.end(bytes);
      }
      if (
        req.method === "POST" &&
        ["/api/image", "/api/dark", "/api/measure"].includes(url.pathname)
      ) {
        const importing = url.pathname !== "/api/measure";
        let data, configuration;
        if (importing) {
          if (req.headers["content-type"] !== "application/octet-stream")
            throw Error("Expected binary PGM upload");
          const parts = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 9 * 1024 * 1024) throw Error("Image exceeds 9 MiB");
            parts.push(chunk);
          }
          data = Buffer.concat(parts);
          configuration = measureConfig(
            JSON.parse(url.searchParams.get("configuration") || "{}"),
          );
        } else {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw Error("Expected application/json");
          configuration = measureConfig(await bodyJSON(req));
        }
        const response = await serial(async () => {
          const commandName =
            url.pathname === "/api/image"
              ? "IMPORT"
              : url.pathname === "/api/dark"
                ? "DARK"
                : "MEASURE";
          const digest = importing
            ? createHash("sha256").update(data).digest("hex")
            : null;
          if (
            importing &&
            !archive.has(digest) &&
            (archiveBytes + data.length > 64 * 1024 * 1024 ||
              archive.size >= 256)
          )
            throw Error(
              "Session archive limit reached; export and restart to begin a new session",
            );
          if (importing) await writeFile(staging, data, { mode: 0o600 });
          const metadata = await command(
            `${commandName} ${configuration.roi.join(" ")} ${configuration.mode} ${configuration.pitch}`,
          );
          if (importing) {
            const record = { sha256: digest, bytes: data.length };
            if (!archive.has(digest)) {
              const archivePath = join(directory, `raw-${digest}.pgm`);
              await writeFile(archivePath, data, { mode: 0o600 });
              archive.set(digest, archivePath);
              archiveBytes += data.length;
            }
            if (commandName === "IMPORT") {
              sourceRecord = record;
              darkRecord = null;
            } else darkRecord = record;
          }
          metadata.source_record = sourceRecord;
          metadata.dark_record = darkRecord;
          metadata.configuration = configuration;
          metadata.timestamp = new Date().toISOString();
          metadata.version = "0.2.0";
          return { metadata, bytes: await snapshot(metadata) };
        });
        return frameResponse(res, response.metadata, response.bytes);
      }
      if (
        req.method !== "POST" ||
        !["/api/frame", "/api/fit"].includes(url.pathname)
      ) {
        res.writeHead(404);
        return res.end("Not found");
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw Error("Expected application/json");
      const body = await bodyJSON(req);
      if (url.pathname === "/api/frame") {
        const configuration = validateFrame(body);
        const { metadata, bytes } = await serial(async () => {
          const metadata = await command(
            "FRAME " + Object.values(configuration).join(" "),
          );
          return { metadata, bytes: await snapshot(metadata) };
        });
        metadata.configuration = configuration;
        metadata.timestamp = new Date().toISOString();
        metadata.version = "0.1.0";
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Beam-Metadata", JSON.stringify(metadata));
        return res.end(bytes);
      }
      const { samples, wavelength_nm: wavelength } = body;
      if (
        typeof wavelength !== "number" ||
        !Number.isFinite(wavelength) ||
        wavelength < 100 ||
        wavelength > 20000 ||
        !Array.isArray(samples) ||
        samples.length < 5 ||
        samples.length > 512
      )
        throw Error("Need 5..512 samples and wavelength 100..20000 nm");
      for (const row of samples)
        if (
          !Array.isArray(row) ||
          row.length !== 2 ||
          row.some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
          Math.abs(row[0]) > 1e6 ||
          row[1] <= 0 ||
          row[1] > 1e6
        )
          throw Error("Samples must be [z_mm, radius_um]");
      const result = await serial(() =>
        command(
          `FIT ${wavelength * 1e-9} ${samples.length} ` +
            samples.map(([z, w]) => `${z * 0.001} ${w * 1e-6}`).join(" "),
        ),
      );
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          ...result,
          samples,
          wavelength_nm: wavelength,
          version: "0.2.0",
        }),
      );
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(dead ? 503 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      } else res.destroy();
    }
  });
  async function close() {
    if (closing) return;
    closing = true;
    const stopped = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await stopped;
    worker.kill();
    await workerClosed;
    await tail;
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return { server, url: `http://127.0.0.1:${server.address().port}`, close };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await startServer(Number(process.env.PORT || 4318));
  console.log(`BeamLab: ${app.url}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      app.close().finally(() => process.exit());
    });
}
