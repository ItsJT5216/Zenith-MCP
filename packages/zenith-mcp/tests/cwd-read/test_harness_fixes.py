#!/usr/bin/env python3
"""Unit tests for the cwd-read harness fixes (review batch 2).

Run:  python3 -m unittest discover -s packages/zenith-mcp/tests/cwd-read -p 'test_*.py'

These drive the pure verifier/harness functions with fake RPC results and fake
process/transport objects; no server is spawned.
"""
import base64
import gc
import os
import sys
import tempfile
import unittest
import warnings
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# harness.py resolves the Node binary at import time (C20-a3). These tests never
# spawn a server, so a Node-less machine may stand in any executable.
import shutil  # noqa: E402
if not shutil.which(os.environ.get("ZENITH_NODE") or "node"):
    os.environ["ZENITH_NODE"] = sys.executable
import harness as H  # noqa: E402
import run_suite as R  # noqa: E402
import verifiers as V  # noqa: E402


class _FakeProc:
    """Minimal Popen stand-in for ServerHandle.stop(): scripted poll() results
    and per-method exceptions, recording the calls made."""

    def __init__(self, polls, raises=None, stdin=None):
        self._polls = list(polls)
        self._raises = raises or {}
        self.stdin = stdin
        self.pid = 0  # falsy: ServerHandle.server_proc_cwd() reports None
        self.calls = []

    def poll(self):
        return self._polls.pop(0) if len(self._polls) > 1 else self._polls[0]

    def _do(self, name):
        self.calls.append(name)
        exc = self._raises.get(name)
        if exc:
            raise exc

    def wait(self, timeout=None):
        self._do("wait")

    def terminate(self):
        self._do("terminate")

    def kill(self):
        self._do("kill")


class _BrokenStdin:
    def close(self):
        raise BrokenPipeError(32, "Broken pipe")


def _handle(proc):
    h = H.ServerHandle.__new__(H.ServerHandle)
    h.proc = proc
    return h


class ReadMediaVerifierClosesFiles(unittest.TestCase):
    """C17-a1: comparing against another project's media must not leak a file handle."""

    def test_other_project_media_comparison_closes_the_fixture_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name, payload in (("proj-alpha", b"ALPHA-PNG"), ("proj-beta", b"BETA-PNG")):
                os.makedirs(os.path.join(tmp, name, "assets"))
                with open(os.path.join(tmp, name, "assets", "img.png"), "wb") as f:
                    f.write(payload)
            # The server "returned" BETA's bytes while ALPHA was expected.
            rpc = {"result": {"content": [{"type": "image", "mimeType": "image/png",
                                           "data": base64.b64encode(b"BETA-PNG").decode()}]}}
            ctx = {"manifest": {"proj-alpha": {}, "proj-beta": {}}, "expected_project": "proj-alpha"}
            _, verify = V.make_read_media("assets/img.png", "png")
            with mock.patch.object(V, "FIXTURES", tmp), warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                status, reason, observed, _ = verify(rpc, ctx)
                gc.collect()
            self.assertEqual((status, observed), ("wrong-root", "proj-beta"))
            self.assertEqual(reason, "media-from-other:proj-beta")
            leaked = [w for w in caught
                      if issubclass(w.category, ResourceWarning) and tmp in str(w.message)]
            self.assertEqual(leaked, [], "fixture file left open: %r" % [str(w.message) for w in leaked])


class ServerHandleStopHandlesOnlyExpectedFailures(unittest.TestCase):
    """C17-a3..a8: stop() tolerates exactly the shutdown failure modes it expects."""

    def test_escalates_through_term_and_kill_when_the_child_ignores_eof_and_sigterm(self):
        import subprocess
        proc = _FakeProc(polls=[None, None, None, None, 0],
                         raises={"wait": subprocess.TimeoutExpired("node", 1.0)},
                         stdin=_BrokenStdin())
        proc._raises["kill"] = None
        _handle(proc).stop()
        # broken stdin pipe swallowed; every wait timed out; TERM then KILL sent.
        self.assertEqual(proc.calls, ["wait", "terminate", "wait", "kill", "wait"])

    def test_a_vanished_child_is_tolerated_at_terminate_and_kill(self):
        proc = _FakeProc(polls=[None], raises={"terminate": ProcessLookupError(3, "No such process"),
                                               "kill": ProcessLookupError(3, "No such process")})
        # wait() returning normally after EOF leaves poll() None in this fake,
        # which forces both signal paths; neither may raise out of stop().
        _handle(proc).stop()
        self.assertEqual(proc.calls, ["wait", "terminate", "kill", "wait"])

    def test_unexpected_errors_are_no_longer_swallowed(self):
        proc = _FakeProc(polls=[None, 0], raises={"wait": RuntimeError("harness bug")})
        with self.assertRaises(RuntimeError):
            _handle(proc).stop()

    def test_log_file_close_errors_are_tolerated_but_not_other_exceptions(self):
        h = _handle(None)
        h._of = mock.Mock(close=mock.Mock(side_effect=OSError(5, "I/O error")))
        h._ef = mock.Mock()
        h.stop()
        h._ef.close.assert_called_once()
        h._ef = mock.Mock(close=mock.Mock(side_effect=TypeError("not a file")))
        with self.assertRaises(TypeError):
            h.stop()


