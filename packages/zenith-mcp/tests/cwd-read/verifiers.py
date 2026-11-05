#!/usr/bin/env python3
"""Prism cwd-read matrix runner.

Runs the repeated-call project-detection matrix for the six owned tools over
both real transports. For every invocation it records an independent ground-
truth record and a status. Assertions are derived from the fixture manifest and
the launcher's controlled cwd — never from the server's own claims.

Usage:
  python3 matrix.py --repo-root <repo> --out-dir <dir> [--transport stdio|http|both]
                    [--run-id N] [--scenario all|...]

Exit code is 0 when the harness itself ran cleanly (regardless of product
pass/fail — those are reported in the JSON + tables), non-zero on harness error.
"""
import argparse, json, os, re, sys, time, hashlib, base64

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H

FIXTURES = os.environ.get("PRISM_FIXTURES", H.DEFAULT_FIXTURES)
MANIFEST_PATH = os.path.join(FIXTURES, "fixtures-manifest.json")

# Canonical transition sequence required by the brief.
TRANSITIONS = ["proj-alpha", "proj-beta", "proj-alpha", "proj-gamma", "proj-beta", "proj-alpha"]


def load_manifest():
    with open(MANIFEST_PATH) as f:
        return json.load(f)


def token_to_project(manifest):
    return {m["token"]: name for name, m in manifest.items()}


class Recorder:
    def __init__(self):
        self.records = []

    def add(self, **kw):
        self.records.append(kw)

    def write(self, path):
        with open(path, "w") as f:
            json.dump(self.records, f, indent=2)


# --- Ground-truth helpers -----------------------------------------------------

def expected_file_bytes(project, rel):
    with open(os.path.join(FIXTURES, project, rel), "rb") as f:
        return f.read()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def classify_text_content(text, manifest, expected_project, rel):
    """Determine which project's on-disk content the returned text matches.
    Returns (matched_project_or_None, status_reason)."""
    if text is None:
        return None, "no-text-content"
    t2p = token_to_project(manifest)
    # Direct token presence is the strongest signal (unique per project).
    found = [name for tok, name in t2p.items() if tok in text]
    if expected_project in found:
        return expected_project, "expected-token-present"
    if found:
        return found[0], f"unexpected-token:{found[0]}"
    # No token: compare against on-disk content (compressed reads keep the token
    # line only if retained, so fall back to a prefix-of-file check).
    ondisk = expected_file_bytes(expected_project, rel).decode("utf-8", "replace")
    # Line-numbered output prefixes 'N. '. Compare a distinctive middle line.
    for line in ondisk.split("\n"):
        line = line.strip()
        if len(line) > 12 and line in text:
            return expected_project, "expected-content-line-present"
    return None, "no-fixture-content-matched"


# --- Per-tool invocation builders + verifiers --------------------------------
# Each returns (arguments, verifier). verifier(rpc, ctx) -> (status, reason,
#   observed_project, extra)
# status in: pass | wrong-root | operation-error | unsupported | harness-error

def enoent_project(errtext, manifest):
    """Map an error message that EMBEDS a resolved absolute path to the fixture
    project whose tree the server actually operated in (wrong-tree evidence),
    or None. The server's validatePath resolves relative paths against
    process.cwd(); when the active project should be B but the resolved path
    sits under a stale A, the operation errors (ENOENT / rg 'IO error' /
    'Parent directory does not exist') and the message names the absolute path
    tried. We key on the embedded project root, not the specific error wording,
    so any resolver-stemming failure is attributed to the tree it hit."""
    if not errtext:
        return None
    # Prefer the realpath'd project root appearing in the message.
    for name, m in manifest.items():
        if m["root"] in errtext:
            return name
    # Fall back to the project dir basename as a path segment.
    for name in manifest:
        if f"/{name}/" in errtext or errtext.rstrip().endswith(name):
            return name
    return None


def _rel_args(relpath):
    return {"path": relpath}

def make_read_file(relpath, **kw):
    args = {"path": relpath}
    args.update(kw)
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            txt = H.extract_text(rpc) or ""
            wp = enoent_project(txt, c["manifest"])
            if wp and wp != c["expected_project"]:
                return "wrong-root", f"enoent-under-other:{wp}", wp, {}
            if wp and wp == c["expected_project"]:
                return "operation-error", f"enoent-under-expected:{txt[:140]}", wp, {}
            return "operation-error", f"isError:{txt[:160]}", None, {}
        text = H.extract_text(rpc)
        proj, reason = classify_text_content(text, c["manifest"], c["expected_project"], relpath)
        if proj == c["expected_project"]:
            return "pass", reason, proj, {}
        if proj is None:
            return "operation-error", f"unmatched-content:{reason}|text[:80]={(text or '')[:80]!r}", None, {}
        return "wrong-root", reason, proj, {}
    return args, verify


