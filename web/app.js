const $ = (id) => document.getElementById(id);
let frame = null,
  pixels = null,
  sourceName = "",
  darkName = "",
  fitGeneration = 0,
  epoch = 0,
  stale = false,
  busy = false,
  records = [],
  scan = [],
  fitResult = null;
const offscreen = document.createElement("canvas");
const rows = [
  ["dx_px", "X 方向 D4σ", "px"],
  ["dy_px", "Y 方向 D4σ", "px"],
  ["major_px", "主轴长径 D4σ", "px"],
  ["minor_px", "主轴短径 D4σ", "px"],
  ["cx", "质心 X", "px"],
  ["cy", "质心 Y", "px"],
  ["angle_deg", "主轴方向", "°"],
  ["ellipticity", "椭圆率", "—"],
  ["major_um", "主轴长径", "μm"],
  ["minor_um", "主轴短径", "μm"],
  ["peak", "校正峰值", "DN"],
  ["signal", "积分信号", "DN·px"],
];
function log(message) {
  const item = document.createElement("li");
  item.textContent = new Date().toLocaleTimeString() + "  " + message;
  $("events").prepend(item);
  while ($("events").children.length > 100) $("events").lastChild.remove();
}
function error(message) {
  $("error").hidden = !message;
  $("error").textContent = message;
  if (message) log("ERROR " + message);
}
function number(id, min, max) {
  const text = $(id).value,
    value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value < min || value > max)
    throw Error(`参数 ${id} 超出允许范围`);
  return value;
}
function settings() {
  const calibration = {
    pitch: number("pitch", 0.01, 100),
    magnification: number("magnification", 0.01, 100),
    confirmed: $("calibrated").checked,
  };
  const pitch = calibration.pitch / calibration.magnification;
  if (pitch > 100 || pitch <= 0)
    throw Error("当前有效像元尺寸超出 0..100 μm/px");
  const roi = ["x", "y", "w", "h"].map((k) => number("roi-" + k, 0, 2048));
  if (roi.some((v) => !Number.isInteger(v))) throw Error("ROI 必须是整数像素");
  return { roi, mode: Number($("correction").value), pitch, calibration };
}
function eligible() {
  return !!frame?.accepted && !stale && !busy;
}
function buttons() {
  $("record").disabled = !eligible();
  $("append-z").disabled = !eligible() || !frame.calibration?.confirmed;
  $("export").disabled = !frame || stale || busy;
  $("report").disabled = !frame || stale || busy;
  $("fit").disabled = scan.length < 5 || busy;
}
function changed() {
  epoch++;
  stale = !!frame;
  $("validity").className = "status warn";
  $("validity").textContent = frame ? "SETTINGS CHANGED" : "NO DATA";
  $("cal-status").textContent = $("calibrated").checked
    ? "标定声明已确认；需要重新测量后生效。"
    : "未确认标定，物理尺寸与 M² 记录不可用。";
  buttons();
}
for (const id of [
  "pitch",
  "magnification",
  "calibrated",
  "roi-x",
  "roi-y",
  "roi-w",
  "roi-h",
  "correction",
])
  $(id).addEventListener("change", changed);