class WaitHealthPollsThroughTransportErrors(unittest.TestCase):
    """C17-a2: the /health poll retries on connection-level failures only."""

    def _handle(self):
        h = _handle(_FakeProc(polls=[None]))
        h.port = 1
        h.err_log = "err.log"
        return h

    def test_retries_connection_refused_and_half_open_responses_until_200(self):
        import http.client
        ok = mock.MagicMock(status=200)
        ok.__enter__.return_value = ok
        attempts = [ConnectionRefusedError(111, "refused"),
                    http.client.RemoteDisconnected("closed"),
                    TimeoutError("timed out"), ok]
        with mock.patch.object(H.urllib.request, "urlopen", side_effect=attempts) as urlopen, \
             mock.patch.object(H.time, "sleep"):
            self._handle()._wait_health(timeout=5)
        self.assertEqual(urlopen.call_count, 4)

    def test_times_out_with_the_documented_error_when_never_healthy(self):
        with mock.patch.object(H.urllib.request, "urlopen", side_effect=ConnectionRefusedError(111, "refused")), \
             mock.patch.object(H.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "health timeout"):
                self._handle()._wait_health(timeout=0.3)

    def test_programming_errors_propagate_instead_of_being_retried(self):
        with mock.patch.object(H.urllib.request, "urlopen", side_effect=TypeError("bad call")), \
             mock.patch.object(H.time, "sleep"):
            with self.assertRaises(TypeError):
                self._handle()._wait_health(timeout=1)


class _FakeServer:
    """ServerHandle stand-in for run_suite controls: never spawns anything."""
    instances = []

    def __init__(self, repo_root, transport, home, tag, spawn_cwd, token=None, port=None):
        self.tag, self.transport, self.port = tag, transport, port
        self.started = self.stopped = False
        _FakeServer.instances.append(self)

    def start(self):
        self.started = True
        return self

    def stop(self):
        self.stopped = True

    def server_proc_cwd(self):
        return None


class _FakeRpcServer(_FakeServer):
    """_FakeServer that answers every tools/call from a scripted response."""
    response = {"_transport_error": "timeout"}

    def rpc(self, method, params, modern=True, timeout=20):
        return {"result": {}}

    def call_tool(self, name, arguments, timeout=25):
        return dict(self.response)


def _args(out_dir):
    import types
    return types.SimpleNamespace(out_dir=out_dir, run_id=1, repo_root="/nonexistent/repo")


_MANIFEST = {"proj-alpha": {"token": "ALPHA-TOK", "root": "/x/proj-alpha"},
             "proj-beta": {"token": "BETA-TOK", "root": "/x/proj-beta"}}


class HttpIndependentClientReportsRequesterFailures(unittest.TestCase):
    """C22-a3 / C17-a9 / C17-a10: a requester that writes no output is a harness
    error (with its exit status and stderr), never a 'wrong-root' product result."""

    def setUp(self):
        _FakeServer.instances.clear()

    def _run(self, fake_run):
        import subprocess
        rec = V.Recorder()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(R.H, "ServerHandle", _FakeServer), \
             mock.patch.object(subprocess, "run", side_effect=fake_run):
            R.run_http_independent_client(_args(tmp), _MANIFEST, rec)
        return rec

    def test_requester_without_output_raises_with_rc_and_stderr(self):
        import subprocess
        def failing_run(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 3, stdout="", stderr="Traceback: boom\n")
        with self.assertRaisesRegex(RuntimeError, r"wrote no output \(rc=3\): Traceback: boom"):
            self._run(failing_run)
        self.assertTrue(_FakeServer.instances[0].stopped, "server stopped in finally")

    def test_requester_output_is_still_recorded_as_before(self):
        import json, subprocess
        def ok_run(cmd, **kw):
            out = cmd[cmd.index("--out") + 1]
            with open(out, "w") as f:
                json.dump({"text": "1. ALPHA-TOK"}, f)
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        rec = self._run(ok_run)
        self.assertEqual([r["status"] for r in rec.records], ["pass", "pass"])
        self.assertEqual({r["observed_project"] for r in rec.records}, {"proj-alpha"})