def make_search_file_grep(relpath, token):
    args = {"path": relpath, "grep": token}
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            txt = H.extract_text(rpc) or ""
            wp = enoent_project(txt, c["manifest"])
            if wp and wp != c["expected_project"]:
                return "wrong-root", f"enoent-under-other:{wp}", wp, {}
            return "operation-error", "isError:" + txt[:160], None, {}
        text = H.extract_text(rpc) or ""
        if token in text:
            return "pass", "grep-hit-in-expected-file", c["expected_project"], {}
        if text.strip() in ("No matches.", ""):
            # empty result means the searched file was not the expected one
            return "wrong-root", "grep-no-match-searched-other-file", None, {}
        # a hit on some other project's token
        t2p = token_to_project(c["manifest"])
        for tok, name in t2p.items():
            if tok in text and name != c["expected_project"]:
                return "wrong-root", f"grep-hit-other:{name}", name, {}
        return "operation-error", f"grep-unexpected:{text[:120]!r}", None, {}
    return args, verify


def make_search_file_symbol(relpath, fnname, tag):
    args = {"path": relpath, "symbol": fnname}
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            txt = H.extract_text(rpc) or ""
            wp = enoent_project(txt, c["manifest"])
            if wp and wp != c["expected_project"]:
                return "wrong-root", f"enoent-under-other:{wp}", wp, {}
            return "operation-error", "isError:" + txt[:160], None, {}
        text = H.extract_text(rpc) or ""
        if fnname in text:
            return "pass", "symbol-found", c["expected_project"], {}
        if "Symbol not found" in text or "Multiple matches" in text:
            return "operation-error", f"symbol:{text[:120]!r}", None, {}
        return "operation-error", f"symbol-unexpected:{text[:120]!r}", None, {}
    return args, verify


def make_read_media(relpath, kind):
    args = {"path": relpath}
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            txt = H.extract_text(rpc) or ""
            wp = enoent_project(txt, c["manifest"])
            if wp and wp != c["expected_project"]:
                return "wrong-root", f"enoent-under-other:{wp}", wp, {}
            return "operation-error", "isError:" + txt[:160], None, {}
        media = H.extract_media(rpc)
        if not media or not media[1]:
            return "operation-error", "no-media-data", None, {}
        mtype, data_b64, mime = media
        try:
            got = base64.b64decode(data_b64)
        except Exception as e:
            return "operation-error", f"bad-base64:{e}", None, {}
        # Compare against every project's media of this kind to find a match.
        expected = expected_file_bytes(c["expected_project"], relpath)
        if sha(got) == sha(expected):
            want_prefix = "audio/" if kind == "wav" else "image/"
            mimeok = (mime or "").startswith(want_prefix)
            return ("pass" if mimeok else "operation-error"), \
                   ("bytes+mime-ok" if mimeok else f"mime-wrong:{mime}"), c["expected_project"], {"sha": sha(got)[:16], "mime": mime}
        # Did we read a DIFFERENT project's media?
        for name in c["manifest"]:
            other = os.path.join(FIXTURES, name, relpath)
            if os.path.exists(other) and sha(got) == sha(expected_file_bytes(name, relpath)):
                return "wrong-root", f"media-from-other:{name}", name, {"sha": sha(got)[:16], "mime": mime}
        return "operation-error", f"media-bytes-unmatched sha={sha(got)[:16]} mime={mime}", None, {}
    return args, verify


_READ_MULTIPLE_LABEL = re.compile(r"^- (\S.*)$")


def split_read_multiple_entries(text):
    """Parse a read_multiple_files response into [(basename, body)].

    The tool emits one entry per requested path, "- <basename>\\n<body>",
    joined by a blank line; every content line of a body carries an "N. "
    line-number prefix (or is "ERROR: ...", or "[truncated]"). So a label is
    recognised only as a whole line "- <name>" that is the first line of the
    response or directly follows an empty line — never by substring, which a
    content line such as "2. - notes.txt" would satisfy.
    """
    lines = text.split("\n")
    entries = []
    for i, line in enumerate(lines):
        m = _READ_MULTIPLE_LABEL.match(line)
        if m and (i == 0 or lines[i - 1] == ""):
            entries.append([m.group(1), []])
        elif entries:
            entries[-1][1].append(line)
    return [(name, "\n".join(body).strip("\n")) for name, body in entries]


