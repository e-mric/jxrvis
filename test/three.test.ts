import test from 'node:test';
import assert from 'node:assert/strict';
import {PerspectiveCamera} from 'three';
import {HOLD_BUTTONS,headPose,xrButtons} from '../src/client/three.ts';

// The rendering parts (eyeView, the label's canvas) need a browser; the example page exercises them.
const fakeRenderer=(session:unknown,presenting=false,xrCamera?:PerspectiveCamera)=>({xr:{getSession:()=>session,isPresenting:presenting,getCamera:()=>xrCamera}}) as any;
const source=(hand:string,pressed:number[])=>({handedness:hand,gamepad:{buttons:Array.from({length:7},(_,i)=>({pressed:pressed.includes(i)}))}});

test('B or Y held on a controller gives one press edge and one release edge',()=>{
  const sources:any[]=[source('left',[]),source('right',[])];
  const buttons=xrButtons(fakeRenderer({inputSources:sources}));
  assert.deepEqual(buttons.poll(),{down:false,up:false});
  sources[1]=source('right',[5]);
  assert.deepEqual(buttons.poll(),{down:true,up:false});
  sources[0]=source('left',[5]);
  assert.deepEqual(buttons.poll(),{down:false,up:false},'Y joining B is not a second press');
  sources[1]=source('right',[4]);
  assert.deepEqual(buttons.poll(),{down:false,up:false},'A does not count, Y still held');
  sources[0]=source('left',[]);
  assert.deepEqual(buttons.poll(),{down:false,up:true});
  assert.deepEqual(HOLD_BUTTONS,[{hand:'right',button:5},{hand:'left',button:5}]);
});

test('bindings are configurable, and no session means nothing is pressed',()=>{
  const sources:any[]=[source('right',[4])];
  assert.deepEqual(xrButtons(fakeRenderer({inputSources:sources}),[{hand:'right',button:4}]).poll(),{down:true,up:false});
  assert.deepEqual(xrButtons(fakeRenderer({inputSources:sources}),[]).poll(),{down:false,up:false});
  assert.deepEqual(xrButtons(fakeRenderer(null)).poll(),{down:false,up:false});
});

test('the head pose comes from the XR camera in a session and the scene camera outside',()=>{
  const camera=new PerspectiveCamera();camera.position.set(1,2,3);camera.updateMatrixWorld();
  assert.deepEqual(headPose(fakeRenderer(null),camera),{position:[1,2,3],looking:[0,0,-1]});
  const xr=new PerspectiveCamera();xr.position.set(0,1.6,0);xr.rotation.y=Math.PI/2;xr.updateMatrixWorld();
  const pose=headPose(fakeRenderer(null,true,xr),camera);
  assert.deepEqual(pose.position,[0,1.6,0]);assert.deepEqual(pose.looking.map(n=>Math.round(n)+0),[-1,0,0],'turned left, looking along -x');
});