class HttpStartupFailureStopsTheChild(unittest.TestCase):
    """C21-a11: a failed /health wait must stop the server that was just spawned."""

    def test_server_handle_start_stops_the_child_when_health_never_comes(self):
        with tempfile.TemporaryDirectory() as home:
            h = H.ServerHandle("/nonexistent/repo", "http", home, "t", home, token="tok", port=1)
            proc = _FakeProc(polls=[None])
            with mock.patch.object(H.subprocess, "Popen", return_value=proc), \
                 mock.patch.object(H.ServerHandle, "_wait_health",
                                   side_effect=RuntimeError("http server health timeout")):
                with self.assertRaisesRegex(RuntimeError, "health timeout"):
                    h.start()
            self.assertIn("terminate", proc.calls)
            self.assertIn("kill", proc.calls)
            self.assertTrue(h._of.closed and h._ef.closed, "log files closed by stop()")

    def test_sandbox_control_stops_the_child_when_health_never_comes(self):
        import subprocess
        proc = _FakeProc(polls=[None])
        rec = V.Recorder()
        with tempfile.TemporaryDirectory() as tmp, \
             mock.patch.object(subprocess, "Popen", return_value=proc), \
             mock.patch.object(H.ServerHandle, "_wait_health",
                               side_effect=RuntimeError("http server health timeout")):
            with self.assertRaisesRegex(RuntimeError, "health timeout"):
                R.run_sandbox_boundary(_args(tmp), _MANIFEST, rec, ["http"])
        self.assertIn("terminate", proc.calls)
        self.assertEqual(rec.records, [])


class ConcurrentControlStartsInsideCleanupScope(unittest.TestCase):
    """C22-a2: if the second concurrent server fails to start, the first is stopped."""

    def test_failing_second_start_still_stops_the_first_server(self):
        class SecondStartFails(_FakeServer):
            def start(self):
                if self.tag.startswith("conc-B"):
                    raise RuntimeError("http server health timeout")
                return super().start()
        _FakeServer.instances.clear()
        rec = V.Recorder()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(R.H, "ServerHandle", SecondStartFails):
            with self.assertRaisesRegex(RuntimeError, "health timeout"):
                R.run_concurrent(_args(tmp), _MANIFEST, rec, ["http"])
        a, b = _FakeServer.instances
        self.assertEqual((a.tag, a.started, a.stopped), ("conc-A-http", True, True))
        self.assertEqual((b.tag, b.started, b.stopped), ("conc-B-http", False, True))
        self.assertEqual(rec.records, [])


class ErrorRecoveryTransportFailuresAreHarnessErrors(unittest.TestCase):
    """C21-a13: a timeout/EOF on the schema-rejection and missing-path probes is a
    harness error, not a passing rejection."""

    def setUp(self):
        self._cwd = os.getcwd()
        _FakeServer.instances.clear()

    def tearDown(self):
        os.chdir(self._cwd)

    def _run(self, response):
        rec = V.Recorder()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "fixtures", "proj-alpha"))
            fake = type("Fake", (_FakeRpcServer,), {"response": response})
            with mock.patch.object(R, "FIXTURES", os.path.join(tmp, "fixtures")), \
                 mock.patch.object(R.H, "ServerHandle", fake):
                R.run_error_recovery(_args(tmp), _MANIFEST, rec, ["stdio"])
        return {r["mode"]: (r["status"], r["reason"]) for r in rec.records}

    def test_transport_errors_are_not_counted_as_rejections(self):
        by_mode = self._run({"_transport_error": "timeout"})
        self.assertEqual(by_mode["error-schema-reject"], ("harness-error", "timeout"))
        self.assertEqual(by_mode["error-missing-path"], ("harness-error", "timeout"))
        self.assertEqual(by_mode["error-recovery-valid-after"][0], "harness-error")

    def test_real_server_rejections_still_pass(self):
        by_mode = self._run({"error": {"code": -32602, "message": "Invalid params"}})
        self.assertEqual(by_mode["error-schema-reject"], ("pass", "schema-rejection-returned"))
        self.assertEqual(by_mode["error-missing-path"], ("pass", "missing-path-errored"))
        by_mode = self._run({"result": {"isError": True, "content": [{"type": "text", "text": "ENOENT"}]}})
        self.assertEqual(by_mode["error-schema-reject"], ("pass", "schema-rejection-returned"))
        by_mode = self._run({"result": {"content": [{"type": "text", "text": "1. hello"}]}})
        self.assertEqual(by_mode["error-schema-reject"], ("operation-error", "schema-not-rejected"))
        self.assertEqual(by_mode["error-missing-path"], ("operation-error", "missing-path-not-errored"))


