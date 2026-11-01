import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCausticCSV,
  predictedRadius,
  axisDiagnostics,
  chartSVG,
  resultsCSV,
  reportDocument,
} from "../web/caustic.js";
import { startServer } from "../desktop/server.mjs";
const lambda = 1064e-9;
const model = (m2, w0, z0) => ({
  M2: m2,
  waist_radius_m: w0,
  waist_position_m: z0,
  divergence_rad: (m2 * lambda) / (Math.PI * w0),
  version: "test",
});
const x = model(1.4, 0.00025, 0.03),
  y = model(1.8, 0.00031, -0.04);
const samples = Array.from({ length: 25 }, (_, i) => {
  const z = -600 + i * 50;
  return {
    z_mm: z,
    wx_um: predictedRadius(x, z),
    wy_um: predictedRadius(y, z),
    included: true,
    note: "",
    source: "external_csv",
    csv_sha256: "a".repeat(64),
  };
});
test("CSV validates units, duplicates and exclusions while preserving quoted notes", () => {
  const parsed = parseCausticCSV(
    '\uFEFFz_mm,wx_um,wy_um,included,note\r\n-1,20,30,0,"bad, sample"\r\n1,30,40,1,"say ""ok"""',
  );
  assert.equal(parsed[0].included, false);
  assert.equal(parsed[0].note, "bad, sample");
  assert.equal(parsed[1].note, 'say "ok"');
  for (const bad of [
    "z_m,wx_um,wy_um\n1,2,3",
    "z_mm,wx_um,wy_um\n1,2,3\n1,4,5",
    "z_mm,wx_um,wy_um\n1,,3",
    "z_mm,wx_um,wy_um\n1,0,3",
    "z_mm,wx_um,wy_um\n1,Infinity,3",
    "z_mm,wx_um,wy_um,included\n1,2,3,2",
  ])
    assert.throws(() => parseCausticCSV(bad));
});
test("residual units, radius R2 and coverage diagnostics agree with analytic caustic", () => {
  const result = axisDiagnostics(x, samples, "wx_um");
  assert.ok(result.rmse_um < 1e-9);
  assert.equal(result.r2, 1);
  assert.ok(
    Math.abs(result.bpp_mm_mrad - ((1.4 * 1064e-9) / Math.PI) * 1e6) < 1e-12,
  );
  assert.ok(
    result.left > 0 && result.right > 0 && result.near > 0 && result.far > 0,
  );
  const changed = structuredClone(samples);
  changed[0].wx_um += 7;
  changed[1].included = false;
  const d = axisDiagnostics(x, changed, "wx_um");
  assert.equal(d.count, 24);
  assert.ok(Math.abs(d.max_abs_um - 7) < 1e-10);
  assert.ok(Math.abs(d.rmse_um - 7 / Math.sqrt(24)) < 1e-10);
  assert.ok(
    axisDiagnostics(
      x,
      samples.filter((s) => s.z_mm >= 100),
      "wx_um",
    ).warnings.some((v) => v.includes("外推")),
  );
});
test("report preserves excluded samples, escapes metadata and exports reproducible values", () => {
  const all = structuredClone(samples);
  all[0].included = false;
  all[0].note = "<script>alert(1)</script>";
  const fit = {
    x,
    y,
    all_samples: all,
    wavelength_nm: 1064,
    fit_time: "2026-10-31T15:00:00Z",
    report_id: "qa-run",
  };
  const report = reportDocument(
    fit,
    { 操作员: "<img src=x onerror=alert(1)>" },
    ["<b>event</b>"],
  );
  assert.ok(report.html.includes("M²"));
  assert.ok(report.html.includes("排除"));
  assert.ok(report.html.includes("&lt;script&gt;"));
  assert.ok(!report.html.includes("<script>"));
  assert.ok(!report.html.includes("<img src=x"));
  assert.ok(report.html.includes("未评估"));
  assert.ok(report.html.includes("qa-run"));
  assert.ok(chartSVG(all, fit, true).includes("实测"));
  assert.equal(resultsCSV(all, fit).split("\r\n").length, 26);
});
test("both native axes recover independent waist and M2; signed residuals match native RMSE", async () => {
  const app = await startServer();
  try {
    for (const [key, reference] of [
      ["wx_um", x],
      ["wy_um", y],
    ]) {
      const data = samples.map((s, i) => [
        s.z_mm,
        s[key] + Math.sin(i * 1.3) * 0.03,
      ]);
      const response = await fetch(app.url + "/api/fit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wavelength_nm: 1064, samples: data }),
      });
      assert.equal(response.status, 200);
      const axis = await response.json();
      assert.ok(Math.abs(axis.M2 - reference.M2) < 0.001);
      const diagnostic = axisDiagnostics(
        axis,
        data.map(([z, w]) => ({ z_mm: z, [key]: w })),
        key,
      );
      assert.ok(Math.abs(diagnostic.rmse_um - axis.radius_rmse_m * 1e6) < 1e-8);
    }
  } finally {
    await app.close();
  }
});
