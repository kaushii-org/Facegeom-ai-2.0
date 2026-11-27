/* FACEGEOM AI — facial landmark analysis and clean results board */
"use strict";

const video = document.getElementById("video");
const canvas = document.getElementById("output");
const ctx = canvas.getContext("2d");
const $ = id => document.getElementById(id);

const placeholder = $("placeholder");
const statusText = $("status");
const startButton = $("startCamera");
const stopButton = $("stopCamera");
const imageInput = $("imageInput");
const scanButton = $("scanFace");
const rescanButton = $("rescanFace");

let faceMesh = null;
let cameraStream = null;
let cameraRunning = false;
let processing = false;
let currentMode = "idle";
let photoObjectUrl = null;
let scanActive = false;
let scanFrames = [];
let scanStartTime = 0;
let scanAnimation = null;
let latestResult = null;
let chatHistory = [];

/* Add a secure backend URL here only after deploying the backend.
   Never place an API key in this public JavaScript file. */
const CHAT_API_URL = "https://facegeom-ai-chat.onrender.com/api/chat";

function setStatus(message) { if (statusText) statusText.textContent = message; }
function setMetric(id, value) { const el = $(id); if (el) el.textContent = value; }
function average(values) { return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0; }
function clamp(value,min,max) { return Math.max(min,Math.min(max,value)); }
function distance(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }

function angleAt(a, vertex, b) {
  const v1={x:a.x-vertex.x,y:a.y-vertex.y}, v2={x:b.x-vertex.x,y:b.y-vertex.y};
  const den=Math.hypot(v1.x,v1.y)*Math.hypot(v2.x,v2.y);
  if(!den) return 0;
  const cos=clamp((v1.x*v2.x+v1.y*v2.y)/den,-1,1);
  return Math.acos(cos)*180/Math.PI;
}

function resetMetrics() {
  ["faceWidth","faceHeight","eyeDistance","faceRatio","jawAngle","landmarks","symmetryScore","harmonyScore","thirdsValue","eyeSpacingValue","jawProportionValue","midlineValue"].forEach(id=>setMetric(id,"--"));
  setMetric("symmetryDescription","Waiting for facial analysis.");
  setMetric("harmonyDescription","Waiting for facial analysis.");
}

