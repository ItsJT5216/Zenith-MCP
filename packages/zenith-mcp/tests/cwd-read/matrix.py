#!/usr/bin/env python3
"""Prism cwd-read matrix driver. See module docstring in harness.py.

For EACH owned tool, on EACH transport, this drives >=30 measured invocations:
first detection, stable repeated calls, immediate transitions inside the 5s
caller-cwd TTL, transitions after that TTL, back-to-back calls, cross-project
absolute controls, and (separately) two concurrent servers and error recovery.

The launcher's cwd IS the model-free evidence the server's ping reads
(/proc/<ppid>/cwd). We hold each server's OS cwd constant while changing the
launcher (parent) cwd to effect parent-cwd transitions. No invocation supplies
a cwd argument or any project/identity header.
"""
import argparse, json, os, sys, time, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import verifiers as V

FIXTURES = os.environ.get("PRISM_FIXTURES", H.DEFAULT_FIXTURES)

# A -> B -> A -> C -> B -> A (alpha, beta, gamma). Repeated transitions, same server.
SEQ = ["proj-alpha", "proj-beta", "proj-alpha", "proj-gamma", "proj-beta", "proj-alpha"]


def realproj(manifest, name):
    return manifest[name]["root"]  # realpath'd fixture project root


class Ctx:
    """Shared per-run context passed to verifiers. Subscriptable so verifier
    code can read c['manifest'] / c['expected_project'] directly."""
    def __init__(self, manifest, expected_project):
        self.manifest = manifest
        self.expected_project = expected_project

    def __getitem__(self, key):
        return getattr(self, key)


def build_steps(manifest):
    """Per-tool step builders. Each step: (tool, mode_label, make_call(project)->(args,verifier)).
    Relative relpaths are SHARED across fixtures so they never reveal the answer."""
    def A(name):  # accessor for project metadata
        return manifest[name]

    def steps_for_tool(tool):
        S = []
        if tool == "read_file":
            S.append(("raw-default", lambda p: V.make_read_file("marker.txt")))
            S.append(("raw-again", lambda p: V.make_read_file("marker.txt")))
            S.append(("nested", lambda p: V.make_read_file(f"nested/deep/deep_{A(p)['tag'].lower()}.txt")))
            S.append(("compressed", lambda p: V.make_read_file(f"src/big_{A(p)['tag'].lower()}.txt", compression=True, maxChars=4000)))
            S.append(("window-aroundLine", lambda p: V.make_read_file(f"src/big_{A(p)['tag'].lower()}.txt", aroundLine=200, context=5)))
            S.append(("ranges", lambda p: V.make_read_file(f"src/big_{A(p)['tag'].lower()}.txt", ranges=[{"startLine": 10, "endLine": 14}, {"startLine": 300, "endLine": 303}])))
        elif tool == "search_file":
            S.append(("grep-token", lambda p: V.make_search_file_grep("marker.txt", A(p)["token"])))
            S.append(("grep-notes", lambda p: V.make_search_file_grep(f"src/notes_{A(p)['tag'].lower()}.txt", A(p)["token"])))
            S.append(("symbol-fn", lambda p: V.make_search_file_symbol(f"src/code_{A(p)['tag'].lower()}.ts", A(p)["fn"], A(p)["tag"])))
        elif tool == "read_media_file":
            S.append(("image-png", lambda p: V.make_read_media(f"assets/img_{A(p)['tag'].lower()}.png", "png")))
            S.append(("audio-wav", lambda p: V.make_read_media(f"assets/snd_{A(p)['tag'].lower()}.wav", "wav")))
            S.append(("image-svg", lambda p: V.make_read_media(f"assets/icon_{A(p)['tag'].lower()}.svg", "svg")))
        elif tool == "read_multiple_files":
            S.append(("default-compression", lambda p: V.make_read_multiple(
                ["marker.txt", f"src/notes_{A(p)['tag'].lower()}.txt"], [A(p)["token"]])))
            S.append(("explicit-raw", lambda p: V.make_read_multiple(
                ["marker.txt", f"src/notes_{A(p)['tag'].lower()}.txt"], [A(p)["token"]], compression=False)))
            S.append(("three-files", lambda p: V.make_read_multiple(
                ["marker.txt", f"nested/deep/deep_{A(p)['tag'].lower()}.txt", f"src/notes_{A(p)['tag'].lower()}.txt"],
                [A(p)["token"]])))
        elif tool == "directory":
            S.append(("list-root", lambda p: V.make_directory("", "list",
                ["marker.txt", "src/", "assets/", "nested/"])))
            S.append(("list-src", lambda p: V.make_directory("src", "list",
                [f"code_{A(p)['tag'].lower()}.ts", f"notes_{A(p)['tag'].lower()}.txt", f"big_{A(p)['tag'].lower()}.txt"])))
            S.append(("tree-root", lambda p: V.make_directory("", "tree",
                ["marker.txt", f"code_{A(p)['tag'].lower()}.ts", f"img_{A(p)['tag'].lower()}.png", f"deep_{A(p)['tag'].lower()}.txt"])))
        elif tool == "search_files":
            S.append(("content-token", lambda p: V.make_search_files("", "content", A(p)["token"],
                {"contentQuery": A(p)["token"]})))
            S.append(("files-glob", lambda p: V.make_search_files("", "files", f"notes_{A(p)['tag'].lower()}.txt",
                {"namePattern": f"notes_{A(p)['tag'].lower()}.txt"})))
            S.append(("symbol-query", lambda p: V.make_search_files("", "symbol", A(p)["fn"],
                {"symbolQuery": A(p)["fn"]})))
        return S
    return steps_for_tool


