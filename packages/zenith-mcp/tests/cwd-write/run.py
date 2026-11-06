#!/usr/bin/env python3
# Launcher for the cwd-write runner. Per the shared tooling README, Node must
# run through Python subprocess with an explicit small environment and piped /
# log-file stdio (the inherited terminal aborts the pinned Node with exit 134).
# Sets RLIMIT_CORE=0 to prevent crash-dump litter. Passes through run.mjs args.
# Node binary: $ZENITH_NODE if set, else `node` on the launcher's PATH.
import os, sys, subprocess, resource, argparse, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(HERE, 'run.mjs')

def resolve_node():
    # Resolved in the launcher's own environment: the child env below pins PATH
    # to /usr/bin:/bin, so a user-installed node would not be found there.
    want = os.environ.get('ZENITH_NODE') or 'node'
    node = shutil.which(want)
    if not node:
        sys.exit(f'run.py: no Node binary found ({want!r}); set ZENITH_NODE=<path to node> or put `node` on PATH')
    return node

ap = argparse.ArgumentParser()
ap.add_argument('--repo-root', required=True)
ap.add_argument('--out-dir', required=True)
ap.add_argument('--repetitions', default='3')
ap.add_argument('--transports', default='stdio,http')
ap.add_argument('--base', default=None, help='fixtures + isolated HOMEs root (default: <out-dir>/base)')
ap.add_argument('--home-base', default=None)
ap.add_argument('--fixtures-base', default=None)
ap.add_argument('--log', default=None)
args = ap.parse_args()

NODE = resolve_node()
# Absolute paths: the runner is started with cwd=base, not the caller's cwd.
out_dir = os.path.abspath(args.out_dir)
base = os.path.abspath(args.base) if args.base else os.path.join(out_dir, 'base')
os.makedirs(base, exist_ok=True)

cmd = [NODE, RUN,
       '--repo-root', os.path.abspath(args.repo_root),
       '--out-dir', out_dir,
       '--repetitions', args.repetitions,
       '--transports', args.transports,
       '--base', base]
if args.home_base: cmd += ['--home-base', os.path.abspath(args.home_base)]
if args.fixtures_base: cmd += ['--fixtures-base', os.path.abspath(args.fixtures_base)]

env = {
    'PATH': '/usr/bin:/bin',
    'HOME': base,                # runner's own HOME (servers get isolated HOMEs)
    'CI': '1', 'NO_COLOR': '1', 'npm_config_userconfig': '/dev/null',
}

def preexec():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

logf = open(args.log, 'w') if args.log else subprocess.PIPE
proc = subprocess.run(cmd, env=env, cwd=base,
                      stdout=logf, stderr=subprocess.STDOUT, preexec_fn=preexec, text=True)
if args.log:
    logf.close()
    # surface the tail for the caller
    with open(args.log) as f:
        tail = f.read().splitlines()[-40:]
    print('\n'.join(tail))
print('EXIT=', proc.returncode)
sys.exit(proc.returncode)
