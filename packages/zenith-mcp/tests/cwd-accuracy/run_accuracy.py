#!/usr/bin/env python3
"""Paired, real-transport all-tool accuracy matrix. No resolver mocks or cwd args.

Usage: python3 run_accuracy.py --repo-root REPO --out-dir NEW_DIR --repetition N
Reads and mutations use shared relative targets. Expected roots/bytes are fixture
facts fixed before calls. Each transport gets one long-running unregistered server
for 11 tools plus a registered (consent, not selection) server for refactor_batch.
"""
import argparse, base64, collections, hashlib, json, os, pathlib, re, resource, secrets, sys, time
ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'cwd-read'))
import harness as H
from build_fixtures import png_bytes

ap = argparse.ArgumentParser()
ap.add_argument('--repo-root', required=True)
ap.add_argument('--out-dir', required=True)
ap.add_argument('--repetition', type=int, default=1)
ap.add_argument('--steps', type=int, default=30)
ap.add_argument('--post-ttl', type=float, default=5.3)
a = ap.parse_args()
OUT = pathlib.Path(a.out_dir).resolve(); OUT.mkdir(parents=True, exist_ok=False)
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
records = []; servers = []; original_cwd = os.getcwd()
EVENTS = (OUT / 'records.jsonl').open('w')

def text(result): return H.extract_text(result) or ''
def success(result): return bool(result and 'error' not in result and not result.get('_transport_error') and not result.get('result', {}).get('isError'))
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def fixtures(name):
    base = OUT / name; base.mkdir()
    projects = {}
    for key in ['A', 'B', 'C']:
        p = base / key; (p / 'work').mkdir(parents=True)
        if key == 'C': (p / 'package.json').write_text('{}')
        else: (p / '.git').mkdir()
        token = 'ROOT_TOKEN_' + key + '_' + str(a.repetition)
        (p / 'marker.txt').write_text(token + '\n')
        (p / 'second.txt').write_text(token + '_SECOND\n')
        (p / ('only_' + key + '.txt')).write_text(key)
        (p / 'image.png').write_bytes(png_bytes(token))
        (p / 'code.js').write_text("function specimen() { return '" + token + "'; }\n")
        projects[key] = p
    (base / 'space alias').symlink_to(projects['C'], target_is_directory=True)
    return projects

def spawn(transport, name, projects, registered=False):
    home = OUT / (name + '-home'); home.mkdir()
    port = H.free_port() if transport == 'http' else None
    H.write_isolated_config(str(home), port=port or 7099)
    if registered:
        with (home / '.zenith-mcp/config').open('a') as f:
            f.write('\n### Projects\n')
            for key, p in projects.items():
                f.write(f'== {key} ==\nProject_ID: {key}\nProject_Name: {key}\nProject_Root: {p}\n\n')
    os.chdir(projects['A'] / 'work')
    server = H.ServerHandle(a.repo_root, transport, str(home), name, str(projects['A'] / 'work'), token=secrets.token_hex(24), port=port).start()
    servers.append(server)
    inventory = server.tools_list()
    names = [x['name'] for x in inventory.get('result', {}).get('tools', [])]
    if set(names) != set(H.ALL_12): raise RuntimeError('tools/list inventory mismatch: ' + repr(inventory))
    return server

def record(server, tool, args, expect, verify, step, phase='primary', extra=None):
    started = time.monotonic(); rpc = server.call_tool(tool, args)
    elapsed = (time.monotonic() - started) * 1000
    try: passed, actual, reason = verify(rpc)
    except Exception as e: passed, actual, reason = False, None, type(e).__name__ + ': ' + str(e)
    status = 'pass' if passed else 'harness-error' if rpc.get('_transport_error') else 'fail'
    row = {'repetition':a.repetition, 'tool':tool, 'transport':server.transport, 'phase':phase, 'step':step,
           'server_pid':server.pid, 'server_cwd':server.server_proc_cwd(), 'parent_cwd':os.getcwd(),
           'expected_target':str(expect), 'actual_evidence':actual, 'status':status, 'reason':reason,
           'latency_ms':round(elapsed,3), 'request':{'name':tool,'arguments':args}, 'response':rpc,
           'evidence_topology':'controlled-local-server-parent', 'extra':extra or {}}
    records.append(row); EVENTS.write(json.dumps(row)+'\n'); EVENTS.flush()
    return rpc

def content_check(expected):
    return lambda rpc: (success(rpc) and expected in text(rpc), text(rpc), 'fixture content must identify expected project')

def mutation_check(projects, key, rel, payload, before):
    def verify(rpc):
        actual = {k:digest(p/rel) for k,p in projects.items()}
        expected = hashlib.sha256(payload.encode()).hexdigest()
        ok = success(rpc) and actual[key] == expected and all(actual[k] == before[k] for k in projects if k != key)
        return ok, actual, 'exact destination bytes and unchanged siblings'
    return verify