function calculateAnalysis(points) {
  if(!points || points.length<455) return null;

  const leftFace=points[234], rightFace=points[454], forehead=points[10], chin=points[152];
  const leftEyeOuter=points[33], rightEyeOuter=points[263], leftEyeInner=points[133], rightEyeInner=points[362];
  const leftJaw=points[172], rightJaw=points[397], noseTip=points[1], brow=points[9], noseBase=points[2];

  const eyeDistance=distance(leftEyeOuter,rightEyeOuter);
  if(eyeDistance<.001) return null;

  const faceWidth=distance(leftFace,rightFace)/eyeDistance;
  const faceHeight=distance(forehead,chin)/eyeDistance;
  const faceRatio=faceWidth/faceHeight;
  const jawWidth=distance(leftJaw,rightJaw);
  const cheekWidth=distance(leftFace,rightFace);
  const jawProportion=cheekWidth>0?jawWidth/cheekWidth:0;
  const eyeSpacing=distance(leftEyeInner,rightEyeInner)/eyeDistance;

  const thirds=[Math.abs(brow.y-forehead.y),Math.abs(noseBase.y-brow.y),Math.abs(chin.y-noseBase.y)];
  const thirdsMean=average(thirds);
  const thirdsDeviation=thirdsMean>0?average(thirds.map(v=>Math.abs(v-thirdsMean)))/thirdsMean:0;

  const mirrorPairs=[[33,263],[133,362],[159,386],[145,374],[70,300],[105,334],[127,356],[234,454],[172,397],[136,365],[150,379],[176,400]];
  const midlineX=noseTip.x;
  const pairErrors=mirrorPairs.map(([a,b])=>{
    const A=points[a],B=points[b];
    const xError=Math.abs((midlineX-A.x)-(B.x-midlineX));
    return Math.hypot(xError,Math.abs(A.y-B.y));
  });

  const meanSymmetryError=average(pairErrors);
  const symmetryScore=clamp(100-meanSymmetryError*350,0,100);
  const thirdsPenalty=clamp(thirdsDeviation*180,0,45);
  const eyePenalty=clamp(Math.abs(eyeSpacing-1)*35,0,25);
  const jawPenalty=clamp(Math.abs(jawProportion-.85)*35,0,25);
  const harmonyScore=clamp(100-thirdsPenalty-eyePenalty-jawPenalty,0,100);
  const jawAngle=angleAt(leftJaw,chin,rightJaw);
  const frontalness=Math.abs(leftEyeOuter.y-rightEyeOuter.y)/eyeDistance;
  const thirdRatio=thirds.map(v=>(v/Math.max(thirdsMean,.0001)).toFixed(2)).join(" : ");

  setMetric("faceWidth",faceWidth.toFixed(3));
  setMetric("faceHeight",faceHeight.toFixed(3));
  setMetric("eyeDistance","1.000");
  setMetric("faceRatio",faceRatio.toFixed(3));
  setMetric("jawAngle",jawAngle.toFixed(1)+"°");
  setMetric("landmarks",String(points.length));
  setMetric("thirdsValue",thirdRatio);
  setMetric("eyeSpacingValue",eyeSpacing.toFixed(3));
  setMetric("jawProportionValue",jawProportion.toFixed(3));
  setMetric("midlineValue",(meanSymmetryError/eyeDistance).toFixed(3));

  if(frontalness>.18) {
    setMetric("symmetryScore","--");
    setMetric("harmonyScore","--");
    setMetric("symmetryDescription","Face alignment is outside the preferred range.");
    setMetric("harmonyDescription","Turn your face directly toward the camera.");
  } else {
    setMetric("symmetryScore",symmetryScore.toFixed(0));
    setMetric("harmonyScore",harmonyScore.toFixed(0));
    setMetric("symmetryDescription","Estimated from mirrored landmark pairs.");
    setMetric("harmonyDescription","Experimental geometric proportion estimate.");
  }

  return {
    faceWidth,faceHeight,faceRatio,eyeDistance,jawWidth,
    jawProportion,eyeSpacing,thirdsDeviation,thirdRatio,
    symmetryScore,harmonyScore,meanSymmetryError,jawAngle,frontalness
  };
}

function resizeCanvas(w,h) {
  canvas.width=Math.max(1,Math.round(w));
  canvas.height=Math.max(1,Math.round(h));
}

function drawResults(results) {
  const source=currentMode==="photo"?results.image:video;
  if(!source) return;

  const width=source.videoWidth||source.naturalWidth||source.width;
  const height=source.videoHeight||source.naturalHeight||source.height;
  if(!width||!height) return;

  resizeCanvas(width,height);
  ctx.clearRect(0,0,width,height);

  if(currentMode==="camera") {
    ctx.save();
    ctx.translate(width,0);
    ctx.scale(-1,1);
    ctx.drawImage(source,0,0,width,height);
    ctx.restore();
  } else {
    ctx.drawImage(source,0,0,width,height);
  }

  if(results.multiFaceLandmarks&&results.multiFaceLandmarks.length) {
    const points=results.multiFaceLandmarks[0];
    const analysis=calculateAnalysis(points);

    if(scanActive&&currentMode==="camera"&&analysis&&analysis.frontalness<=.18) {
      scanFrames.push({
        points:points.map(p=>({x:p.x,y:p.y,z:p.z||0}))
      });
    }

    if(typeof drawConnectors==="function"&&typeof FACEMESH_TESSELATION!=="undefined") {
      ctx.save();

      if(currentMode==="camera") {
        ctx.translate(width,0);
        ctx.scale(-1,1);
      }

      drawConnectors(ctx,points,FACEMESH_TESSELATION,{
        color:"rgba(72,198,239,0.28)",lineWidth:.5
      });

      if(typeof FACEMESH_CONTOURS!=="undefined") {
        drawConnectors(ctx,points,FACEMESH_CONTOURS,{
          color:"#48c6ef",lineWidth:1
        });
      }

      ctx.restore();
    }

    if(placeholder) placeholder.style.display="none";
    setStatus(scanActive?"SCAN IN PROGRESS":"FACE DETECTED");

  } else {
    resetMetrics();
    setStatus(scanActive?"SEARCHING FOR FACE...":"NO FACE DETECTED");
    if(placeholder) placeholder.style.display="flex";
  }
}

