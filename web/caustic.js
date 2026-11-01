// Pure presentation/diagnostic helpers. The authoritative fit remains in C++.
export const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const predictedRadius = (axis, z_mm) =>
  Math.hypot(
    axis.waist_radius_m,
    axis.divergence_rad * (z_mm * 0.001 - axis.waist_position_m),
  ) * 1e6;
export function parseCausticCSV(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i <= text.length; i++) {
    const c = i === text.length ? "\n" : text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!field || quoted) quoted = !quoted;
      else throw Error("CSV 引号位置错误");
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(field.trim());
      field = "";
      if (c !== ",") {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else field += c;
  }
  if (quoted) throw Error("CSV 引号未闭合");
  const header = rows.shift();
  if (
    !header ||
    header.slice(0, 3).join(",") !== "z_mm,wx_um,wy_um" ||
    header.length > 5 ||
    (header[3] && header[3] !== "included") ||
    (header[4] && header[4] !== "note")
  )
    throw Error("CSV 表头须为 z_mm,wx_um,wy_um，可追加 included,note");
  if (!rows.length || rows.length > 512)
    throw Error("CSV 需要 1–512 个轴向位置");
  const seen = new Set();
  return rows.map((r, i) => {
    if (
      r.length !== header.length ||
      r.slice(0, 3).some((v) => !v || !Number.isFinite(Number(v)))
    )
      throw Error(`CSV 第 ${i + 2} 行：需要完整有限数值`);
    const [z, wx, wy] = r.map(Number);
    if (Math.abs(z) > 1e6 || wx <= 0 || wy <= 0 || wx > 1e6 || wy > 1e6)
      throw Error(`CSV 第 ${i + 2} 行：坐标或半径超出范围`);
    if (seen.has(z)) throw Error("CSV 有重复 z 位置");
    seen.add(z);
    if (r[3] && !["0", "1"].includes(r[3]))
      throw Error("included 只能为 0 或 1");
    if ((r[4] || "").length > 240) throw Error("备注最多 240 字符");
    return {
      z_mm: z,
      wx_um: wx,
      wy_um: wy,
      included: r[3] !== "0",
      note: r[4] || "",
      source: "external_csv",
    };
  });
}
export function axisDiagnostics(axis, samples, key) {
  const included = samples.filter((s) => s.included !== false),
    residuals = included.map((s) => s[key] - predictedRadius(axis, s.z_mm)),
    mean = included.reduce((a, s) => a + s[key], 0) / included.length,
    sse = residuals.reduce((a, r) => a + r * r, 0),
    sst = included.reduce((a, s) => a + (s[key] - mean) ** 2, 0),
    z0 = axis.waist_position_m * 1000,
    zR = (axis.waist_radius_m / axis.divergence_rad) * 1000;
  const zs = included.map((s) => s.z_mm),
    min = Math.min(...zs),
    max = Math.max(...zs),
    left = included.filter((s) => s.z_mm < z0).length,
    right = included.filter((s) => s.z_mm > z0).length,
    near = included.filter((s) => Math.abs(s.z_mm - z0) <= zR).length,
    far = included.filter((s) => Math.abs(s.z_mm - z0) >= 2 * zR).length,
    warnings = [];
  if (axis.M2 < 1) warnings.push("M² < 1：检查单位、校正及模型适用性");
  if (z0 < min || z0 > max) warnings.push("拟合束腰在采样区间外，属于外推");
  if (!left || !right) warnings.push("束腰两侧未形成双侧覆盖");
  if (!near) warnings.push("未覆盖拟合瑞利长度以内区域");
  if (!far) warnings.push("未覆盖 2 倍拟合瑞利长度以外区域");
  if (included.length < 10) warnings.push("采样点较少；需另行制定完整测量方案");
  return {
    count: included.length,
    z0_mm: z0,
    zR_mm: zR,
    left,
    right,
    near,
    far,
    rmse_um: Math.sqrt(sse / included.length),
    max_abs_um: Math.max(...residuals.map(Math.abs)),
    r2: sst > 0 ? 1 - sse / sst : null,
    bpp_mm_mrad: axis.waist_radius_m * axis.divergence_rad * 1e6,
    warnings,
  };
}
export function chartSVG(samples, fit, residual = false) {
  const w = 900,
    h = residual ? 250 : 360,
    p = { l: 72, r: 28, t: 30, b: 45 };
  let zs = samples.map((s) => s.z_mm),
    min = zs.length ? Math.min(...zs) : -1,
    max = zs.length ? Math.max(...zs) : 1;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const axes = [
    ["x", "wx_um", "#2175b5"],
    ["y", "wy_um", "#d18425"],
  ];
  let values = [];
  for (const [axis, key] of axes)
    for (const s of samples)
      values.push(
        residual
          ? fit
            ? s[key] - predictedRadius(fit[axis], s.z_mm)
            : 0
          : s[key],
      );
  if (fit && !residual)
    for (const [axis] of axes)
      for (let i = 0; i <= 100; i++)
        values.push(predictedRadius(fit[axis], min + ((max - min) * i) / 100));
  const span = residual
      ? Math.max(0.001, ...values.map(Math.abs)) * 1.18
      : Math.max(1, ...values) * 1.12,
    lo = residual ? -span : 0,
    hi = span;
  const xx = (z) => p.l + ((z - min) / (max - min)) * (w - p.l - p.r),
    yy = (v) => h - p.b - ((v - lo) / (hi - lo)) * (h - p.t - p.b),
    f = (v) => Number(v).toFixed(2),
    tick = (v) =>
      Math.abs(v) >= 10000
        ? v.toExponential(2)
        : Number(v.toPrecision(4)).toString();
  let parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${residual ? "双轴拟合残差（实测减拟合）" : "双轴焦散曲线（半径）"}"><rect width="${w}" height="${h}" fill="white"/>`,
  ];
  for (let i = 0; i <= 5; i++) {
    const z = min + ((max - min) * i) / 5,
      y = lo + ((hi - lo) * i) / 5;
    parts.push(
      `<path d="M${f(xx(z))} ${p.t}V${h - p.b} M${p.l} ${f(yy(y))}H${w - p.r}" stroke="#e1e8ee" fill="none"/><text x="${f(xx(z))}" y="${h - 21}" text-anchor="middle">${tick(z)}</text><text x="${p.l - 10}" y="${f(yy(y) + 4)}" text-anchor="end">${tick(y)}</text>`,
    );
  }
  parts.push(
    `<text x="${p.l}" y="16">${residual ? "残差 Δw / μm（实测 − 拟合）" : "二阶矩半径 w / μm"}</text><text x="${w - 30}" y="${h - 3}" text-anchor="end">z / mm</text>`,
  );
  if (residual)
    parts.push(
      `<path d="M${p.l} ${f(yy(0))}H${w - p.r}" stroke="#73899a" stroke-dasharray="5 4"/>`,
    );
  for (const [axis, key, color] of axes) {
    if (fit && !residual) {
      const selected = samples
          .filter((s) => s.included !== false)
          .map((s) => s.z_mm),
        start = Math.min(...selected),
        end = Math.max(...selected);
      const curve = (a, b) => {
        let path = "";
        for (let i = 0; i <= 160; i++) {
          const z = a + ((b - a) * i) / 160;
          path +=
            (i ? "L" : "M") +
            f(xx(z)) +
            " " +
            f(yy(predictedRadius(fit[axis], z))) +
            " ";
        }
        return path;
      };
      parts.push(
        `<path d="${curve(min, max)}" stroke="${color}" fill="none" stroke-width="2" stroke-dasharray="5 4"/>`,
      );
      parts.push(
        `<path d="${curve(start, end)}" stroke="${color}" fill="none" stroke-width="2"/>`,
      );
    }
    for (const s of samples) {
      if (residual && !fit) continue;
      const x = xx(s.z_mm),
        y = yy(residual ? s[key] - predictedRadius(fit[axis], s.z_mm) : s[key]),
        enabled = s.included !== false;
      parts.push(
        enabled
          ? `<circle cx="${f(x)}" cy="${f(y)}" r="3.5" fill="${color}"><title>${axis.toUpperCase()} z=${s.z_mm} mm, ${residual ? "Δw" : "w"}=${tick(residual ? s[key] - predictedRadius(fit[axis], s.z_mm) : s[key])} μm</title></circle>`
          : `<path d="M${f(x - 4)} ${f(y - 4)}l8 8m-8 0l8 -8" stroke="#929ca6"><title>排除：${escapeHTML(s.note || "未填写原因")}</title></path>`,
      );
    }
  }
  if (!samples.length)
    parts.push(
      `<text x="450" y="${h / 2}" text-anchor="middle" fill="#8193a3">等待采样数据</text>`,
    );
  else if (residual && !fit)
    parts.push(
      `<text x="450" y="${h / 2}" text-anchor="middle" fill="#8193a3">拟合后显示残差</text>`,
    );
  parts.push(
    '<text x="700" y="16" fill="#2175b5">● X 轴</text><text x="775" y="16" fill="#d18425">● Y 轴</text></svg>',
  );
  return parts.join("");
}
export const csvField = (value) => {
  let text = String(value ?? "");
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function resultsCSV(samples, fit) {
  return (
    "z_mm,wx_um,wy_um,included,note,predicted_x_um,predicted_y_um,residual_x_um,residual_y_um,source_sha256\r\n" +
    samples
      .map((s) =>
        [
          s.z_mm,
          s.wx_um,
          s.wy_um,
          s.included === false ? 0 : 1,
          s.note || "",
          predictedRadius(fit.x, s.z_mm),
          predictedRadius(fit.y, s.z_mm),
          s.wx_um - predictedRadius(fit.x, s.z_mm),
          s.wy_um - predictedRadius(fit.y, s.z_mm),
          s.sha256 || s.csv_sha256 || "",
        ]
          .map(csvField)
          .join(","),
      )
      .join("\r\n")
  );
}
export function reportDocument(fit, metadata, events = []) {
  const samples = fit.all_samples,
    dx = axisDiagnostics(fit.x, samples, "wx_um"),
    dy = axisDiagnostics(fit.y, samples, "wy_um"),
    fmt = (v, n = 4) => (Number.isFinite(v) ? v.toFixed(n) : "未评估");
  const metrics = [
    ["M²", "—", fit.x.M2, fit.y.M2],
    [
      "束腰半径 w₀",
      "μm",
      fit.x.waist_radius_m * 1e6,
      fit.y.waist_radius_m * 1e6,
    ],
    ["束腰位置 z₀", "mm", dx.z0_mm, dy.z0_mm],
    [
      "发散半角 θ",
      "mrad",
      fit.x.divergence_rad * 1e3,
      fit.y.divergence_rad * 1e3,
    ],
    [
      "发散全角 2θ",
      "mrad",
      fit.x.divergence_rad * 2e3,
      fit.y.divergence_rad * 2e3,
    ],
    ["BPP", "mm·mrad", dx.bpp_mm_mrad, dy.bpp_mm_mrad],
    ["拟合瑞利长度", "mm", dx.zR_mm, dy.zR_mm],
    ["半径 RMSE", "μm", dx.rmse_um, dy.rmse_um],
    ["最大绝对残差", "μm", dx.max_abs_um, dy.max_abs_um],
    ["半径 R²", "—", dx.r2, dy.r2],
  ];
  const warnings = [
    ...dx.warnings.map((s) => "X：" + s),
    ...dy.warnings.map((s) => "Y：" + s),
  ];
  if (samples.some((s) => s.source === "external_csv"))
    warnings.push("外部 CSV 的原始图像、暗场、曝光和空间标定未由本软件核验。");
  if (samples.some((s) => s.included === false && !s.note))
    warnings.push("有被排除的采样点尚未填写原因。");
  const content = `<header><h1>光束传播质量测量报告</h1><p>BeamLab · 双轴焦散分析 · 固定传感器 X / Y 轴</p></header><dl>${Object.entries(
    {
      ...metadata,
      report_id: fit.report_id,
      fit_time: fit.fit_time,
      wavelength_nm: fit.wavelength_nm,
      software_version: fit.x.version || "unknown",
    },
  )
    .map(
      ([k, v]) =>
        `<dt>${escapeHTML({ report_id: "报告编号", fit_time: "拟合时间（UTC）", wavelength_nm: "波长 / nm", software_version: "计算服务版本" }[k] || k)}</dt><dd>${escapeHTML(v || "未填写")}</dd>`,
    )
    .join(
      "",
    )}</dl><h2>1. 方法与测量范围</h2><p>无权重最小二乘拟合 w²(z)，以二阶矩半径 w = D4σ / 2 表示。M² = πw₀θ/λ；θ 为半角。C++ 负责数值拟合；图形为该解的可视化。实线覆盖采用点的 z 区间，区间外曲线为虚线外推。单轴自由度 n−3。共 ${samples.length} 点，采用 ${dx.count} 点，排除 ${samples.length - dx.count} 点。</p><p class="notice">本报告为分析记录，不是计量证书。ISO 11146 符合性、完整广义像散、校准证书和测量不确定度均未评估；不提供未经验证的 ± 精度或置信区间。</p><h2>2. 双轴结果</h2><table><thead><tr><th>参数</th><th>单位</th><th>X</th><th>Y</th></tr></thead><tbody>${metrics.map(([name, unit, x, y]) => `<tr><td>${name}</td><td>${unit}</td><td>${fmt(x, name.includes("R²") ? 8 : 4)}</td><td>${fmt(y, name.includes("R²") ? 8 : 4)}</td></tr>`).join("")}</tbody></table><h2>3. 双轴焦散曲线</h2>${chartSVG(samples, fit)}<h2>4. 拟合残差</h2>${chartSVG(samples, fit, true)}<h2>5. 覆盖与质量复核</h2><table><tr><th>项目</th><th>X</th><th>Y</th></tr><tr><td>束腰左 / 右采样点</td><td>${dx.left} / ${dx.right}</td><td>${dy.left} / ${dy.right}</td></tr><tr><td>|z−z₀| ≤ zR / ≥ 2zR</td><td>${dx.near} / ${dx.far}</td><td>${dy.near} / ${dy.far}</td></tr></table><p>上述覆盖指标是工程诊断，不自动判定标准符合性。</p><ul>${warnings.length ? warnings.map((s) => `<li>${escapeHTML(s)}</li>`).join("") : "<li>未触发当前工程诊断提示；这不等同于测量符合标准。</li>"}</ul><h2>6. 全部采样点与溯源</h2><table class="samples"><thead><tr><th>z / mm</th><th>wₓ / μm</th><th>wᵧ / μm</th><th>ΔX / μm</th><th>ΔY / μm</th><th>采用 / 原因</th></tr></thead><tbody>${samples.map((s) => `<tr><td>${fmt(s.z_mm, 3)}</td><td>${fmt(s.wx_um, 3)}</td><td>${fmt(s.wy_um, 3)}</td><td>${fmt(s.wx_um - predictedRadius(fit.x, s.z_mm), 3)}</td><td>${fmt(s.wy_um - predictedRadius(fit.y, s.z_mm), 3)}</td><td>${s.included === false ? "排除" : "采用"} ${escapeHTML(s.note)}</td></tr>`).join("")}</tbody></table><h3>原始数据标识与测量配置</h3>${samples.map((s) => `<p class="provenance">z=${s.z_mm} mm · 来源=${escapeHTML(s.source || "image")} · SHA-256=${escapeHTML(s.sha256 || s.csv_sha256 || "未提供")}<br>配置=${escapeHTML(s.signature || s.csv_filename || "未提供")} · 时间=${escapeHTML(s.timestamp || "未提供")}</p>`).join("")}<h2>7. 事件记录</h2><ol>${events.map((s) => `<li>${escapeHTML(s)}</li>`).join("")}</ol><footer>审核人：________________　日期：________________<br>报告生成 ${escapeHTML(new Date().toISOString())} · 原始数据须与会话归档共同保存。</footer>`;
  const css = `body{font:12px Arial,'Microsoft YaHei',sans-serif;color:#203448;max-width:1000px;margin:30px auto;padding:0 25px}h1{font-size:25px}h2{font-size:16px;border-bottom:1px solid #bccad6;margin-top:28px;padding-bottom:8px}h3{font-size:13px}p,li{line-height:1.7}table{border-collapse:collapse;width:100%;font-size:11px}td,th{padding:7px;border:1px solid #d1dce5;text-align:right}td:first-child,th:first-child{text-align:left}th{background:#eaf0f5}dl{display:grid;grid-template-columns:180px 1fr;gap:6px}dd{margin:0;overflow-wrap:anywhere}dt{color:#647b90}svg{width:100%;height:auto;font:11px Arial,sans-serif}.notice{background:#fff5dc;padding:12px}.provenance{font:9px monospace;overflow-wrap:anywhere}footer{border-top:1px solid #bdcad5;margin-top:30px;padding-top:15px}thead{display:table-header-group}tr,svg{break-inside:avoid}@page{size:A4;margin:15mm}@media print{body{max-width:none;margin:0;padding:0}.notice{background:white}}`;
  return {
    content,
    css,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BeamLab M² 报告 ${escapeHTML(fit.report_id)}</title><style>${css}</style></head><body>${content}</body></html>`,
  };
}
