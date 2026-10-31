import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../desktop/server.mjs";
test("C++ shared frame, concurrent snapshots, validation and caustic fit", async () => {
  const app = await startServer();
  try {
    const post = (path, data, origin) =>
      fetch(app.url + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify(data),
      });
    const frames = await Promise.all([
      post("/api/frame", { sigmaX: 25, sigmaY: 14 }),
      post("/api/frame", { sigmaX: 30, sigmaY: 10 }),
    ]);
    for (let i = 0; i < frames.length; i++) {
      assert.equal(frames[i].status, 200);
      const metadata = JSON.parse(frames[i].headers.get("X-Beam-Metadata")),
        buffer = await frames[i].arrayBuffer(),
        view = new DataView(buffer);
      assert.equal(view.getUint32(8, true), metadata.sequence);
      assert.equal(buffer.byteLength, 32 + 384 * 288 * 4);
      assert.ok(Math.abs(metadata.major_px - (i ? 120 : 100)) < 0.01);
      assert.ok(Math.abs(metadata.minor_px - (i ? 40 : 56)) < 0.01);
    }
    assert.equal((await post("/api/frame", { sigmaX: -1 })).status, 400);
    assert.equal((await post("/api/frame", { subtract: 1200 })).status, 400);
    assert.equal(
      (await post("/api/frame", {}, "https://example.com")).status,
      403,
    );
    const samples = Array.from({ length: 25 }, (_, i) => {
      const z = -0.5 + i / 24,
        w = Math.hypot(
          0.00025,
          ((1.4 * 1064e-9) / (Math.PI * 0.00025)) * (z - 0.03),
        );
      return [z * 1000, w * 1e6];
    });
    const response = await post("/api/fit", { samples, wavelength_nm: 1064 });
    assert.equal(response.status, 200);
    const fit = await response.json();
    assert.ok(Math.abs(fit.M2 - 1.4) < 1e-8);
    assert.ok(Math.abs(fit.waist_position_m - 0.03) < 1e-9);
    assert.equal(
      (
        await post("/api/fit", {
          samples: Array(5).fill([0, 250]),
          wavelength_nm: 1064,
        })
      ).status,
      400,
    );
    assert.equal(
      (await post("/api/frame", {})).status,
      200,
      "worker survives rejected input",
    );
  } finally {
    await app.close();
  }
});

test("16-bit PGM measurement, dark frame, ROI, saturation gating and invalid file recovery", async () => {
  const app = await startServer();
  try {
    const w = 96,
      h = 80;
    function pgm(background = 100, saturated = false) {
      const header = Buffer.from(`P5\n${w} ${h}\n65535\n`),
        payload = Buffer.alloc(w * h * 2);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const signal =
            background === 100
              ? Math.round(
                  20000 *
                    Math.exp(-0.5 * ((x - 48) ** 2 / 64 + (y - 40) ** 2 / 36)),
                )
              : 0;
          payload.writeUInt16BE(
            saturated && x === 48 && y === 40 ? 65535 : background + signal,
            (y * w + x) * 2,
          );
        }
      return Buffer.concat([header, payload]);
    }
    const upload = (path, data, mode = 1) =>
      fetch(
        app.url +
          path +
          "?configuration=" +
          encodeURIComponent(JSON.stringify({ mode, pitch: 5.5 })),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: data,
        },
      );
    let response = await upload("/api/image", pgm());
    assert.equal(response.status, 200);
    let metadata = JSON.parse(response.headers.get("X-Beam-Metadata"));
    assert.equal(metadata.width, w);
    assert.equal(metadata.source, "file");
    assert.equal(metadata.accepted, true);
    assert.ok(Math.abs(metadata.major_px - 32) < 0.1);
    assert.equal(metadata.source_record.sha256.length, 64);
    assert.equal((await response.arrayBuffer()).byteLength, 32 + w * h * 4);
    response = await upload("/api/dark", pgm(1000), 2);
    assert.equal(response.status, 200);
    metadata = JSON.parse(response.headers.get("X-Beam-Metadata"));
    assert.equal(metadata.has_dark, true);
    assert.equal(
      metadata.valid,
      false,
      "bad dark calibration cannot fabricate valid moments",
    );
    response = await upload("/api/image", pgm(100, true));
    assert.equal(response.status, 200);
    metadata = JSON.parse(response.headers.get("X-Beam-Metadata"));
    assert.equal(metadata.accepted, false);
    assert.ok(metadata.saturation_fraction > 0);
    assert.equal(metadata.has_dark, false, "new source invalidates dark");
    assert.equal(
      (await upload("/api/image", Buffer.from("P5\n96 80\n65535\n"))).status,
      400,
    );
    response = await fetch(app.url + "/api/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roi: [90, 70, 20, 20] }),
    });
    assert.equal(response.status, 400);
    response = await upload("/api/image", pgm());
    assert.equal(response.status, 200, "worker survives malformed PGM");
    metadata = JSON.parse(response.headers.get("X-Beam-Metadata"));
    const exported = await fetch(app.url + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: "beamlab.session/0.2",
        measurement: metadata,
        statistics: [],
        scan: [],
      }),
    });
    assert.equal(exported.status, 200);
    const zip = Buffer.from(await exported.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from("manifest.json")));
    assert.ok(
      zip.includes(Buffer.from(`raw/${metadata.source_record.sha256}.pgm`)),
    );
    assert.ok(
      zip.includes(pgm()),
      "raw 16-bit bytes included without normalization",
    );
  } finally {
    await app.close();
  }
});

test("startup failure releases worker resources and leaves existing service available", async () => {
  const app = await startServer();
  try {
    await assert.rejects(startServer(app.server.address().port), /EADDRINUSE/);
    assert.equal((await fetch(app.url + "/api/health")).status, 200);
  } finally {
    await app.close();
  }
});
