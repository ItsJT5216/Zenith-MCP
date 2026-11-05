#!/usr/bin/env python3
# unittest for run.py's launcher behaviour (PR #108 review C20-a4 / C21-a18):
# Node resolution ($ZENITH_NODE, else `node` on PATH, clear failure otherwise)
# and the portable --base default. run.py has import-time side effects, so it
# is exercised as a subprocess with a fake `node` shim that records its argv,
# cwd and HOME instead of running run.mjs.
#
# Run: python3 -m unittest discover -s packages/zenith-mcp/tests/cwd-write -p 'test_*.py'
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RUN_PY = os.path.join(HERE, 'run.py')

SHIM = """#!/bin/sh
printf 'SHIM=%s\\n' "$(python3 -c 'import json,os,sys; print(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(), "home": os.environ.get("HOME")}))' "$@")"
"""


@unittest.skipUnless(os.name == 'posix', 'run.py uses the posix resource module')
class RunPyLauncher(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='cwd-write-runpy-')
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bindir = os.path.join(self.tmp, 'bin')
        os.makedirs(self.bindir)
        self.shim = os.path.join(self.bindir, 'node')
        with open(self.shim, 'w') as f:
            f.write(SHIM)
        os.chmod(self.shim, 0o755)
        self.out = os.path.join(self.tmp, 'out')
        self.log = os.path.join(self.tmp, 'run.log')

    def launch(self, env_overrides, cwd=None, extra=()):
        env = {k: v for k, v in os.environ.items() if k not in ('ZENITH_NODE',)}
        env.update(env_overrides)
        cmd = [sys.executable, RUN_PY, '--repo-root', 'repo', '--out-dir', self.out, '--log', self.log, *extra]
        return subprocess.run(cmd, env=env, cwd=cwd or self.tmp, capture_output=True, text=True)

    def shim_record(self):
        with open(self.log) as f:
            for line in f:
                if line.startswith('SHIM='):
                    return json.loads(line[len('SHIM='):])
        self.fail('shim was not invoked: ' + open(self.log).read())

    def test_zenith_node_env_selects_the_binary_and_base_defaults_under_out_dir(self):
        proc = self.launch({'ZENITH_NODE': self.shim})
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        rec = self.shim_record()
        base = os.path.join(self.out, 'base')
        self.assertTrue(os.path.isdir(base), 'base must be created before it is used as cwd')
        self.assertEqual(rec['cwd'], base)
        self.assertEqual(rec['home'], base)
        argv = rec['argv']
        self.assertEqual(argv[0], os.path.join(HERE, 'run.mjs'))
        self.assertEqual(argv[argv.index('--base') + 1], base)
        self.assertEqual(argv[argv.index('--out-dir') + 1], self.out)
        self.assertEqual(argv[argv.index('--repo-root') + 1], os.path.join(self.tmp, 'repo'))

    def test_falls_back_to_node_on_the_launchers_path(self):
        proc = self.launch({'PATH': self.bindir + os.pathsep + os.environ.get('PATH', '')})
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.shim_record()['argv'][0], os.path.join(HERE, 'run.mjs'))

    def test_explicit_base_is_honoured_and_created(self):
        base = os.path.join(self.tmp, 'elsewhere', 'flint')
        proc = self.launch({'ZENITH_NODE': self.shim}, extra=('--base', base))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        rec = self.shim_record()
        self.assertTrue(os.path.isdir(base))
        self.assertEqual(rec['cwd'], base)
        self.assertEqual(rec['argv'][rec['argv'].index('--base') + 1], base)

    def test_missing_node_fails_with_a_clear_message(self):
        proc = self.launch({'ZENITH_NODE': os.path.join(self.tmp, 'no-such-node'), 'PATH': self.tmp})
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('no Node binary found', proc.stderr)
        self.assertIn('ZENITH_NODE', proc.stderr)
        self.assertNotIn('Traceback', proc.stderr)


if __name__ == '__main__':
    unittest.main()