function metrics() {
  if (!frame) return {};
  return {
    ...frame,
    cx: frame.centroid_px[0],
    cy: frame.centroid_px[1],
    ellipticity: frame.major_px ? frame.minor_px / frame.major_px : null,
    major_um: frame.calibration.confirmed
      ? frame.major_px * frame.pitch_um
      : null,
    minor_um: frame.calibration.confirmed
      ? frame.minor_px * frame.pitch_um
      : null,
  };
}
function renderResults() {
  const m = metrics(),
    tbody = $("results");
  tbody.replaceChildren();
  for (const [key, name, unit] of rows) {
    const row = document.createElement("tr");
    for (const text of [
      name,
      m[key] === undefined ||
      m[key] === null ||
      (!frame.valid && !["peak", "signal"].includes(key))
        ? "—"
        : Number(m[key]).toLocaleString("en-US", {
            maximumFractionDigits: key === "signal" ? 0 : 3,
          }),
      unit,
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      row.append(td);
    }
    tbody.append(row);
  }
}
function quality() {
  const entries = [
    ["数值解", frame.valid, frame.valid ? "有效" : frame.error],
    [
      "灰度饱和",
      frame.saturation_fraction === 0,
      (frame.saturation_fraction * 100).toFixed(3) + " %",
    ],
    [
      "ROI 边缘能量",
      frame.edge_fraction < 0.02,
      (frame.edge_fraction * 100).toFixed(2) + " % / 门限 2%",
    ],
    [
      "峰值 / 边界噪声",
      frame.noise < 1e-12 || frame.snr >= 10,
      frame.noise < 1e-12
        ? "噪声低于分辨限"
        : frame.snr.toFixed(1) + " / 门限 10",
    ],
    [
      "背景校正",
      frame.correction !== 0,
      ["未执行", "边界均值", "暗场矩阵"][frame.correction],
    ],
    [
      "空间标定",
      frame.calibration.confirmed,
      frame.calibration.confirmed ? "用户确认" : "未确认，仅像素结果",
    ],
  ];
  const list = $("quality");
  list.replaceChildren();
  for (const [label, ok, value] of entries) {
    const li = document.createElement("li"),
      a = document.createElement("span"),
      b = document.createElement("span");
    a.textContent = label;
    b.textContent = value;
    b.className = ok ? "q-good" : "q-warn";
    li.append(a, b);
    list.append(li);
  }
  $("validity").textContent = stale
    ? "SETTINGS CHANGED"
    : frame.accepted
      ? "ACCEPTED / 像素门限通过"
      : "REJECTED / 待检查";
  $("validity").className =
    "status " + (stale ? "warn" : frame.accepted ? "good" : "bad");
}
function linePlot(id, values) {
  const canvas = $(id),
    ctx = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "#dce4ec";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    ctx.beginPath();
    ctx.moveTo(30, (h * i) / 5);
    ctx.lineTo(w - 10, (h * i) / 5);
    ctx.stroke();
  }
  if (!values.length) return;
  let lo = Math.min(0, ...values),
    hi = Math.max(...values);
  if (hi === lo) hi = lo + 1;
  ctx.strokeStyle = "#2675b8";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = 30 + (i / Math.max(1, values.length - 1)) * (w - 45),
      y = h - 20 - ((v - lo) / (hi - lo)) * (h - 35);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#7e92a6";
  ctx.font = "10px sans-serif";
  ctx.fillText(hi.toPrecision(3), 1, 12);
  ctx.fillText(lo.toPrecision(2), 1, h - 5);
}
function draw() {
  if (!frame || !pixels) return;
  const w = frame.width,
    h = frame.height;
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext("2d"),
    im = ctx.createImageData(w, h);
  let peak = 0;
  for (const v of pixels) peak = Math.max(peak, v);
  peak = Math.max(peak, 1);
  const px = new Float64Array(frame.roi[2]),
    py = new Float64Array(frame.roi[3]),
    [rx, ry, rw, rh] = frame.roi;
  for (let i = 0; i < pixels.length; i++) {
    const x = i % w,
      y = Math.floor(i / w),
      signal = pixels[i];
    let t = Math.max(0, signal) / peak;
    if ($("scale").value === "log") t = Math.log1p(t * 999) / Math.log(1000);
    t = Math.min(1, t);
    const k = i * 4;
    if ($("palette").value === "gray")
      im.data[k] = im.data[k + 1] = im.data[k + 2] = t * 255;
    else {
      im.data[k] = 255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 3)));
      im.data[k + 1] =
        255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 2)));
      im.data[k + 2] =
        255 * Math.max(0, Math.min(1, 1.5 - Math.abs(4 * t - 1)));
    }
    im.data[k + 3] = 255;
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) {
      px[x - rx] += signal;
      py[y - ry] += signal;
    }
  }
  ctx.putImageData(im, 0, 0);
  const canvas = $("beam");
  canvas.width = w;
  canvas.height = h;
  const view = canvas.getContext("2d");
  view.drawImage(offscreen, 0, 0);
  if ($("ellipse").checked) {
    view.strokeStyle = "#fff";
    view.lineWidth = Math.max(0.7, w / 800);
    view.setLineDash([w / 100, w / 140]);
    view.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
    if (frame.valid) {
      const [cx, cy] = frame.centroid_px;
      view.setLineDash([]);
      view.beginPath();
      view.ellipse(
        cx,
        cy,
        frame.major_px / 2,
        frame.minor_px / 2,
        (frame.angle_deg * Math.PI) / 180,
        0,
        Math.PI * 2,
      );
      view.stroke();
      view.beginPath();
      const d = Math.max(3, w / 80);
      view.moveTo(cx - d, cy);
      view.lineTo(cx + d, cy);
      view.moveTo(cx, cy - d);
      view.lineTo(cx, cy + d);
      view.stroke();
    }
  }
  linePlot("profile-x", px);
  linePlot("profile-y", py);
}
for (const id of ["scale", "palette", "ellipse"])
  $(id).addEventListener("change", draw);
