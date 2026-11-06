#!/usr/bin/env python3
"""Prism fixture builder — creates the project-detection fixture tree.

All fixtures live under <scratch>/fixtures (default agents/prism/fixtures),
OUTSIDE /tmp, OUTSIDE the isolated HOME, and OUTSIDE any unintended ancestor
git/marker project. Each fixture project carries unique, greppable content so
returned data is unambiguous ground truth.

Projects:
  proj-alpha   git-dir project (.git directory)
  proj-beta    git-dir project (.git directory)
  proj-gamma   marker-only project (package.json, no .git)
  proj-wt      git worktree (.git FILE pointer) -> detected as its own root
  proj-sp ace  git-dir project whose path contains a space and a symlink
  junk-plain   markerless directory (junk source evidence; no boundary)

Every project exposes a shared RELATIVE layout so relative-path tests never
reveal the answer in the path itself:
  marker.txt          unique one-line token per project
  src/code_<tag>.ts   unique exported function symbol per project
  src/notes_<tag>.txt unique greppable sentence per project
  assets/img_<tag>.png  valid PNG (distinct bytes per project)
  assets/snd_<tag>.wav  valid WAV (distinct bytes per project)
  nested/deep/deep_<tag>.txt  unique nested content
"""
import json, os, struct, sys, zlib, hashlib

def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(data, (bytes, bytearray)) else "w"
    with open(path, mode) as f:
        f.write(data)

def png_bytes(tag_text):
    """A minimal valid 1x1 PNG; the tag text is embedded in a tEXt chunk so
    bytes differ per project while remaining a real image."""
    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    # raw scanline: filter byte 0 + RGB pixel
    raw = b"\x00" + bytes([0x40, 0x70, 0xB0])
    idat = zlib.compress(raw)
    text = b"Comment\x00" + tag_text.encode()
    return (sig + chunk(b"IHDR", ihdr) + chunk(b"tEXt", text)
            + chunk(b"IDAT", idat) + chunk(b"IEND", b""))

def wav_bytes(tag_freq):
    """A minimal valid mono 8-bit WAV with a short tone; freq differs per
    project so bytes (and sha) differ."""
    import math
    rate = 8000
    n = 800
    frames = bytes(int(128 + 60 * math.sin(2 * math.pi * tag_freq * i / rate))
                   for i in range(n))
    byte_rate = rate * 1 * 8 // 8
    block_align = 1
    data_size = len(frames)
    hdr = b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
    fmt = b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 1, rate, byte_rate, block_align, 8)
    dat = b"data" + struct.pack("<I", data_size) + frames
    return hdr + fmt + dat

def code_ts(tag, fnname, token):
    return (
        f"// {tag} source module\n"
        f"export interface {tag}Config {{\n"
        f"    name: string;\n"
        f"}}\n"
        f"\n"
        f"export function {fnname}(input: string): string {{\n"
        f"    // unique marker: {token}\n"
        f"    return `{token}::${{input}}`;\n"
        f"}}\n"
        f"\n"
        f"export class {tag}Service {{\n"
        f"    run(): string {{\n"
        f"        return {fnname}(\"call\");\n"
        f"    }}\n"
        f"}}\n"
    )

def big_text(tag, token, lines=400):
    out = []
    for i in range(1, lines + 1):
        out.append(f"{tag} line {i:04d} payload {token} {'x' * 40}")
    return "\n".join(out) + "\n"

# Per-project identity
PROJECTS = {
    "proj-alpha":  {"tag": "Alpha",  "fn": "alphaCompute",  "token": "ALPHA-TOKEN-7f3a1", "freq": 220, "kind": "gitdir"},
    "proj-beta":   {"tag": "Beta",   "fn": "betaCompute",   "token": "BETA-TOKEN-2c9e4",  "freq": 330, "kind": "gitdir"},
    "proj-gamma":  {"tag": "Gamma",  "fn": "gammaCompute",  "token": "GAMMA-TOKEN-5b1d8", "freq": 440, "kind": "marker"},
    "proj-wt":     {"tag": "Worktree","fn": "worktreeCompute","token": "WT-TOKEN-9a6f2",   "freq": 550, "kind": "worktree"},
    "proj-sp ace": {"tag": "Space",  "fn": "spaceCompute",  "token": "SPACE-TOKEN-4d7c3", "freq": 660, "kind": "gitdir"},
}

