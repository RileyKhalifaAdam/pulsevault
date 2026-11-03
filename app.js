// PLACEHOLDER: replace with your real Formspree form URL, e.g. https://formspree.io/f/abcdwxyz
const CONTACT_ENDPOINT="https://formspree.io/f/YOUR_FORM_ID";
// PLACEHOLDER: set your real support inbox
const SUPPORT_EMAIL="support@pulsevault.example";
const CLAIM_MS=30*60*1000;
const ls={get:(k,d)=>{try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}},set:(k,v)=>localStorage.setItem(k,JSON.stringify(v))};
const me=()=>ls.get("pv_user",{scores:[],accepted:0});
const qualifies=()=>{const u=me();const r=u.scores.slice(-2);return (r.length===2&&r.every(s=>s>=4.5))||u.accepted>=5};
const claims=()=>ls.get("pv_claims",{}); // id -> expiry ms
const esc=s=>String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]);
// base = slots already taken by others (would come from the server); plus this user's claim
const taken=id=>{const c=CALLS.find(x=>x.id===id);return Math.min(c.slots,(c.taken||0)+(claims()[id]?1:0))};
const size=mb=>mb<1000?mb+" MB":(mb/1000)+" GB";
const $=s=>document.querySelector(s);
function fmt(ms){ms=Math.max(0,ms);const m=Math.floor(ms/60000),s=Math.floor(ms/1000)%60;return m+":"+String(s).padStart(2,"0")}
function due(h){return h>=48?`Due in ${Math.round(h/24)}d`:`Due in ${h}h`}
const shots=[...new Set(CALLS.flatMap(c=>c.tags))].filter(t=>!["Sound","Hands"].includes(t));
shots.forEach(t=>$("#shot").add(new Option(t,t)));[...new Set(CALLS.map(c=>c.city))].forEach(t=>$("#city").add(new Option(t,t)));
const DEMO=new URLSearchParams(location.search).has("demo");
function status(){if(!DEMO){$("#status").innerHTML="";return}const u=me();$("#status").innerHTML=`<b>Demo profile</b> · recent scores: ${u.scores.slice(-2).join(", ")||"none"} · accepted files: ${u.accepted} · ${qualifies()?'<span style="color:var(--ok)">Invite calls unlocked</span>':"Invite calls locked"}
<div class="row"><button data-a="score">Add a 4.8 score</button><button data-a="acc">Add accepted file</button><button data-a="reset">Reset demo</button></div>`}
function render(){status();renderWork();renderProfile();renderBuyer();badge();const q=$("#q").value.toLowerCase(),sh=$("#shot").value,ci=$("#city").value,so=$("#sort").value;
let L=CALLS.filter(c=>(!q||(c.title+c.desc+c.buyer).toLowerCase().includes(q))&&(!sh||c.tags.includes(sh))&&(!ci||c.city===ci));
if(so==="pay")L=[...L].sort((a,b)=>b.pay-a.pay);if(so==="due")L=[...L].sort((a,b)=>a.dueH-b.dueH);
const cl=claims(),ok=qualifies();
$("#list").innerHTML=L.map(c=>{const mine=cl[c.id];const locked=c.invite&&!ok;
let act;if(locked)act=`<div class="note">🔒 Invite only. Opens after two recent scores at 4.5, or five accepted files. Upload is locked.</div>`;
else if(mine)act=`<span>Your slot · <span class="timer" role="timer" data-exp="${mine}" data-id="${c.id}">${fmt(mine-Date.now())}</span> left</span><button data-a="rel" data-id="${c.id}">Release</button><button class="pri" data-a="up" data-id="${c.id}">Upload file</button>`;
else act=taken(c.id)>=c.slots?`<span class="mute">Full</span>`:`<button class="pri" data-a="claim" data-id="${c.id}">Claim a slot</button>`;
return `<article class="card"><div class="top"><div><div class="mute">${esc(c.city)} · ${esc(c.buyer)}</div><h3 style="margin:4px 0">${esc(c.title)}</h3></div><div class="pay">$${c.pay}</div></div>
<p>${esc(c.desc)}</p>${c.night?`<div class="note">⚠️ Night shoot: stay somewhere public and well lit, don't trespass, and don't film anyone who objects. <a href="#safety">Safety tips</a></div>`:""}<div class="mute" style="font-size:13px">File: ${c.spec.minSec}s to ${c.spec.maxSec/60} min, ${c.spec.orientation==="any"?"vertical or landscape":c.spec.orientation}, up to ${size(c.spec.maxMB)}</div><div class="mute" style="font-size:13px">${esc(c.license)}</div><div>${c.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join("")}${c.invite?'<span class="tag inv">Invite</span>':""}<span class="tag">Funded</span><span class="tag">${esc(c.gear)}</span>${c.decision?`<span class="tag">Decision in ${esc(c.decision)}</span>`:""}</div>
<div class="row mute" style="font-size:14px">★ ${esc(c.rating)} from ${esc(c.ratings)} · ${due(c.dueH)} · <b class="slots">${taken(c.id)} of ${c.slots}</b>${c.mount?" · "+esc(c.mount):""}</div><div class="row">${act}</div></article>`}).join("")||'<p class="mute">No calls match.</p>'}
document.addEventListener("click",e=>{const b=e.target.closest("[data-a]");if(!b)return;const a=b.dataset.a,id=b.dataset.id,cl=claims(),u=me();
if(a==="claim"){const c=CALLS.find(x=>x.id===id);if(c.invite&&!qualifies())return;if(taken(id)>=c.slots){alert("This call is full.");return}cl[id]=Date.now()+CLAIM_MS;ls.set("pv_claims",cl)}
if(a==="up"){openUpload(CALLS.find(x=>x.id===id));return}
if(a==="rel"){delete cl[id];ls.set("pv_claims",cl)}
if(!DEMO&&["score","acc","reset"].includes(a))return;if(a==="score"){u.scores.push(4.8);ls.set("pv_user",u)}if(a==="acc"){u.accepted++;ls.set("pv_user",u)}
if(a==="reset"){if(!confirm("Reset the demo? This erases your claims, scores and My Work history."))return;["pv_user","pv_claims","pv_subs"].forEach(k=>localStorage.removeItem(k))}render()});
["#q","#sort","#shot","#city"].forEach(s=>$(s).addEventListener("input",render));
setInterval(()=>{let expired=false;document.querySelectorAll(".timer").forEach(t=>{const left=+t.dataset.exp-Date.now();t.textContent=fmt(left);if(left>0&&Math.floor(left/1000)%300===0)$("#live").textContent=`${fmt(left)} left on your slot.`;if(left<=0){$("#live").textContent="Your slot timed out and was released.";const cl=claims();delete cl[t.dataset.id];ls.set("pv_claims",cl);expired=true}});if(expired)render()},1000);
$("#cf").addEventListener("submit",async e=>{e.preventDefault();const f=e.target,ticket="PV-"+Date.now().toString(36).toUpperCase().slice(-6);const fd=new FormData(f);fd.append("ticket",ticket);fd.append("_subject",`[${ticket}] ${fd.get("type")}`);
const m=$("#cfmsg");m.textContent="Sending…";let sent=false;if(!CONTACT_ENDPOINT.includes("YOUR_FORM_ID")){try{const r=await fetch(CONTACT_ENDPOINT,{method:"POST",body:fd,headers:{Accept:"application/json"}});sent=r.ok}catch{}}
m.innerHTML=sent?`Sent. Your ticket number is <b>${ticket}</b>.`:(CONTACT_ENDPOINT.includes("YOUR_FORM_ID")?`<b style="color:#e66">Not sent.</b> The contact form isn't connected yet, so nobody received this. For safety issues, please email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.`:`<b style="color:#e66">Not sent.</b> Something went wrong, so nobody received this. Please try again.`);if(sent)f.reset()});
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});