async function initializeFaceMesh() {
  if(faceMesh) return faceMesh;

  if(typeof FaceMesh==="undefined") {
    throw new Error("MediaPipe did not load. Check your internet connection and reload.");
  }

  faceMesh=new FaceMesh({
    locateFile:file=>"https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/"+file
  });

  faceMesh.setOptions({
    maxNumFaces:1,
    refineLandmarks:true,
    minDetectionConfidence:.5,
    minTrackingConfidence:.5
  });

  faceMesh.onResults(results=>{
    drawResults(results);
    processing=false;
  });

  return faceMesh;
}

async function startCamera() {
  try {
    if(cameraRunning) return;

    setStatus("STARTING CAMERA...");
    await initializeFaceMesh();

    if(!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access requires HTTPS or localhost.");
    }

    cameraStream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:"user"},
      audio:false
    });

    video.srcObject=cameraStream;
    await video.play();

    currentMode="camera";
    cameraRunning=true;
    processing=false;
    scanButton.disabled=false;

    if(placeholder) placeholder.style.display="none";

    setStatus("CAMERA ACTIVE");
    setScanFeedback("Camera ready. Position your face in the frame.",0);

    async function cameraLoop() {
      if(!cameraRunning) return;

      if(!processing&&video.readyState>=2) {
        processing=true;

        try {
          await faceMesh.send({image:video});
        } catch(err) {
          processing=false;
          console.error(err);
          setStatus("ANALYSIS ERROR");
        }
      }

      requestAnimationFrame(cameraLoop);
    }

    requestAnimationFrame(cameraLoop);

  } catch(err) {
    console.error(err);
    setStatus("CAMERA ERROR");
    alert(err.message||"Could not start the camera.");
    stopCamera();
  }
}

function stopCamera() {
  cancelScan();
  cameraRunning=false;
  processing=false;

  if(cameraStream) {
    cameraStream.getTracks().forEach(t=>t.stop());
    cameraStream=null;
  }

  if(video) {
    video.pause();
    video.srcObject=null;
  }

  scanButton.disabled=true;

  if(currentMode==="camera") {
    currentMode="idle";
    ctx.clearRect(0,0,canvas.width,canvas.height);
    resizeCanvas(1,1);
    resetMetrics();

    if(placeholder) placeholder.style.display="flex";

    setStatus("SYSTEM READY");
    setScanFeedback("Start the camera to begin.",0);
  }
}

async function analyzePhoto(file) {
  if(!file||!file.type.startsWith("image/")) {
    alert("Please choose a valid image file.");
    return;
  }

  try {
    stopCamera();
    await initializeFaceMesh();

    if(photoObjectUrl) URL.revokeObjectURL(photoObjectUrl);

    photoObjectUrl=URL.createObjectURL(file);
    const image=new Image();

    image.onload=async()=>{
      currentMode="photo";
      processing=true;

      if(placeholder) placeholder.style.display="none";

      setStatus("ANALYZING PHOTO...");

      try {
        await faceMesh.send({image});
        processing=false;
        setStatus("PHOTO ANALYSIS COMPLETE");
      } catch(err) {
        processing=false;
        console.error(err);
        setStatus("PHOTO ANALYSIS ERROR");
        alert("Could not analyze this photo. Try another image.");
      }
    };

    image.onerror=()=>{
      setStatus("IMAGE ERROR");
      alert("The selected image could not be opened.");
    };

    image.src=photoObjectUrl;

  } catch(err) {
    console.error(err);
    setStatus("SYSTEM ERROR");
    alert(err.message||"Could not initialize facial analysis.");
  }
}