def run_transition_matrix(srv, tool, manifest, recorder, run_id, transport, settle_s, include_postttl=True):
    """Drive SEQ on ONE server. For each project, run each step. The launcher's
    cwd is set to the project BEFORE its calls (parent-cwd transition). Server
    OS cwd is held constant (spawn dir). We separate immediate (in-TTL) from
    post-TTL by settling per phase when settle_s>0, and we also record a
    back-to-back pair with no settle inside the TTL."""
    steps_for_tool = build_steps(manifest)
    steps = steps_for_tool(tool)
    seq_index = 0
    # Plan covers, on the SAME server, with no restart and no cache clearing:
    #   - first detection on SEQ[0]
    #   - stable repeated back-to-back calls (no settle, deep inside the TTL)
    #   - the full A->B->A->C->B->A transition sequence IMMEDIATE (no settle:
    #     each transition lands inside the 5s caller-cwd TTL window)
    #   - the same transition sequence POST-TTL (settle past the 5s TTL each leg)
    # Immediate and post-TTL accuracy are recorded separately via ttl_boundary.
    plan = []
    first = SEQ[0]
    plan.append((first, "first-detection", 0))
    plan.append((first, "stable-repeat", 0))
    for i, proj in enumerate(SEQ[1:], 1):
        plan.append((proj, f"transition-immediate-{i}", 0))       # inside TTL
    if include_postttl:
        for i, proj in enumerate(SEQ[1:], 1):
            plan.append((proj, f"transition-postttl-{i}", settle_s))  # after TTL

    for proj, phase, settle in plan:
        expected_root = realproj(manifest, proj)
        os.chdir(expected_root)  # parent-cwd transition; server OS cwd unchanged
        if settle > 0:
            time.sleep(settle)   # allow caller-cwd TTL to expire -> post-TTL evidence
        # time boundary marker: immediate (in-TTL) vs post-TTL
        boundary = "post-ttl" if settle >= (H.CALLER_TTL_MS / 1000) else "immediate"
        for (mode_label, make_call) in steps:
            seq_index += 1
            args, verifier = make_call(proj)
            parent_cwd = os.getcwd()
            server_cwd = srv.server_proc_cwd()
            t0 = time.time()
            rpc = srv.call_tool(tool, args)
            dt = time.time() - t0
            ctx = Ctx(manifest, proj)
            try:
                status, reason, observed, extra = verifier(rpc, ctx)
            except Exception as e:
                status, reason, observed, extra = "harness-error", f"verifier:{type(e).__name__}:{e}", None, {}
            recorder.add(
                run_id=run_id, tool=tool, mode=mode_label, transport=transport,
                server_instance=srv.tag, seq_index=seq_index, phase=phase,
                ttl_boundary=boundary, settle_seconds=settle,
                elapsed_ms=round(dt * 1000, 2),
                evidence_topology=f"parent-cwd={os.path.basename(parent_cwd)};server-cwd={os.path.basename(server_cwd or '?')}",
                parent_proc_cwd=parent_cwd, server_proc_cwd=server_cwd,
                expected_active_root=expected_root,
                expected_project=proj, expected_relative_args=args,
                observed_project=observed, status=status, reason=reason,
                **(extra or {}),
            )
    return seq_index


