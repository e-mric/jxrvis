import {CanvasTexture,Color,Mesh,MeshBasicMaterial,PerspectiveCamera,PlaneGeometry,SRGBColorSpace,Vector3,WebGLRenderTarget,type Camera,type ColorRepresentation,type Object3D,type Scene,type WebGLRenderer} from 'three';
import {bindKey,createFeedbackClient,type ClientOptions,type FeedbackClient,type Snapshot} from './core.ts';
import {wrap} from './label-lines.ts';

const TO_SRGB=Uint8Array.from({length:256},(_,i)=>{const c=i/255;return Math.round(255*(c<=.0031308?12.92*c:1.055*c**(1/2.4)-.055));});

export interface EyeViewOptions{
  /** Objects left out of the picture (the status label, the menu that started the take). */
  hidden?:Object3D[];
  /** Width of the image in pixels; the height follows the eye's aspect. */
  width?:number;
  /**
   * Replaces the scene's background in the picture. By default the scene's own background is kept, except in
   * passthrough (the page cannot see the room), where it is ROOM_GREY.
   */
  background?:ColorRepresentation;
}

/** What stands in for the real room in passthrough snapshots. */
export const ROOM_GREY=0x8a8f96;

/**
 * What the player sees right now as a PNG data URL: the left eye in an XR session, `camera` otherwise.
 * Renders the scene once more into an offscreen target, so it works at any moment of the frame.
 */
export function eyeView(renderer:WebGLRenderer,scene:Scene,camera:PerspectiveCamera,{hidden=[],width=1280,background}:EyeViewOptions={}){
  const xr=renderer.xr,blend=xr.getSession()?.environmentBlendMode;
  const passthrough=!!blend&&blend!=='opaque';
  const replace=background??(passthrough||!scene.background?ROOM_GREY:undefined);
  const room=new Color(replace??(scene.background instanceof Color?scene.background:ROOM_GREY));
  let shot:Camera=camera,aspect=camera.aspect;
  if(xr.isPresenting){
    const eye=xr.getCamera().cameras[0],lens=new PerspectiveCamera();
    lens.projectionMatrix.copy(eye.projectionMatrix);lens.projectionMatrixInverse.copy(eye.projectionMatrixInverse);
    eye.matrixWorld.decompose(lens.position,lens.quaternion,lens.scale);lens.updateMatrixWorld();
    shot=lens;aspect=eye.viewport.z/eye.viewport.w||camera.aspect;
  }
  const height=Math.round(width/aspect),target=new WebGLRenderTarget(width,height,{samples:4});
  const previousBackground=scene.background,previousTarget=renderer.getRenderTarget(),wasXR=xr.enabled,shown=hidden.map(o=>o.visible);
  xr.enabled=false;if(replace!==undefined)scene.background=room;for(const o of hidden)o.visible=false;
  try{renderer.setRenderTarget(target);renderer.render(scene,shot);}
  finally{xr.enabled=wasXR;scene.background=previousBackground;renderer.setRenderTarget(previousTarget);hidden.forEach((o,i)=>o.visible=shown[i]);}
  const pixels=new Uint8Array(width*height*4);renderer.readRenderTargetPixels(target,0,0,width,height,pixels);target.dispose();
  // A render target holds linear colour, bottom row first. In an AR session three.js clears to transparent
  // whatever the background, so the room colour goes in wherever nothing was drawn.
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d')!,image=ctx.createImageData(width,height),fill=[room.r,room.g,room.b].map(c=>c*255);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const from=((height-1-y)*width+x)*4,to=(y*width+x)*4,clear=1-pixels[from+3]/255;
    for(let c=0;c<3;c++)image.data[to+c]=TO_SRGB[Math.min(255,Math.round(pixels[from+c]+fill[c]*clear))];
    image.data[to+3]=255;
  }
  ctx.putImageData(image,0,0);
  return canvas.toDataURL('image/png');
}

/** The camera that is the player's head: the XR camera in a session, `camera` otherwise. */
export function headCamera(renderer:WebGLRenderer,camera:Camera):Camera{
  return renderer.xr.isPresenting?renderer.xr.getCamera():camera;
}

export function headPose(renderer:WebGLRenderer,camera:Camera){
  const head=headCamera(renderer,camera),position=new Vector3(),looking=new Vector3();
  head.getWorldPosition(position);head.getWorldDirection(looking);
  const round=(v:Vector3)=>v.toArray().map(n=>+n.toFixed(3));
  return {position:round(position),looking:round(looking)};
}

export interface LabelStyle{paper?:string;ink?:string;font?:string;/** metres ahead, metres below eye level */ ahead?:number;below?:number;/** width in metres */ width?:number}

/**
 * A pill-shaped text label kept low in the player's view, so it never covers what a take is about.
 * Call `place(head)` every frame while it is visible.
 */
