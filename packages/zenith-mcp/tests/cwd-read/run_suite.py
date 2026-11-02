#!/usr/bin/env python3
"""Prism cwd-read suite runner — the command the orchestrator executes.

  python3 run_suite.py --repo-root <repo> --out-dir <dir> [--run-id 1] \
      [--transport both|stdio|http] [--tools all] [--quick]

Spawns real dist/cli/stdio.js and dist/server/http.js servers from --repo-root,
runs the full per-tool matrix, cross-project absolute controls, two concurrent
servers, and transport error recovery; writes machine-readable JSON records plus
human-readable per-tool tables. Exit 0 on harness success regardless of product
pass/fail (those are data), non-zero on harness failure.

The SAME script runs against the frozen baseline and the final build by passing
a different --repo-root. Settle behaviour: the transition matrix uses a 6s
settle for the post-TTL leg and a 0s settle for the immediate leg, recorded
separately via ttl_boundary; no cache is cleared and no refresh call is issued.
"""
import argparse, json, os, sys, time, secrets, shutil

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import verifiers as V
import matrix as M

BASE = H.BASE
SCRATCH = os.path.join(BASE, "agents", "prism")
FIXTURES = os.environ.get("PRISM_FIXTURES", os.path.join(SCRATCH, "fixtures"))

SETTLE_POST_TTL = 6.2   # > 5s caller-cwd TTL (detection/process-tree.ts)