def run_cross_project_controls(srv, manifest, recorder, run_id, transport):
    """Explicit ABSOLUTE cross-project controls, separately labeled. Caller stays
    in proj-alpha; an absolute read of proj-beta must read B without changing the
    active project for the subsequent implicit (relative) op."""
    home_proj = "proj-alpha"
    other = "proj-beta"
    os.chdir(realproj(manifest, home_proj))
    time.sleep(0.2)
    seq = 9000
    # relative baseline in A
    def rec(tool, mode, args, verifier, proj, phase, boundary):
        nonlocal seq
        seq += 1
        parent_cwd = os.getcwd(); server_cwd = srv.server_proc_cwd()
        t0 = time.time(); rpc = srv.call_tool(tool, args); dt = time.time() - t0
        ctx = Ctx(manifest, proj)
        try:
            status, reason, observed, extra = verifier(rpc, ctx)
        except Exception as e:
            status, reason, observed, extra = "harness-error", f"verifier:{e}", None, {}
        recorder.add(run_id=run_id, tool=tool, mode=mode, transport=transport,
                     server_instance=srv.tag, seq_index=seq, phase=phase,
                     ttl_boundary=boundary, settle_seconds=0, elapsed_ms=round(dt*1000, 2),
                     evidence_topology="cross-project-absolute-control",
                     parent_proc_cwd=parent_cwd, server_proc_cwd=server_cwd,
                     expected_active_root=realproj(manifest, proj),
                     expected_project=proj, expected_relative_args=args,
                     observed_project=observed, status=status, reason=reason, **(extra or {}))

    # 1) implicit relative in A (establishes A as the home project)
    a1, v1 = V.make_read_file("marker.txt")
    rec("read_file", "xproj-implicit-A", a1, v1, home_proj, "xproj", "immediate")
    # 2) explicit ABSOLUTE into B (must read B's content)
    absB = {"path": os.path.join(realproj(manifest, other), "marker.txt")}
    rec("read_file", "xproj-absolute-B", absB, _abs_verifier(manifest, other, "marker.txt"), other, "xproj", "immediate")
    # 3) implicit relative again — active project must still be A (B read must not move it)
    a3, v3 = V.make_read_file("marker.txt")
    rec("read_file", "xproj-implicit-A-after", a3, v3, home_proj, "xproj", "immediate")
    # directory absolute into B, then relative in A
    dB = {"mode": "list", "path": os.path.join(realproj(manifest, other), "src")}
    rec("directory", "xproj-absolute-B-list", dB, _abs_dir_verifier(manifest, other), other, "xproj", "immediate")
    d4, v4 = V.make_directory("src", "list", [f"code_{manifest[home_proj]['tag'].lower()}.ts"])
    rec("directory", "xproj-implicit-A-list-after", d4, v4, home_proj, "xproj", "immediate")
    # search_files absolute into B content, then relative in A
    sB = {"mode": "content", "path": os.path.join(realproj(manifest, other)), "contentQuery": manifest[other]["token"]}
    rec("search_files", "xproj-absolute-B-content", sB, _abs_search_verifier(manifest, other), other, "xproj", "immediate")
    s4, v4 = V.make_search_files("", "content", manifest[home_proj]["token"], {"contentQuery": manifest[home_proj]["token"]})
    rec("search_files", "xproj-implicit-A-content-after", s4, v4, home_proj, "xproj", "immediate")


def _abs_verifier(manifest, project, rel):
    def verify(rpc, c):
        if rpc.get("_transport_error"): return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc: return "operation-error", rpc["error"].get("message", "")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"): return "operation-error", "isError:" + (H.extract_text(rpc) or "")[:160], None, {}
        text = H.extract_text(rpc)
        proj, reason = V.classify_text_content(text, manifest, project, rel)
        if proj == project: return "pass", reason, proj, {}
        if proj is None: return "operation-error", f"abs-unmatched:{reason}", None, {}
        return "wrong-root", reason, proj, {}
    return verify


def _abs_dir_verifier(manifest, project):
    tag = manifest[project]["tag"].lower()
    def verify(rpc, c):
        if rpc.get("_transport_error"): return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc: return "operation-error", rpc["error"].get("message", "")[:200], None, {}
        if rpc.get("result", {}).get("isError"): return "operation-error", "isError", None, {}
        text = H.extract_text(rpc) or ""
        if f"code_{tag}.ts" in text: return "pass", "abs-dir-ok", project, {}
        return "operation-error", f"abs-dir-missing:{text[:120]!r}", None, {}
    return verify


def _abs_search_verifier(manifest, project):
    tok = manifest[project]["token"]
    def verify(rpc, c):
        if rpc.get("_transport_error"): return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc: return "operation-error", rpc["error"].get("message", "")[:200], None, {}
        if rpc.get("result", {}).get("isError"): return "operation-error", "isError", None, {}
        text = H.extract_text(rpc) or ""
        if tok in text: return "pass", "abs-search-ok", project, {}
        if text.strip() in ("No matches.", ""): return "operation-error", "abs-search-no-hit", None, {}
        return "operation-error", f"abs-search-unexpected:{text[:120]!r}", None, {}
    return verify


def summarize(records, out_path):
    per = {}
    for r in records:
        key = (r["tool"], r["transport"])
        per.setdefault(key, {"planned": 0, "attempted": 0, "correct": 0, "wrong-root": 0,
                             "operation-error": 0, "harness-error": 0, "unsupported": 0})
    for r in records:
        key = (r["tool"], r["transport"])
        per[key]["planned"] += 1
        st = r["status"]
        if st in ("pass", "wrong-root", "operation-error"):
            per[key]["attempted"] += 1
        if st == "pass":
            per[key]["correct"] += 1
        elif st in per[key]:
            per[key][st] += 1
        else:
            per[key]["operation-error"] += 1
    lines = []
    lines.append(f"{'tool':<20}{'transport':<11}{'planned':>8}{'attempted':>10}{'correct':>9}{'wrong-root':>11}{'op-err':>8}{'harness-err':>12}{'unsup':>7}")
    for (tool, transport), m in sorted(per.items()):
        lines.append(f"{tool:<20}{transport:<11}{m['planned']:>8}{m['attempted']:>10}{m['correct']:>9}{m['wrong-root']:>11}{m['operation-error']:>8}{m['harness-error']:>12}{m['unsupported']:>7}")
    table = "\n".join(lines)
    with open(out_path, "w") as f:
        f.write(table + "\n")
    return per, table