class SandboxBoundaryRequiresAccessDenied(unittest.TestCase):
    """C21-a14: the out-of-sandbox control passes only on the access-denied error."""

    def setUp(self):
        self._cwd = os.getcwd()

    def tearDown(self):
        os.chdir(self._cwd)

    def _run(self, oob_response):
        import subprocess
        def call_tool(self_, name, arguments, timeout=25):
            if arguments["path"] == "marker.txt":
                return {"result": {"content": [{"type": "text", "text": "1. ALPHA-TOK"}]}}
            return dict(oob_response)
        rec = V.Recorder()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "fixtures", "proj-alpha"))
            with mock.patch.object(R, "FIXTURES", os.path.join(tmp, "fixtures")), \
                 mock.patch.object(subprocess, "Popen", return_value=_FakeProc(polls=[None, 0])), \
                 mock.patch.object(H.ServerHandle, "rpc", return_value={"result": {}}), \
                 mock.patch.object(H.ServerHandle, "call_tool", call_tool):
                R.run_sandbox_boundary(_args(tmp), _MANIFEST, rec, ["stdio"])
        return {r["mode"]: (r["status"], r["reason"]) for r in rec.records}

    def test_unrelated_errors_do_not_count_as_boundary_enforcement(self):
        by_mode = self._run({"result": {"isError": True, "content": [{"type": "text",
                             "text": "ENOENT: no such file or directory"}]}})
        self.assertEqual(by_mode["sandbox-in-bounds"], ("pass", "in-sandbox-read-ok"))
        status, reason = by_mode["sandbox-out-of-bounds"]
        self.assertEqual(status, "operation-error")
        self.assertTrue(reason.startswith("out-of-sandbox-not-denied:"), reason)
        by_mode = self._run({"error": {"code": -32602, "message": "Invalid params"}})
        self.assertEqual(by_mode["sandbox-out-of-bounds"][0], "operation-error")

    def test_access_denied_in_either_error_channel_passes(self):
        msg = "Access denied: /x/proj-beta/marker.txt is outside allowed directories"
        by_mode = self._run({"result": {"isError": True, "content": [{"type": "text", "text": msg}]}})
        self.assertEqual(by_mode["sandbox-out-of-bounds"], ("pass", "out-of-sandbox-denied"))
        by_mode = self._run({"error": {"code": -32603, "message": msg}})
        self.assertEqual(by_mode["sandbox-out-of-bounds"], ("pass", "out-of-sandbox-denied"))

    def test_leaked_content_is_still_reported_as_wrong_root(self):
        by_mode = self._run({"result": {"content": [{"type": "text", "text": "1. BETA-TOK"}]}})
        self.assertEqual(by_mode["sandbox-out-of-bounds"][0], "wrong-root")


_TOPO_MANIFEST = dict(_MANIFEST, **{
    "proj-wt": {"token": "WT-TOK", "root": "/x/proj-wt"},
    "proj-gamma": {"token": "GAMMA-TOK", "root": "/x/proj-gamma"},
    "proj-sp ace": {"token": "SPACE-TOK", "root": "/x/proj-sp ace"},
})