function setScanFeedback(message,percent) {
  setMetric("scanCountdown",message);
  setMetric("scanPercent",Math.round(percent)+"%");

  const bar=$("scanProgress");
  if(bar) bar.style.width=percent+"%";
}

function startFinalScan() {
  if(!cameraRunning||currentMode!=="camera") {
    alert("Please start the camera before scanning.");
    return;
  }

  cancelScan();
  scanFrames=[];
  scanActive=true;
  scanStartTime=Date.now();

  $("finalReport").classList.remove("visible");
  $("finalReport").setAttribute("aria-hidden","true");

  scanButton.disabled=true;
  scanButton.textContent="SCANNING...";
  setStatus("SCAN IN PROGRESS");

  function updateScan() {
    if(!scanActive) return;

    const elapsed=(Date.now()-scanStartTime)/1000;
    const remaining=Math.max(0,5-elapsed);

    setScanFeedback(
      "Scanning face... "+remaining.toFixed(1)+" seconds remaining",
      Math.min(100,elapsed/5*100)
    );

    if(elapsed>=5) {
      finishFinalScan();
    } else {
      scanAnimation=requestAnimationFrame(updateScan);
    }
  }

  updateScan();
}

function cancelScan() {
  scanActive=false;

  if(scanAnimation!==null) {
    cancelAnimationFrame(scanAnimation);
    scanAnimation=null;
  }

  if(scanButton) {
    scanButton.disabled=!cameraRunning;
    scanButton.textContent="START 5-SECOND SCAN";
  }
}

function averageLandmarks(frames) {
  if(!frames.length) return null;

  const count=frames[0].points.length;
  const output=[];

  for(let i=0;i<count;i++) {
    output.push({
      x:average(frames.map(f=>f.points[i].x)),
      y:average(frames.map(f=>f.points[i].y)),
      z:average(frames.map(f=>f.points[i].z))
    });
  }

  return output;
}

function finishFinalScan() {
  scanActive=false;

  if(scanAnimation!==null) {
    cancelAnimationFrame(scanAnimation);
    scanAnimation=null;
  }

  scanButton.disabled=false;
  scanButton.textContent="START 5-SECOND SCAN";

  const count=scanFrames.length;

  if(count<10) {
    setStatus("SCAN INCOMPLETE");
    setScanFeedback(
      "Not enough stable face frames. Face the camera directly and try again.",
      100
    );

    setMetric("reportStatus","Scan incomplete — not enough stable frames were collected.");
    openReport();

    $("reportTitle").textContent="Scan incomplete";
    $("faceShapeSummary").textContent="Please face the camera directly and try again.";
    $("finalFaceShape").textContent="Not available";
    return;
  }

  const points=averageLandmarks(scanFrames);
  const result=calculateAnalysis(points);

  if(!result||result.frontalness>.18) {
    setStatus("SCAN INCOMPLETE");
    setScanFeedback("Face alignment was not stable. Please scan again.",100);

    setMetric("reportStatus","Scan incomplete — face alignment was not stable.");
    openReport();

    $("reportTitle").textContent="Scan incomplete";
    $("faceShapeSummary").textContent="Keep your head straight and try another scan.";
    $("finalFaceShape").textContent="Not available";
    return;
  }

  latestResult=result;
  showFinalReport(result,count);

  setStatus("ANALYSIS COMPLETE");
  setScanFeedback("Scan complete. "+count+" stable frames analysed.",100);
  setMetric("reportStatus","Analysis completed using "+count+" stable facial frames.");

  openReport();
}

function estimateFaceShape(r) {
  if(r.faceRatio>=.88) return "Round / Broad";
  if(r.faceRatio<=.68) return "Oblong / Long";
  if(r.jawProportion>=.88) return "Square-like";
  if(r.jawProportion<=.70) return "Heart / Tapered";

  return "Oval-like";
}

