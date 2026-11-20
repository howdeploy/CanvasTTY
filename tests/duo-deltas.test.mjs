import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeDuoSnapshot} from '../src/shared/canvasDuo.ts';
const card=(id,buffer,offset=buffer.length)=>({id,title:id,provider:'terminal',running:true,control:true,position:{x:0,y:0},size:{width:700,height:400},output:{buffer,outputOffset:offset,cols:80,rows:24}});
const snapshot=(cards,sequence=1)=>({sequence,cards,comments:[],cursors:[],expiresAt:999,documentSync:true,manage:true,document:{settings:{canvasColor:'#123'}}});
test('delta history handles overlap, gaps, reset, stale delivery and terminal removal',()=>{
 const base=snapshot([card('a','ABCDE')]);
 const delta={...snapshot([{...card('a','DEFGH',8),output:{...card('a','DEFGH',8).output,startOffset:3}}],2),incremental:true,document:undefined};
 const merged=mergeDuoSnapshot(base,delta);assert.equal(merged.cards[0].output.buffer,'ABCDEFGH');assert.equal(merged.document,base.document);
 assert.equal(mergeDuoSnapshot(merged,delta).cards[0].output.buffer,'ABCDEFGH');
 assert.equal(mergeDuoSnapshot(merged,{...delta,sequence:0}),merged);
 const gap={...delta,sequence:3,cards:[{...card('a','XYZ',50),output:{...card('a','XYZ',50).output,startOffset:47}}]};
 assert.equal(mergeDuoSnapshot(merged,gap).cards[0].output.buffer,'XYZ','Do not fabricate missing bytes');
 const reset={...delta,sequence:3,cards:[{...card('a','NEW',3),output:{...card('a','NEW',3).output,startOffset:0}}]};
 assert.equal(mergeDuoSnapshot(merged,reset).cards[0].output.buffer,'NEW');
 assert.equal(mergeDuoSnapshot(merged,{...delta,sequence:3,cards:[]}).cards.length,0);
});
test('partial input acknowledgements retain workspace data and immediately reflect revoked control',()=>{
 const base=snapshot([card('a','TEXT')]);
 const result=mergeDuoSnapshot(base,{partial:true,manage:false,cards:[],comments:[],cursors:[],expiresAt:1000});
 assert.equal(result.cards[0].output.buffer,'TEXT');assert.equal(result.cards[0].control,false);assert.equal(result.manage,false);assert.equal(result.document,base.document);
});
