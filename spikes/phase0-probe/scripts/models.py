# /// script
# requires-python = ">=3.11"
# dependencies = ["huggingface_hub>=0.34", "onnx>=1.18", "onnxruntime>=1.22", "numpy>=2"]
# ///
"""Phase 0 model tooling for the probe's WebGPU benchmark harness.

  uv run scripts/models.py fetch [ids...|--all]     download registry graphs into models/<id>/
  uv run scripts/models.py inspect [ids...|--all]   write graph I/O metadata to src/models/graph-metadata.json
  uv run scripts/models.py fixtures [ids...|--all]  CPU onnxruntime known-answer fixtures in models/<id>/fixtures/

The browser harness reads the same registry, so input generation rules here mirror
src/spikes/model-inputs.ts; fixtures carry their inputs so the two never need to agree exactly.
"""

from __future__ import annotations

import argparse
import base64
import json
import shutil
import sys
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "src" / "models" / "registry.json"
METADATA = ROOT / "src" / "models" / "graph-metadata.json"
MODELS = ROOT / "models"
FIXTURE_MAX_BYTES = 32 * 2**20

ONNX_TO_NP = {
    1: np.float32, 2: np.uint8, 3: np.int8, 5: np.int16, 6: np.int32, 7: np.int64,
    9: np.bool_, 10: np.float16, 11: np.float64, 12: np.uint32, 13: np.uint64,
}
ORT_TYPE_TO_NP = {
    "tensor(float)": np.float32, "tensor(float16)": np.float16, "tensor(double)": np.float64,
    "tensor(int64)": np.int64, "tensor(int32)": np.int32, "tensor(int8)": np.int8,
    "tensor(uint8)": np.uint8, "tensor(bool)": np.bool_,
}
NP_TO_ORT_WEB = {
    np.float32: "float32", np.float16: "float16", np.float64: "float64", np.int64: "int64",
    np.int32: "int32", np.int8: "int8", np.uint8: "uint8", np.bool_: "bool",
}


def registry() -> list[dict]:
    return json.loads(REGISTRY.read_text())["models"]


def select(ids: list[str], all_: bool) -> list[dict]:
    models = [m for m in registry() if m.get("graphs")]
    if all_:
        return models
    unknown = set(ids) - {m["id"] for m in models}
    if unknown:
        sys.exit(f"unknown or export-less model ids: {sorted(unknown)}")
    return [m for m in models if m["id"] in ids]


def files_for(model: dict) -> list[str]:
    out: list[str] = []
    for g in model["graphs"]:
        out.append(g["file"])
        out.extend(g.get("externalData", []))
    return out


