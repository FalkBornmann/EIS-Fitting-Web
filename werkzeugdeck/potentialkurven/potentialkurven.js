"use strict";

function parseCurve(text) {
  const lines = text.split(/\r?\n/);
  const type = lines[1]?.trim();
  if (type !== "TE" && type !== "EIT") {
    throw new Error("Dieses Werkzeug unterstützt VoltaLab-CRV-Dateien mit dem Kurventyp TE oder EIT.");
  }
  const count = Number(lines[8]);
  if (lines[6]?.trim() !== "VoltaLab" || !Number.isSafeInteger(count) ||
      count < 1 || count > lines.length - 9) {
    throw new Error("Der VoltaLab-Dateikopf oder die Anzahl der Messpunkte ist ungültig.");
  }
  const points = lines.slice(9, 9 + count).map((line, index) => {
    const columns = line.trim().split(/\s+/);
    const values = columns.map(value => Number(value.replace(",", ".")));
    if (columns.length !== type.length || values.some(value => !Number.isFinite(value))) {
      throw new Error("Ungültiger Messpunkt " + (index + 1) + ".");
    }
    if (type === "TE") return { t: values[0], e: values[1] };
    return { e: values[0], i: values[1], t: values[2] };
  });
  return { type, points };
}

function regression(points, x) {
  const average = getter => points.reduce((sum, point) => sum + getter(point), 0) / points.length;
  const meanX = average(x);
  const meanE = average(point => point.e);
  const xx = average(point => (x(point) - meanX) ** 2);
  const ee = average(point => (point.e - meanE) ** 2);
  const xe = average(point => (x(point) - meanX) * (point.e - meanE));
  const slope = points.length > 1 && xx > 0 ? xe / xx : NaN;
  return { meanE, slope, r2: xx > 0 && ee > 0 ? xe ** 2 / (xx * ee) : NaN,
    predict: value => meanE + slope * (value - meanX) };
}

