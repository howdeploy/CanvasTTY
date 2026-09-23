import type { ContainerProfile } from '../../shared/contracts.ts';
import { REMOTE_PROCESS_CAPTURE } from './RemoteProcessCapture.ts';
import { CONTAINER_BOOTSTRAP } from './ContainerBootstrap.ts';
import { REMOTE_CONTAINER_HOST_LIBRARY } from './RemoteContainerHost.ts';

/** Fixed host-only operations. Raw engine responses and environment verification material never cross SSH. */
export const REMOTE_CONTAINER_ENGINE = REMOTE_CONTAINER_HOST_LIBRARY + REMOTE_PROCESS_CAPTURE + '\nBOOTSTRAP = ' + JSON.stringify(CONTAINER_BOOTSTRAP) + String.raw`
import re, hmac, secrets, selectors, time, signal, fcntl

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def require(value):
    if not value: raise ValueError('verification failed')

def host_call(request):
    previous = sys.argv; previous_environment = dict(os.environ)
    try:
        # Workspace Git checks do not need the selected or ambient API keys.
        os.environ.clear(); os.environ.update({k:previous_environment[k] for k in ['HOME','PATH','LANG'] if k in previous_environment})
        sys.argv = [previous[0], json.dumps(request)]
        return main()
    finally:
        sys.argv = previous; os.environ.clear(); os.environ.update(previous_environment)


def engine_env(endpoint):
    return {'HOME': endpoint['home'], 'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8'}

def engine_command(p, endpoint, words):
    if p['runtime'] == 'docker':
        prefix = ['--config', endpoint['configDirectory'], '--host', 'unix://' + endpoint['socket']]
    else:
        prefix = ['--remote=true', '--url', 'unix://' + endpoint['socket']] if endpoint.get('socket') else ['--remote=false']
    return [endpoint['executable']] + prefix + words

def engine_run(p, endpoint, words, values=None):
    env = engine_env(endpoint)
    if values: env.update(values)
    return capture(engine_command(p, endpoint, words), env)

def engine_info(p, endpoint):
    data = json.loads(engine_run(p, endpoint, ['info', '--format', '{{json .}}'] if p['runtime']=='docker' else ['info', '--format=json']))
    if p['runtime'] == 'docker':
        security = data.get('SecurityOptions', []); rootless = 'name=rootless' in security
        require(data.get('OSType')=='linux' and data.get('CgroupVersion')=='2' and all(data.get(k) is True for k in ['CpuCfsPeriod','CpuCfsQuota','MemoryLimit','PidsLimit']))
        require(not rootless or data.get('CgroupDriver')=='systemd')
        require(all(isinstance(data.get(k),str) and data[k] for k in ['ID','Name','DockerRootDir']))
        require(not any('userns' in s for s in security if isinstance(s,str)))
        name=data['Name']; identity=[data['ID'], name, data['DockerRootDir'], rootless]
    else:
        host=data['host']; store=data['store']; rootless=host['security'].get('rootless') is True
        require(host.get('os')=='linux' and host.get('cgroupVersion')=='v2' and all(c in host.get('cgroupControllers',[]) for c in ['cpu','memory','pids']))
        require(all(isinstance(v,str) for v in [host.get('hostname'),store.get('graphRoot'),store.get('runRoot')]))
        name=host['hostname']; identity=[name,store['graphRoot'],store['runRoot'],rootless]
    # The existing local identity hashes an array, so this is byte-compatible.
    return {'identity':digest(identity), 'rootless':rootless, 'name':name[:200]}

def one(raw):
    value=json.loads(raw); require(isinstance(value,list) and len(value)==1 and isinstance(value[0],dict)); return value[0]

def image_identity(value):
    require(isinstance(value,str)); value=value.removeprefix('sha256:'); require(re.fullmatch('[a-f0-9]{64}', value)); return 'sha256:'+value

def image_info(p, endpoint):
    value=one(engine_run(p,endpoint,['image','inspect',p['image']])); config=value.get('Config') or {}
    require(value.get('Os')=='linux' and value.get('Architecture') and not config.get('Volumes'))
    environment=config.get('Env') or []; require(isinstance(environment,list) and len(environment)<=512)
    names=[]
    for entry in environment:
        require(isinstance(entry,str) and re.match(r'^[A-Za-z_][A-Za-z0-9_]*=',entry))
        name=entry.split('=',1)[0]
        if name not in names: names.append(name)
    return {'id':image_identity(value['Id']), 'environmentNames':names}

def private_read(path, limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and not info.st_mode & 0o077 and info.st_size<=limit)
        data=os.read(fd,limit+1); require(len(data)<=limit); return data
    finally: os.close(fd)

def credential(ref, workspace):
    require(isinstance(ref,dict))
    if ref.get('kind')=='environment':
        require(set(ref)=={'kind','name'} and re.fullmatch('[A-Z][A-Z0-9_]{0,127}',ref['name']))
        require(not re.match(r'^(LD_|DYLD_|PYTHON|DOCKER|CONTAINER|PODMAN|XDG_|SSH_|GIT_|NODE_|PERL|RUBY)',ref['name']))
        require(ref['name'] not in ['PATH','HOME','ENV','BASH_ENV','SHELL','SHELLOPTS','BASHOPTS','IFS','CDPATH','USER','LOGNAME','LANG','LC_ALL','TMPDIR','TMP','TEMP'])
        value=os.environ.get(ref['name']); require(isinstance(value,str))
    else:
        require(ref.get('kind')=='key-file' and set(ref)=={'kind','path'})
        path=ref['path']; require(isinstance(path,str) and len(path.encode())<=4096 and path.startswith('/') and not re.search(r'[\x00-\x1f\x7f]',path))
        parts=path.split('/')[1:]; require(parts and all(p not in ['', '.', '..'] for p in parts))
        for root in [workspace['sourceDirectory'],workspace['directory']]:
            require(os.path.commonpath([path,root])!=root)
        parent=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                os.close(parent); parent=next_fd
                require(not os.fstat(parent).st_mode & 0o022)
            fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            try:
                info=os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and not info.st_mode & 0o077 and 0<info.st_size<=16384)
                data=os.read(fd,16385); require(len(data)<=16384); value=data.decode('utf-8')
            finally: os.close(fd)
        finally: os.close(parent)
        if value.endswith('\r\n'): value=value[:-2]
        elif value.endswith('\n'): value=value[:-1]
    require(0<len(value.encode())<=16384 and value.strip() and not re.search(r'[\x00-\x1f\x7f]',value))
    return value

def fixed_environment(values):
    require(isinstance(values,dict) and set(values)<= {'CANVASTTY_CONTAINER_RECIPE','OPENCODE_CONFIG_CONTENT','OPENCODE_PERMISSION','CANVASTTY_PROFILE_API_KEY'})
    require(all(isinstance(v,str) and '\0' not in v for v in values.values()))
    result=dict(values, HOME='/tmp', PATH='/usr/local/bin:/usr/bin:/bin', TERM='xterm-256color', LANG='C.UTF-8')
    return sorted(k+'='+v for k,v in result.items())

def inspected_environment(c):
    values=c.get('Env'); require(isinstance(values,list) and len(values)<=16)
    allowed={'HOME','PATH','TERM','LANG','CANVASTTY_CONTAINER_RECIPE','CANVASTTY_PROFILE_API_KEY','OPENCODE_CONFIG_CONTENT','OPENCODE_PERMISSION','HOSTNAME','container'}
    seen=set(); result=[]
    for entry in values:
        require(isinstance(entry,str) and '=' in entry)
        name=entry.split('=',1)[0]; require(name in allowed and name not in seen); seen.add(name)
        if name not in ['HOSTNAME','container']: result.append(entry)
    return sorted(result)

def verify_inspection(plan, container_id, value, manifest=None):
    p=plan['profile']; c=value['Config']; h=value['HostConfig']; state=value['State']
    require(value.get('Id')==container_id and value.get('Name','').removeprefix('/')==plan['name'] and image_identity(value['Image'])==plan['image']['id'])
    require(all(c.get('Labels',{}).get(k)==v for k,v in plan['labels'].items()))
    require(c.get('WorkingDir')=='/workspace' and (plan['user']=='keep-id' or c.get('User')==plan['user']))
    require(value.get('Path')==p['python'] and value.get('Args')==['-I','-S','-c',BOOTSTRAP] and c.get('Tty') is True and c.get('OpenStdin') is True)
    environment=inspected_environment(c)
    if manifest:
        actual=hmac.new(bytes.fromhex(manifest['hmacKey']),canonical(environment),hashlib.sha256).hexdigest()
        require(hmac.compare_digest(actual,manifest['environmentHmac']))
    else: require(digest(environment)==plan['environmentDigest'])
    require(c.get('Healthcheck') is None or isinstance(c['Healthcheck'],dict) and c['Healthcheck'].get('Test')==['NONE'])
    require(c.get('StartupHealthCheck') in [None,False] and c.get('Secrets') in [None,[]])
    require(h.get('LogConfig',{}).get('Type')=='none' and h.get('Init') is not True)
    mounts=value.get('Mounts'); require(isinstance(mounts,list)); binds=[m for m in mounts if m.get('Type')!='tmpfs']
    require(all(m.get('Destination')=='/tmp' for m in mounts if m.get('Type')=='tmpfs'))
    require(len(binds)==1); bind=binds[0]
    require(bind.get('Type')=='bind' and bind.get('Source')==plan['workspace']['directory'] and bind.get('Destination')=='/workspace' and bind.get('RW') is True and bind.get('Propagation')=='rprivate')
    empty=lambda v: v is None or v=='' or v==[]
    if p['runtime']=='docker':
        require(isinstance(h.get('Mounts'),list) and len(h['Mounts'])==1 and h['Mounts'][0].get('BindOptions',{}).get('NonRecursive') is True)
        require(any(cap in ['ALL','all'] for cap in h.get('CapDrop',[])))
    else:
        require(value.get('EffectiveCaps','missing') in [None,[]] and value.get('BoundingCaps','missing') in [None,[]])
        require('bind' in bind.get('Options',[]) and 'rbind' not in bind.get('Options',[]))
    numeric=lambda n: isinstance(n,(int,float)) and not isinstance(n,bool)
    cpus=h.get('NanoCpus',0)/1e9 if numeric(h.get('NanoCpus')) and h['NanoCpus']>0 else h.get('CpuQuota',0)/h['CpuPeriod'] if numeric(h.get('CpuQuota')) and numeric(h.get('CpuPeriod')) and h['CpuPeriod']>0 else 0
    require(h.get('Privileged') is False and h.get('ReadonlyRootfs') is True and empty(h.get('CapAdd')))
    require(any(s in ['no-new-privileges','no-new-privileges=true'] for s in h.get('SecurityOpt',[])) and h.get('NetworkMode')==p['network'])
    require(0<cpus<=p['cpus']+0.000001 and numeric(h.get('Memory')) and 0<h['Memory']<=p['memoryMb']*1048576 and isinstance(h.get('PidsLimit'),int) and not isinstance(h['PidsLimit'],bool) and 0<h['PidsLimit']<=p['pids'])
    require(all(empty(h.get(k)) for k in ['VolumesFrom','Devices','DeviceRequests']) and all(h.get(k)!='host' for k in ['PidMode','IpcMode','UTSMode']))
    require(h.get('CgroupnsMode' if p['runtime']=='docker' else 'CgroupMode')=='private' and h.get('RestartPolicy',{}).get('Name')=='no')
    tmpfs=h.get('Tmpfs'); require(isinstance(tmpfs,dict) and set(tmpfs)=={'/tmp'} and isinstance(tmpfs['/tmp'],str))
    options=tmpfs['/tmp'].split(','); sizes=[re.fullmatch(r'size=(\d+)([kmg]?)',o,re.I) for o in options if o.startswith('size=')]
    require(len(sizes)==1 and sizes[0] is not None); size=sizes[0]; count=int(size[1])*{'':1,'k':1024,'m':1024**2,'g':1024**3}[size[2].lower()]
    require(0<count<=256*1024**2 and all(o in options for o in ['noexec','nosuid','nodev']))
    return {'running':state.get('Running') is True}

def create_words(plan, names):
    p=plan['profile']; mount='type=bind,src='+plan['workspace']['directory']+',dst=/workspace,readonly=false,'+('bind-recursive=disabled' if p['runtime']=='docker' else 'bind-nonrecursive')+',bind-propagation=rprivate'
    words=['container','create','--name',plan['name']]
    for k,v in plan['labels'].items(): words+=['--label',k+'='+v]
    words+=['--interactive','--tty','--pull=never','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--network='+p['network'],'--cpus='+str(p['cpus']),'--memory='+str(p['memoryMb'])+'m','--pids-limit='+str(p['pids']),'--cgroupns=private','--restart=no','--stop-signal=SIGTERM','--log-driver=none','--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777'+(',notmpcopyup' if p['runtime']=='podman' else ''),'--workdir=/workspace','--mount='+mount,'--entrypoint',p['python']]
    if p['runtime']=='docker': words+=['--no-healthcheck']+['--env='+n for n in plan['image']['environmentNames'] if n not in names]
    else: words+=['--health-cmd=none','--image-volume=ignore','--http-proxy=false','--unsetenv-all','--read-only-tmpfs=false','--systemd=false','--sdnotify=ignore']
    words+=['--userns=keep-id'] if plan['user']=='keep-id' else ['--user='+plan['user']]
    return words+['--env='+n for n in names]+['--env=HOME=/tmp','--env=PATH=/usr/local/bin:/usr/bin:/bin','--env=TERM=xterm-256color','--env=LANG=C.UTF-8',plan['image']['id'],'-I','-S','-c',BOOTSTRAP]

def verify_engine(plan):
    endpoint=host_call({'action':'endpoint','profile':plan['profile']})
    require({k:v for k,v in endpoint.items() if v is not None}=={k:v for k,v in plan['endpoint'].items() if k!='hostFingerprint' and v is not None})
    require(engine_info(plan['profile'],endpoint)==plan['engine']); return endpoint

def manifest_path(plan):
    root=os.path.join(os.path.expanduser('~'),'.local','share','canvastty-container-workspaces'); checked_dir(root,True)
    directory=os.path.join(root,'engine-generations'); os.makedirs(directory,mode=0o700,exist_ok=True); checked_dir(directory,True)
    require(str(uuid.UUID(plan['id']))==plan['id']); return os.path.join(directory,plan['id']+'.json')

def save_manifest(path, value, initial=False):
    if initial:
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        try: os.write(fd,canonical(value)); os.fsync(fd)
        finally: os.close(fd)
    else:
        temporary=path+'.'+str(uuid.uuid4())+'.tmp'; save_manifest(temporary,value,True); os.replace(temporary,path)
    directory=os.open(os.path.dirname(path),os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(directory)
    finally: os.close(directory)

def complete_manifest(path, plan_digest, container_id):
    # Replace verification material with a nonsecret completion receipt. This
    # survives a lost successful SSH response without retaining the HMAC key.
    save_manifest(path,{'version':1,'planDigest':plan_digest,'phase':'removed','containerId':container_id})

def validate_plan(plan):
    require(isinstance(plan,dict) and plan['bootstrap']==BOOTSTRAP and plan['name']=='canvastty-'+plan['id'])
    require(plan['profile']['runtime'] in ['docker','podman'] and plan['profile']['hostId']!='local' and plan['profile']['network'] in ['none','bridge'])
    require(plan['labels']=={'io.canvastty.installation':plan['installation'],'io.canvastty.session':plan['sessionId'],'io.canvastty.generation':plan['id'],'io.canvastty.workspace':plan['workspace']['id']})
    for value in [plan['id'],plan['installation'],plan['workspace']['id']]: require(str(uuid.UUID(value))==value)

def owned_locked(request):
    plan=request['plan']; validate_plan(plan); plan_digest=digest(plan); require(plan_digest==request['planDigest'])
    endpoint=verify_engine(plan); p=plan['profile']; action=request['action']; path=manifest_path(plan)
    manifest=None
    if plan['version']==2:
        if action=='create-owned':
            # Persist the non-dispatch phase under the generation lock. A bad
            # credential must not strand a checkout as an unknown engine create.
            manifest={'version':1,'planDigest':plan_digest,'phase':'validating'}
            save_manifest(path,manifest,True)
            workspace=host_call({'action':'verify','source':plan['workspace']['sourceDirectory'],'id':plan['workspace']['id']})
            require(all(workspace[k]==plan['workspace'][k] for k in ['id','directory','sourceDirectory','commit']))
            if p['runtime']=='docker' and not plan['engine']['rootless']: require(plan['user']==str(workspace['uid'])+':'+str(workspace['gid']))
            if p['runtime']=='docker' and plan['engine']['rootless']: require(plan['user']=='0:0')
            if p['runtime']=='podman': require(plan['user']=='keep-id')
            values=dict(request['environment']); require('CANVASTTY_PROFILE_API_KEY' not in values)
            if request.get('credential') is not None: values['CANVASTTY_PROFILE_API_KEY']=credential(request['credential'],workspace)
            expected=fixed_environment(values); key=secrets.token_bytes(32)
            manifest={'version':1,'planDigest':plan_digest,'phase':'create-requested','hmacKey':key.hex(),'environmentHmac':hmac.new(key,canonical(expected),hashlib.sha256).hexdigest()}
            save_manifest(path,manifest)
            verify_engine(plan)
            created=engine_run(p,endpoint,create_words(plan,list(values)),values).strip(); require(re.fullmatch('[a-f0-9]{64}',created))
            manifest['containerId']=created; save_manifest(path,manifest)
        else:
            manifest=json.loads(private_read(path,8192)); require(set(manifest)<= {'version','planDigest','phase','hmacKey','environmentHmac','containerId'})
            require(manifest['version']==1 and manifest['planDigest']==plan_digest)
            if manifest.get('phase')=='removed':
                require(set(manifest)=={'version','planDigest','phase','containerId'} and action=='cleanup-owned')
                removed_id=manifest['containerId']; require(removed_id is None or isinstance(removed_id,str) and re.fullmatch('[a-f0-9]{64}',removed_id))
                require(request.get('containerId') is None or request['containerId']==removed_id)
                selector='id='+removed_id if removed_id else 'name=^'+plan['name']+'$'
                require(not engine_run(p,endpoint,['container','ls','--all','--no-trunc','--filter',selector,'--format','{{.ID}}']).strip())
                return {'version':1,'generationId':plan['id'],'planDigest':plan_digest,'containerId':removed_id,'verified':True,'removed':True}
            if manifest.get('phase')=='validating':
                require(set(manifest)=={'version','planDigest','phase'} and action=='cleanup-owned' and request.get('containerId') is None)
                require(not engine_run(p,endpoint,['container','ls','--all','--no-trunc','--filter','name=^'+plan['name']+'$','--format','{{.ID}}']).strip())
                complete_manifest(path,plan_digest,None)
                return {'version':1,'generationId':plan['id'],'planDigest':plan_digest,'containerId':None,'verified':True,'removed':True}
            require(manifest.get('phase')=='create-requested' and all(re.fullmatch('[a-f0-9]{64}',manifest[k]) for k in ['hmacKey','environmentHmac']))
    else: require(plan['version']==1 and action!='create-owned' and re.fullmatch('[a-f0-9]{64}',plan['environmentDigest']))
    container_id=request.get('containerId') or (manifest or {}).get('containerId')
    if request.get('containerId') and manifest and manifest.get('containerId'): require(request['containerId']==manifest['containerId'])
    require(container_id is None or re.fullmatch('[a-f0-9]{64}',container_id))
    selector='id='+container_id if container_id else 'name=^'+plan['name']+'$'
    listed=engine_run(p,endpoint,['container','ls','--all','--no-trunc','--filter',selector,'--format','{{.ID}}']).split()
    if not listed:
        require(action=='cleanup-owned' and container_id is not None)
        if manifest: complete_manifest(path,plan_digest,container_id)
        return {'version':1,'generationId':plan['id'],'planDigest':plan_digest,'containerId':container_id,'verified':True,'removed':True}
    require(len(listed)==1 and re.fullmatch('[a-f0-9]{64}',listed[0]) and (container_id is None or listed[0]==container_id)); container_id=listed[0]
    def inspect():
        return verify_inspection(plan,container_id,one(engine_run(p,endpoint,['container','inspect',container_id])),manifest)
    state=inspect()
    if manifest and not manifest.get('containerId'): manifest['containerId']=container_id; save_manifest(path,manifest)
    result={'version':1,'generationId':plan['id'],'planDigest':plan_digest,'containerId':container_id,'verified':True,'state':state}
    if action=='cleanup-owned':
        if state['running']:
            verify_engine(plan); inspect(); engine_run(p,endpoint,['container','stop','-t','5',container_id])
        verify_engine(plan); require(not inspect()['running']); engine_run(p,endpoint,['container','rm',container_id])
        require(not engine_run(p,endpoint,['container','ls','--all','--no-trunc','--filter','id='+container_id,'--format','{{.ID}}']).strip())
        if manifest: complete_manifest(path,plan_digest,container_id)
        result.pop('state'); result['removed']=True
    elif action=='start-owned':
        verify_engine(plan); inspect(); os.execve(endpoint['executable'],engine_command(p,endpoint,['container','start','--attach','--interactive',container_id]),engine_env(endpoint))
    return result

def owned(request):
    # A disconnected SSH client does not prove the earlier host create has ended.
    # Retain a private generation lock across all helper operations, including
    # recovery, so a second SSH cleanup cannot race an in-flight create helper.
    plan=request['plan']; validate_plan(plan); path=manifest_path(plan)+'.lock'
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    try:
        info=os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and not info.st_mode & 0o077)
        deadline=time.monotonic()+10
        while True:
            try: fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB); break
            except BlockingIOError:
                require(time.monotonic()<deadline); time.sleep(0.05)
        return owned_locked(request)
    finally: os.close(fd)

def engine_main():
    require(len(sys.argv)==2 and len(sys.argv[1].encode())<=65536 and sys.platform=='linux')
    request=json.loads(sys.argv[1]); action=request.get('action'); require(request.get('version')==1)
    if action in ['engine','image']:
        require(set(request)=={'version','action','profile','endpoint'})
        endpoint=host_call({'action':'endpoint','profile':request['profile']})
        require({k:v for k,v in endpoint.items() if v is not None}=={k:v for k,v in request['endpoint'].items() if k!='hostFingerprint' and v is not None})
        return engine_info(request['profile'],endpoint) if action=='engine' else image_info(request['profile'],endpoint)
    require(action in ['create-owned','inspect-owned','cleanup-owned','start-owned'])
    require(set(request)<= {'version','action','plan','planDigest','containerId','environment','credential'})
    require(action=='create-owned' or not any(k in request for k in ['environment','credential']))
    return owned(request)

# The error boundary must never echo request, engine output or exception details.
try:
    os.umask(0o077)
    print(json.dumps(engine_main(),separators=(',',':')))
except Exception:
    sys.stderr.write('CanvasTTY remote container engine verification failed. Output retained.\n'); sys.exit(78)
`;

export function remoteEngineHelperArguments(profile: Pick<ContainerProfile, 'hostPython'>, request: Record<string, unknown>): string[] {
  if (!profile.hostPython) throw new Error('Remote profile requires an absolute host Python interpreter.');
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > 65_536) throw new Error('Remote container request exceeds its bound.');
  return ['-I', '-S', '-c', REMOTE_CONTAINER_ENGINE, serialized];
}