// ---- My Work: submission timeline, rejection reasons, appeals ----
const REASONS={spec:"Doesn't match the call's spec",face:"Faces visible without a release",talk:"Talking or music in the audio",quality:"Too shaky or too dark"};
const subs=()=>ls.get("pv_subs",[]);const saveSubs=s=>ls.set("pv_subs",s);
const when=t=>new Date(t).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
function addSub(c,file,consent,manual){const s=subs(),now=Date.now(),cl=claims();s.unshift({id:"S"+now.toString(36),callId:c.id,title:c.title,pay:c.pay,file,consent,manual:!!manual,status:"In review",steps:[["Claimed",cl[c.id]?cl[c.id]-CLAIM_MS:now],["Uploaded",now],["In review",now]]});saveSubs(s);delete cl[c.id];ls.set("pv_claims",cl)}
function sweepAppeals(){const s=subs(),now=Date.now();let ch=false;s.forEach(x=>{if(x.status==="Appealed"&&now>=x.appealDue){x.steps.push(["No buyer response in 72h · decided for you",x.appealDue]);x.status="Paid";x.steps.push(["Accepted",now],["Paid $"+x.pay+" to PayPal (demo) · demo only, no real money moved",now]);x.unread=true;const u=me();u.accepted++;ls.set("pv_user",u);ch=true}});if(ch){saveSubs(s);$("#live").textContent="An appeal was decided in your favor."}return ch}
setInterval(()=>{if(sweepAppeals())render()},1000);
function renderWork(){sweepAppeals();const s=subs();$("#worklist").innerHTML=s.length?s.map(x=>{
let extra="";if(x.reject)extra=`<div class="note"><b>Score ${x.reject.score}/5 · ${esc(REASONS[x.reject.reason])}</b><br>${esc(x.reject.comment)}</div>`;
if(x.status==="Rejected")extra+=x.appealed?`<div class="mute">This file already had its one appeal.</div>`:`<label class="sr" for="ap-${x.id}">Why the decision is wrong</label><textarea id="ap-${x.id}" rows="2" maxlength="500" placeholder="Say why, e.g. the face is blurred at 0:12" style="width:100%"></textarea><button data-w="appeal" data-id="${x.id}">Appeal this decision (one per file)</button>`;
if(x.appeal)extra+=`<div class="note"><b>Your appeal:</b> ${esc(x.appeal)}</div>`;if(x.status==="Closed")extra+=`<div class="mute">Appeal denied. That decision is final for this file; PulseVault support only steps in for a safety or payment problem.</div>`;if(x.status==="Appealed")extra+=`<div class="mute">The buyer has to respond by ${when(x.appealDue)}. If they don't, the appeal is decided in your favor.</div>`;
return `<div class="card"><div class="top"><b>${esc(x.title)}</b><span class="pay">$${x.pay}</span></div><div class="mute">${esc(x.file)} · <b>${x.status}</b>${x.manual?" · needs a manual check (we couldn't read this format in the browser)":""}</div>${x.buyerNote?`<div class="note"><b>Buyer reply:</b> ${esc(x.buyerNote)}</div>`:""}
<ol style="margin:8px 0;padding-left:18px">${x.steps.map(([n,t])=>`<li>${n} · <span class="mute">${when(t)}</span></li>`).join("")}</ol>${extra}</div>`}).join(""):'<p class="mute">Nothing yet. Claim a call and upload a file to see it here.</p>'}
document.addEventListener("click",e=>{const b=e.target.closest("[data-w]");if(!b)return;const s=subs(),x=s.find(y=>y.id===b.dataset.id),a=b.dataset.w,now=Date.now(),u=me();if(!x)return;
if(a==="appeal"&&x.status==="Rejected"&&!x.appealed){const t=(document.getElementById("ap-"+x.id).value||"").trim();if(t.length<10){alert("Please say why in a sentence so the buyer can respond.");return}x.appeal=t;x.appealed=true;x.status="Appealed";x.appealDue=now+72*3600e3;x.steps.push(["Appealed",now])}
if(a!=="appeal")return;
const pay=()=>{x.status="Paid";x.steps.push(["Accepted",now],["Paid $"+x.pay+" to "+(u.payout||"PayPal (demo)")+" · demo only, no real money moved",now]);u.accepted++;u.scores.push(4.8);ls.set("pv_user",u)};
if(a==="acc"&&x.status==="In review")pay();
if(a==="rej"&&x.status==="In review"){x.status="Rejected";x.reject={score:2,reason:"talk",comment:"Music from a nearby speaker runs through most of the clip."};x.steps.push(["Rejected",now])}
if(a==="won"&&x.status==="Appealed"){x.steps.push(["Appeal upheld",now]);pay()}
if(a==="lost"&&x.status==="Appealed"){x.status="Closed";x.steps.push(["Appeal denied",now])}
if(a==="lost"&&x.status==="Appealed"){x.status="Closed";x.steps.push(["Appeal denied",now])}
saveSubs(s);render()});

