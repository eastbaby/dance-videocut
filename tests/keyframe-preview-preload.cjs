window.trackRequests = [];
window.trackFailure = null;
window.danceframe = {
 diagnostics: async () => ({}), onEngineProgress: () => () => {},
 selectVideo: async () => ({path:'/tmp/danceframe-keyframe-test.mp4',name:'test.mp4',url:'file:///tmp/danceframe-keyframe-test.mp4'}),
 trackVideo: async job => { window.trackRequests.push(job); if(window.trackFailure) return {ok:false,error:window.trackFailure}; return {ok:true,fps:30,boxes:Array.from({length:180},()=>({x:window.trackRequests.length===1?240:400,y:90,w:100,h:180}))}; },
 exportVideo: async job => {window.exportJob=job;return {canceled:true}}
};
window.draws=[];
const original=CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage=function(...args){ if(args[0] instanceof HTMLVideoElement) window.draws.push({time:args[0].currentTime,seeking:args[0].seeking,crop:args.slice(1,5)}); return original.apply(this,args); };
