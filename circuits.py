"""Search passive series/parallel circuits from a user-selected element library."""
from collections import Counter
from itertools import product

import numpy as np
from scipy.optimize import least_squares


ELEMENTS = {
    "R": ("R",), "C": ("C",), "L": ("L",), "Q": ("Q", "n"),
    "W": ("A",), "Wo": ("Z0", "tau"), "Ws": ("Z0", "tau"),
    "G": ("R", "tau"), "La": ("L", "n"),
}
MAX_ELEMENTS = 7
MAX_CUSTOM_ELEMENTS = 12
BEAM_WIDTH = 5


def element_impedance(kind, w, a, b=None):
    if kind == "R":
        return np.full_like(w, a)
    if kind == "C":
        return 1 / (a * w)
    if kind == "L":
        return a * w
    if kind == "Q":
        return 1 / (a * w ** b)
    if kind == "W":
        return a * np.sqrt(2 / w)
    if kind == "G":
        return a / np.sqrt(1 + w * b)
    if kind == "La":
        return a * w ** b
    root = np.sqrt(w * b)
    # tanh is indistinguishable from 1 for these large positive real parts.
    tanh = np.tanh(np.where(root.real > 20, 20, root))
    if kind == "Wo":
        return a / (root * tanh)
    return a * tanh / root


def join(op, left, right):
    children = []
    for branch in (left, right):
        children.extend(branch[1:] if isinstance(branch, tuple) and branch[0] == op else [branch])
    # Identical ideal elements in the same group collapse into one.
    ideal = [x for x in children if isinstance(x, str) and x in ("R", "C", "L", "W")]
    if len(set(ideal)) != len(ideal):
        return None
    return (op, *sorted(children, key=str))


def compile_circuit(tree, f, z):
    w = 2j * np.pi * f
    center = np.sqrt(abs(w[0] * w[-1]))
    scale = np.exp(np.median(np.log(abs(z))))
    low, high, initial, names = [], [], [], []
    counts = Counter()

    def build(node):
        if isinstance(node, str):
            counts[node] += 1
            index = len(names)
            for parameter in ELEMENTS[node]:
                names.append(f"{node}{counts[node]} {parameter}")
                if parameter == "n":
                    low.append(.2)
                    high.append(1.)
                    initial.append(.85)
                else:
                    guess = {"C": 1/(scale*center), "Q": 1/(scale*center**.85),
                             "L": scale/center, "A": scale*np.sqrt(center/2),
                             "tau": 1/center}.get(parameter, scale)
                    low.append(-32.)
                    high.append(32.)
                    initial.append(np.log10(guess))

            def evaluate(x):
                a = 10 ** x[index]
                if len(ELEMENTS[node]) == 1:
                    return element_impedance(node, w, a)
                b = x[index+1] if ELEMENTS[node][1] == "n" else 10 ** x[index+1]
                return element_impedance(node, w, a, b)
            return node, evaluate

        children = [build(child) for child in node[1:]]
        op = node[0]
        label = "(" + (" + " if op == "s" else " ∥ ").join(child[0] for child in children) + ")"

        def evaluate(x):
            branches = [child[1](x) for child in children]
            if op == "s":
                return sum(branches)
            admittance = sum(1 / branch for branch in branches)
            return 1 / np.where(abs(admittance) < 1e-75, 1e-75, admittance)
        return label, evaluate

    label, evaluate = build(tree)
    return label, evaluate, names, np.array(initial), np.array(low), np.array(high)