// ---- Upload: consent + file checks ----
let upCall=null;
function openUpload(c){if(c.invite&&!qualifies())return;upCall=c;const f=$("#cform");f.reset();$("#cerr").textContent="";$("#clic").textContent=c.license;$("#cspec").textContent=`${c.title}: ${c.spec.minSec}s to ${c.spec.maxSec/60} min, ${c.spec.orientation==="any"?"vertical or landscape":c.spec.orientation}, up to ${size(c.spec.maxMB)}.`;$("#consent").showModal()}
function probe(file){return new Promise(res=>{const v=document.createElement("video");v.preload="metadata";v.onloadedmetadata=()=>{res({dur:v.duration,w:v.videoWidth,h:v.videoHeight});URL.revokeObjectURL(v.src)};v.onerror=()=>res(null);v.src=URL.createObjectURL(file)})}
async function checkFile(c,file){const s=c.spec,e=[];if(!file.type.startsWith("video/"))e.push("That isn't a video file.");if(file.size>s.maxMB*1e6)e.push(`It's ${(file.size/1e9).toFixed(1)} GB; the limit is ${size(s.maxMB)}.`);
const m=e.length?null:await probe(file);if(!e.length&&!m)return{errs:[],manual:true};
if(m){if(m.dur<s.minSec)e.push(`It's ${Math.round(m.dur)}s; the call needs at least ${s.minSec}s.`);if(m.dur>s.maxSec)e.push(`It's ${Math.round(m.dur/60)} min; the limit is ${s.maxSec/60} min.`);if(s.orientation==="landscape"&&m.h>m.w)e.push("It's vertical; this call needs a landscape (sideways) video.");if(s.orientation==="vertical"&&m.w>m.h)e.push("It's sideways; this call needs a vertical video.")}return{errs:e,manual:false}}
$("#cgo").addEventListener("click",async e=>{e.preventDefault();const f=$("#cform");if(!f.reportValidity())return;const file=$("#cfile").files[0];$("#cerr").textContent="Checking…";const chk=await checkFile(upCall,file),errs=chk.errs;if(errs.length){$("#cerr").textContent=errs.join(" ");return}
$("#consent").close();addSub(upCall,file.name,{license:upCall.license,consentAt:Date.now()},chk.manual);render();location.hash="work";$("#live").textContent=`Uploaded ${file.name} for ${upCall.title}. It's in review.`});