class SymlinkControlIsUnsupportedWithoutTheLink(unittest.TestCase):
    """C21-a10: a missing link-to-space fixture symlink is an environment gap
    ('unsupported'), not a product 'operation-error'."""

    def setUp(self):
        self._cwd = os.getcwd()
        _FakeServer.instances.clear()

    def tearDown(self):
        os.chdir(self._cwd)

    def _run(self, with_link):
        def call_tool(self_, name, arguments, timeout=25):
            if "link-to-space" in arguments["path"]:
                if with_link:
                    return {"result": {"content": [{"type": "text", "text": "1. SPACE-TOK"}]}}
                return {"result": {"isError": True, "content": [{"type": "text",
                        "text": f"ENOENT: no such file or directory, open '{arguments['path']}'"}]}}
            return {"result": {"content": [{"type": "text", "text": "1. whatever"}]}}
        fake = type("Fake", (_FakeRpcServer,), {"call_tool": call_tool})
        rec = V.Recorder()
        with tempfile.TemporaryDirectory() as tmp:
            fixtures = os.path.join(tmp, "fixtures")
            for proj in ("proj-wt", "proj-gamma", "proj-sp ace", "junk-plain"):
                os.makedirs(os.path.join(fixtures, proj))
                with open(os.path.join(fixtures, proj, "marker.txt"), "w") as f:
                    f.write("x\n")
            if with_link:
                try:
                    os.symlink(os.path.join(fixtures, "proj-sp ace"), os.path.join(fixtures, "link-to-space"))
                except OSError as e:  # pragma: no cover - filesystem without symlinks
                    self.skipTest(f"symlinks unavailable here: {e}")
            with mock.patch.object(R, "FIXTURES", fixtures), mock.patch.object(V, "FIXTURES", fixtures), \
                 mock.patch.object(R.H, "ServerHandle", fake), mock.patch.object(R.time, "sleep"):
                R.run_special_topologies(_args(tmp), _TOPO_MANIFEST, rec, ["stdio"])
        return {r["mode"]: (r["status"], r["reason"]) for r in rec.records}

    def test_missing_symlink_records_unsupported(self):
        self.assertEqual(self._run(with_link=False)["topo-symlink-through"],
                         ("unsupported", "symlink-unavailable"))

    def test_present_symlink_is_still_verified(self):
        self.assertEqual(self._run(with_link=True)["topo-symlink-through"],
                         ("pass", "symlink-realpath-ok"))


class ReadMultipleVerifierChecksEveryPath(unittest.TestCase):
    """C21-a15: read_multiple_files passes only when every requested path came
    back as its own non-error entry, not when the single token appears once."""

    PATHS = ["marker.txt", "nested/deep/deep_alpha.txt", "src/notes_alpha.txt"]
    CTX = {"manifest": _MANIFEST, "expected_project": "proj-alpha"}

    def _verify(self, text):
        _, verify = V.make_read_multiple(self.PATHS, ["ALPHA-TOK"])
        return verify({"result": {"content": [{"type": "text", "text": text}]}}, self.CTX)

    def test_all_entries_present_passes(self):
        text = ("- marker.txt\n1. ALPHA-TOK\n\n"
                "- deep_alpha.txt\n1. deep content Alpha ALPHA-TOK\n\n"
                "- notes_alpha.txt\n1. This sentence is unique to project Alpha. Token ALPHA-TOK.")
        status, reason, observed, _ = self._verify(text)
        self.assertEqual((status, observed), ("pass", "proj-alpha"))
        self.assertIn("all-3-entries", reason)

    def test_token_alone_does_not_vouch_for_unread_files(self):
        status, reason, observed, _ = self._verify("- marker.txt\n1. ALPHA-TOK")
        self.assertEqual(status, "operation-error")
        self.assertIn("entries-missing:['nested/deep/deep_alpha.txt', 'src/notes_alpha.txt']", reason)

    def test_per_file_error_entry_fails_even_with_the_token_present(self):
        text = ("- marker.txt\n1. ALPHA-TOK\n\n"
                "- deep_alpha.txt\nERROR: ENOENT: no such file or directory\n\n"
                "- notes_alpha.txt\n1. notes")
        status, reason, _, _ = self._verify(text)
        self.assertEqual(status, "operation-error")
        self.assertIn("entries-errored:['deep_alpha.txt']", reason)

    # Entries are parsed structurally — a label is a whole "- <name>" line at
    # the start or after the blank separator — so the names of unread files
    # appearing inside one entry's numbered content do not count as entries.
    def test_labels_inside_one_entrys_content_do_not_count_as_entries(self):
        text = ("- marker.txt\n1. ALPHA-TOK\n2. - deep_alpha.txt\n3. - notes_alpha.txt\n4. end")
        status, reason, _, _ = self._verify(text)
        self.assertEqual(status, "operation-error")
        self.assertIn("entries-missing:['nested/deep/deep_alpha.txt', 'src/notes_alpha.txt']", reason)

    def test_labels_without_the_blank_separator_are_content_not_entries(self):
        text = "- marker.txt\n1. ALPHA-TOK\n- deep_alpha.txt\n1. x\n- notes_alpha.txt\n1. y"
        status, reason, _, _ = self._verify(text)
        self.assertEqual(status, "operation-error")
        self.assertIn("entries-missing:", reason)

    def test_an_extra_entry_fails(self):
        text = ("- marker.txt\n1. ALPHA-TOK\n\n- deep_alpha.txt\n1. deep\n\n"
                "- notes_alpha.txt\n1. notes\n\n- other.txt\n1. z")
        status, reason, _, _ = self._verify(text)
        self.assertEqual(status, "operation-error")
        self.assertIn("entries-count:4!=3", reason)

    def test_an_entry_with_no_body_fails(self):
        text = "- marker.txt\n1. ALPHA-TOK\n\n- deep_alpha.txt\n\n- notes_alpha.txt\n1. notes"
        status, reason, _, _ = self._verify(text)
        self.assertEqual(status, "operation-error")
        self.assertIn("entries-empty:['deep_alpha.txt']", reason)

    def test_split_entries_follows_the_tool_format(self):
        text = ("- marker.txt\n1. ALPHA-TOK\n2. - notes_alpha.txt\n\n"
                "- deep_alpha.txt\nERROR: ENOENT\n\n- notes_alpha.txt\n1. a\n2. \n3. b\n[truncated]")
        self.assertEqual(V.split_read_multiple_entries(text), [
            ("marker.txt", "1. ALPHA-TOK\n2. - notes_alpha.txt"),
            ("deep_alpha.txt", "ERROR: ENOENT"),
            ("notes_alpha.txt", "1. a\n2. \n3. b\n[truncated]"),
        ])

    def test_error_entry_under_another_tree_is_still_wrong_root(self):
        text = ("- marker.txt\n1. ALPHA-TOK\n\n"
                "- deep_alpha.txt\nERROR: ENOENT: no such file, open '/x/proj-beta/nested/deep/deep_alpha.txt'\n\n"
                "- notes_alpha.txt\n1. notes")
        status, reason, observed, _ = self._verify(text)
        self.assertEqual((status, observed), ("wrong-root", "proj-beta"))