$("beam").addEventListener("pointermove", (event) => {
  if (!frame) return;
  const r = $("beam").getBoundingClientRect(),
    scale = Math.min(r.width / frame.width, r.height / frame.height),
    ox = (r.width - frame.width * scale) / 2,
    oy = (r.height - frame.height * scale) / 2,
    x = Math.floor((event.clientX - r.left - ox) / scale),
    y = Math.floor((event.clientY - r.top - oy) / scale);
  if (x >= 0 && x < frame.width && y >= 0 && y < frame.height)
    $("cursor").textContent =
      `X ${x} px  /  Y ${y} px  /  ${pixels[y * frame.width + x].toFixed(2)} DN`;
});
async function receive(response, configuration, requestEpoch) {
  if (!response.ok) {
    const data = await response.json();
    throw Error(data.error || "C++ 请求失败");
  }
  const metadata = JSON.parse(response.headers.get("X-Beam-Metadata")),
    bytes = await response.arrayBuffer(),
    header = new DataView(bytes);
  if (
    header.getUint32(0, true) !== 0x314d4142 ||
    header.getUint32(8, true) !== metadata.sequence ||
    bytes.byteLength !== 32 + metadata.width * metadata.height * 4
  )
    throw Error("帧快照校验失败");
  frame = {
    ...metadata,
    calibration: configuration.calibration,
    filename: sourceName,
    dark_filename: darkName,
  };
  pixels = new Float32Array(bytes, 32);
  stale = requestEpoch !== epoch;
  $("empty").hidden = true;
  $("source-state").textContent = "● 离线图像";
  $("source-info").textContent = sourceName;
  $("dimensions").textContent = `${frame.width} × ${frame.height} px`;
  $("format").textContent = `PGM / maxval ${frame.maxval}`;
  $("image-caption").textContent =
    `${frame.width} × ${frame.height} · ${$("scale").value === "log" ? "LOG" : "LINEAR"}`;
  $("filename").textContent = sourceName;
  $("dark-name").textContent = frame.has_dark ? darkName : "未载入";
  $("sequence").textContent = "#" + frame.sequence;
  $("received").textContent = new Date(frame.timestamp).toLocaleString();
  $("hash").textContent = "SHA-256: " + frame.source_record.sha256;
  $("compute").textContent = `C++ ${frame.compute_ms.toFixed(2)} ms`;
  $("footer-state").textContent =
    `相机 / 位移台未连接 · 文件测量 · 标定${frame.calibration.confirmed ? "用户确认" : "未确认"}`;
  draw();
  renderResults();
  quality();
  log(
    `帧 #${frame.sequence} ${frame.width}×${frame.height} ${frame.accepted ? "门限通过" : "未通过"}，校正模式 ${frame.correction}`,
  );
}
async function processFrame(endpoint, file) {
  if (busy) return;
  busy = true;
  buttons();
  const oldName = sourceName,
    oldDark = darkName;
  try {
    const configuration = settings(),
      version = epoch;
    let response;
    if (file) {
      if (file.size > 9 * 1024 * 1024) throw Error("PGM 文件不能超过 9 MiB");
      if (endpoint === "/api/image") {
        configuration.mode = configuration.mode === 2 ? 1 : configuration.mode;
        sourceName = file.name;
        darkName = "";
        $("correction").value = configuration.mode;
      } else {
        configuration.mode = 2;
        darkName = file.name;
        $("correction").value = 2;
      }
      response = await fetch(
        endpoint +
          "?configuration=" +
          encodeURIComponent(JSON.stringify(configuration)),
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
    } else
      response = await fetch("/api/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configuration),
      });
    await receive(response, configuration, version);
    error("");
  } catch (e) {
    sourceName = oldName;
    darkName = oldDark;
    stale = !!frame;
    $("validity").textContent = "ERROR / 旧帧不可记录";
    $("validity").className = "status bad";
    error(e.message);
  } finally {
    busy = false;
    buttons();
  }
}
for (const id of ["file", "file-empty"])
  $(id).addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) processFrame("/api/image", file);
    event.target.value = "";
  });
