#!/usr/bin/env python3
"""Prism cwd-read harness core — Zenith-MCP project-detection ground truth.

This module spawns REAL servers from a chosen build root (frozen baseline or
final build) via dist/cli/stdio.js and dist/server/http.js, drives tool calls
over both transports, and captures independent ground truth (parent /proc cwd,
server /proc cwd, on-disk content) for every invocation. It never relaxes
assertions to fit the implementation; expected values come from the fixture
manifest and the launcher's controlled cwd, not from the server.

Design notes (from source + handoff review):
- All six owned tools resolve relative paths via ctx.validatePath ->
  path.resolve(process.cwd(), path). The "intended" post-fix behavior is that a
  relative op resolves against the invocation's selected active project.
- The only model-free evidence the server can see without a cwd arg/header is
  the caller process-tree cwd (pingCallerEnvironment -> /proc/<ppid>/cwd). This
  harness IS the server's parent and controls its own cwd to present that
  evidence. No test supplies a cwd argument or any project/identity header.
"""
import json, os, socket, subprocess, sys, threading, time, select, shutil
import urllib.request, urllib.error, http.client

HERE = os.path.dirname(os.path.abspath(__file__))
# Fixture location when PRISM_FIXTURES is unset (run.py always sets it): under
# the home directory like the vitest fixtures — outside /tmp (a junk root for
# detection) and outside any ancestor project.
DEFAULT_FIXTURES = os.path.join(os.path.expanduser("~"), ".prism-cwd-read", "fixtures")


def resolve_node():
    """Node binary for the spawned servers: $ZENITH_NODE if set, else `node` on
    PATH (the convention shared with tests/cwd-write). Fails with a clear
    message instead of an obscure Popen error deep inside the suite."""
    want = os.environ.get("ZENITH_NODE") or "node"
    node = shutil.which(want)
    if not node:
        raise FileNotFoundError(
            f"cwd-read harness: Node binary {want!r} not found - set ZENITH_NODE=/path/to/node "
            "or put `node` on PATH")
    return os.path.abspath(node)


NODE = resolve_node()
PROTO_MODERN = "2026-07-28"
PROTO_LEGACY = "2025-03-26"
CALLER_TTL_MS = 5000  # production getCallerCwds TTL (detection/process-tree.ts)

# The six tools this suite owns (the other author covers the rest).
OWNED_TOOLS = ["read_file", "search_file", "read_media_file",
               "read_multiple_files", "directory", "search_files"]
ALL_12 = ["read_file", "search_file", "read_media_file", "read_multiple_files",
          "write_file", "edit_file", "directory", "search_files",
          "file_manager", "stashRestore", "refactor_batch", "bash"]


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def readlink_cwd(pid):
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except OSError:
        return None


def write_isolated_config(home, port=7099, extra_tools=None, sandbox=False):
    """Pre-create a valid isolated Zenith config so the first-run wizard never
    runs against a real HOME. Tools default-enabled by sync; we can disable some."""
    cfgdir = os.path.join(home, ".zenith-mcp")
    os.makedirs(cfgdir, exist_ok=True)
    lines = [f"Port: {port}", f"Sandbox: {'enabled' if sandbox else 'disabled'}", "", "### Tools"]
    for t in ALL_12:
        state = "enabled"
        if extra_tools and t in extra_tools:
            state = extra_tools[t]
        lines.append(f"{t}: {state}")
    lines.append("")
    with open(os.path.join(cfgdir, "config"), "w") as f:
        f.write("\n".join(lines))


def server_env(home, token=None):
    env = {
        "PATH": f"{os.path.dirname(NODE)}:/usr/bin:/bin",
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/config",
        "XDG_CACHE_HOME": f"{home}/cache",
        "XDG_DATA_HOME": f"{home}/data",
        "CI": "1", "NO_COLOR": "1", "npm_config_userconfig": "/dev/null",
    }
    if token is not None:
        env["ZENITH_API_KEY"] = ""
        env["ZENITH_MCP_API_KEY"] = token
    return env