function getStyleProfile(shape) {
  const profiles={

    "Round / Broad":{
      description:"Your measured width-to-height ratio falls in the broader range of this project's face-shape heuristic.",
      hair:"Height and texture on top; cleaner, tighter sides",
      hairWhy:"A textured quiff, side-part or moderate pompadour can add vertical structure. Avoid excessive width at the temples if you want a more elongated outline.",
      grooming:"Short boxed beard or neat stubble",
      groomingWhy:"A slightly defined beard line can add visual structure. If clean-shaven, keep the cheek and neck areas tidy.",
      glasses:"Rectangular or softly angular frames",
      glassesWhy:"Angular frame shapes create contrast with a rounder outline. Frame width should still fit your actual face comfortably.",
      colours:"Start with navy, charcoal, forest green and off-white",
      coloursWhy:"These are versatile wardrobe colours, not colours inferred from the camera. Test shades in natural daylight against your skin."
    },

    "Oblong / Long":{
      description:"Your measured width-to-height ratio falls in the longer range of this project's face-shape heuristic.",
      hair:"Moderate side volume with a low-to-medium profile",
      hairWhy:"A textured crop, classic side-part or fringe can keep the silhouette balanced. Avoid adding excessive height if you prefer a shorter-looking outline.",
      grooming:"Even stubble or a short, fuller beard",
      groomingWhy:"Keep beard length balanced rather than creating a long pointed chin. A clean shave can also work.",
      glasses:"Wayfarer, round or medium-depth frames",
      glassesWhy:"Frames with a little more vertical depth can visually balance a longer outline. Prioritize fit over trend.",
      colours:"Try deep blue, olive, burgundy, stone and cream",
      coloursWhy:"These are adaptable colour options, not a skin-tone diagnosis. Compare them in natural light."
    },

    "Square-like":{
      description:"Your estimated jaw-to-cheek proportion falls in the broader-jaw range of this project's heuristic.",
      hair:"Textured crop, loose side-part or soft fringe",
      hairWhy:"Texture and a slightly softer outline can complement a defined jaw. You can keep the sides neat without making the cut overly severe.",
      grooming:"Short stubble or a neatly shaped short beard",
      groomingWhy:"Keep the beard edges intentional and avoid an overly heavy squared-off outline if you want a softer finish.",
      glasses:"Round, oval or softly curved frames",
      glassesWhy:"Curved frames can contrast with angular facial lines. Check bridge and temple fit.",
      colours:"Try charcoal, muted blue, cream, dark green and earth tones",
      coloursWhy:"These are flexible wardrobe choices, not colours detected by the scan."
    },

    "Heart / Tapered":{
      description:"Your estimated jaw-to-cheek proportion falls in the narrower-jaw range of this project's heuristic.",
      hair:"Layered texture with controlled height and some side movement",
      hairWhy:"A textured fringe, medium-length layers or relaxed side-part can help balance the upper and lower outline. Avoid extreme height if you want less emphasis on the forehead.",
      grooming:"Light stubble or a short beard with balanced chin length",
      groomingWhy:"A little lower-face definition can be an option. Keep the shape natural rather than making the chin appear excessively pointed.",
      glasses:"Thin oval, round or subtle aviator-style frames",
      glassesWhy:"Softer frames can work well with a tapered lower outline. Choose a frame width that sits naturally.",
      colours:"Try slate, navy, warm neutrals, olive and burgundy",
      coloursWhy:"These are general palette ideas. Camera lighting cannot accurately identify your undertone."
    },

    "Oval-like":{
      description:"Your measured proportions fall within the middle range of this project's face-shape heuristic.",
      hair:"Versatile options: textured crop, side-part, quiff or medium layers",
      hairWhy:"This estimate suggests flexibility. Choose based on hair texture, hairline, maintenance and the look you actually want.",
      grooming:"Clean shave, light stubble or a short shaped beard",
      groomingWhy:"Several grooming approaches may work. Keep proportions neat and choose the maintenance level you can sustain.",
      glasses:"Most classic frame shapes; start with rectangular or softly rounded",
      glassesWhy:"The estimated outline is relatively balanced, so fit and personal style matter more than strict face-shape rules.",
      colours:"Build around navy, charcoal, cream, olive and muted earth tones",
      coloursWhy:"These are reliable starting points, not a colour analysis. Test clothing in daylight."
    }
  };

  return profiles[shape]||profiles["Oval-like"];
}

