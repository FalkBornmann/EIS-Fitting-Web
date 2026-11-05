function powerOfTen(exponent) {
  if (exponent === 0) return "1";
  const superscript = String(exponent).replace(/[-0-9]/g,
    digit => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(digit)]);
  return "10" + superscript;
}

function formatQuantity(value, digits=3) {
  const decimal = n => n.toLocaleString("de-DE", {maximumSignificantDigits:digits, useGrouping:false});
  if (value === 0 || (Math.abs(value) >= .01 && Math.abs(value) < 1000)) return decimal(value);
  const [coefficient, exponent] = Number(value.toPrecision(digits)).toExponential().split("e").map(Number);
  if (coefficient === 1) return powerOfTen(exponent);
  if (coefficient === -1) return "−" + powerOfTen(exponent);
  return decimal(coefficient) + " × " + powerOfTen(exponent);
}

/* Measure branches first, then draw wires and symbols in the allocated space. */
function drawCircuit(tree, parameters) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Ersatzschaltbild des ausgewählten Fits");
  const counts = new Map();
  function add(tag, attributes, content) {
    const element = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (content) element.textContent = content;
    svg.append(element);
  }
  function wire(d) {
    add("path", {d, fill: "none", stroke: "currentColor", "stroke-width": 2});
  }
  function measure(node) {
    if (typeof node === "string") return {width: 140, top: 38, bottom: 43};
    const [op, ...branches] = node;
    const sizes = branches.map(measure);
    const height = size => size.top + size.bottom;
    if (op === "s") return {
      width: sizes.reduce((sum, size) => sum + size.width, 0),
      top: Math.max(...sizes.map(size => size.top)),
      bottom: Math.max(...sizes.map(size => size.bottom)), sizes,
    };
    const total = sizes.reduce((sum, size) => sum + height(size), 0);
    return {width: Math.max(...sizes.map(size => size.width)) + 36,
            top: total / 2, bottom: total / 2, sizes};
  }
  function draw(node, size, x, y, width) {
    if (typeof node === "string") {
      const mid = x + width / 2;
      const half = node === "C" || node === "Q" ? 6 : 19;
      const count = (counts.get(node) || 0) + 1;
      counts.set(node, count);
      const label = node + count;
      wire(`M${x} ${y}H${mid-half} M${mid+half} ${y}H${x+width}`);
      add("text", {x: mid, y: y-19, "text-anchor": "middle", "font-size": 13, fill: "currentColor"}, label);
      const units = {R:"Ω", C:"F", L:node === "La" ? "Ω·sⁿ" : "H", Q:"S·sⁿ", Z0:"Ω", tau:"s", A:"Ω·s⁻½", n:""};
      Object.entries(parameters).filter(([key]) => key.startsWith(label + " ")).forEach(([key, value], i) => {
        const name = key.slice(label.length+1);
        const symbol = {Z0:"Z₀", tau:"τ", A:"Aₓ"}[name] || name;
        const number = formatQuantity(value);
        add("text", {x: mid, y: y+23+i*14, "text-anchor": "middle", "font-size": 11, fill: "#4b6473"},
            `${symbol} = ${number}${units[name] ? " " + units[name] : ""}`);
      });
      if (node === "C" || node === "Q") {
        wire(`M${mid-6} ${y-10}v20 M${mid+6} ${y-10}v20`);
        if (node === "Q") wire(`M${mid-14} ${y+13}l28 -26 m-7 0h7v7`);
      } else if (node === "L" || node === "La") {
        wire(`M${mid-19} ${y}` + "q4.75 -16 9.5 0 ".repeat(4));
        if (node === "La") wire(`M${mid-13} ${y+10}l26 -23 m-6 0h6v6`);
      } else {
        add("rect", {x: mid-19, y: y-9, width: 38, height: 18, fill: "none", stroke: "currentColor", "stroke-width": 2});
        if (node !== "R") add("text", {x: mid, y: y+4, "text-anchor": "middle", "font-size": 11, fill: "currentColor"}, node);
      }
      return;
    }
    const [op, ...branches] = node;
    if (op === "s") {
      let offset = x + (width-size.width)/2;
      wire(`M${x} ${y}H${offset} M${offset+size.width} ${y}H${x+width}`);
      branches.forEach((branch, i) => {
        const child = size.sizes[i];
        draw(branch, child, offset, y, child.width);
        offset += child.width;
      });
      return;
    }
    let top = y-size.top;
    const positions = size.sizes.map(child => {
      const center = top + child.top;
      top += child.top + child.bottom;
      return center;
    });
    const left = x+18, right = x+width-18;
    const lo = Math.min(y, ...positions), hi = Math.max(y, ...positions);
    wire(`M${x} ${y}H${left} M${right} ${y}H${x+width} M${left} ${lo}V${hi} M${right} ${lo}V${hi}`);
    branches.forEach((branch, i) => draw(branch, size.sizes[i], left, positions[i], right-left));
    for (const center of new Set([y, ...positions.slice(1, -1)])) {
      for (const rail of [left, right]) add("circle", {cx: rail, cy: center, r: 3, fill: "currentColor"});
    }
  }
  const size = measure(tree);
  const width = size.width+60, y = size.top+8;
  svg.setAttribute("viewBox", `0 0 ${width} ${y+size.bottom+8}`);
  svg.setAttribute("width", width);
  wire(`M12 ${y}H30 M${width-30} ${y}H${width-12}`);
  draw(tree, size, 30, y, size.width);
  for (const x of [12,width-12]) add("circle", {cx:x, cy:y, r:4, stroke:"currentColor", fill:"white", "stroke-width":2});
  return svg;
}
