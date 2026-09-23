import { REMOTE_CONTAINER_HOST_LIBRARY } from './RemoteContainerHost.ts';
import { REMOTE_PROCESS_CAPTURE } from './RemoteProcessCapture.ts';

/** Fixed, bounded review of an owned stopped checkout. Never runs the engine or applies a patch. */
export const REMOTE_WORKSPACE_REVIEW = REMOTE_CONTAINER_HOST_LIBRARY + REMOTE_PROCESS_CAPTURE + String.raw`
import re

def require(value):
    if not value: raise ValueError('workspace review verification failed')

deadline = time.monotonic() + 15
git_options = ['core.fsmonitor=false','core.untrackedCache=false','core.ignoreStat=false','core.trustCtime=true','core.checkStat=default','core.fileMode=true','core.hooksPath=/dev/null','submodule.recurse=false','diff.ignoreSubmodules=none','color.ui=false','core.pager=cat']
git_environment = {'HOME':'/nonexistent','PATH':'/usr/bin:/bin','LANG':'C.UTF-8','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1','GIT_TERMINAL_PROMPT':'0','GIT_OPTIONAL_LOCKS':'0','GIT_NO_REPLACE_OBJECTS':'1','GIT_NO_LAZY_FETCH':'1','GIT_ALLOW_PROTOCOL':'','GIT_ATTR_NOSYSTEM':'1'}

def review_git(cwd, args, limit=2097152, options=None):
    remaining=deadline-time.monotonic(); require(remaining>0)
    command=['/usr/bin/git','--no-pager']
    for option in (git_options if options is None else options): command += ['-c',option]
    return capture(command+['-C',cwd]+args,git_environment,limit,remaining)

# All library identity checks use the same bounded, environment-isolated Git runner.
def git(cwd, args):
    return review_git(cwd,args).rstrip('\n')

def metadata(info):
    return [info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns]

def inventory(root):
    entries=[]; total=0
    def visit(parent, prefix, depth):
        nonlocal total
        require(depth<=64 and time.monotonic()<deadline)
        before=os.fstat(parent); require(stat.S_ISDIR(before.st_mode) and before.st_uid==os.getuid())
        names=[]
        with os.scandir(parent) as scan:
            for entry in scan:
                names.append(entry.name); require(len(names)+len(entries)<=20000)
        for name in sorted(names):
            require(time.monotonic()<deadline and len(entries)<20000)
            require(not name.startswith('.canvastty-container-') and (name!='.git' or not prefix))
            relative=prefix+name; relative.encode('utf-8')
            info=os.stat(name,dir_fd=parent,follow_symlinks=False)
            require(info.st_uid==os.getuid() and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)))
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|(os.O_DIRECTORY if stat.S_ISDIR(info.st_mode) else 0),dir_fd=parent)
            try:
                opened=os.fstat(fd); require(metadata(opened)==metadata(info))
                if stat.S_ISDIR(info.st_mode):
                    entries.append([relative,metadata(info),'directory']); visit(fd,relative+'/',depth+1)
                else:
                    require(info.st_nlink==1 and info.st_size<=16777216)
                    total+=info.st_size; require(total<=67108864)
                    digest=hashlib.sha256(); length=0
                    while True:
                        require(time.monotonic()<deadline)
                        data=os.read(fd,65536)
                        if not data: break
                        length+=len(data); require(length<=info.st_size); digest.update(data)
                    require(length==info.st_size); entries.append([relative,metadata(info),digest.hexdigest()])
                require(metadata(os.fstat(fd))==metadata(info) and metadata(os.stat(name,dir_fd=parent,follow_symlinks=False))==metadata(info))
            finally: os.close(fd)
        require(metadata(os.fstat(parent))==metadata(before))
        return metadata(before)
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: root_info=visit(fd,'',0)
    finally: os.close(fd)
    require(metadata(os.lstat(root))==root_info)
    return [root_info,entries]

def index_state(directory):
    flags=review_git(directory,['ls-files','-v','-z','--cached'])
    require(all(entry.startswith('H ') for entry in flags.split('\0') if entry))
    stages=review_git(directory,['ls-files','--stage','-z'])
    for entry in stages.split('\0'):
        if not entry: continue
        fields=entry.split('\t',1)[0].split()
        require(len(fields)==3 and fields[0] in ['100644','100755'] and fields[2]=='0')
    head=git(directory,['rev-parse','--verify','HEAD^{commit}']); require(re.fullmatch('[a-f0-9]{40,64}',head))
    untracked=review_git(directory,['ls-files','--others','--exclude-standard','-z'])
    ignored=review_git(directory,['ls-files','--others','--ignored','--exclude-standard','-z'])
    return [flags,stages,head,untracked,ignored]

def review():
    require(len(sys.argv)==2 and len(sys.argv[1].encode())<=16384)
    request=json.loads(sys.argv[1])
    require(isinstance(request,dict) and set(request)=={'version','action','source','id','base'} and request['version']==1 and request['action']=='review')
    require(isinstance(request['base'],str) and re.fullmatch('[a-f0-9]{40,64}',request['base']))
    require(isinstance(request['id'],str) and str(uuid.UUID(request['id']))==request['id'])
    root=os.path.join(os.path.expanduser('~'),'.local','share','canvastty-container-workspaces')
    # Review may only open existing metadata; the library must not create anything.
    checked_dir(root,True); checked_dir(os.path.join(root,'engine-config'),True)
    require(os.path.isfile(os.path.join(root,'engine-config','config.json')))
    directory=checked_dir(os.path.join(root,request['id']),True)
    checkout=checked_dir(os.path.join(directory,'workspace'))
    info=os.lstat(os.path.join(checkout,'.git'))
    require(stat.S_ISREG(info.st_mode) and info.st_uid==os.getuid() and info.st_nlink==1 and info.st_size<=8192)
    before=inventory(checkout)
    workspace=main(); require(workspace['commit']==request['base'])
    # Diff can invoke clean filters. Enumerate names only, then disable each driver.
    base_options=list(git_options)
    config=review_git(checkout,['config','--includes','--null','--name-only','--list'],options=base_options)
    filters=set()
    for key in config.split('\0'):
        if key.startswith('filter.'):
            name=key[7:].rsplit('.',1)[0]; require(name and len(name)<=256 and not re.search(r'[\x00-\x1f\x7f]',name)); filters.add(name)
    require(len(filters)<=128)
    for name in sorted(filters):
        for suffix in ['clean=','smudge=','process=','required=false']: git_options.append('filter.'+name+'.'+suffix)
    state=index_state(checkout)
    patch=review_git(checkout,['diff','--no-ext-diff','--no-textconv','--no-renames','--binary','--full-index','--src-prefix=a/','--dst-prefix=b/',request['base'],'--'],524288)
    require(before==inventory(checkout) and state==index_state(checkout))
    require(config==review_git(checkout,['config','--includes','--null','--name-only','--list'],options=base_options))
    result={'patch':patch,'baseCommit':workspace['commit'],'headCommit':state[2],'untrackedFiles':state[3].count('\0'),'ignoredFiles':state[4].count('\0')}
    result['digest']=hashlib.sha256(json.dumps([before,state,result],sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
    return result

try:
    os.umask(0o077)
    result=json.dumps(review()); require(len(result.encode())<=2097152); print(result)
except Exception:
    sys.stderr.write('CanvasTTY remote output review failed: files or Git metadata are unsafe, changed, unavailable or exceed review limits. Output retained.\n'); sys.exit(78)
`;
