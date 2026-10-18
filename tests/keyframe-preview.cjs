// Run after npm run build: node_modules/.bin/electron tests/keyframe-preview.cjs
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
require('node:child_process').execFileSync(require('ffmpeg-static'), ['-y','-f','lavfi','-i','testsrc2=size=640x360:rate=30','-t','6','-c:v','libx264','-pix_fmt','yuv420p','/tmp/danceframe-keyframe-test.mp4','-loglevel','error']);
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,width:1480,height:920,webPreferences:{preload:path.join(__dirname,'keyframe-preview-preload.cjs'),contextIsolation:false,webSecurity:false}});
try {
 await win.loadFile(process.env.DANCEFRAME_TEST_APP ? path.join(process.env.DANCEFRAME_TEST_APP,'dist/index.html') : path.join(__dirname,'../dist/index.html'));
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const check=(x,m)=>{if(!x)throw Error(m)};
 const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await wait(50)}throw Error('timed out waiting for video')};
 const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes(text));
 const range=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
 check(document.querySelector('[aria-label="运镜平滑度"]').disabled,'smoothing enabled before import');
 button('导入视频').click(); await until(()=>document.querySelector('video')?.readyState>=2); await wait(100);
 check(document.querySelector('[aria-label="人物画面占比"]').disabled,'scale enabled without target');
 check(button('在当前帧添加').disabled,'keys enabled before tracking');
 const overlay=document.querySelector('.selectionOverlay'), r=overlay.getBoundingClientRect();
 overlay.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+100,clientY:r.top+100,pointerId:1}));
 overlay.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:r.left+220,clientY:r.top+260,pointerId:1}));
 overlay.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:r.left+220,clientY:r.top+260,pointerId:1}));
 await wait(100); check(!document.querySelector('[aria-label="人物画面占比"]').disabled,'static framing unavailable'); button('开始人物追踪').click();await wait(200);
 check(document.querySelector('[aria-label="占比调整范围"]'),'tracking fixture failed');
 check(!document.querySelector('[aria-label="运镜平滑度"]').disabled,'smoothing locked after analysis');
 const timeline=document.querySelector('[aria-label="视频播放位置"]');
 range(timeline,2);await until(()=>Math.abs(document.querySelector('video').currentTime-2)<.01&&!document.querySelector('video').seeking);await wait(100);
 const scale=()=>document.querySelector('.fieldGroup input[type=range]');
 range(scale(),80);await wait(100);
 range(timeline,4);await until(()=>Math.abs(document.querySelector('video').currentTime-4)<.01&&!document.querySelector('video').seeking);await wait(100);range(scale(),50);await wait(100);
 const keys=()=>[...document.querySelectorAll('.keyframe-item')];
 check(keys().length===2,'expected two keys: '+JSON.stringify({keys:keys().map(k=>k.textContent),time:document.querySelector('video').currentTime,scale:scale().outerHTML}));
 keys()[0].click();await wait(300);
 check(Number(scale().value)===80,'first scale lost');
 check(Math.abs(draws.at(-1).time-2)<.04,'program monitor stale after first seek');
 keys()[1].click();await wait(300);
 check(Number(scale().value)===50,'second scale lost');
 check(Math.abs(draws.at(-1).time-4)<.04,'program monitor stale after second seek');
 check(draws.every(d=>!d.seeking),'drew undecoded seek frame');
 const video=document.querySelector('video'), output=document.querySelector('canvas');
 const expected=document.createElement('canvas');expected.width=output.width;expected.height=output.height;
 expected.getContext('2d').imageSmoothingQuality='high';expected.getContext('2d').drawImage(video,...draws.at(-1).crop,0,0,expected.width,expected.height);
 check(expected.toDataURL()===output.toDataURL(),'canvas does not match decoded source frame');
 // Dragging edits only the current frame; the visible button explicitly re-locks the future.
 range(timeline,2); await until(()=>Math.abs(video.currentTime-2)<.01&&!video.seeking);await wait(100);
 const drag=async()=>{
   const box=document.querySelector('.subjectBox'), rect=box.getBoundingClientRect();
   box.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:rect.left+10,clientY:rect.top+10,pointerId:1}));
   window.dispatchEvent(new PointerEvent('pointermove',{clientX:rect.left+80,clientY:rect.top+10,pointerId:1}));
   window.dispatchEvent(new PointerEvent('pointerup',{clientX:rect.left+80,clientY:rect.top+10,pointerId:1}));
   await wait(200);
 };
 await drag();
 check(trackRequests.length===1,'local drag unexpectedly called tracking engine');
 button('导出 MP4').click(); await wait(100);
 const center=b=>b.x+b.w/2;
 check(center(exportJob.boxes[60])>center(exportJob.boxes[0]),'local drag did not move current frame');
 check(Math.abs(center(exportJob.boxes[179])-center(exportJob.boxes[0]))<.01,'local drag changed distant frames');
 button('从当前帧重新锁定后续人物').click(); await wait(200);
 check(trackRequests.length===2,'relock button did not call tracking engine');
 check(Math.abs(trackRequests[1].currentTime-2)<.01,'relock used stale time');
 check(trackRequests[1].box.x>240,'relock used old box');
 button('导出 MP4').click(); await wait(100);
 const previousExport=JSON.stringify(exportJob.boxes);
 check(Math.abs(center(exportJob.boxes[0])-290)<.01,'relock changed previous identity');
 check(Math.abs(center(exportJob.boxes[179])-450)<.01,'relock reverted after 1.5s');
 check(keys().length===2,'relock lost scale keyframes');
 range(timeline,4); await until(()=>Math.abs(video.currentTime-4)<.01&&!video.seeking);await wait(100);
 check(Number(scale().value)===50,'relock lost local scale');
 for(const reason of ['已取消分析','当前框内未检测到人物']) {
   window.trackFailure=reason;button('从当前帧重新锁定后续人物').click();await wait(200);
   button('导出 MP4').click();await wait(100);
   check(JSON.stringify(exportJob.boxes)===previousExport,'failed/cancelled relock damaged existing trajectory');
 }
 return {keys:keys().map(k=>k.textContent),pixelMatch:true,relock:true,preservedPrefix:true,permanentFuture:true,cancelAndFailurePreserved:true};
})()`);
 console.log(JSON.stringify(result));app.exit(0);
}catch(e){console.error(e);app.exit(1)}
});