def fit_tree(tree, f, z, starts=1, max_evaluations=65):
    label, evaluate, names, initial, low, high = compile_circuit(tree, f, z)
    n, k = 2 * len(f), len(names)
    if n <= k+1:
        return None

    def residual(x):
        with np.errstate(over="ignore", divide="ignore", invalid="ignore"):
            error = (evaluate(x) - z) / abs(z)
        return np.clip(np.nan_to_num(np.r_[error.real, error.imag], nan=1e30), -1e30, 1e30)

    rng = np.random.default_rng(42)
    guesses = [initial] + [initial + rng.normal(0, np.where(high == 1, .14, 1.8)) for _ in range(starts-1)]
    best = min(
        (least_squares(residual, np.clip(x, low+1e-7, high-1e-7),
                       bounds=(low, high), max_nfev=max_evaluations) for x in guesses),
        key=lambda result: result.cost,
    )
    sse = 2 * best.cost
    pred = evaluate(best.x)
    if not np.all(np.isfinite(pred)):
        return None
    values = [float(x if h == 1 else 10**x) for x, h in zip(best.x, high)]
    return dict(
        model=label, topology=tree, elements=sum(1 for _ in _leaves(tree)),
        parameters=dict(zip(names, values)), rms=100*np.sqrt(sse/len(f)),
        aicc=n*np.log(max(sse/n, 1e-300))+2*k+2*k*(k+1)/(n-k-1),
        limited=bool(np.any(best.active_mask) or not best.success or np.linalg.cond(best.jac) > 1e6),
        real=pred.real.tolist(), imag=pred.imag.tolist(),
    )


def _leaves(tree):
    if isinstance(tree, str):
        yield ELEMENTS[tree]
    else:
        for child in tree[1:]:
            yield from _leaves(child)


def validate_custom(tree, point_count):
    """Validate without sorting, flattening or simplifying the user's circuit."""
    def visit(node, depth):
        if depth > MAX_CUSTOM_ELEMENTS:
            raise ValueError("Das Schaltbild ist zu tief verschachtelt.")
        if isinstance(node, str) and node in ELEMENTS:
            return node, 1, len(ELEMENTS[node])
        if (not isinstance(node, (list, tuple)) or not 3 <= len(node) <= MAX_CUSTOM_ELEMENTS + 1
                or node[0] not in ("s", "p")):
            raise ValueError("Wähle gültige Bauteile. Jede Reihe oder Parallelschaltung braucht mindestens zwei Zweige.")
        branches = [visit(branch, depth+1) for branch in node[1:]]
        return (node[0], *(branch[0] for branch in branches)), sum(b[1] for b in branches), sum(b[2] for b in branches)

    topology, count, parameters = visit(tree, 0)
    if count > MAX_CUSTOM_ELEMENTS:
        raise ValueError(f"Eigene Schaltbilder dürfen höchstens {MAX_CUSTOM_ELEMENTS} Bauteile enthalten.")
    if 2 * point_count <= parameters + 1:
        raise ValueError("Zu wenige Frequenzpunkte für die Zahl der freien Parameter.")
    return topology


def fit_custom(tree, f, z):
    topology = validate_custom(tree, len(f))
    result = fit_tree(topology, f, z, starts=9, max_evaluations=800)
    if result is None:
        raise ValueError("Für dieses Schaltbild wurde kein auswertbarer Fit gefunden.")
    return result


def search(components, limit, f, z):
    allowed = set(components.split(",")) if components else set()
    if not allowed or not allowed <= ELEMENTS.keys() or not 1 <= limit <= MAX_ELEMENTS:
        raise ValueError("Wähle mindestens ein Bauteil und eine Obergrenze von 1 bis 7.")
    # Screen on a logarithmically distributed subset, then refit finalists on all points.
    sample = np.unique(np.linspace(0, len(f)-1, min(len(f), 90), dtype=int))
    groups, finalists = {}, []
    for size in range(1, limit+1):
        if size == 1:
            candidates = allowed
        else:
            candidates = {
                join(op, left, right)
                for split in range(1, size//2+1)
                for op, left, right in product(("s", "p"), groups[split], groups[size-split])
            } - {None}
        ranked = []
        for candidate in sorted(candidates, key=str):
            result = fit_tree(candidate, f[sample], z[sample])
            if result is not None:
                ranked.append((result["aicc"], candidate))
        ranked.sort(key=lambda item: item[0])
        groups[size] = [candidate for _, candidate in ranked[:BEAM_WIDTH]]
        finalists.extend(groups[size][:2])
    # Include the established coating topology when its ingredients are allowed.
    if limit >= 5 and {"R", "Q"} <= allowed:
        finalists.append(join("s", "R", join("p", "Q", join("s", "R", join("p", "R", "Q")))))
    results = [fit_tree(tree, f, z, starts=5, max_evaluations=350) for tree in dict.fromkeys(finalists)]
    return sorted((result for result in results if result is not None), key=lambda item: item["aicc"])
