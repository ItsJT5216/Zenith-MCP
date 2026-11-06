#!/usr/bin/env python3
"""Independent HTTP requester for the Prism cwd-read negative control.

Runs as a SEPARATE process (a child of the harness, NOT of the server). Its cwd
is set by the harness's subprocess `cwd=` argument. It issues ONE modern
(2026-07-28) tools/call read_file for the relative path 'marker.txt' against the
server on 127.0.0.1:<port>, and writes the returned primary text to --out as
JSON {"text": ...}. Because this process shares no ancestry with the server, its
cwd cannot appear in the server's pingCallerEnvironment walk — that is the whole
point of the negative control.

The bearer token is passed only to the server and is never written to --out or to
any log. No cwd or identity header is sent; only the SEP-2243 standard headers.
"""
import argparse, json, urllib.request, urllib.error


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    meta = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": {"name": "prism-independent-requester", "version": "0"},
        "io.modelcontextprotocol/clientCapabilities": {},
    }
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "read_file", "arguments": {"path": "marker.txt"}, "_meta": meta}}
    headers = {
        "Authorization": f"Bearer {args.token}",
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "read_file",
    }
    text = ""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{args.port}/mcp",
                                     data=json.dumps(body).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode()
            ct = r.headers.get("content-type") or ""
        if "text/event-stream" in ct:
            lines = [l[5:].strip() for l in raw.split("\n") if l.startswith("data:")]
            raw = lines[-1] if lines else "{}"
        obj = json.loads(raw)
        content = obj.get("result", {}).get("content", [])
        for item in content:
            if item.get("type") == "text":
                text = item.get("text", "")
                break
        if not text and obj.get("result", {}).get("isError"):
            text = "__ISERROR__"
    except urllib.error.HTTPError as e:
        text = f"__HTTP_{e.code}__"
    except Exception as e:
        text = f"__ERR_{type(e).__name__}__"
    with open(args.out, "w") as f:
        json.dump({"text": text}, f)


if __name__ == "__main__":
    main()
