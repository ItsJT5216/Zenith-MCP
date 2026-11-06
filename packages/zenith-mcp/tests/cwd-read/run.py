#!/usr/bin/env python3
import os, sys, argparse, resource
p = argparse.ArgumentParser(add_help=False)
p.add_argument('--out-dir', required=True); p.add_argument('--run-id', default='1')
a, _ = p.parse_known_args()
os.environ['PRISM_FIXTURES'] = os.path.abspath(os.path.join(a.out_dir, 'fixtures-run' + a.run_id))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_suite
raise SystemExit(run_suite.main())
