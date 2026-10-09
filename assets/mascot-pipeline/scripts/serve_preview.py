"""Serve a live, read-only mascot workbench on loopback.

Usage: python serve_preview.py PROJECT --port 0
Prints its URL as one JSON line. Keep the process alive during creation.
"""

import argparse
import functools
import hashlib
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


PAGE = b'''<!doctype html><meta charset="utf-8"><title>Mascot workbench</title>
<style>body{background:#202128;color:#eee;font:16px system-ui;margin:24px}h1{font-size:24px}
section{display:flex;flex-wrap:wrap;gap:12px}figure{margin:0;padding:10px;background:#30323b;border-radius:10px}
img{height:280px;max-width:100%;object-fit:contain;background:repeating-conic-gradient(#454550 0% 25%,#393943 0% 50%) 0/20px 20px}
figcaption{max-width:250px;overflow-wrap:anywhere;font-size:13px}iframe{width:440px;height:650px;border:1px solid #777;background:#393943}
button,select{font:inherit;margin:8px;padding:8px}#status{overflow-wrap:anywhere}</style>
<h1>Mascot workbench</h1><p id="status">Waiting for source images...</p>
<p>Drafts stay visible for review. Displayed images are not automatically approved.</p>
<h2>Uploaded and prepared references</h2><section id="references"></section>
<h2>Generated frames</h2><section id="frames"></section>
<h2>Built animation</h2><select id="action"></select><div id="runtime"></div>
<h2>Deterministic atlas review</h2>
<p>Paused inspection uses actual atlas cells. Source placement is shown separately.
Support lines use declared diagnostic regions; they do not prove anatomy or scale.</p>
<select id="review-clip"></select><button id="previous">Previous step</button>
<select id="review-step"></select><button id="next">Next step</button>
<label>Shared display height <input id="review-height" type="number" min="64" max="1600" value="420"></label>
<p id="review-name">Build an animation to inspect its named steps.</p>
<section id="inspection"></section><pre id="measurements" style="white-space:pre-wrap"></pre>
<script>
let last='', build='', names='', reviewData=null, inspectedBuild='', reviewSignature='', renderToken=0;
const action=document.querySelector('#action');
const reviewClip=document.querySelector('#review-clip'),reviewStep=document.querySelector('#review-step');
const pictures=new Map();
function imageAt(url){if(!pictures.has(url))pictures.set(url,new Promise((resolve,reject)=>{
const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>{pictures.delete(url);reject(Error('Image unavailable: '+url));};img.src=url;}));return pictures.get(url);}
function reviewSequence(){const s=reviewData.sprite;
if(!reviewClip.value.startsWith('scene/'))return (s.clips[reviewClip.value]||[]).map((v,i)=>({clip:reviewClip.value,step:i,index:v[0],seconds:v[1]}));
const a=reviewClip.value.slice(6),order=['idle',a+':in',a,a,a+':out','idle'];
return order.flatMap(k=>(s.clips[k]||[]).map((v,i)=>({clip:k,step:i,index:v[0],seconds:v[1]})));}
function selectSteps(){reviewStep.replaceChildren(...reviewSequence().map((v,i)=>{
const o=document.createElement('option');o.value=i;o.textContent=v.clip+' ['+v.step+'] '+reviewData.sprite.frameNames[v.index];return o;}));reviewStep.onchange();}
async function showStep(){if(!reviewData)return;const token=++renderToken,s=reviewData.sprite,p=reviewData.placement;
const seq=reviewSequence(),i=Number(reviewStep.value),v=seq[i];if(!v)return;
const name=s.frameNames[v.index],height=Math.max(64,Math.min(1600,Number(document.querySelector('#review-height').value)||420));
document.querySelector('#review-name').textContent='Build '+s.buildId+' | '+v.clip+' | Step '+v.step+' | '+name+' | '+v.seconds+' seconds';
const panels=await Promise.all([['Previous atlas cell',seq[(i-1+seq.length)%seq.length]],['Current atlas cell',v],
['Next atlas cell',seq[(i+1)%seq.length]],['Current source before placement',v]].map(async([label,step],panel)=>{
const figure=document.createElement('figure'),caption=document.createElement('figcaption'),canvas=document.createElement('canvas');
const n=s.frameNames[step.index],record=reviewData.continuity?.frames?.[n];canvas.width=s.cell[0];canvas.height=s.cell[1];
canvas.style.height=height+'px';canvas.style.width=(height*canvas.width/canvas.height)+'px';
canvas.style.background='repeating-conic-gradient(#454550 0% 25%,#393943 0% 50%) 0/20px 20px';
const ctx=canvas.getContext('2d');if(panel===3){const img=await imageAt('/frames/'+encodeURIComponent(p.frames[n].source)+'?build='+s.buildId);
ctx.drawImage(img,p.crop_x,0,p.crop_width,p.source_canvas[1],0,0,canvas.width,p.source_canvas[1]*canvas.height/p.padded_height);
}else{const sheet=Math.floor(step.index/s.perSheet),local=step.index%s.perSheet;
const img=await imageAt('/plugin/'+encodeURIComponent(s.sheets[sheet].file)+'?build='+s.buildId);
ctx.drawImage(img,(local%s.cols)*canvas.width,Math.floor(local/s.cols)*canvas.height,canvas.width,canvas.height,0,0,canvas.width,canvas.height);}
if(record){ctx.strokeStyle='#62ffb8';ctx.lineWidth=2;for(const support of Object.values(record.supports)){
const y=panel===3?support.source_y*canvas.height/p.padded_height:support.built_y;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(canvas.width,y);ctx.stroke();}}
caption.textContent=label+' | '+n+' | '+step.clip+' ['+step.step+'] | shift '+p.frames[n].shift_y+' source px';
figure.append(caption,canvas);return figure;}));if(token!==renderToken)return;
document.querySelector('#inspection').replaceChildren(...panels);
const record=reviewData.continuity?.frames?.[name];
const flags=(reviewData.continuity?.flags||[]).filter(x=>x.previous===name||x.current===name);
document.querySelector('#measurements').textContent=JSON.stringify({build:s.buildId,placement:p.frames[name],
continuity:record||'No current measured continuity report; review is incomplete.',flags},null,2);
}
reviewClip.onchange=selectSteps;reviewStep.onchange=()=>showStep().catch(e=>document.querySelector('#review-name').textContent=e.message);
document.querySelector('#review-height').onchange=reviewStep.onchange;
for(const [id,delta] of [['previous',-1],['next',1]])document.getElementById(id).onclick=()=>{
const count=reviewSequence().length;if(count){reviewStep.value=(Number(reviewStep.value)+delta+count)%count;reviewStep.onchange();}};
function player(){const frame=document.createElement('iframe');frame.title='Current mascot animation';
frame.src='/plugin/index.html?action='+encodeURIComponent(action.value)+'&build='+encodeURIComponent(build);
document.querySelector('#runtime').replaceChildren(frame);}
action.onchange=player;
async function refresh(){try{const state=await (await fetch('/state',{cache:'no-store'})).json();
document.querySelector('#status').textContent='Project: '+state.project+' | Build: '+(state.build||'not built');
const signature=JSON.stringify(state.images);if(signature!==last){last=signature;
for(const group of ['references','frames']){const nodes=state.images.filter(x=>x.group===group).map(x=>{
const figure=document.createElement('figure'),img=document.createElement('img'),caption=document.createElement('figcaption');
img.src=x.url+'?v='+x.modified;img.alt=x.name;caption.textContent=x.name;figure.append(img,caption);return figure;});
document.getElementById(group).replaceChildren(...nodes);}}
if(state.build && (state.build!==build||JSON.stringify(state.actions)!==names)){
build=state.build;names=JSON.stringify(state.actions);const selected=action.value;
action.replaceChildren(...state.actions.map(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.label;return o;}));
if(state.actions.some(x=>x.id===selected))action.value=selected;if(state.actions.length)player();}
if(state.review){reviewData=state.review;const signature=JSON.stringify(reviewData.continuity);
if(inspectedBuild!==build){inspectedBuild=build;pictures.clear();const selected=reviewClip.value;
const choices=[...Object.keys(reviewData.sprite.clips),...reviewData.sprite.deck.map(a=>'scene/'+a)];
reviewClip.replaceChildren(...choices.map(k=>{const o=document.createElement('option');o.value=k;o.textContent=k;return o;}));
if(choices.includes(selected))reviewClip.value=selected;selectSteps();}
else if(signature!==reviewSignature)reviewStep.onchange();reviewSignature=signature;}
}catch(error){document.querySelector('#status').textContent='Preview unavailable: '+error.message;}}
refresh();setInterval(refresh,2000);
</script>'''


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def reply(self, data, content_type):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        root = Path(self.directory).resolve()
        url = urlsplit(self.path).path
        if url == '/':
            return self.reply(PAGE, 'text/html; charset=utf-8')
        if url == '/state':
            images = []
            for group in ('references', 'frames'):
                for path in sorted((root / group).glob('*')):
                    if (path.suffix.lower() in ('.png', '.jpg', '.jpeg') and path.is_file()
                            and path.resolve().is_relative_to(root)):
                        images.append(dict(group=group, name=path.name,
                                           url=f'/{group}/{quote(path.name)}', modified=path.stat().st_mtime_ns))
            sprite = {}
            try:
                sprite = json.loads((root / 'plugin' / 'frames.js').read_text(encoding='utf-8')
                                    .strip().removeprefix('window.SPRITE = ').removesuffix(';'))
            except (OSError, ValueError):
                pass
            data = dict(project=root.name, images=images, build=sprite.get('buildId'),
                        actions=[dict(id=a, label=sprite.get('labels', {}).get(a, a)) for a in sprite.get('deck', [])])
            try:
                build_report = json.loads((root / 'build-report.json').read_text(encoding='utf-8'))
                if (build_report.get('build_id') == sprite.get('buildId') and sprite.get('frameNames')
                        and build_report.get('placement')):
                    continuity = None
                    try:
                        candidate = json.loads((root / 'continuity-report.json').read_text(encoding='utf-8'))
                        manifest_hash = hashlib.sha256((root / 'continuity.json').read_bytes()).hexdigest()
                        if (candidate.get('build_id') == sprite['buildId']
                                and candidate.get('manifest_sha256') == manifest_hash):
                            continuity = candidate
                    except (OSError, ValueError):
                        pass
                    data['review'] = dict(sprite=sprite, placement=build_report['placement'], continuity=continuity)
            except (OSError, ValueError):
                pass
            return self.reply(json.dumps(data).encode(), 'application/json')
        relative = Path(unquote(url).lstrip('/'))
        resolved = (root / relative).resolve()
        if (not resolved.is_relative_to(root) or not relative.parts
                or relative.parts[0] not in ('references', 'frames', 'previews', 'plugin')
                or resolved.suffix.lower() not in ('.png', '.webp', '.jpg', '.jpeg', '.html', '.js', '.css')
                or not resolved.is_file()):
            return self.send_error(404)
        return super().do_GET()

    def do_HEAD(self):
        self.send_error(405)

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('project', type=Path)
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    root = args.project.resolve(strict=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), functools.partial(Handler, directory=str(root)))
    print(json.dumps({'url': f'http://127.0.0.1:{server.server_port}/', 'project': root.name}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