class ServerHandle:
    """A spawned stdio.js or http.js server. stderr/stdout are logged to files
    (no token values). We record the server's real /proc cwd as ground truth."""
    def __init__(self, repo_root, transport, home, tag, spawn_cwd, token=None, port=None):
        self.repo_root = repo_root
        self.transport = transport
        self.home = home
        self.tag = tag
        self.spawn_cwd = spawn_cwd
        self.token = token
        self.port = port
        self.proc = None
        self._id = 0
        self._lock = threading.Lock()
        pkg = os.path.join(repo_root, "packages", "zenith-mcp")
        self.stdio_js = os.path.join(pkg, "dist", "cli", "stdio.js")
        self.http_js = os.path.join(pkg, "dist", "server", "http.js")
        self.out_log = os.path.join(home, f"server-{tag}.out.log")
        self.err_log = os.path.join(home, f"server-{tag}.err.log")

    def start(self):
        env = server_env(self.home, self.token if self.transport == "http" else None)
        self._of = open(self.out_log, "w")
        self._ef = open(self.err_log, "w")
        if self.transport == "stdio":
            self.proc = subprocess.Popen(
                [NODE, self.stdio_js], cwd=self.spawn_cwd, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=self._ef, bufsize=0)
            self._stdout_reader_active = True
        else:
            self.proc = subprocess.Popen(
                [NODE, self.http_js, "--host=127.0.0.1", f"--port={self.port}"],
                cwd=self.spawn_cwd, env=env,
                stdin=subprocess.DEVNULL, stdout=self._of, stderr=self._ef)
            try:
                self._wait_health()
            except BaseException:
                self.stop()  # never leak a child the caller has no handle to
                raise
        return self

    @property
    def pid(self):
        return self.proc.pid if self.proc else None

    def server_proc_cwd(self):
        return readlink_cwd(self.pid) if self.pid else None

    def _wait_health(self, timeout=12):
        base = f"http://127.0.0.1:{self.port}"
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"http server exited early; see {self.err_log}")
            try:
                with urllib.request.urlopen(base + "/health", timeout=1) as r:
                    if r.status == 200:
                        return
            except (OSError, http.client.HTTPException):
                # Not listening yet (refused / reset / timeout / non-200 /
                # half-written response): keep polling until the deadline.
                pass
            time.sleep(0.1)
        raise RuntimeError(f"http server health timeout; see {self.err_log}")

    # ---- stdio framing ----
    def _stdio_call(self, method, params, timeout=20):
        with self._lock:
            self._id += 1
            rid = self._id
            params = dict(params)
            if method != "initialize":
                params["_meta"] = {
                    "io.modelcontextprotocol/protocolVersion": PROTO_MODERN,
                    "io.modelcontextprotocol/clientInfo": {"name": "prism", "version": "1"},
                    "io.modelcontextprotocol/clientCapabilities": {},
                }
            msg = json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}) + "\n"
            self.proc.stdin.write(msg.encode()); self.proc.stdin.flush()
            deadline = time.time() + timeout
            while time.time() < deadline:
                ready, _, _ = select.select([self.proc.stdout], [], [], max(0, deadline - time.time()))
                if not ready: return {"_transport_error": "timeout"}
                line = self.proc.stdout.readline()
                if not line:
                    return {"_transport_error": "eof"}
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue  # skip log/non-JSON lines
                if obj.get("id") == rid:
                    return obj
            return {"_transport_error": "timeout"}

    # ---- http framing ----
    def _http_call(self, method, params, modern=True, timeout=20):
        base = f"http://127.0.0.1:{self.port}"
        with self._lock:
            self._id += 1
            rid = self._id
        body = {"jsonrpc": "2.0", "id": rid, "method": method, "params": dict(params)}
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if modern:
            # Per-request 2026-07-28 envelope + SEP-2243 standard headers.
            body["params"]["_meta"] = {
                "io.modelcontextprotocol/protocolVersion": PROTO_MODERN,
                "io.modelcontextprotocol/clientInfo": {"name": "prism", "version": "0.0.0"},
                "io.modelcontextprotocol/clientCapabilities": {},
            }
            headers["MCP-Protocol-Version"] = PROTO_MODERN
            headers["Mcp-Method"] = method
            if method == "tools/call":
                headers["Mcp-Name"] = params.get("name", "")
        data = json.dumps(body).encode()
        req = urllib.request.Request(base + "/mcp", data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read().decode()
                ct = r.headers.get("content-type") or ""
                return _parse_http(ct, raw)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return _parse_http(e.headers.get("content-type") or "", raw)
            except Exception:
                return {"_transport_error": f"http {e.code}", "_raw": raw[:400]}
        except Exception as e:
            return {"_transport_error": f"{type(e).__name__}: {e}"}

    def rpc(self, method, params, modern=True, timeout=20):
        if self.transport == "stdio":
            return self._stdio_call(method, params, timeout=timeout)
        return self._http_call(method, params, modern=modern, timeout=timeout)

    def tools_list(self):
        return self.rpc("tools/list", {}, modern=False if self.transport == "stdio" else True)

    def call_tool(self, name, arguments, timeout=25):
        return self.rpc("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)

    def stop(self):
        """Bounded, robust shutdown. Close stdin first (clean EOF lets the stdio
        server's read loop exit), then SIGTERM briefly, then SIGKILL. Never hangs:
        every wait is bounded and a final wait() reaps the child."""
        p = self.proc
        if p and p.poll() is None:
            try:
                if p.stdin:
                    p.stdin.close()  # EOF -> stdio server exits its read loop
            except OSError:
                pass  # pipe already broken/closed: the child is on its way out
            try:
                p.wait(timeout=2.0)          # graceful EOF exit
            except subprocess.TimeoutExpired:
                pass  # still running: escalate to SIGTERM below
            if p.poll() is None:
                try:
                    p.terminate()            # SIGTERM
                    p.wait(timeout=1.0)
                except (OSError, subprocess.TimeoutExpired):
                    pass  # ignored SIGTERM, or exited between poll() and signal: SIGKILL below
            if p.poll() is None:
                try:
                    p.kill()                 # SIGKILL
                except OSError:
                    pass  # exited between poll() and kill(); the final wait() reaps it
            try:
                p.wait(timeout=2.0)          # reap; never leave a zombie
            except subprocess.TimeoutExpired:
                pass  # unreapable (e.g. stuck in D state); nothing more we can do
        for f in (getattr(self, "_of", None), getattr(self, "_ef", None)):
            try:
                if f: f.close()
            except OSError:
                pass  # a log-file flush failure must not mask the result being recorded


def _parse_http(ct, raw):
    if "text/event-stream" in ct:
        lines = [l[5:].strip() for l in raw.split("\n") if l.startswith("data:")]
        lines = [l for l in lines if l]
        return json.loads(lines[-1]) if lines else {"_transport_error": "empty-sse"}
    return json.loads(raw)


def extract_text(rpc):
    """Pull the primary text content out of a tools/call result (or None)."""
    if not rpc or "result" not in rpc:
        return None
    res = rpc["result"]
    content = res.get("content") if isinstance(res, dict) else None
    if not content:
        return None
    for item in content:
        if item.get("type") == "text":
            return item.get("text")
    return None


def extract_media(rpc):
    """Return (type, data_b64, mimeType) for read_media_file, else None."""
    if not rpc or "result" not in rpc:
        return None
    content = rpc["result"].get("content")
    if not content:
        return None
    item = content[0]
    return (item.get("type"), item.get("data"), item.get("mimeType"))