function showFinalReport(r,frameCount) {
  const shape=estimateFaceShape(r);
  const style=getStyleProfile(shape);

  setMetric("reportTitle","Your face profile");
  setMetric("faceShapeSummary",style.description);
  setMetric("finalFaceShape",shape);
  setMetric("shapeDescription",style.description);
  setMetric("finalRatio",r.faceRatio.toFixed(3));

  setMetric("finalSymmetry",r.symmetryScore.toFixed(0)+" / 100");
  setMetric("finalHarmony",r.harmonyScore.toFixed(0)+" / 100");
  setMetric("finalWidth",r.faceWidth.toFixed(3));
  setMetric("finalHeight",r.faceHeight.toFixed(3));
  setMetric("finalEyeSpacing",r.eyeSpacing.toFixed(3));
  setMetric("finalJaw",r.jawProportion.toFixed(3));

  setMetric("hairRecommendation",style.hair);
  setMetric("hairReason",style.hairWhy);

  setMetric("groomingRecommendation",style.grooming);
  setMetric("groomingReason",style.groomingWhy);

  setMetric("glassesRecommendation",style.glasses);
  setMetric("glassesReason",style.glassesWhy);

  setMetric("colourRecommendation",style.colours);
  setMetric("colourReason",style.coloursWhy);

  let observation="The scan averaged "+frameCount+" stable frames. ";

  observation+=r.thirdsDeviation<.12
    ?"The measured facial thirds were relatively similar in length. "
    :"The measured facial thirds showed some variation. ";

  observation+=r.symmetryScore>=85
    ?"Detected mirrored landmark pairs showed relatively low positional differences. "
    :"Detected mirrored landmark pairs showed measurable positional differences. ";

  observation+="These are observations about 2D image geometry, not facial quality.";

  setMetric("finalObservation",observation);

  chatHistory=[];

  if($("chatMessages")) {
    $("chatMessages").innerHTML=
      '<div class="chat-message assistant-message"><strong>FACEGEOM AI</strong><p>Your scan suggests an '+shape+' profile. Ask me about the recommendations or any measurement in this report.</p></div>';
  }
}

function openReport() {
  const overlay=$("finalReport");

  overlay.classList.add("visible");
  overlay.setAttribute("aria-hidden","false");

  document.body.style.overflow="hidden";
}

function closeFinalReport() {
  const overlay=$("finalReport");

  overlay.classList.remove("visible");
  overlay.setAttribute("aria-hidden","true");

  document.body.style.overflow="";
}

startButton?.addEventListener("click",startCamera);
stopButton?.addEventListener("click",stopCamera);
scanButton?.addEventListener("click",startFinalScan);

rescanButton?.addEventListener("click",()=>{
  closeFinalReport();

  if(currentMode==="photo") {
    setScanFeedback("Start the camera to perform another 5-second scan.",0);
    return;
  }

  if(!cameraRunning) {
    startCamera();
    return;
  }

  startFinalScan();
});

imageInput?.addEventListener("change",e=>{
  const file=e.target.files?.[0];
  if(file) analyzePhoto(file);
  e.target.value="";
});

$("closeReport")?.addEventListener("click",closeFinalReport);

$("finalReport")?.addEventListener("click",e=>{
  if(e.target===$("finalReport")) closeFinalReport();
});

document.addEventListener("keydown",e=>{
  if(e.key==="Escape") closeFinalReport();
});

document.querySelectorAll(".report-tab").forEach(button=>{
  button.addEventListener("click",()=>{
    const tab=button.dataset.tab;

    document.querySelectorAll(".report-tab").forEach(b=>{
      b.classList.toggle("active",b===button);
    });

    $("overviewTab").classList.toggle("active",tab==="overview");
    $("assistantTab").classList.toggle("active",tab==="assistant");
  });
});