// ---- Contributor profile: level, stats, specialties ----
function level(u){const sc=u.scores,avg=sc.length?sc.reduce((x,y)=>x+y,0)/sc.length:0;const since=Date.now()-90*864e5,recent=subs().filter(x=>x.status==="Paid"&&x.steps.some(([n,t])=>n==="Accepted"&&t>=since)),paid=recent.reduce((t,x)=>t+x.pay,0);if(recent.length>=20&&paid>=3000&&avg>=4.7)return["Pro","20+ accepted files and $3,000+ in the last 90 days, with a 4.7+ average"];if(qualifies())return["Rated","Unlocks invite-only calls"];return["New","Two scores of 4.5+ or five accepted files moves you to Rated"]}
function renderProfile(){const u=me(),s=subs(),sc=u.scores,avg=sc.length?(sc.reduce((x,y)=>x+y,0)/sc.length).toFixed(1):"none yet";const[lv,why]=level(u);
const tags={};s.filter(x=>x.status==="Paid").forEach(x=>{const c=CALLS.find(k=>k.id===x.callId);c&&c.tags.filter(t=>!["Sound","Hands"].includes(t)).forEach(t=>tags[t]=(tags[t]||0)+1)});
const spec=Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t])=>`<span class="tag">${esc(t)}</span>`).join("")||'<span class="mute">Shows up after your first accepted file</span>';
const earned=s.filter(x=>x.status==="Paid").reduce((t,x)=>t+x.pay,0);
$("#prof").innerHTML=`<div class="row"><span class="tag inv" style="font-size:15px">${lv}</span><span class="mute">${why}</span></div>
<div class="row" style="gap:24px"><div><b>${avg}</b><div class="mute">avg score</div></div><div><b>${u.accepted}</b><div class="mute">accepted files</div></div><div><b>${s.filter(x=>x.status==="In review"||x.status==="Appealed").length}</b><div class="mute">pending</div></div><div><b>$${earned}</b><div class="mute">earned (demo)</div></div></div>
<div>Specialties: ${spec}</div><p class="mute" style="font-size:12px">Demo note: badges and stats are worked out in this browser and can be edited. In the real product they have to come from the server.</p>`}