def ensure_fixtures():
    if not os.path.exists(os.path.join(FIXTURES, "fixtures-manifest.json")):
        import subprocess
        subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "build_fixtures.py"), FIXTURES],
                       check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--run-id", type=int, default=1)
    ap.add_argument("--transport", default="both", choices=["both", "stdio", "http"])
    ap.add_argument("--tools", default="all")
    ap.add_argument("--quick", action="store_true", help="reduced settle for smoke runs")
    args = ap.parse_args()

    ensure_fixtures()
    manifest = V.load_manifest()
    os.makedirs(args.out_dir, exist_ok=True)
    run_home = os.path.join(args.out_dir, f"home-run{args.run_id}")
    os.makedirs(run_home, exist_ok=True)

    tools = H.OWNED_TOOLS if args.tools == "all" else [t.strip() for t in args.tools.split(",")]
    transports = ["stdio", "http"] if args.transport == "both" else [args.transport]
    settle = 1.0 if args.quick else SETTLE_POST_TTL

    rec = V.Recorder()
    meta = {"run_id": args.run_id, "repo_root": os.path.abspath(args.repo_root),
            "transport": args.transport, "tools": tools, "settle_seconds": settle,
            "quick": args.quick, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fixtures": FIXTURES, "caller_ttl_ms": H.CALLER_TTL_MS}

    # Capture a tools/list inventory per transport on a probe server.
    inventory = {}
    servers = []
    try:
        for transport in transports:
            # one probe server per transport for inventory
            token = secrets.token_hex(16)
            port = H.free_port() if transport == "http" else None
            home = os.path.join(run_home, f"inventory-{transport}")
            os.makedirs(home, exist_ok=True)
            H.write_isolated_config(home, port=port or 7099)
            spawn_cwd = os.path.realpath(os.path.join(FIXTURES, "proj-alpha"))
            srv = H.ServerHandle(args.repo_root, transport, home, f"inventory-{transport}",
                                 spawn_cwd, token=token, port=port).start()
            servers.append(srv)
            tl = srv.tools_list()
            names = []
            if tl and "result" in tl and isinstance(tl["result"], dict):
                names = [t.get("name") for t in tl["result"].get("tools", [])]
            inventory[transport] = names
            rec.add(run_id=args.run_id, tool="(inventory)", mode="tools/list", transport=transport,
                    server_instance=srv.tag, seq_index=0, phase="inventory", ttl_boundary="n/a",
                    settle_seconds=0, elapsed_ms=0,
                    evidence_topology="inventory", parent_proc_cwd=os.getcwd(),
                    server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=None, expected_project=None, expected_relative_args={},
                    observed_project=None,
                    status=("pass" if all(t in names for t in H.OWNED_TOOLS) else "operation-error"),
                    reason=f"registered={len(names)}; owned-present={all(t in names for t in H.OWNED_TOOLS)}",
                    registered_tools=names)
            srv.stop(); servers.remove(srv)

        # Per-tool x per-transport matrix on a dedicated server each.
        for transport in transports:
            for tool in tools:
                token = secrets.token_hex(16)
                port = H.free_port() if transport == "http" else None
                home = os.path.join(run_home, f"{tool}-{transport}")
                os.makedirs(home, exist_ok=True)
                H.write_isolated_config(home, port=port or 7099)
                spawn_cwd = os.path.realpath(os.path.join(FIXTURES, "proj-alpha"))
                srv = H.ServerHandle(args.repo_root, transport, home, f"{tool}-{transport}",
                                     spawn_cwd, token=token, port=port).start()
                servers.append(srv)
                try:
                    if transport == "stdio":
                        srv.rpc("initialize", {"protocolVersion": H.PROTO_LEGACY, "capabilities": {},
                                               "clientInfo": {"name": "prism", "version": "0"}}, modern=False)
                    # quick mode: skip the post-TTL legs (settle< TTL would mislabel
                    # them); full mode runs both immediate and post-TTL legs.
                    M.run_transition_matrix(srv, tool, manifest, rec, args.run_id, transport, settle,
                                            include_postttl=not args.quick)
                    M.run_cross_project_controls(srv, manifest, rec, args.run_id, transport)
                finally:
                    srv.stop(); servers.remove(srv)

        # Two independent servers operating concurrently (separate homes/processes).
        run_concurrent(args, manifest, rec, transports)
        # Transport error recovery.
        run_error_recovery(args, manifest, rec, transports)
        # Special evidence topologies: git-file/worktree, marker-only, symlink +
        # spaces, and markerless junk source evidence.
        run_special_topologies(args, manifest, rec, transports)
        # Enabled-sandbox boundary controls (opt-in enforcement).
        run_sandbox_boundary(args, manifest, rec, transports)
        # Separately-labeled independent HTTP-client negative control.
        if "http" in transports:
            run_http_independent_client(args, manifest, rec)
    finally:
        for s in servers:
            s.stop()

    json_path = os.path.join(args.out_dir, f"records-run{args.run_id}.json")
    rec.write(json_path)
    table_path = os.path.join(args.out_dir, f"table-run{args.run_id}.txt")
    per, table = M.summarize(rec.records, table_path)
    meta["inventory"] = inventory
    meta["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    meta["records"] = len(rec.records)
    meta["summary"] = {f"{k[0]}|{k[1]}": v for k, v in per.items()}
    with open(os.path.join(args.out_dir, f"meta-run{args.run_id}.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(table)
    print(f"\nWROTE {json_path}")
    print(f"WROTE {table_path}")
    return 0


def run_concurrent(args, manifest, rec, transports):
    """Two independent servers (separate processes + homes) active at once, each
    driven from a distinct launcher cwd. Verifies independent per-process context."""
    seq = 7000
    for transport in transports:
        tokenA, tokenB = secrets.token_hex(16), secrets.token_hex(16)
        portA = H.free_port() if transport == "http" else None
        portB = H.free_port() if transport == "http" else None
        homeA = os.path.join(args.out_dir, f"home-run{args.run_id}", f"conc-A-{transport}")
        homeB = os.path.join(args.out_dir, f"home-run{args.run_id}", f"conc-B-{transport}")
        os.makedirs(homeA, exist_ok=True); os.makedirs(homeB, exist_ok=True)
        H.write_isolated_config(homeA, port=portA or 7099)
        H.write_isolated_config(homeB, port=portB or 7099)
        cwdA = os.path.realpath(os.path.join(FIXTURES, "proj-alpha"))
        cwdB = os.path.realpath(os.path.join(FIXTURES, "proj-beta"))
        srvA = H.ServerHandle(args.repo_root, transport, homeA, f"conc-A-{transport}", cwdA, token=tokenA, port=portA).start()
        srvB = H.ServerHandle(args.repo_root, transport, homeB, f"conc-B-{transport}", cwdB, token=tokenB, port=portB).start()
        try:
            if transport == "stdio":
                for s in (srvA, srvB):
                    s.rpc("initialize", {"protocolVersion": H.PROTO_LEGACY, "capabilities": {},
                                         "clientInfo": {"name": "prism", "version": "0"}}, modern=False)
            # Two live server instances share this launcher. Set its cwd for
            # each sequential call; this is instance coverage, not concurrent
            # different-requester attribution.
            for srv, proj in ((srvA, "proj-alpha"), (srvB, "proj-beta")):
                os.chdir(M.realproj(manifest, proj))
                argspec, verifier = V.make_read_file("marker.txt")
                seq += 1
                t0 = time.time(); rpc = srv.call_tool("read_file", argspec); dt = time.time() - t0
                ctx = M.Ctx(manifest, proj)
                try:
                    status, reason, observed, extra = verifier(rpc, ctx)
                except Exception as e:
                    status, reason, observed, extra = "harness-error", f"{e}", None, {}
                rec.add(run_id=args.run_id, tool="read_file", mode="concurrent-relative", transport=transport,
                        server_instance=srv.tag, seq_index=seq, phase="concurrent", ttl_boundary="n/a",
                        settle_seconds=0, elapsed_ms=round(dt*1000, 2),
                        evidence_topology=f"two-servers;instance={srv.tag}",
                        parent_proc_cwd=os.getcwd(), server_proc_cwd=srv.server_proc_cwd(),
                        expected_active_root=M.realproj(manifest, proj), expected_project=proj,
                        expected_relative_args=argspec, observed_project=observed,
                        status=status, reason=reason, **(extra or {}))
        finally:
            srvA.stop(); srvB.stop()


def run_error_recovery(args, manifest, rec, transports):
    """Meaningful transport error recovery: a schema rejection and a missing-path
    read must produce an error, after which a valid call must still succeed on the
    same server (the server recovers; detection state is unaffected by the error)."""
    seq = 8000
    for transport in transports:
        token = secrets.token_hex(16)
        port = H.free_port() if transport == "http" else None
        home = os.path.join(args.out_dir, f"home-run{args.run_id}", f"err-{transport}")
        os.makedirs(home, exist_ok=True)
        H.write_isolated_config(home, port=port or 7099)
        cwd = os.path.realpath(os.path.join(FIXTURES, "proj-alpha"))
        srv = H.ServerHandle(args.repo_root, transport, home, f"err-{transport}", cwd, token=token, port=port).start()
        try:
            if transport == "stdio":
                srv.rpc("initialize", {"protocolVersion": H.PROTO_LEGACY, "capabilities": {},
                                       "clientInfo": {"name": "prism", "version": "0"}}, modern=False)
            os.chdir(cwd)
            # 1) schema rejection (missing required path)
            seq += 1
            t0 = time.time(); bad = srv.call_tool("read_file", {}); dt = time.time() - t0
            is_err = (bad.get("_transport_error")) or ("error" in bad) or bad.get("result", {}).get("isError")
            rec.add(run_id=args.run_id, tool="read_file", mode="error-schema-reject", transport=transport,
                    server_instance=srv.tag, seq_index=seq, phase="error-recovery", ttl_boundary="n/a",
                    settle_seconds=0, elapsed_ms=round(dt*1000, 2), evidence_topology="error-recovery",
                    parent_proc_cwd=os.getcwd(), server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=cwd, expected_project="proj-alpha",
                    expected_relative_args={}, observed_project=None,
                    status=("pass" if is_err else "operation-error"),
                    reason="schema-rejection-returned" if is_err else "schema-not-rejected")
            # 2) missing path read (operational error, not a crash)
            seq += 1
            t0 = time.time(); miss = srv.call_tool("read_file", {"path": "does/not/exist.txt"}); dt = time.time() - t0
            miss_err = (miss.get("_transport_error")) or ("error" in miss) or miss.get("result", {}).get("isError")
            rec.add(run_id=args.run_id, tool="read_file", mode="error-missing-path", transport=transport,
                    server_instance=srv.tag, seq_index=seq, phase="error-recovery", ttl_boundary="n/a",
                    settle_seconds=0, elapsed_ms=round(dt*1000, 2), evidence_topology="error-recovery",
                    parent_proc_cwd=os.getcwd(), server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=cwd, expected_project="proj-alpha",
                    expected_relative_args={"path": "does/not/exist.txt"}, observed_project=None,
                    status=("pass" if miss_err else "operation-error"),
                    reason="missing-path-errored" if miss_err else "missing-path-not-errored")
            # 3) valid call afterwards still works (recovery)
            seq += 1
            argspec, verifier = V.make_read_file("marker.txt")
            t0 = time.time(); ok = srv.call_tool("read_file", argspec); dt = time.time() - t0
            ctx = M.Ctx(manifest, "proj-alpha")
            try:
                status, reason, observed, extra = verifier(ok, ctx)
            except Exception as e:
                status, reason, observed, extra = "harness-error", f"{e}", None, {}
            rec.add(run_id=args.run_id, tool="read_file", mode="error-recovery-valid-after", transport=transport,
                    server_instance=srv.tag, seq_index=seq, phase="error-recovery", ttl_boundary="n/a",
                    settle_seconds=0, elapsed_ms=round(dt*1000, 2), evidence_topology="error-recovery",
                    parent_proc_cwd=os.getcwd(), server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=cwd, expected_project="proj-alpha",
                    expected_relative_args=argspec, observed_project=observed,
                    status=status, reason="post-error-" + reason, **(extra or {}))
        finally:
            srv.stop()


def run_special_topologies(args, manifest, rec, transports):
    """Evidence-topology coverage beyond the A/B/C git-dir projects:
      - proj-wt:      git-FILE worktree (.git is a pointer file) — detected as its own root
      - proj-gamma:   marker-ONLY project (package.json, no .git)
      - proj-sp ace:  a git project whose real path contains a SPACE, also reachable
                      through the 'link-to-space' SYMLINK
      - junk-plain:   markerless directory (no .git, no markers) — junk source evidence;
                      a relative read there must NOT bind it as a project (never-refuse
                      degrades to global, but the FILE must still be read).
    Each runs a relative read from the topology as the launcher cwd (the model-free
    evidence), on a fresh server per transport, and asserts the returned content
    matches the on-disk file actually under that cwd. The junk-plain case expects
    the read to succeed with junk content (never-refuse) — detection refusing would
    be a product failure, recorded as operation-error, not silently passed."""
    seq = 6000
    cases = [
        ("proj-wt", "marker.txt", "git-file-worktree"),
        ("proj-gamma", "marker.txt", "marker-only"),
        ("proj-sp ace", "marker.txt", "space-in-path"),
        ("junk-plain", "marker.txt", "markerless-junk"),
    ]
    for transport in transports:
        token = secrets.token_hex(16)
        port = H.free_port() if transport == "http" else None
        home = os.path.join(args.out_dir, f"home-run{args.run_id}", f"topo-{transport}")
        os.makedirs(home, exist_ok=True)
        H.write_isolated_config(home, port=port or 7099)
        # spawn the server from a NEUTRAL cwd (the markerless fixtures root) so the
        # launch dir is not itself one of the topology projects under test.
        neutral = os.path.realpath(FIXTURES)
        srv = H.ServerHandle(args.repo_root, transport, home, f"topo-{transport}", neutral, token=token, port=port).start()
        try:
            if transport == "stdio":
                srv.rpc("initialize", {"protocolVersion": H.PROTO_LEGACY, "capabilities": {},
                                       "clientInfo": {"name": "prism", "version": "0"}}, modern=False)
            for proj, rel, label in cases:
                seq += 1
                cwd = os.path.realpath(os.path.join(FIXTURES, proj))
                os.chdir(cwd)
                time.sleep(0.3)  # let the ping observe the new parent cwd
                argspec = {"path": rel}
                t0 = time.time(); rpc = srv.call_tool("read_file", argspec); dt = time.time() - t0
                expected_bytes = V.expected_file_bytes(proj, rel).decode("utf-8", "replace")
                text = H.extract_text(rpc) or ""
                tok = manifest.get(proj, {}).get("token") if proj in manifest else "JUNK-TOKEN-0e0f0"
                if rpc.get("_transport_error"):
                    status, reason, observed = "harness-error", rpc["_transport_error"], None
                elif "error" in rpc:
                    status, reason, observed = "operation-error", rpc["error"].get("message", "")[:160], None
                elif rpc.get("result", {}).get("isError"):
                    wp = V.enoent_project(text, manifest)
                    # The read did not land in the expected project. Attribute the tree
                    # it actually hit: another fixture project, else the server's neutral
                    # launch dir (relative resolution via process.cwd ignores detection).
                    where = wp if wp else f"launch-dir:{os.path.basename(neutral)}"
                    status, reason, observed = "wrong-root", f"enoent-under-other:{where}", wp
                elif tok in text:
                    status, reason, observed = "pass", "expected-content", proj
                else:
                    # what did we actually read?
                    wp = None
                    for n, m in manifest.items():
                        if m["token"] in text: wp = n; break
                    status = "wrong-root" if wp else "operation-error"
                    reason = (f"read-other:{wp}" if wp else f"no-fixture-token:{text[:80]!r}")
                    observed = wp
                rec.add(run_id=args.run_id, tool="read_file", mode=f"topo-{label}", transport=transport,
                        server_instance=srv.tag, seq_index=seq, phase="special-topology",
                        ttl_boundary="n/a", settle_seconds=0.3, elapsed_ms=round(dt*1000, 2),
                        evidence_topology=label, parent_proc_cwd=os.getcwd(),
                        server_proc_cwd=srv.server_proc_cwd(),
                        expected_active_root=cwd, expected_project=proj,
                        expected_relative_args=argspec, observed_project=observed,
                        status=status, reason=reason)
            # Symlink-through case: read via the 'link-to-space' symlink (absolute),
            # which validatePath must realpath into the space project's real file.
            seq += 1
            linkrel = os.path.join(FIXTURES, "link-to-space", "marker.txt")
            space_tok = manifest["proj-sp ace"]["token"]
            t0 = time.time(); rpc = srv.call_tool("read_file", {"path": linkrel}); dt = time.time() - t0
            text = H.extract_text(rpc) or ""
            if rpc.get("_transport_error"):
                st, rs = "harness-error", rpc["_transport_error"]
            elif "error" in rpc or rpc.get("result", {}).get("isError"):
                st, rs = "operation-error", "symlink-read-error"
            elif space_tok in text:
                st, rs = "pass", "symlink-realpath-ok"
            else:
                st, rs = "operation-error", f"symlink-unexpected:{text[:80]!r}"
            rec.add(run_id=args.run_id, tool="read_file", mode="topo-symlink-through", transport=transport,
                    server_instance=srv.tag, seq_index=seq, phase="special-topology",
                    ttl_boundary="n/a", settle_seconds=0, elapsed_ms=round(dt*1000, 2),
                    evidence_topology="symlink-through-absolute", parent_proc_cwd=os.getcwd(),
                    server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=manifest["proj-sp ace"]["root"], expected_project="proj-sp ace",
                    expected_relative_args={"path": linkrel}, observed_project=("proj-sp ace" if st=="pass" else None),
                    status=st, reason=rs)
        finally:
            srv.stop()


def run_sandbox_boundary(args, manifest, rec, transports):
    """Enabled-sandbox boundary control. The sandbox is OPT-IN (`Sandbox: enabled`)
    and freezes the allowed dirs at startup. With proj-alpha as the sole allowed
dir: an in-sandbox read must succeed and an out-of-sandbox read (proj-beta) must
    be denied with an access-denied error — while the SAME relative path under the
    allowed project keeps working. This is a boundary control, separate from the
    active-project matrix; it never relaxes into 'sandbox off' behavior."""
    seq = 5500
    alpha = os.path.realpath(os.path.join(FIXTURES, "proj-alpha"))
    beta = os.path.realpath(os.path.join(FIXTURES, "proj-beta"))
    for transport in transports:
        token = secrets.token_hex(16)
        port = H.free_port() if transport == "http" else None
        home = os.path.join(args.out_dir, f"home-run{args.run_id}", f"sandbox-{transport}")
        os.makedirs(home, exist_ok=True)
        H.write_isolated_config(home, port=port or 7099, sandbox=True)
        # Pass the allowed dir as a CLI arg so the frozen sandbox boundary is alpha.
        srv = H.ServerHandle(args.repo_root, transport, home, f"sandbox-{transport}", alpha, token=token, port=port)
        # Override start to pass the allowed-dir CLI argument.
        env = H.server_env(home, token if transport == "http" else None)
        import subprocess as _sp
        srv._of = open(srv.out_log, "w"); srv._ef = open(srv.err_log, "w")
        if transport == "stdio":
            srv.proc = _sp.Popen([H.NODE, srv.stdio_js, alpha], cwd=alpha, env=env,
                                 stdin=_sp.PIPE, stdout=_sp.PIPE, stderr=srv._ef, bufsize=0)
        else:
            srv.proc = _sp.Popen([H.NODE, srv.http_js, alpha, "--host=127.0.0.1", f"--port={port}"],
                                 cwd=alpha, env=env, stdin=_sp.DEVNULL, stdout=srv._of, stderr=srv._ef)
            srv._wait_health()
        try:
            if transport == "stdio":
                srv.rpc("initialize", {"protocolVersion": H.PROTO_LEGACY, "capabilities": {},
                                       "clientInfo": {"name": "prism", "version": "0"}}, modern=False)
            os.chdir(alpha)
            # 1) in-sandbox relative read must succeed
            seq += 1
            t0 = time.time(); okr = srv.call_tool("read_file", {"path": "marker.txt"}); dt = time.time() - t0
            ok_text = H.extract_text(okr) or ""
            in_ok = manifest["proj-alpha"]["token"] in ok_text
            rec.add(run_id=args.run_id, tool="read_file", mode="sandbox-in-bounds", transport=transport,
                    server_instance=srv.tag, seq_index=seq, phase="sandbox", ttl_boundary="n/a",
                    settle_seconds=0, elapsed_ms=round(dt*1000, 2), evidence_topology="sandbox-enabled",
                    parent_proc_cwd=os.getcwd(), server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=alpha, expected_project="proj-alpha",
                    expected_relative_args={"path": "marker.txt"},
                    observed_project=("proj-alpha" if in_ok else None),
                    status=("pass" if in_ok else "operation-error"),
                    reason="in-sandbox-read-ok" if in_ok else f"in-sandbox-read-failed:{ok_text[:80]!r}")
            # 2) out-of-sandbox absolute read of proj-beta must be DENIED
            seq += 1
            t0 = time.time(); oob = srv.call_tool("read_file", {"path": os.path.join(beta, "marker.txt")}); dt = time.time() - t0
            oob_text = (H.extract_text(oob) or "") + json.dumps(oob.get("error", {}))
            denied = ("Access denied" in oob_text) or ("error" in oob) or oob.get("result", {}).get("isError")
            # Confirm we did NOT actually read beta's content
            leaked_beta = manifest["proj-beta"]["token"] in oob_text
            rec.add(run_id=args.run_id, tool="read_file", mode="sandbox-out-of-bounds", transport=transport,
                    server_instance=srv.tag, seq_index=seq, phase="sandbox", ttl_boundary="n/a",
                    settle_seconds=0, elapsed_ms=round(dt*1000, 2), evidence_topology="sandbox-enabled",
                    parent_proc_cwd=os.getcwd(), server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=alpha, expected_project="proj-alpha",
                    expected_relative_args={"path": os.path.join(beta, "marker.txt")},
                    observed_project=("proj-beta" if leaked_beta else None),
                    status=("pass" if (denied and not leaked_beta) else "wrong-root" if leaked_beta else "operation-error"),
                    reason=("out-of-sandbox-denied" if (denied and not leaked_beta)
                            else ("SANDBOX-LEAK: read out-of-bounds content" if leaked_beta
                                  else f"out-of-sandbox-not-denied:{oob_text[:100]!r}")))
        finally:
            srv.stop()


def run_http_independent_client(args, manifest, rec):
    """NEGATIVE CONTROL (separately labeled). One HTTP server with FIXED ancestry
    (spawn cwd = proj-alpha; its process tree is held constant). An INDEPENDENT
    requester process — NOT a server ancestor — issues relative reads while its
    own cwd is varied (alpha then beta). The independent requester's cwd is NOT
    available to the server (it shares no process tree with it), so the server's
    active project must remain its launch directory. This control proves the
    harness does not fabricate per-request workspace evidence; it is NOT evidence
    that a remote requester's cwd reaches the server. Status 'pass' means the
    server stayed at its launch root (the honest expectation over HTTP)."""
    import subprocess as _sp
    seq = 8500
    token = secrets.token_hex(16)
    port = H.free_port()
    home = os.path.join(args.out_dir, f"home-run{args.run_id}", "http-ind-client")
    os.makedirs(home, exist_ok=True)
    H.write_isolated_config(home, port=port)
    launch = os.path.realpath(os.path.join(FIXTURES, "proj-alpha"))
    srv = H.ServerHandle(args.repo_root, "http", home, "http-ind-client", launch, token=token, port=port).start()
    try:
        # An independent requester process with a controllable cwd. It is a child
        # of THIS harness process, not of the server, so its cwd is invisible to
        # the server's ancestor walk. We hold the server ancestry fixed.
        requester = os.path.join(SCRATCH, "independent_requester.py")
        for req_proj in ("proj-alpha", "proj-beta"):
            req_cwd = os.path.realpath(os.path.join(FIXTURES, req_proj))
            seq += 1
            t0 = time.time()
            outp = os.path.join(home, f"indreq-{seq}.json")
            env = dict(os.environ)
            r = _sp.run([sys.executable, requester, "--port", str(port), "--token", token,
                         "--out", outp], cwd=req_cwd, env=env,
                        capture_output=True, text=True, timeout=30)
            dt = time.time() - t0
            got = None
            try:
                with open(outp) as f:
                    got = json.load(f)
            except Exception:
                pass
            text = (got or {}).get("text", "")
            # The served content should be the SERVER's launch project (alpha),
            # independent of the requester's cwd. observed = which token returned.
            observed = None
            for name, m in manifest.items():
                if m["token"] in text:
                    observed = name
                    break
            stayed = (observed == "proj-alpha")
            rec.add(run_id=args.run_id, tool="read_file", mode="http-independent-client",
                    transport="http", server_instance=srv.tag, seq_index=seq,
                    phase="http-independent-client", ttl_boundary="n/a", settle_seconds=0,
                    elapsed_ms=round(dt*1000, 2),
                    evidence_topology=f"independent-requester-cwd={req_proj};server-ancestry-fixed",
                    parent_proc_cwd=req_cwd, server_proc_cwd=srv.server_proc_cwd(),
                    expected_active_root=launch, expected_project="proj-alpha",
                    expected_relative_args={"path": "marker.txt"},
                    observed_project=observed,
                    status=("pass" if stayed else "wrong-root"),
                    reason=("server-stayed-at-launch-root-despite-requester-cwd"
                            if stayed else
                            f"server-followed-non-ancestor-requester-cwd:{observed}"))
    finally:
        srv.stop()


if __name__ == "__main__":
    sys.exit(main())