def make_read_multiple(relpaths, tokens, **kw):
    args = {"paths": list(relpaths)}
    args.update(kw)
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            return "operation-error", "isError:" + (H.extract_text(rpc) or "")[:160], None, {}
        text = H.extract_text(rpc) or ""
        hits = sum(1 for tok in tokens if tok in text)
        others = [n for tok, n in token_to_project(c["manifest"]).items()
                  if tok in text and n != c["expected_project"]]
        # Every requested path must come back as its own non-error entry.
        # The response is parsed into entries structurally (see
        # split_read_multiple_entries) rather than searched for "- <name>"
        # substrings: a file's content can mention another file's label
        # ("2. - notes.txt"), so a substring hit proves nothing was read.
        entries = split_read_multiple_entries(text)
        names = [n for n, _ in entries]
        wanted = [os.path.basename(p) for p in relpaths]
        missing = [p for p, b in zip(relpaths, wanted) if names.count(b) < wanted.count(b)]
        errored = [n for n, body in entries if body.startswith("ERROR:")]
        empty = [n for n, body in entries if not body]
        extra = len(entries) - len(relpaths)
        complete = not missing and not errored and not empty and extra == 0
        if hits == len(tokens) and not others and complete:
            return "pass", f"all-{hits}-expected-tokens;all-{len(relpaths)}-entries", c["expected_project"], {}
        if others:
            return "wrong-root", f"contained-other:{others[0]}", others[0], {}
        # per-file ERROR lines naming another tree = wrong-root-via-ENOENT
        wp = enoent_project(text, c["manifest"])
        if wp and wp != c["expected_project"]:
            return "wrong-root", f"enoent-under-other:{wp}", wp, {}
        if not complete:
            why = (f"entries-missing:{missing}" if missing else
                   f"entries-errored:{errored}" if errored else
                   f"entries-empty:{empty}" if empty else
                   f"entries-count:{len(entries)}!={len(relpaths)}")
            return "operation-error", f"{why}; text[:120]={text[:120]!r}", None, {}
        return "operation-error", f"tokens {hits}/{len(tokens)}; text[:120]={text[:120]!r}", None, {}
    return args, verify


def make_directory(relpath, mode, marker_names):
    args = {"mode": mode}
    if relpath:
        args["path"] = relpath
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            return "operation-error", "isError:" + (H.extract_text(rpc) or "")[:160], None, {}
        text = H.extract_text(rpc) or ""
        # fixture-specific entries: expected project's marker/files must appear,
        # and no other project's tag-named files.
        present = sum(1 for m in marker_names if m in text)
        other_tags = [m["tag"].lower() for m in c["manifest"].values()
                      if m["tag"].lower() != c["manifest"][c["expected_project"]]["tag"].lower()]
        leaked = [t for t in other_tags if f"_{t}." in text or f"-{t}" in text or f"img_{t}" in text or f"snd_{t}" in text or f"code_{t}" in text or f"notes_{t}" in text or f"deep_{t}" in text]
        if present == len(marker_names) and not leaked:
            return "pass", f"entries-ok:{present}", c["expected_project"], {}
        if leaked:
            return "wrong-root", f"listed-other-tag:{leaked[0]}", None, {}
        if present == 0:
            return "wrong-root", "no-expected-entries-listed", None, {}
        return "operation-error", f"partial-entries:{present}/{len(marker_names)}; text[:120]={text[:120]!r}", None, {}
    return args, verify


def make_search_files(relpath, mode, expect_substr, extra):
    args = {"mode": mode, "path": relpath}
    args.update(extra)
    def verify(rpc, c):
        if rpc.get("_transport_error"):
            return "harness-error", rpc["_transport_error"], None, {}
        if "error" in rpc:
            return "operation-error", rpc["error"].get("message", "rpc-error")[:200], None, {}
        res = rpc.get("result", {})
        if res.get("isError"):
            return "operation-error", "isError:" + (H.extract_text(rpc) or "")[:160], None, {}
        text = H.extract_text(rpc) or ""
        if text.strip() in ("No matches.", "No files found.", "No supported files found.", ""):
            return "wrong-root", "search-no-hit-searched-other-tree", None, {}
        if expect_substr and expect_substr in text:
            # ensure the path references the expected project tree
            if c["expected_project"] in text or c["manifest"][c["expected_project"]]["tag"].lower() in text:
                return "pass", "search-hit-in-expected-tree", c["expected_project"], {}
            return "pass", "search-hit-substr", c["expected_project"], {}
        # other project's tag leaked?
        for name, m in c["manifest"].items():
            if name != c["expected_project"] and (m["token"] in text or f"_{m['tag'].lower()}." in text):
                return "wrong-root", f"search-hit-other:{name}", name, {}
        return "operation-error", f"search-unexpected:{text[:120]!r}", None, {}
    return args, verify