// ---- Buyer review screen ----
function renderBuyer(){const flag=$("#buyerflag");if(!DEMO){flag.innerHTML="";$("#buyer").innerHTML='<p class="mute">Buyers sign in to review files. Sign-in isn\'t built yet, so this screen is only available in the demo.</p>';return}flag.innerHTML='<div class="buyer-only" role="status">🧪 Buyer-only demo. Without a sign-in, anyone with the demo link could score their own files. Not for real use.</div>';const s=subs().filter(x=>x.status==="In review"||x.status==="Appealed");
$("#buyer").innerHTML=(s.length?s.map(x=>{const c=CALLS.find(k=>k.id===x.callId);
if(x.status==="Appealed")return `<div class="card"><b>Appeal: ${esc(x.title)}</b><div class="mute">${esc(x.file)} · you scored it ${x.reject.score}/5 (${esc(REASONS[x.reject.reason])})</div><div class="note"><b>Contributor says:</b> ${esc(x.appeal)}</div><div class="mute">Respond by ${when(x.appealDue)} or it's decided for the contributor.</div>
<label class="sr" for="br-${x.id}">Your reply</label><textarea id="br-${x.id}" rows="2" placeholder="Your reply to the contributor" style="width:100%"></textarea><div class="row"><button class="pri" data-b="uphold" data-id="${x.id}">Uphold appeal and pay</button><button data-b="deny" data-id="${x.id}">Deny appeal</button></div></div>`;
return `<div class="card"><b>${esc(x.title)}</b> <span class="pay">$${x.pay}</span><div class="mute">${esc(x.file)}${x.manual?" · format couldn't be checked automatically, check length and orientation yourself":""} · spec: ${c.spec.minSec}s to ${c.spec.maxSec/60} min, ${c.spec.orientation}</div>
<div class="row"><label>Score <select id="bs-${x.id}">${[5,4,3,2,1].map(n=>`<option>${n}</option>`).join("")}</select></label><label>Reason <select id="bw-${x.id}"><option value="">(needed below 3)</option>${Object.entries(REASONS).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join("")}</select></label></div>
<label class="sr" for="bc-${x.id}">Comment</label><textarea id="bc-${x.id}" rows="2" placeholder="Comment (needed below 3)" style="width:100%"></textarea><button class="pri" data-b="decide" data-id="${x.id}">Submit decision</button><p class="err" id="be-${x.id}" style="color:#e66"></p></div>`}).join(""):'<p class="mute">No files waiting for review.</p>')}
document.addEventListener("click",e=>{const b=e.target.closest("[data-b]");if(!b||!DEMO)return;const s=subs(),x=s.find(y=>y.id===b.dataset.id),now=Date.now(),u=me();if(!x)return;const v=id=>document.getElementById(id).value.trim();
const pay=()=>{x.status="Paid";x.steps.push(["Accepted",now],["Paid $"+x.pay+" to PayPal (demo) · demo only, no real money moved",now]);u.accepted++;ls.set("pv_user",u)};
if(b.dataset.b==="decide"&&x.status==="In review"){const sc=+v("bs-"+x.id),rs=v("bw-"+x.id),cm=v("bc-"+x.id);
 if(sc<3&&(!rs||cm.length<10)){document.getElementById("be-"+x.id).textContent="Scores below 3 need a reason and a comment of at least a sentence.";return}
 u.scores.push(sc);ls.set("pv_user",u);if(sc>=3)pay();else{x.status="Rejected";x.reject={score:sc,reason:rs,comment:cm};x.steps.push(["Rejected",now])}x.unread=true}
if(b.dataset.b==="uphold"&&x.status==="Appealed"){x.buyerNote=v("br-"+x.id);x.steps.push(["Appeal upheld",now]);pay();x.unread=true}
if(b.dataset.b==="deny"&&x.status==="Appealed"){const r=v("br-"+x.id);if(r.length<10){alert("Please explain the denial in a sentence.");return}x.buyerNote=r;x.status="Closed";x.steps.push(["Appeal denied",now]);x.unread=true}
saveSubs(s);render()});
function badge(){const n=subs().filter(x=>x.unread).length;$("#worknav").innerHTML="My Work"+(n?` <span class="tag inv" aria-label="${n} new updates">${n}</span>`:"")}
function seen(force){if(!force&&location.hash!=="#work")return;const s=subs();if(s.some(x=>x.unread)){s.forEach(x=>x.unread=false);saveSubs(s);badge()}}
window.addEventListener("hashchange",()=>seen());document.addEventListener("click",e=>{if(e.target.closest("#worknav"))seen(true)});
new IntersectionObserver(es=>{if(es.some(x=>x.isIntersecting))setTimeout(()=>seen(true),1500)}).observe(document.getElementById("worklist"));
document.addEventListener("click",e=>{if(e.target.closest("[data-x=export]")){const blob=new Blob([JSON.stringify({exported:new Date().toISOString(),profile:me(),submissions:subs()},null,1)],{type:"application/json"});const l=document.createElement("a");l.href=URL.createObjectURL(blob);l.download="pulsevault-history.json";l.click()}});
render();
