// A small three.js WebXR scene with the whole jXRvis loop: hold F (desktop) or B/Y (Quest), talk, let go.
import {AmbientLight,BoxGeometry,Clock,Color,DirectionalLight,GridHelper,Mesh,MeshStandardMaterial,PerspectiveCamera,Scene,SphereGeometry,TorusKnotGeometry,WebGLRenderer} from 'three';
import {VRButton} from 'three/examples/jsm/webxr/VRButton.js';
import {attachFeedback} from 'jxrvis/three';

const renderer=new WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);
renderer.xr.enabled=true;
document.body.append(renderer.domElement,VRButton.createButton(renderer));

const scene=new Scene();scene.background=new Color(0x20232a);
const camera=new PerspectiveCamera(70,innerWidth/innerHeight,.05,100);camera.position.set(0,1.6,1.2);
scene.add(new AmbientLight(0xffffff,.6));
const sun=new DirectionalLight(0xffffff,2.2);sun.position.set(2,4,3);scene.add(sun);
scene.add(new GridHelper(10,20,0x666666,0x444444));

// Something to talk about: three shapes, one of them floating where it should not.
const knot=new Mesh(new TorusKnotGeometry(.18,.06,128,16),new MeshStandardMaterial({color:0xf2a541,roughness:.35}));
knot.position.set(0,1.4,-1);
const box=new Mesh(new BoxGeometry(.3,.3,.3),new MeshStandardMaterial({color:0x4aa3df}));
box.position.set(-.6,1.15,-1.2);
const ball=new Mesh(new SphereGeometry(.15,32,16),new MeshStandardMaterial({color:0xd64545}));
ball.position.set(.6,1.9,-1.2);
scene.add(knot,box,ball);

const message=document.getElementById('message')!,toggle=document.getElementById('toggle')!;
const synthetic=document.getElementById('synthetic') as HTMLInputElement;
if(new URLSearchParams(location.search).has('synthetic'))synthetic.checked=true;

// No microphone (a desktop without one, a test browser): record a tone instead, through the same MediaRecorder path.
let tone:MediaStream|undefined;
function syntheticVoice(){
  if(!tone){
    const audio=new AudioContext(),osc=audio.createOscillator(),gain=audio.createGain(),out=audio.createMediaStreamDestination();
    osc.frequency.value=220;gain.gain.value=.2;osc.connect(gain).connect(out);osc.start();void audio.resume();
    tone=out.stream;
  }
  return Promise.resolve(tone);
}

const feedback=attachFeedback({
  renderer,scene,camera,
  agentName:'Agent',
  // What the app was doing; `summary` is printed next to the transcript by the watcher.
  context:()=>({summary:`knot ${knot.visible?'spinning':'hidden'}; ${renderer.xr.isPresenting?'in XR':'desktop'}`,shapes:{knot:knot.position.toArray(),box:box.position.toArray(),ball:ball.position.toArray()}}),
  microphone:()=>synthetic.checked?syntheticVoice():navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}}),
  changed:recording=>{toggle.textContent=recording?'Stop':'Record';toggle.setAttribute('aria-pressed',String(recording));},
  onMessage:text=>{message.textContent=text;},
});
toggle.addEventListener('click',()=>feedback.toggle());
const speak=document.getElementById('speak') as HTMLInputElement;
speak.addEventListener('change',()=>{feedback.client.voice=speak.checked?'auto':'off';});
// For debugging and automated checks from the console.
Object.assign(window,{jxrvis:feedback});

addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
const clock=new Clock();
renderer.setAnimationLoop(()=>{
  const delta=clock.getDelta();
  knot.rotation.x+=delta*.6;knot.rotation.y+=delta*.9;
  feedback.update(delta);
  renderer.render(scene,camera);
});
