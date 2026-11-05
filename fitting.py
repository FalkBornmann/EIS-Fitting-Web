import csv
import io

import numpy as np
from scipy.optimize import least_squares

from circuits import fit_custom, search


MODELS = {
    "RC": ("Rs", "R", "C"),
    "RQ": ("Rs", "R", "Q", "n"),
    "2RQ": ("Rs", "R1", "Q1", "R2", "Q2", "n1", "n2"),
    "nested": ("Rs", "Rp", "Qc", "Rint", "Qint", "nc", "nint"),
}

MODEL_COMPONENTS = {
    "RC": {"R", "C"},
    "RQ": {"R", "Q"},
    "2RQ": {"R", "Q"},
    "nested": {"R", "Q"},
}


def select_models(components, parameter_limit):
    allowed = set(components.split(",")) if components else set()
    if not allowed <= {"R", "C", "Q"} or not 3 <= parameter_limit <= 7:
        raise ValueError("Ungültige Bauteilauswahl oder Parametergrenze.")
    models = [
        kind for kind, parameters in MODELS.items()
        if MODEL_COMPONENTS[kind] <= allowed and len(parameters) <= parameter_limit
    ]
    if not models:
        raise ValueError("Kein Modell verfügbar. Wähle R und C oder R und Q. Ein Modell mit Q benötigt mindestens vier Parameter.")
    return models


def load_spectrum(raw, suffix):
    if suffix == ".ism":
        count = int.from_bytes(raw[6:12], "big") + 1
        if raw[:6] != bytes.fromhex("0000fffffffe") or count > 5000 or len(raw) < 12 + 34 * count:
            raise ValueError("Ungültige oder nicht unterstützte ISM-Datei.")
        f, magnitude, phase = np.frombuffer(raw, ">f8", count=3 * count, offset=12).reshape(3, count)
        start, end = sorted((f.argmin(), f.argmax()))
        f, magnitude, phase = (a[start:end + 1] for a in (f, magnitude, phase))
        if not np.all(np.isfinite(phase)) or np.any(abs(phase) > np.pi + 1e-6):
            raise ValueError("Ungültiger ISM-Phasenwinkel.")
        if np.any(magnitude <= 0):
            raise ValueError("Impedanzbeträge müssen positiv sein.")
        z = magnitude * np.exp(1j * phase)
    elif suffix == ".csv":
        table = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
        names = ("frequency_Hz", "Zreal_ohm", "Zimag_ohm")
        if not set(names).issubset(table.fieldnames or []):
            raise ValueError("CSV-Spalten erforderlich: frequency_Hz, Zreal_ohm, Zimag_ohm.")
        f, real, imag = np.array([[float(row[n]) for n in names] for row in table]).reshape(-1, 3).T
        z = real + 1j * imag
    else:
        raise ValueError("Bitte eine ISM- oder CSV-Datei auswählen.")
    if not 8 <= len(f) <= 5000 or not np.all(np.isfinite(f)) or not np.all(np.isfinite(z)):
        raise ValueError("Erwartet werden 8 bis 5000 gültige Frequenzpunkte.")
    order = np.argsort(f)
    f, z = f[order], z[order]
    if f[0] <= 0 or np.any(np.diff(f) <= 0) or np.any(abs(z) == 0):
        raise ValueError("Frequenzen müssen positiv und eindeutig sein. Impedanz darf nicht null sein.")
    if f[0] < 1e-12 or f[-1] > 1e12 or np.any((abs(z) < 1e-12) | (abs(z) > 1e18)):
        raise ValueError("Unterstützt werden 10⁻¹² bis 10¹² Hz und Impedanzbeträge von 10⁻¹² bis 10¹⁸ Ω.")
    return f, z


def spectrum(kind, x, f):
    w = 2j * np.pi * f
    if kind in ("RC", "RQ"):
        rs, r, q = 10 ** x[:3]
        n = 1 if kind == "RC" else x[3]
        return rs + 1 / (1 / r + q * w ** n)
    rs, r1, q1, r2, q2 = 10 ** x[:5]
    n1, n2 = x[5:]
    inner = 1 / (1 / r2 + q2 * w ** n2)
    if kind == "2RQ":
        return rs + 1 / (1 / r1 + q1 * w ** n1) + inner
    return rs + 1 / (q1 * w ** n1 + 1 / (r1 + inner))


def fit(kind, f, z):
    large = kind in ("2RQ", "nested")
    log_count = 5 if large else 3
    n_count = 2 if large else int(kind == "RQ")
    lower = np.array([-8, -6, -20] + ([-6, -20] if large else []) + [.25] * n_count)
    upper = np.array([14, 16, 3] + ([16, 3] if large else []) + [1] * n_count)
    r = np.log10(abs(z[0]))
    rs = np.log10(max(abs(z[-1]) * .1, 1e-8))
    q = -np.median(np.log10(abs(z)) + .9 * np.log10(2 * np.pi * f))
    start = np.array([rs, r - 2 if large else r, q] + ([r, q + 1] if large else []) + ([.95, .65] if large else [.9] * n_count))

    def residual(x):
        error = (spectrum(kind, x, f) - z) / abs(z)
        return np.r_[error.real, error.imag]

    rng = np.random.default_rng(42)
    starts = [start] + [start + rng.normal(size=len(start)) * ([1.5] * log_count + [.13] * n_count) for _ in range(7)]
    candidates = [least_squares(residual, np.clip(x, lower + 1e-6, upper - 1e-6), bounds=(lower, upper), max_nfev=600) for x in starts]
    best = min(candidates, key=lambda x: x.cost)
    pred = spectrum(kind, best.x, f)
    sse = 2 * best.cost
    n, k = 2 * len(f), len(best.x)
    values = np.r_[10 ** best.x[:log_count], best.x[log_count:]]
    return {
        "model": kind, "parameters": dict(zip(MODELS[kind], values)),
        "rms": 100 * np.sqrt(sse / len(f)),
        "aicc": n * np.log(max(sse / n, 1e-300)) + 2*k + 2*k*(k+1)/(n-k-1),
        "limited": bool(np.any(best.active_mask) or np.linalg.cond(best.jac) > 1e6 or not best.success),
        "real": pred.real.tolist(), "imag": pred.imag.tolist(),
    }


def demo():
    f = np.geomspace(.1, 1e5, 50)
    z = spectrum("nested", np.array([2., 5., -8.3, 8., -7.8, .95, .61]), f)
    rng = np.random.default_rng(31)
    return f, z * (1 + .002 * (rng.normal(size=len(f)) + 1j * rng.normal(size=len(f))))


def analyze(raw, suffix, components, limit, example=False, topology=None):
    if len(raw) > 2_000_000:
        raise ValueError("Datei zu groß (maximal 2 MB).")
    f, z = demo() if example else load_spectrum(raw, suffix)
    fits = search(components, limit, f, z) if topology is None else [fit_custom(topology, f, z)]
    return dict(f=f.tolist(), real=z.real.tolist(), imag=z.imag.tolist(), fits=fits)