export function createStatusLabel({paper='#fffaf0',ink='#1b1b1b',font='system-ui, sans-serif',ahead=.7,below=.2,width=.3}:LabelStyle={}){
  const W=768,H=128;
  const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
  const texture=new CanvasTexture(canvas);texture.colorSpace=SRGBColorSpace;
  const mesh=new Mesh(new PlaneGeometry(width,width*H/W),new MeshBasicMaterial({map:texture,toneMapped:false,transparent:true,depthTest:false,depthWrite:false}));
  mesh.name='jXRvis status';mesh.renderOrder=999;mesh.visible=false;mesh.frustumCulled=false;
  let remaining=Infinity;
  const forward=new Vector3(),down=new Vector3();
  return {
    mesh,
    get text(){return mesh.userData.text as string|undefined;},
    show(text:string,seconds=Infinity){
      const ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,W,H);
      ctx.fillStyle=paper;ctx.strokeStyle=ink;ctx.lineWidth=5;ctx.beginPath();ctx.roundRect(4,4,W-8,H-8,58);ctx.fill();ctx.stroke();
      ctx.fillStyle=ink;ctx.textAlign='center';ctx.textBaseline='middle';
      const lines=wrap(text);ctx.font=`600 ${lines.length>1?32:40}px ${font}`;
      lines.forEach((line,i)=>ctx.fillText(line,W/2,lines.length>1?46+i*38:66));
      texture.needsUpdate=true;mesh.userData.text=text;mesh.visible=true;remaining=seconds;
    },
    hide(){mesh.visible=false;remaining=Infinity;},
    /** Counts down the message's time and keeps the label in front of `head`. */
    update(delta:number,head:Camera){
      if(remaining!==Infinity){remaining-=delta;if(remaining<=0)this.hide();}
      if(!mesh.visible)return;
      head.getWorldPosition(mesh.position);head.getWorldQuaternion(mesh.quaternion);
      forward.set(0,0,-ahead).applyQuaternion(mesh.quaternion);down.set(0,-below,0).applyQuaternion(mesh.quaternion);
      mesh.position.add(forward).add(down);mesh.updateMatrixWorld();
    },
    dispose(){mesh.removeFromParent();mesh.geometry.dispose();(mesh.material as MeshBasicMaterial).dispose();texture.dispose();},
  };
}

/** A controller button, by hand and index in the xr-standard gamepad (Quest Touch: 4 = A/X, 5 = B/Y). */
export type XRButton={hand:'left'|'right';button:number};
/** B on the right controller and Y on the left. */
export const HOLD_BUTTONS:XRButton[]=[{hand:'right',button:5},{hand:'left',button:5}];

/** Turns the XR session's gamepad states into press and release edges. Call `poll()` once per frame. */
export function xrButtons(renderer:WebGLRenderer,buttons:XRButton[]=HOLD_BUTTONS){
  let was=false;
  return {poll(){
    const session=renderer.xr.getSession();
    let now=false;
    if(session)for(const source of session.inputSources)for(const b of buttons)
      if(source.handedness===b.hand&&source.gamepad?.buttons[b.button]?.pressed)now=true;
    const edge={down:now&&!was,up:!now&&was};was=now;return edge;
  }};
}

export interface ThreeFeedbackOptions extends Omit<ClientOptions,'snapshot'|'show'>{
  renderer:WebGLRenderer;
  scene:Scene;
  camera:PerspectiveCamera;
  /** Objects to leave out of the eye view, read at each snapshot (your menu, for instance). */
  hidden?:()=>Object3D[];
  /** Hold-to-talk controller buttons; [] for none. Default B and Y. */
  holdButtons?:XRButton[];
  /** Hold-to-talk keyboard key on desktop; null for none. Default F. */
  key?:string|null;
  label?:LabelStyle;
  view?:Omit<EyeViewOptions,'hidden'>;
  /** Also called with every message, e.g. to show it in the page outside XR. */
  onMessage?(text:string,seconds:number):void;
}

/**
 * The whole headset client for a three.js app: eye-view snapshots, a head-locked status label, hold-to-talk
 * on B/Y and F, and everything in createFeedbackClient. Call `update(deltaSeconds)` once per frame and
 * `toggle()` from a menu button.
 */
export function attachFeedback(options:ThreeFeedbackOptions){
  const {renderer,scene,camera}=options;
  const label=createStatusLabel(options.label);scene.add(label.mesh);
  const snapshot=():Snapshot=>({
    image:eyeView(renderer,scene,camera,{...options.view,hidden:[label.mesh,...options.hidden?.()??[]]}),
    details:{xr:renderer.xr.isPresenting,head:headPose(renderer,camera)},
  });
  const client:FeedbackClient=createFeedbackClient({
    ...options,
    snapshot,
    show(text,seconds){label.show(text,seconds);options.onMessage?.(text,seconds);},
  });
  const buttons=xrButtons(renderer,options.holdButtons);
  const unbindKey=options.key===null||typeof window==='undefined'?()=>{}:bindKey(client,{key:options.key??'f'});
  return {
    client,
    label,
    toggle:()=>client.toggle(),
    get recording(){return client.recording;},
    /** The current view, e.g. for a development capture. */
    view:(withHidden=false)=>eyeView(renderer,scene,camera,{...options.view,hidden:withHidden?[]:[label.mesh,...options.hidden?.()??[]]}),
    update(delta:number){
      const edge=buttons.poll();
      if(edge.down)client.holdDown();
      if(edge.up)client.release();
      label.update(delta,headCamera(renderer,camera));
    },
    dispose(){unbindKey();client.dispose();label.dispose();},
  };
}
