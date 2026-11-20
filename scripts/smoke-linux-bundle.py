#!/usr/bin/env python3
"""Own Xvfb, isolated profile and packaged Linux alpha. Never controls the user's desktop."""
import hashlib,json,os,signal,subprocess,time
from pathlib import Path
root=Path(__file__).resolve().parent.parent
lab=root.parent
output=lab/('acceptance-linux-'+str(time.time_ns()))
output.mkdir()
profile=output/'profile'
env=dict(os.environ)
for key in list(env):
    if key.startswith(('CANVASTTY_RUNTIME_','CANVASTTY_SHELL_','CANVASTTY_CAPTURE_','CANVASTTY_MAC_WINDOW_LAB','CANVASTTY_DUO_LAB_','CANVASTTY_FILES_LAB_')): del env[key]
env.pop('ELECTRON_RUN_AS_NODE',None)
env['CANVASTTY_USER_DATA_DIR']=str(profile)
subprocess.run(['node',str(root/'scripts/prepare-v2-profile.mjs'),str(profile)],env=env,check=True,stdout=subprocess.DEVNULL)
env.update(CANVASTTY_HOME_LAB_SMOKE_OUTPUT=str(output),CANVASTTY_V2_LAB_SMOKE='0',GDK_BACKEND='x11',NO_AT_BRIDGE='1')
read,write=os.pipe()
xvfb=subprocess.Popen(['Xvfb','-displayfd',str(write),'-screen','0','1920x1400x24','-nolisten','tcp','-extension','GLX'],pass_fds=(write,),stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
os.close(write)
app=None
try:
    with os.fdopen(read) as stream: number=stream.readline().strip()
    if not number.isdigit(): raise RuntimeError(xvfb.stderr.read().decode())
    env['DISPLAY']=':'+number
    binary=root/'release/v2-home-alpha7/linux-unpacked/canvastty-v2-alpha'
    executable=binary.parent/'start-canvastty.sh' if os.environ.get('CANVASTTY_LINUX_LAB_LAUNCHER')=='1' else binary
    args=[str(executable),'--ozone-platform=x11','--disable-gpu']
    if os.environ.get('CANVASTTY_LINUX_LAB_USERNS')=='1': args.append('--disable-setuid-sandbox')
    # Only this disposable test may opt out after proving the lab lacks a usable sandbox.
    if os.environ.get('CANVASTTY_LINUX_LAB_NO_SANDBOX')=='1': args.append('--no-sandbox')
    with (output/'app.log').open('wb') as log:
        app=subprocess.Popen(args,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try: code=app.wait(timeout=150)
        except subprocess.TimeoutExpired:
            os.killpg(app.pid,signal.SIGKILL); app.wait(); raise
    if code: raise RuntimeError('Packaged application exited '+str(code)+'; see '+str(output/'app.log'))
    report=json.loads((output/'verification.json').read_text())
    assert report['version']=='2.0.0-alpha.7' and report['packaged'] and report['profile']==str(profile)
    report.update(platform='linux-x64',isolatedXvfb=True,portableLauncher=executable!=binary,sandboxDisabled='--no-sandbox' in args,asarSha256=hashlib.sha256((binary.parent/'resources/app.asar').read_bytes()).hexdigest())
    (output/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    (lab/'linux-latest-acceptance.json').write_text(json.dumps(dict(output=str(output),**report),ensure_ascii=False,indent=2))
    print(json.dumps(dict(output=str(output),result='passed',checks=report['checks'],asarSha256=report['asarSha256']),ensure_ascii=False))
finally:
    if app and app.poll() is None: os.killpg(app.pid,signal.SIGKILL);app.wait()
    xvfb.terminate()
    try: xvfb.wait(timeout=3)
    except subprocess.TimeoutExpired: xvfb.kill();xvfb.wait()