def build_project(root, name, meta):
    tag, fn, token, freq = meta["tag"], meta["fn"], meta["token"], meta["freq"]
    pdir = os.path.join(root, name)
    os.makedirs(pdir, exist_ok=True)
    kind = meta["kind"]
    if kind == "gitdir":
        os.makedirs(os.path.join(pdir, ".git"), exist_ok=True)
        write(os.path.join(pdir, ".git", "HEAD"), "ref: refs/heads/main\n")
    elif kind == "worktree":
        # .git FILE pointer (worktree/submodule style) — containing dir is root
        write(os.path.join(pdir, ".git"), f"gitdir: {root}/proj-mainrepo/.git/worktrees/{name}\n")
    elif kind == "marker":
        write(os.path.join(pdir, "package.json"),
              json_pkg(name))
    # shared relative layout
    write(os.path.join(pdir, "marker.txt"), f"{token}\n")
    write(os.path.join(pdir, "src", f"code_{tag.lower()}.ts"), code_ts(tag, fn, token))
    write(os.path.join(pdir, "src", f"notes_{tag.lower()}.txt"),
          f"This sentence is unique to project {tag}. Token {token}.\nSecond line of {tag} notes.\n")
    write(os.path.join(pdir, "src", f"big_{tag.lower()}.txt"), big_text(tag, token))
    write(os.path.join(pdir, "assets", f"img_{tag.lower()}.png"), png_bytes(f"{tag}-{token}"))
    write(os.path.join(pdir, "assets", f"snd_{tag.lower()}.wav"), wav_bytes(freq))
    write(os.path.join(pdir, "assets", f"icon_{tag.lower()}.svg"),
          f"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\">"
          f"<title>{tag} {token}</title><rect width=\"8\" height=\"8\" fill=\"#3060a0\"/></svg>\n")
    write(os.path.join(pdir, "nested", "deep", f"deep_{tag.lower()}.txt"),
          f"deep content {tag} {token}\n")

def json_pkg(name):
    return json.dumps({"name": name, "version": "0.0.0", "private": True}, indent=2) + "\n"

def main():
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.expanduser("~"), ".prism-cwd-read", "fixtures")  # == harness.DEFAULT_FIXTURES
    os.makedirs(root, exist_ok=True)
    # A parent container with NO marker/git so ancestors don't become a project.
    # (fixtures root itself must be markerless.)
    for name, meta in PROJECTS.items():
        build_project(root, name, meta)
    # markerless junk project (no .git, no markers) — must NOT be detected
    junk = os.path.join(root, "junk-plain")
    os.makedirs(os.path.join(junk, "src"), exist_ok=True)
    write(os.path.join(junk, "marker.txt"), "JUNK-TOKEN-0e0f0\n")
    write(os.path.join(junk, "src", "notes_junk.txt"), "junk notes, no project markers here.\n")
    # a git-file worktree needs a plausible main repo to point at (not strictly
    # required for boundary detection, which only stats the .git file's presence)
    os.makedirs(os.path.join(root, "proj-mainrepo", ".git", "worktrees"), exist_ok=True)
    # symlinked access path to proj-sp ace
    link = os.path.join(root, "link-to-space")
    try:
        if os.path.islink(link) or os.path.exists(link):
            os.remove(link)
        os.symlink(os.path.join(root, "proj-sp ace"), link)
    except OSError as e:
        print("symlink note:", e, file=sys.stderr)
    # manifest of expected tokens + sha256 of media for ground truth
    manifest = {}
    for name, meta in PROJECTS.items():
        pdir = os.path.join(root, name)
        rec = {"tag": meta["tag"], "fn": meta["fn"], "token": meta["token"],
               "kind": meta["kind"], "root": os.path.realpath(pdir)}
        for mediarel, key in ((f"assets/img_{meta['tag'].lower()}.png", "png"),
                              (f"assets/snd_{meta['tag'].lower()}.wav", "wav"),
                              (f"assets/icon_{meta['tag'].lower()}.svg", "svg")):
            with open(os.path.join(pdir, mediarel), "rb") as f:
                rec[key + "_sha256"] = hashlib.sha256(f.read()).hexdigest()
        manifest[name] = rec
    import json as _j
    write(os.path.join(root, "fixtures-manifest.json"), _j.dumps(manifest, indent=2) + "\n")
    print("FIXTURES_BUILT at", root)
    print("projects:", ", ".join(list(PROJECTS) + ["junk-plain"]))

if __name__ == "__main__":
    main()