if (typeof document !== "undefined") {
  const get = id => document.getElementById(id);
  const value = id => get(id).value;
  const number = id => get(id).valueAsNumber;
  const format = new Intl.NumberFormat("de", { maximumSignificantDigits: 5 });
  const show = number => Number.isFinite(number) ? format.format(number) : "–";
  const currentFactors = { A: 1, mA: 1e-3, "µA": 1e-6, nA: 1e-9 };
  const areaFactors = { "cm²": 1, "mm²": 0.01, "m²": 10000 };
  const canvas = get("plot");
  const ctx = canvas.getContext("2d");
  let curve, selected, fileName;
  let loadVersion = 0;
  const polar = () => value("mode") === "polar";
  const x = point => polar() ? point.i : point.t;
  const rangeKey = point => polar() ? point.e : point.t;

  function extent(points, getter) {
    let min = Infinity, max = -Infinity;
    for (const point of points) {
      const v = getter(point);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return [min, max];
  }

  function reset() {
    const [min, max] = extent(curve.points, rangeKey);
    get("lower").value = min;
    get("upper").value = max;
    get("first").value = 1;
    get("last").value = curve.points.length;
    get("view").value = "all";
    render();
  }

  function draw(points, fit) {
    const visible = value("view") === "window" ? selected : points;
    const unit = value("currentUnit");
    const xLabel = polar() ? "Strom (" + (unit || "Dateieinheit") + ")" : "Zeit (s)";
    const left = 135, right = 1165, top = 32, bottom = 450;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!visible.length) return;
    function padded([min, max]) {
      const pad = (max - min) * 0.05 || Math.max(Math.abs(min) * 0.05, 1e-9);
      return [min - pad, max + pad];
    }
    const [xmin, xmax] = padded(extent(visible, x));
    const [ymin, ymax] = padded(extent(visible, point => point.e));
    const px = v => left + (v - xmin) / (xmax - xmin) * (right - left);
    const py = v => bottom - (v - ymin) / (ymax - ymin) * (bottom - top);
    ctx.font = "20px system-ui";
    ctx.fillStyle = "#132c3c";
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#d4e1e7";
    for (let tick = 0; tick <= 5; tick++) {
      const fraction = tick / 5;
      const gx = left + fraction * (right - left);
      const gy = bottom - fraction * (bottom - top);
      ctx.beginPath();
      ctx.moveTo(gx, top);
      ctx.lineTo(gx, bottom);
      ctx.moveTo(left, gy);
      ctx.lineTo(right, gy);
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.fillText(show(xmin + fraction * (xmax - xmin)), gx, bottom + 28);
      ctx.textAlign = "right";
      ctx.fillText(show(ymin + fraction * (ymax - ymin)), left - 9, gy + 6);
    }
    ctx.textAlign = "center";
    ctx.fillText(xLabel, (left + right) / 2, 520);
    ctx.save();
    ctx.translate(23, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Potential (V)", 0, 0);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    ctx.strokeStyle = "#085b79";
    ctx.lineWidth = 2;
    ctx.beginPath();
    visible.forEach((point, index) => {
      const method = index && (value("view") !== "window" ||
        point.index === visible[index - 1].index + 1) ? "lineTo" : "moveTo";
      ctx[method](px(x(point)), py(point.e));
    });
    ctx.stroke();
    ctx.fillStyle = "#00736f";
    for (const point of selected) ctx.fillRect(px(x(point)) - 2, py(point.e) - 2, 4, 4);
    if (Number.isFinite(fit?.slope)) {
      const [start, end] = extent(selected, x);
      ctx.strokeStyle = "#ac471c";
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(px(start), py(fit.predict(start)));
      ctx.lineTo(px(end), py(fit.predict(end)));
      ctx.stroke();
    }
    ctx.restore();
  }

  function render() {
    const limits = polar() ? "Potential (V)" : "Zeit (s)";
    get("lowerLabel").textContent = limits + " von";
    get("upperLabel").textContent = limits + " bis";
    get("polarOptions").hidden = !polar();
    const lower = number("lower"), upper = number("upper");
    const first = number("first"), last = number("last");
    selected = curve.points.filter(point => rangeKey(point) >= lower && rangeKey(point) <= upper &&
      (!polar() || (point.index >= first && point.index <= last)));
    const fit = selected.length ? regression(selected, x) : null;
    const details = [selected.length + " Messpunkte ausgewählt"];
    if (!selected.length) details.push("Prüfe die Grenzen des Auswertefensters.");
    if (fit && !polar()) {
      details.push("Mittelwert " + show(fit.meanE * 1000) + " mV",
        "Drift " + show(fit.slope * 60000) + " mV/min");
    }
    let displayFit = fit;
    if (fit && polar()) {
      const [min, max] = extent(selected, x);
      const factor = currentFactors[value("currentUnit")];
      const resistance = fit.slope / factor;
      if (min >= 0 || max <= 0 || selected.length < 3) {
        details.push("Für Rₚ mindestens drei Punkte und beide Stromvorzeichen auswählen.");
        displayFit = null;
      } else if (!factor) {
        details.push("Für Rₚ die Stromeinheit aus dem Messprogramm wählen.");
      } else if (!(resistance > 0 && Number.isFinite(resistance))) {
        details.push("Die Auswahl ergibt keinen positiven Polarisationswiderstand.");
      } else {
        details.push("Rₚ " + show(resistance) + " Ω", "E bei I = 0: " + show(fit.predict(0)) + " V");
        const area = number("area") * areaFactors[value("areaUnit")];
        if (area > 0) details.push("Rₚ × Fläche " + show(resistance * area) + " Ω·cm²");
        else if (value("area")) details.push("Die exponierte Fläche muss positiv sein.");
      }
      if (displayFit) details.push("R² " + show(fit.r2));
    }
    get("result").textContent = details.join(" · ");
    get("csv").disabled = !selected.length;
    get("png").disabled = value("view") === "window" && !selected.length;
    draw(curve.points, displayFit);
  }

  get("file").addEventListener("change", async () => {
    const version = ++loadVersion;
    const file = get("file").files[0];
    get("analysis").hidden = true;
    if (!file) {
      get("status").textContent = "Wähle eine CRV-Datei.";
      return;
    }
    try {
      const parsed = parseCurve(await file.text());
      if (version !== loadVersion) return;
      curve = parsed;
      curve.points.forEach((point, index) => { point.index = index + 1; });
      fileName = file.name.replace(/\.crv$/i, "");
      get("mode").options[1].disabled = curve.type === "TE";
      get("mode").value = "time";
      get("currentUnit").value = "";
      get("area").value = "";
      get("status").textContent = file.name + " · " + curve.type + " · " + curve.points.length + " Messpunkte";
      get("analysis").hidden = false;
      reset();
    } catch (error) {
      if (version === loadVersion) get("status").textContent = error.message;
    }
  });

  function download(blob, extension) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName + "-" + value("mode") + "." + extension;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  get("mode").addEventListener("change", reset);
  get("reset").addEventListener("click", reset);
  for (const id of ["lower", "upper", "first", "last", "view", "currentUnit", "area", "areaUnit"]) {
    get(id).addEventListener("input", render);
  }
  get("csv").addEventListener("click", () => {
    const hasCurrent = curve.type === "EIT";
    const unit = value("currentUnit") || "Dateieinheit";
    const rows = [["Messpunkt", "Zeit (s)", "Potential (V)", ...(hasCurrent ? ["Strom (" + unit + ")"] : [])]];
    for (const point of selected) {
      rows.push([point.index, point.t, point.e, ...(hasCurrent ? [point.i] : [])]);
    }
    download(new Blob([rows.map(row => row.join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }), "csv");
  });
  get("png").addEventListener("click", () => {
    canvas.toBlob(blob => { if (blob) download(blob, "png"); });
  });
}