def fetch(model: dict) -> None:
    dest = MODELS / model["id"]
    dest.mkdir(parents=True, exist_ok=True)
    src = model["source"]
    for rel in files_for(model):
        target = dest / rel
        if target.exists() and target.stat().st_size > 0:
            print(f"  have {model['id']}/{rel}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        print(f"  get  {model['id']}/{rel}", flush=True)
        if src["type"] == "hf":
            from huggingface_hub import hf_hub_download

            cached = hf_hub_download(src["repo"], rel, revision=src.get("revision", "main"))
            shutil.copyfile(cached, target)
        elif src["type"] == "url":
            tmp = target.with_suffix(target.suffix + ".part")
            urllib.request.urlretrieve(src["url"], tmp)
            tmp.rename(target)
        else:
            sys.exit(f"unsupported source type {src['type']}")


def resolve_shape(name: str, shape: list, graph: dict) -> list[int]:
    if name in graph.get("shapes", {}):
        return list(graph["shapes"][name])
    dims = graph.get("dims", {})
    out = []
    for d in shape:
        if isinstance(d, int) and d > 0:
            out.append(d)
        elif isinstance(d, str) and d in dims:
            out.append(int(dims[d]))
        else:
            out.append(1)
    return out


def make_input(name: str, dtype, shape: list[int], graph: dict, rng: np.random.Generator) -> np.ndarray:
    values = graph.get("values", {})
    lname = name.lower()
    if name in values:
        return np.full(shape, values[name], dtype=dtype)
    if dtype == np.bool_:
        return np.ones(shape, dtype=np.bool_)
    if np.issubdtype(dtype, np.integer):
        if "mask" in lname:
            return np.ones(shape, dtype=dtype)
        if "position" in lname:
            n = shape[-1] if shape else 1
            return np.broadcast_to(np.arange(n, dtype=dtype), shape).copy()
        if "length" in lname or lname in ("sr", "sample_rate"):
            return np.full(shape, shape[-1] if shape else 1, dtype=dtype)
        return rng.integers(1, 1000, size=shape).astype(dtype)
    return (rng.standard_normal(shape) * 0.5).astype(dtype)


def inspect(model: dict, metadata: dict) -> None:
    import onnx

    for g in model["graphs"]:
        path = MODELS / model["id"] / g["file"]
        if not path.exists():
            print(f"  skip {model['id']}/{g['name']}: not fetched")
            continue
        proto = onnx.load(str(path), load_external_data=False)

        def io(values):
            res = []
            for v in values:
                t = v.type.tensor_type
                shape = [d.dim_value if d.HasField("dim_value") else (d.dim_param or "?") for d in t.shape.dim]
                np_type = ONNX_TO_NP.get(t.elem_type)
                dtype = next((n for k, n in NP_TO_ORT_WEB.items() if np_type is not None and np.dtype(k) == np.dtype(np_type)), str(t.elem_type))
                res.append({"name": v.name, "dtype": dtype, "shape": shape})
            return res

        ops: dict[str, int] = {}
        for node in proto.graph.node:
            key = f"{node.domain + '.' if node.domain else ''}{node.op_type}"
            ops[key] = ops.get(key, 0) + 1
        initializer_names = {i.name for i in proto.graph.initializer}
        metadata[f"{model['id']}/{g['name']}"] = {
            "opset": [{"domain": o.domain or "ai.onnx", "version": o.version} for o in proto.opset_import],
            "inputs": [i for i in io(proto.graph.input) if i["name"] not in initializer_names],
            "outputs": io(proto.graph.output),
            "opCounts": dict(sorted(ops.items(), key=lambda kv: -kv[1])),
            "fileBytes": path.stat().st_size + sum((MODELS / model["id"] / e).stat().st_size for e in g.get("externalData", []) if (MODELS / model["id"] / e).exists()),
        }
        print(f"  {model['id']}/{g['name']}: {len(proto.graph.node)} nodes, inputs {[i['name'] for i in metadata[model['id'] + '/' + g['name']]['inputs']]}")


def encode(arr: np.ndarray) -> dict:
    arr = np.ascontiguousarray(arr)
    data = arr.astype(np.uint8).tobytes() if arr.dtype == np.bool_ else arr.tobytes()
    dtype = next(name for t, name in NP_TO_ORT_WEB.items() if np.dtype(t) == arr.dtype)
    return {"dtype": dtype, "shape": list(arr.shape), "b64": base64.b64encode(data).decode()}


def fixtures(model: dict) -> None:
    import onnxruntime as ort

    for g in model["graphs"]:
        path = MODELS / model["id"] / g["file"]
        if not path.exists():
            print(f"  skip {model['id']}/{g['name']}: not fetched")
            continue
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        try:
            sess = ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])
        except Exception as e:  # noqa: BLE001 - report and continue with the other graphs
            print(f"  FAIL load {model['id']}/{g['name']}: {e}")
            continue
        rng = np.random.default_rng(20260913)
        feeds = {}
        for i in sess.get_inputs():
            dtype = ORT_TYPE_TO_NP[i.type]
            feeds[i.name] = make_input(i.name, dtype, resolve_shape(i.name, i.shape, g), g, rng)
        in_bytes = sum(v.nbytes for v in feeds.values())
        if in_bytes > FIXTURE_MAX_BYTES:
            print(f"  skip fixture {model['id']}/{g['name']}: inputs {in_bytes >> 20} MiB")
            continue
        try:
            outs = sess.run(None, feeds)
        except Exception as e:  # noqa: BLE001
            print(f"  FAIL run {model['id']}/{g['name']}: {e}")
            continue
        out_bytes = sum(o.nbytes for o in outs)
        if out_bytes > FIXTURE_MAX_BYTES:
            print(f"  skip fixture {model['id']}/{g['name']}: outputs {out_bytes >> 20} MiB")
            continue
        fixture = {
            "reference": f"onnxruntime {ort.__version__} CPUExecutionProvider",
            "inputs": {k: encode(v) for k, v in feeds.items()},
            "outputs": {o.name: encode(v) for o, v in zip(sess.get_outputs(), outs)},
        }
        out = MODELS / model["id"] / "fixtures" / f"{g['name']}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(fixture))
        print(f"  wrote {out.relative_to(ROOT)} ({(in_bytes + out_bytes) >> 10} KiB)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["fetch", "inspect", "fixtures", "list"])
    p.add_argument("ids", nargs="*")
    p.add_argument("--all", action="store_true")
    args = p.parse_args()

    if args.command == "list":
        for m in registry():
            status = m.get("status", "export-available")
            print(f"{m['id']:32} {m['role']:18} {status:18} {'default' if m.get('catalogDefault') else ''}")
        return
    models = select(args.ids, args.all)
    if args.command == "fetch":
        for m in models:
            fetch(m)
    elif args.command == "inspect":
        metadata = json.loads(METADATA.read_text()) if METADATA.exists() else {}
        for m in models:
            inspect(m, metadata)
        METADATA.write_text(json.dumps(dict(sorted(metadata.items())), indent=1) + "\n")
    elif args.command == "fixtures":
        for m in models:
            fixtures(m)


if __name__ == "__main__":
    main()
