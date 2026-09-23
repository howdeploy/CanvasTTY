/** Fixed image bootstrap. Never generated from workspace content; invoked with Python -I -S. */
export const CONTAINER_BOOTSTRAP = String.raw`
import os, sys, json, tempfile, stat

def fail():
    sys.stderr.write('CanvasTTY container preflight failed: limits, workspace, image command or recipe could not be verified.\n')
    sys.exit(78)

def verify_limits(root, requested, cgroup):
    if cgroup.strip() != '0::/': raise ValueError('private cgroup required')
    with open(root + '/cpu.max') as f: cpu = f.read().strip().split()
    if len(cpu) != 2 or cpu[0] == 'max' or int(cpu[0]) <= 0 or int(cpu[1]) <= 0 or int(cpu[0]) / int(cpu[1]) > requested['cpus'] + 0.000001: raise ValueError('cpu')
    for name, maximum in [('memory.max', requested['memoryMb'] * 1048576), ('pids.max', requested['pids'])]:
        with open(root + '/' + name) as f: value = f.read().strip()
        if value == 'max' or int(value) <= 0 or int(value) > maximum: raise ValueError('limit')

def run():
    raw = os.environ.get('CANVASTTY_CONTAINER_RECIPE', '')
    if len(raw) > 65536: fail()
    recipe = json.loads(raw)
    with open('/proc/self/status') as f: status = dict(line.split(':', 1) for line in f if ':' in line)
    if status.get('NoNewPrivs', '').strip() != '1' or any(int(status.get(key, '-1').strip(), 16) != 0 for key in ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']): fail()
    with open('/proc/self/cgroup') as f: verify_limits('/sys/fs/cgroup', recipe['limits'], f.read())
    # No unexpected host data mount is accepted. Ordinary runtime pseudo-filesystems and DNS files are allowed.
    required_mounts = set()
    with open('/proc/self/mountinfo') as f:
        for line in f:
            fields = line.split(); mount = fields[4].replace('\\040', ' ')
            options = fields[5].split(',')
            if mount == '/' and 'ro' not in options: raise ValueError('root is writable')
            if mount == '/tmp' and any(flag not in options for flag in ['rw','nosuid','nodev','noexec']): raise ValueError('temporary mount restrictions')
            if mount == '/workspace' and ('rw' not in options or any(field.startswith('shared:') for field in fields[6:fields.index('-')])): raise ValueError('workspace propagation')
            if mount in ['/','/tmp','/workspace']: required_mounts.add(mount)
            if mount in ['/', '/workspace', '/tmp', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf'] or mount == '/proc' or mount.startswith('/proc/') or mount == '/sys' or mount.startswith('/sys/') or mount == '/dev' or mount.startswith('/dev/'): continue
            raise ValueError('unexpected mount')
    if len(required_mounts) != 3: fail()
    if os.path.realpath('/workspace') != '/workspace' or not os.path.isdir('/workspace'): fail()
    marker = recipe['marker']
    if not isinstance(marker, dict) or not marker['name'].startswith('.canvastty-container-') or '/' in marker['name'] or len(marker['name']) != len('.canvastty-container-') + 36: fail()
    marker_path = '/workspace/' + marker['name']
    fd = os.open(marker_path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        identity = os.fstat(fd)
        if not stat.S_ISREG(identity.st_mode) or identity.st_nlink != 1 or os.read(fd, 129).decode('ascii') != marker['token']: fail()
    finally: os.close(fd)
    os.unlink(marker_path)
    info = os.stat('/workspace')
    if recipe.get('workspaceDev') is not None and recipe.get('nativeHost') and (info.st_dev != recipe['workspaceDev'] or info.st_ino != recipe['workspaceIno']): fail()
    os.umask(0o077)
    fd, probe = tempfile.mkstemp(prefix='.canvastty-write-', dir='/workspace'); os.close(fd); os.unlink(probe)
    command = recipe['command']; args = recipe['args']
    if not isinstance(command, str) or not command.startswith('/') or not os.path.isfile(command) or not os.access(command, os.X_OK): fail()
    if not isinstance(args, list) or len(args) > 256 or any(not isinstance(a, str) or len(a) > 65536 for a in args): fail()
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8'}
    for key in ['CANVASTTY_PROFILE_API_KEY', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION']:
        if key in os.environ: env[key] = os.environ[key]
    config = recipe.get('api')
    if config:
        if config['runtime'] not in ['minimax', 'omp']: fail()
        key = env.get('CANVASTTY_PROFILE_API_KEY')
        if not key: fail()
        directory = tempfile.mkdtemp(prefix='canvastty-api-', dir='/tmp')
        provider, model = config['provider'], config['model']
        if config['runtime'] == 'minimax':
            name = 'config.yaml'
            document = {'defaultModel': 'custom_provider:' + provider + '/' + model, 'custom_provider': {provider: {'name': 'CanvasTTY', 'api': config['api'], 'options': {'baseURL': config['baseUrl'], 'apiKey': key}, 'models': {model: {}}}}}
            env['MINIMAX_DATA_DIR'] = directory; env['MAVIS_DATA_DIR'] = directory; del env['CANVASTTY_PROFILE_API_KEY']
        else:
            name = 'models.yml'
            document = {'providers': {provider: {'baseUrl': config['baseUrl'], 'apiKey': 'CANVASTTY_PROFILE_API_KEY', 'api': config['api'], 'models': [{'id': model}]}}}
            env['PI_CODING_AGENT_DIR'] = directory; env['OMP_PROFILE'] = ''; env['PI_PROFILE'] = ''
        with open(directory + '/' + name, 'x', encoding='utf8') as f: json.dump(document, f)
        os.chmod(directory + '/' + name, 0o600)
    cwd = recipe.get('cwd', '/workspace')
    if not isinstance(cwd, str) or (cwd != '/workspace' and not cwd.startswith('/workspace/')) or os.path.realpath(cwd) != cwd: fail()
    os.chdir(cwd)
    os.execve(command, [command] + args, env)

if __name__ == '__main__':
    try: run()
    except Exception: fail()
`;