class NodeBinaryResolution(unittest.TestCase):
    """C20-a3: the harness finds Node via ZENITH_NODE or PATH, never a fixed path."""

    def test_zenith_node_wins_when_set(self):
        with mock.patch.dict(os.environ, {"ZENITH_NODE": sys.executable}):
            self.assertEqual(H.resolve_node(), os.path.abspath(sys.executable))

    def test_falls_back_to_node_on_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "node")
            with open(fake, "w") as f:
                f.write("#!/bin/sh\nexit 0\n")
            os.chmod(fake, 0o755)
            with mock.patch.dict(os.environ, {"PATH": tmp}, clear=False):
                os.environ.pop("ZENITH_NODE", None)
                self.assertEqual(H.resolve_node(), fake)

    def test_clear_error_when_nothing_resolves(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"PATH": tmp}):
            os.environ.pop("ZENITH_NODE", None)
            with self.assertRaisesRegex(FileNotFoundError, "ZENITH_NODE"):
                H.resolve_node()
            os.environ["ZENITH_NODE"] = os.path.join(tmp, "missing-node")
            with self.assertRaisesRegex(FileNotFoundError, "missing-node"):
                H.resolve_node()

    def test_no_author_specific_paths_remain_in_the_harness(self):
        here = os.path.dirname(os.path.abspath(__file__))
        offenders = []
        for name in sorted(os.listdir(here)):
            if name.endswith((".py", ".md")) and name != os.path.basename(__file__):
                with open(os.path.join(here, name)) as f:
                    if "/home/tanner" in f.read():
                        offenders.append(name)
        self.assertEqual(offenders, [])
        self.assertEqual(H.HERE, here)
        self.assertFalse(hasattr(H, "BASE"))


class ReadmeDescribesRunPyAccurately(unittest.TestCase):
    """C21-a12: the README must not claim run.py reads PRISM_HOME (it never did)."""

    def test_readme_matches_run_py(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "run.py")) as f:
            run_py = f.read()
        with open(os.path.join(here, "README.md")) as f:
            readme = f.read()
        with open(os.path.join(here, "MANIFEST.md")) as f:
            manifest = f.read()
        self.assertNotIn("PRISM_HOME", run_py)
        self.assertNotIn("PRISM_HOME", readme)
        self.assertIn("os.environ['PRISM_FIXTURES']", run_py)
        self.assertIn("`PRISM_FIXTURES`", readme)
        self.assertIn("inserts its own directory", readme)
        for doc in (readme, manifest):
            self.assertNotIn("author's scratch", doc)


if __name__ == "__main__":
    unittest.main()