sequence = ['A','A','B','B','A','C','B','A','C','A']
try:
    for transport in ['stdio','http']:
        projects = fixtures(transport + '-plain')
        server = spawn(transport, transport + '-plain', projects)
        stash_ids = {}
        # Real error-path creation of one stash per fixture, with ABSOLUTE paths.
        # These are setup, not discovery evidence. The measured file filter is relative.
        for key,p in projects.items():
            (p/'stash.txt').write_text('fixture '+key+'\n')
            rpc = server.call_tool('edit_file', {'path':str(p/'stash.txt'), 'edits':[{'mode':'content','oldContent':'NO_SUCH_MARKER','newContent':'replacement'}]})
            m = re.search(r'stash:(\d+)', text(rpc))
            stash_ids[key] = int(m[1]) if m else None
        for step in range(a.steps):
            key=sequence[step%len(sequence)]; p=projects[key]
            os.chdir(p/'work')
            delayed = step % 10 == 5
            if delayed: time.sleep(a.post_ttl)
            phase = 'primary-post-ttl' if delayed else 'primary-immediate'
            token=(p/'marker.txt').read_text().strip()
            record(server,'bash',{'command':'pwd'},p,lambda r:(success(r) and str(p)+'\n' in text(r),text(r),'actual command cwd'),step,phase)
            record(server,'read_file',{'path':'marker.txt'},p/'marker.txt',content_check(token),step,phase)
            record(server,'search_file',{'path':'marker.txt','grep':'ROOT_TOKEN'},p/'marker.txt',content_check(token),step,phase)
            media_hash=digest(p/'image.png')
            def check_media(r, expected=media_hash):
                media=H.extract_media(r); actual=hashlib.sha256(base64.b64decode(media[1])).hexdigest() if media and media[1] else None
                return success(r) and actual==expected,actual,'exact media bytes'
            record(server,'read_media_file',{'path':'image.png'},p/'image.png',check_media,step,phase)
            record(server,'read_multiple_files',{'paths':['marker.txt','second.txt'],'compression':False},p,content_check(token+'_SECOND'),step,phase)
            record(server,'directory',{'mode':'list','path':'.'},p,content_check('only_'+key+'.txt'),step,phase)
            record(server,'search_files',{'mode':'content','path':'.','contentQuery':'ROOT_TOKEN','pattern':'marker.txt','literalSearch':True},p,content_check(token),step,phase)
            rel='write-'+str(step)+'.txt'; payload='WRITTEN_'+key+'_'+str(step)+'\n'; before={k:digest(v/rel) for k,v in projects.items()}
            record(server,'write_file',{'path':rel,'content':payload},p/rel,mutation_check(projects,key,rel,payload,before),step,phase)
            rel='edit-'+str(step)+'.txt'
            for k,v in projects.items(): (v/rel).write_text('OLD_'+k+'\n')
            before={k:digest(v/rel) for k,v in projects.items()}; payload='NEW_'+key+'\n'
            record(server,'edit_file',{'path':rel,'edits':[{'mode':'content','oldContent':'OLD_'+key,'newContent':'NEW_'+key}]},p/rel,mutation_check(projects,key,rel,payload,before),step,phase)
            rel='remove-'+str(step)+'.txt'
            for k,v in projects.items(): (v/rel).write_text('REMOVE_'+k+'\n')
            before={k:digest(v/rel) for k,v in projects.items()}
            def deleted(r, key=key,rel=rel,before=before):
                actual={k:digest(v/rel) for k,v in projects.items()}
                return success(r) and actual[key] is None and all(actual[k]==before[k] for k in projects if k!=key),actual,'only the intended relative target was deleted'
            record(server,'file_manager',{'mode':'delete','path':rel},p/rel,deleted,step,phase)
            expected_id=stash_ids[key]
            def stash_check(r, key=key,p=p,expected_id=expected_id):
                t=text(r); ok=success(r) and expected_id is not None and ('#'+str(expected_id)+' ') in t and str(p/'stash.txt') in t
                return ok,t,'relative file filter must select the independently created project entry'
            record(server,'stashRestore',{'mode':'list','file':'stash.txt','range':100},p/'stash.txt',stash_check,step,phase)
        # Absolute-path control and following relative operation with parent held in A.
        os.chdir(projects['A']/'work')
        record(server,'read_file',{'path':str(projects['B']/'marker.txt')},projects['B']/'marker.txt',content_check((projects['B']/'marker.txt').read_text().strip()),-1,'absolute-control')
        record(server,'bash',{'command':'pwd'},projects['A'],lambda r:(success(r) and str(projects['A'])+'\n' in text(r),text(r),'absolute read did not change active project'),-1,'post-absolute-control')
        server.stop(); servers.remove(server)

        # Symbol persistence consent is registered for ALL candidates, with no
        # granted/selected root. Ambient cwd must still choose between A/B/C.
        reg = fixtures(transport+'-registered')
        server = spawn(transport,transport+'-registered',reg,registered=True)
        for step in range(a.steps):
            key=sequence[step%len(sequence)]; p=reg[key]; os.chdir(p/'work')
            token=(p/'marker.txt').read_text().strip()
            record(server,'refactor_batch',{'mode':'loadDiff','selection':[{'symbol':'specimen','file':'code.js'}],'contextLines':0},p/'code.js',content_check(token),step,'primary-registered-consent')
        server.stop(); servers.remove(server)
finally:
    for server in servers: server.stop()
    os.chdir(original_cwd); EVENTS.close()
counts=collections.defaultdict(collections.Counter)
for r in records: counts[r['tool']+'|'+r['transport']][r['status']]+=1
summary={'repo_root':str(pathlib.Path(a.repo_root).resolve()),'repetition':a.repetition,'steps':a.steps,
         'records':len(records),'primary_records':sum(r['phase'].startswith('primary') for r in records),
         'tools':{k:dict(v) for k,v in counts.items()},'all_pass':all(r['status']=='pass' for r in records),
         'observability':'Operation target and returned bytes; bash additionally exposes actual child cwd. Other active-root selection is covered separately by registration-seam tests.',
         'scope':'Local Linux parent-cwd evidence; refactor matrix uses declared registry persistence consent, never a fixed selection.'}
(OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary),flush=True)
sys.exit(0 if not any(r['status']=='harness-error' for r in records) else 2)
