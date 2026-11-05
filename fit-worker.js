const indexURL = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
let runtime;

async function initialize() {
  importScripts(indexURL + "pyodide.js");
  const py = await loadPyodide({indexURL});
  await py.loadPackage("scipy");
  for (const filename of ["circuits.py", "fitting.py"]) {
    const response = await fetch(filename);
    if (!response.ok) throw new Error("Rechenmodul konnte nicht geladen werden: " + filename);
    py.FS.writeFile(filename, await response.text());
  }
  return py;
}

self.onmessage = async ({data}) => {
  let py;
  try {
    if (!runtime) {
      self.postMessage({status: "Rechenmodul wird geladen. Beim ersten Start kann das etwas dauern."});
      runtime = initialize().catch(error => {
        runtime = undefined;
        throw error;
      });
    }
    py = await runtime;
    self.postMessage({status: "Ersatzschaltungen werden gesucht und gefittet …"});
    py.FS.writeFile("measurement.bin", new Uint8Array(data.raw));
    py.globals.set("suffix", data.suffix);
    py.globals.set("components", data.components);
    py.globals.set("limit", data.limit);
    py.globals.set("example", data.example);
    py.globals.set("circuit_json", JSON.stringify(data.topology));
    const result = py.runPython(`
import json
from pathlib import Path
from fitting import analyze
try:
    result_json = json.dumps(analyze(Path("measurement.bin").read_bytes(), suffix, components, limit, example, json.loads(circuit_json)), allow_nan=False)
except (ValueError, TypeError) as exc:
    result_json = json.dumps({"error": str(exc)})
result_json
`);
    self.postMessage(JSON.parse(result));
  } catch (error) {
    self.postMessage({error: "Berechnung konnte nicht gestartet oder abgeschlossen werden. " + error.message});
  } finally {
    if (py && py.FS.analyzePath("measurement.bin").exists) py.FS.unlink("measurement.bin");
  }
};