function addChatMessage(message,sender) {
  const box=document.createElement("div");

  box.className=sender==="user"
    ?"chat-message user-message"
    :"chat-message assistant-message";

  const heading=document.createElement("strong");
  heading.textContent=sender==="user"?"YOU":"FACEGEOM AI";

  const p=document.createElement("p");
  p.textContent=message;

  box.append(heading,p);

  $("chatMessages").appendChild(box);
  $("chatMessages").scrollTop=$("chatMessages").scrollHeight;
}

function getChatScanContext() {
  return {
    faceShape:$("finalFaceShape").textContent,
    symmetry:$("finalSymmetry").textContent,
    harmony:$("finalHarmony").textContent,
    faceRatio:$("finalRatio").textContent,
    faceWidth:$("finalWidth").textContent,
    faceHeight:$("finalHeight").textContent,
    eyeSpacing:$("finalEyeSpacing").textContent,
    jawProportion:$("finalJaw").textContent,
    hairstyle:$("hairRecommendation").textContent,
    grooming:$("groomingRecommendation").textContent,
    glasses:$("glassesRecommendation").textContent,
    clothingColours:$("colourRecommendation").textContent,
    observations:$("finalObservation").textContent
  };
}

async function sendChatMessage(message) {
  if(!message.trim()) return;

  addChatMessage(message,"user");
  chatHistory.push({role:"user",content:message});

  $("chatInput").value="";
  $("chatInput").disabled=true;
  $("chatSend").disabled=true;

  setMetric("chatStatus","Preparing response...");

  if(!CHAT_API_URL) {
    addChatMessage(
      "The chat interface is ready, but the AI service is not connected yet. To enable real answers, this project needs a secure backend endpoint. The API key must stay on the backend, never in this website's JavaScript.",
      "assistant"
    );

    chatHistory.pop();

    $("chatInput").disabled=false;
    $("chatSend").disabled=false;

    setMetric("chatStatus","AI service not connected — backend setup required.");
    return;
  }

  try {
    const response=await fetch(CHAT_API_URL,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        message,
        context:getChatScanContext(),
        history:chatHistory.slice(-10),
        systemInstruction:"You are FACEGEOM AI, a concise and practical style advisor. Use the supplied scan context to explain estimated face shape and suggest hairstyles, grooming, glasses and clothing colours. Be clear that the face-shape heuristic is approximate, 2D scan scores are not attractiveness ratings, and webcam lighting cannot determine skin undertone reliably. Do not make medical claims or rate attractiveness. Ask a clarifying question only when needed."
      })
    });

    if(!response.ok) {
      throw new Error("AI service returned "+response.status);
    }

    const data=await response.json();

    if(!data.reply) {
      throw new Error("AI service returned an empty response.");
    }

    addChatMessage(data.reply,"assistant");
    chatHistory.push({role:"assistant",content:data.reply});

    setMetric("chatStatus","AI assistant connected.");

  } catch(err) {
    console.error("Chatbot error:",err);

    addChatMessage(
      "I couldn't connect to the AI service. Please try again later.",
      "assistant"
    );

    setMetric("chatStatus","Connection error.");

  } finally {
    $("chatInput").disabled=false;
    $("chatSend").disabled=false;
    $("chatInput").focus();
  }
}

$("chatForm")?.addEventListener("submit",e=>{
  e.preventDefault();

  const msg=$("chatInput").value.trim();

  if(msg) sendChatMessage(msg);
});

document.querySelectorAll(".chat-prompt").forEach(button=>{
  button.addEventListener("click",()=>{
    sendChatMessage(button.textContent.trim());
  });
});

window.addEventListener("beforeunload",()=>{
  stopCamera();

  if(photoObjectUrl) {
    URL.revokeObjectURL(photoObjectUrl);
  }
});

resetMetrics();
setStatus("SYSTEM READY");
setScanFeedback("Start the camera to begin.",0);