$("dark").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) processFrame("/api/dark", file);
  event.target.value = "";
});
$("apply").addEventListener("click", () => processFrame("/api/measure"));
$("full-roi").addEventListener("click", () => {
  for (const k of ["x", "y", "w", "h"]) $("roi-" + k).value = 0;
  changed();
  if (frame) processFrame("/api/measure");
});
function signature() {
  return JSON.stringify([
    frame.width,
    frame.height,
    frame.maxval,
    frame.roi,
    frame.correction,
    frame.dark_record?.sha256,
    frame.pitch_um,
    frame.calibration,
  ]);
}
function recordStats() {
  if (!eligible()) return;
  try {
    const sig = signature();
    if (records.length && records[0].signature !== sig)
      throw Error("ROI、校正或标定已变化，请先清除统计记录");
    if (records.some((r) => r.sha256 === frame.source_record.sha256))
      throw Error("该源图像已经记录，不重复累计同一静态帧");
    if (records.length >= 1000)
      throw Error("当前会话最多记录 1000 帧，请导出后新建会话");
    records.push({
      sequence: frame.sequence,
      sha256: frame.source_record.sha256,
      signature: sig,
      timestamp: frame.timestamp,
      ...metrics(),
    });
    stats();
    error("");
    log("有效帧已纳入统计");
  } catch (e) {
    error(e.message);
  }
}
function stats() {
  const tbody = $("stats");
  tbody.replaceChildren();
  for (const [key, label] of [
    ["dx_px", "D4σ X"],
    ["dy_px", "D4σ Y"],
    ["cx", "质心 X"],
    ["cy", "质心 Y"],
  ]) {
    const values = records.map((r) => r[key]),
      mean = values.reduce((a, b) => a + b, 0) / (values.length || 1),
      sd =
        values.length > 1
          ? Math.sqrt(
              values.reduce((s, v) => s + (v - mean) ** 2, 0) /
                (values.length - 1),
            )
          : 0,
      row = document.createElement("tr");
    for (const text of [
      label,
      ...(values.length
        ? [mean, sd, Math.min(...values), Math.max(...values)].map((v, i) =>
            i === 1 && values.length < 2 ? "—" : v.toFixed(3),
          )
        : ["—", "—", "—", "—"]),
    ]) {
      const td = document.createElement("td");
      td.textContent = text;
      row.append(td);
    }
    tbody.append(row);
  }
  $("stats-count").textContent =
    `${records.length} 个有效源图像 · 标准差采用 n−1；至少 2 帧`;
  const canvas = $("stability"),
    ctx = canvas.getContext("2d"),
    w = canvas.width,
    h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#6c8295";
  ctx.fillText("ΔX / ΔY (px) · reference: first recorded frame", 8, 12);
  if (records.length) {
    const series = ["cx", "cy"].map((key) =>
      records.map((row) => row[key] - records[0][key]),
    );
    let span = 0.05;
    for (const values of series)
      for (const value of values) span = Math.max(span, Math.abs(value) * 1.1);
    ctx.strokeStyle = "#d4dee7";
    ctx.beginPath();
    ctx.moveTo(45, h / 2);
    ctx.lineTo(w - 10, h / 2);
    ctx.stroke();
    ["#216aab", "#c47a20"].forEach((color, k) => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.fillText(k ? "ΔY" : "ΔX", w - 80 + k * 35, 12);
      ctx.beginPath();
      series[k].forEach((value, i) => {
        const x = 45 + (i / Math.max(1, records.length - 1)) * (w - 60),
          y = h / 2 - (value / span) * (h / 2 - 22);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
    ctx.fillStyle = "#6c8295";
    ctx.fillText("+" + span.toFixed(3), 2, 29);
    ctx.fillText("-" + span.toFixed(3), 2, h - 10);
  }
}
$("record").addEventListener("click", recordStats);
$("clear-stats").addEventListener("click", () => {
  records = [];
  stats();
  log("统计记录已清除");
});
function scanRows() {
  const table = $("scan-rows");
  table.replaceChildren();
  for (const sample of scan) {
    const tr = document.createElement("tr");
    for (const v of [
      sample.z_mm,
      sample.wx_um.toFixed(3),
      sample.wy_um.toFixed(3),
      sample.sequence,
    ]) {
      const td = document.createElement("td");
      td.textContent = v;
      tr.append(td);
    }
    table.append(tr);
  }
  buttons();
}
$("append-z").addEventListener("click", () => {
  try {
    if (!eligible() || !frame.calibration.confirmed)
      throw Error("当前帧无效或未标定");
    const z = number("z", -1e6, 1e6),
      sig = signature();
    if (scan.length && scan[0].signature !== sig)
      throw Error("扫描须保持同一 ROI、校正和空间标定");
    if (scan.some((row) => row.z_mm === z))
      throw Error("该 z 位置已有样本，请清除后重新采样");
    if (scan.some((row) => row.sha256 === frame.source_record.sha256))
      throw Error("不能将同一源图像登记为不同 z 位置");
    fitGeneration++;
    scan.push({
      z_mm: z,
      wx_um: (frame.dx_px * frame.pitch_um) / 2,
      wy_um: (frame.dy_px * frame.pitch_um) / 2,
      sequence: frame.sequence,
      sha256: frame.source_record.sha256,
      signature: sig,
      timestamp: frame.timestamp,
    });
    scan.sort((a, b) => a.z_mm - b.z_mm);
    fitResult = null;
    $("fit-result").textContent =
      `已记录 ${scan.length} 个轴向位置；尚未拟合。`;
    scanRows();
    error("");
    log(`追加扫描位置 ${z} mm`);
  } catch (e) {
    error(e.message);
  }
});
$("wavelength").addEventListener("change", () => {
  fitGeneration++;
  fitResult = null;
  $("fit-result").textContent = "波长已改变，需重新拟合。";
});
$("fit").addEventListener("click", async () => {
  busy = true;
  buttons();
  try {
    const generation = fitGeneration,
      wavelength = number("wavelength", 100, 20000),
      samples = structuredClone(scan);
    if (samples.length < 5) throw Error("至少需要 5 个不同 z 位置");
    const fit = async (key) => {
      const response = await fetch("/api/fit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wavelength_nm: wavelength,
          samples: samples.map((row) => [row.z_mm, row[key]]),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error);
      return data;
    };
    const x = await fit("wx_um"),
      y = await fit("wy_um");
    if (generation !== fitGeneration)
      throw Error("扫描或波长已更改，请重新拟合");
    fitResult = {
      x,
      y,
      wavelength_nm: wavelength,
      samples,
      standard_conformance: "not assessed",
    };
    $("fit-result").textContent =
      `M²x ${x.M2.toFixed(4)} / M²y ${y.M2.toFixed(4)} · 束腰位置 X ${(x.waist_position_m * 1000).toFixed(3)} / Y ${(y.waist_position_m * 1000).toFixed(3)} mm · 半径 RMSE ${(x.radius_rmse_m * 1e6).toFixed(3)} / ${(y.radius_rmse_m * 1e6).toFixed(3)} μm` +
      (x.M2 < 1 || y.M2 < 1 ? " · M² < 1，请检查单位、校正与样本" : "");
    error("");
    log("固定 X/Y 轴焦散拟合完成，未判定标准符合性");
  } catch (e) {
    fitResult = null;
    error(e.message);
  } finally {
    busy = false;
    buttons();
  }
});
$("clear-scan").addEventListener("click", () => {
  fitGeneration++;
  scan = [];
  fitResult = null;
  scanRows();
  $("fit-result").textContent = "扫描记录已清除。";
  log("扫描记录已清除");
});
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
$("export").addEventListener("click", async () => {
  if (!frame || stale) return;
  const manifest = {
    schema: "beamlab.session/0.2",
    measurement: frame,
    statistics: records,
    scan,
    fit: fitResult,
    coordinate_system: "sensor top-left; x right, y down",
    units: {
      diameter: "px",
      pixel_pitch: "um/px",
      signal: "DN",
      z: "mm",
      scan_radius: "um",
    },
    validity_policy: {
      saturation_fraction: 0,
      edge_fraction_lt: 0.02,
      peak_noise_ratio_gte: 10,
    },
    standard_conformance: "not assessed",
    note: "Raw PGM source and dark frames are included in the ZIP and referenced by SHA-256.",
  };
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (!response.ok) throw Error((await response.json()).error);
    download(
      `beam-session-${frame.sequence}.zip`,
      await response.blob(),
      "application/zip",
    );
    log("测量包已导出：原始图像、暗场、校正设置、统计和扫描清单");
  } catch (e) {
    error(e.message);
  }
});
$("report").addEventListener("click", () => {
  if (frame && !stale) window.print();
});
renderResults();
stats();
log("工作站启动。设备未连接；等待用户载入原始图像。");
fetch("/api/health")
  .then((r) => r.json())
  .then((data) => {
    if (!data.ok) throw Error("C++ 引擎离线");
    $("compute").textContent = "C++ 引擎在线 · 等待数据";
  })
  .catch((e) => error(e.message));
