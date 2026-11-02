#!/usr/bin/env python3
# Launcher for the cwd-write runner. Per the shared tooling README, Node must
# run through Python subprocess with an explicit small environment and piped /
# log-file stdio (the inherited terminal aborts the pinned Node with exit 134).
# Sets RLIMIT_CORE=0 to prevent crash-dump litter. Passes through run.mjs args.
import os, sys, subprocess, resource, argparse

NODE = '/home/tanner/Projects/Zenith-Worktrees/bash/tooling/node-v26.3.0-linux-x64/bin/node'
HERE = os.path.dirname(os.path.abspath(__file__))
RUN = os.path.join(HERE, 'run.mjs')

ap = argparse.ArgumentParser()
ap.add_argument('--repo-root', required=True)
ap.add_argument('--out-dir', required=True)
ap.add_argument('--repetitions', default='3')
ap.add_argument('--transports', default='stdio,http')
ap.add_argument('--base', default='/home/tanner/Projects/Zenith-Worktrees/bash/agents/flint')
ap.add_argument('--home-base', default=None)
ap.add_argument('--fixtures-base', default=None)
ap.add_argument('--log', default=None)
args = ap.parse_args()

cmd = [NODE, RUN,
       '--repo-root', args.repo_root,
       '--out-dir', args.out_dir,
       '--repetitions', args.repetitions,
       '--transports', args.transports,
       '--base', args.base]
if args.home_base: cmd += ['--home-base', args.home_base]
if args.fixtures_base: cmd += ['--fixtures-base', args.fixtures_base]

env = {
    'PATH': '/usr/bin:/bin',
    'HOME': args.base,           # runner's own HOME (servers get isolated HOMEs)
    'CI': '1', 'NO_COLOR': '1', 'npm_config_userconfig': '/dev/null',
}

def preexec():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

logf = open(args.log, 'w') if args.log else subprocess.PIPE
proc = subprocess.run(cmd, env=env, cwd=args.base,
                      stdout=logf, stderr=subprocess.STDOUT, preexec_fn=preexec, text=True)
if args.log:
    logf.close()
    # surface the tail for the caller
    with open(args.log) as f:
        tail = f.read().splitlines()[-40:]
    print('\n'.join(tail))
print('EXIT=', proc.returncode)
sys.exit(proc.returncode)
