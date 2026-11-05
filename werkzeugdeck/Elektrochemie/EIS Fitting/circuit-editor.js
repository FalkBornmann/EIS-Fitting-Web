function createCircuitEditor(container, preview, changed) {
  const elements = {R:"Widerstand", C:"Kondensator", Q:"CPE", L:"Induktivität",
    La:"Modifizierte Induktivität", W:"Warburg", Wo:"Warburg offen", Ws:"Warburg kurzgeschlossen", G:"Gerischer"};
  let root = ["s", "R", ["p", "R", "Q"]];
  let locked = false;
  const count = node => Array.isArray(node) ? node.slice(1).reduce((n,b) => n+count(b),0) : 1;
  function update() { render(); changed(); }
  function button(label, action, disabled=false) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    control.className = "editor-action";
    control.disabled = locked || disabled;
    control.onclick = action;
    return control;
  }
  function branch(node, replace, remove) {
    const panel = document.createElement("div");
    panel.className = "editor-branch";
    const bar = document.createElement("div");
    bar.className = "actions";
    const group = Array.isArray(node);
    const select = document.createElement("select");
    select.setAttribute("aria-label", group ? "Verbindung" : "Bauteiltyp");
    const options = group ? {s:"Reihe", p:"Parallel"} : elements;
    for (const [key, name] of Object.entries(options)) select.add(new Option(group ? name : key+" · "+name,key));
    select.value = group ? node[0] : node;
    select.disabled = locked;
    select.onchange = () => replace(group ? [select.value,...node.slice(1)] : select.value);
    bar.append(select);
    const atLimit = count(root) >= 12;
    if (group) bar.append(button("Zweig hinzufügen", () => replace([...node,"R"]), atLimit));
    bar.append(button("+ in Reihe", () => replace(["s",node,"R"]), atLimit),
               button("+ parallel", () => replace(["p",node,"R"]), atLimit));
    if (remove) bar.append(button("Entfernen",remove));
    panel.append(bar);
    if (group) {
      const children = document.createElement("div");
      children.className = "editor-children";
      node.slice(1).forEach((child,index) => {
        children.append(branch(child, next => {
          const copy = [...node]; copy[index+1] = next; replace(copy);
        }, () => {
          const remaining = node.slice(1).filter((_,i) => i !== index);
          replace(remaining.length === 1 ? remaining[0] : [node[0],...remaining]);
        }));
      });
      panel.append(children);
    }
    return panel;
  }
  function render() {
    container.replaceChildren(branch(root, next => {root=next; update();}));
    preview.replaceChildren(drawCircuit(root, {}));
  }
  render();
  return {topology: () => root, lock: value => {locked=value; render();}};
}
