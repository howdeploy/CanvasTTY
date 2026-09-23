import type { ContainerProfile, RemoteHost } from '../../shared/contracts.ts';
import { remoteHostInvalidReason } from '../../shared/contracts.ts';
export const quoteRemoteWord = (word: string): string => { if (word.includes('\0')) throw new Error('Invalid remote container argument.'); return `'${word.replaceAll("'", "'\\''")}'`; };
export function remoteContainerCommand(host: RemoteHost, command: string, args: string[], tty = false): { command: string; args: string[] } {
  if (remoteHostInvalidReason(host)) throw new Error('Invalid remote container host.');
  return { command: 'ssh', args: [tty ? '-tt' : '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', ...(host.sshPort ? ['-p', String(host.sshPort)] : []), '--', host.sshUser ? `${host.sshUser}@${host.sshHost}` : host.sshHost, [command, ...args].map(quoteRemoteWord).join(' ')] };
}
/** One-shot host helper. It never prints environment/auth files, starts engines or deletes output. */
export const REMOTE_CONTAINER_HOST = String.raw`
import os, sys, json, stat, uuid, subprocess, tempfile, hashlib

def checked_dir(path, private=False):
    if os.path.realpath(path) != path or not stat.S_ISDIR(os.lstat(path).st_mode): raise ValueError('noncanonical directory')
    if private and (os.stat(path).st_uid != os.getuid() or os.stat(path).st_mode & 0o077): raise ValueError('private directory required')
    return path

def git(cwd, args):
    env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    env['GIT_TERMINAL_PROMPT']='0'; env['GIT_LFS_SKIP_SMUDGE']='1'
    with tempfile.TemporaryFile() as out:
        result = subprocess.run(['/usr/bin/git', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', cwd] + args, stdout=out, stderr=subprocess.DEVNULL, env=env, timeout=30)
        if result.returncode or out.tell() > 4194304: raise ValueError('bounded git operation failed')
        out.seek(0); return out.read().decode('utf-8').rstrip('\n')

def main():
    request = json.loads(sys.argv[1]); action=request['action']
    if sys.platform != 'linux': raise ValueError('remote Linux required')
    root = os.path.join(os.path.expanduser('~'), '.local', 'share', 'canvastty-container-workspaces')
    os.makedirs(root, mode=0o700, exist_ok=True); checked_dir(root, True)
    config = os.path.join(root, 'engine-config'); os.makedirs(config, mode=0o700, exist_ok=True); checked_dir(config, True)
    config_file = os.path.join(config, 'config.json')
    if not os.path.lexists(config_file):
        fd=os.open(config_file, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600); os.write(fd, b'{}'); os.close(fd)
    info=os.lstat(config_file)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size != 2: raise ValueError('config identity')
    with open(config_file) as f:
        if f.read() != '{}': raise ValueError('config content')
    if action == 'endpoint':
        p=request['profile']; executable=os.path.realpath(p['executable']); info=os.stat(executable)
        if not stat.S_ISREG(info.st_mode) or not os.access(executable, os.X_OK): raise ValueError('engine executable')
        socket=None
        if p['endpoint']['kind'] == 'unix':
            socket=os.path.realpath(p['endpoint']['socket'])
            if not stat.S_ISSOCK(os.stat(socket).st_mode): raise ValueError('engine socket')
        return {'executable':executable, 'socket':socket, 'executableIdentity':hashlib.sha256(json.dumps([executable,info.st_dev,info.st_ino,info.st_mtime_ns,info.st_size]).encode()).hexdigest(), 'configDirectory':config, 'home':os.path.expanduser('~')}
    selected=checked_dir(request['source'])
    source=selected
    source=checked_dir(git(source,['rev-parse','--show-toplevel']))
    common=checked_dir(os.path.realpath(os.path.join(source,git(source,['rev-parse','--git-common-dir']))))
    identity=os.stat(source)
    ident=request.get('id') or str(uuid.uuid4())
    if str(uuid.UUID(ident)) != ident: raise ValueError('workspace identity')
    directory=os.path.join(root,ident); checkout=os.path.join(directory,'workspace')
    if action == 'create':
        if len(os.listdir(root)) >= 514: raise ValueError('workspace registry full')
        os.mkdir(directory,0o700); hooks=os.path.join(directory,'disabled-hooks'); os.mkdir(hooks,0o700)
        commit=git(source,['rev-parse','--verify','HEAD^{commit}'])
        entries=git(source,['ls-tree','-rlz',commit]).split('\0')
        size=0
        if len(entries)>20001: raise ValueError('workspace size')
        for entry in entries:
            if not entry: continue
            fields=entry.split('\t',1)[0].split()
            if fields[-1].isdigit(): size += int(fields[-1])
        if size>1073741824: raise ValueError('workspace size')
        git(source,['-c','core.hooksPath='+hooks,'-c','submodule.recurse=false','worktree','add','--detach','--',checkout,commit])
        workspace={'id':ident,'directory':checkout,'sourceDirectory':source,'commit':commit}
        manifest={'workspace':workspace,'dev':identity.st_dev,'ino':identity.st_ino,'common':common,'gitDirectory':os.path.realpath(git(checkout,['rev-parse','--absolute-git-dir']))}
        fd=os.open(os.path.join(directory,'manifest.json'),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600); os.write(fd,json.dumps(manifest).encode()); os.close(fd)
        relative=os.path.relpath(selected,source)
        selected_checkout=os.path.normpath(os.path.join(checkout,relative))
        checked_dir(selected_checkout)
        return dict(workspace,relativeCwd='' if relative=='.' else relative,uid=os.stat(checkout).st_uid,gid=os.stat(checkout).st_gid)
    checked_dir(directory,True); path=os.path.join(directory,'manifest.json'); info=os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>8192 or info.st_mode & 0o077: raise ValueError('manifest')
    with open(path) as f: manifest=json.load(f)
    w=manifest['workspace']; checked_dir(checkout)
    if w['id']!=ident or w['directory']!=checkout or w['sourceDirectory']!=source or manifest['common']!=common or manifest['dev']!=identity.st_dev or manifest['ino']!=identity.st_ino: raise ValueError('workspace changed')
    if os.path.realpath(git(checkout,['rev-parse','--absolute-git-dir']))!=manifest['gitDirectory']: raise ValueError('git identity')
    if os.path.realpath(os.path.join(checkout,git(checkout,['rev-parse','--git-common-dir'])))!=common: raise ValueError('git common identity')
    relative=os.path.relpath(selected,source)
    checked_dir(os.path.normpath(os.path.join(checkout,relative)))
    if action in ['marker-write','marker-remove']:
        name=request['name']; token=request['token']
        if not name.startswith('.canvastty-container-') or str(uuid.UUID(name[len('.canvastty-container-'):]))!=name[len('.canvastty-container-'):] or str(uuid.UUID(token))!=token: raise ValueError('marker identity')
        marker=os.path.join(checkout,name)
        if action=='marker-write':
            fd=os.open(marker,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600); os.write(fd,token.encode()); os.close(fd)
        elif os.path.lexists(marker):
            fd=os.open(marker,os.O_RDONLY|os.O_NOFOLLOW)
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or os.read(fd,129).decode()!=token: raise ValueError('marker changed')
            finally: os.close(fd)
            os.unlink(marker)
    return dict(w,relativeCwd='' if relative=='.' else relative,uid=os.stat(checkout).st_uid,gid=os.stat(checkout).st_gid)
try:
    os.umask(0o077)
    print(json.dumps(main()))
except Exception:
    sys.stderr.write('CanvasTTY remote container host verification failed. Output retained.\n'); sys.exit(78)
`;
export function remoteHostHelperArguments(profile: ContainerProfile, request: Record<string, unknown>): string[] {
  if (!profile.hostPython) throw new Error('Remote profile requires an absolute host Python interpreter.');
  return ['-I', '-S', '-c', REMOTE_CONTAINER_HOST, JSON.stringify(request)];
}
