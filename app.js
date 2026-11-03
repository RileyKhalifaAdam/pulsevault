// PLACEHOLDER: replace with your real Formspree form URL, e.g. https://formspree.io/f/abcdwxyz
const CONTACT_ENDPOINT="https://formspree.io/f/YOUR_FORM_ID";
// PLACEHOLDER: set your real support inbox
const SUPPORT_EMAIL="support@pulsevault.example";
const CLAIM_MS=30*60*1000;
const ls={get:(k,d)=>{try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}},set:(k,v)=>localStorage.setItem(k,JSON.stringify(v))};
let LANG=ls.get("pv_lang","en")==="es"?"es":"en";
CALLS.forEach(c=>{if(typeof c.postedAt==="number"&&c.postedAt<1e11)c.postedAt=Date.now()-c.postedAt*36e5});
const posts=()=>ls.get("pv_posts",[]);
function board(){return posts().concat(CALLS)}
const findCall=id=>board().find(x=>x.id===id);
const me=()=>ls.get("pv_user",{scores:[],accepted:0});
const qualifies=()=>{const u=me();const r=u.scores.slice(-2);return (r.length===2&&r.every(s=>s>=4.5))||u.accepted>=5};
const claims=()=>ls.get("pv_claims",{}); // id -> expiry ms
const esc=s=>String(s??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch]);
// base = slots already taken by others (would come from the server); plus this user's claim
const taken=id=>{const c=findCall(id);return Math.min(c.slots,(c.taken||0)+(claims()[id]?1:0))};
const size=mb=>mb<1000?mb+" MB":(mb/1000)+" GB";
const $=s=>document.querySelector(s);
function fmt(ms){ms=Math.max(0,ms);const m=Math.floor(ms/60000),s=Math.floor(ms/1000)%60;return m+":"+String(s).padStart(2,"0")}
function due(h){const n=h>=48?Math.round(h/24):h,u=h>=48?(LANG==="es"?"d":"d"):(LANG==="es"?"h":"h");return LANG==="es"?`Vence en ${n} ${u}`:`Due in ${n}${u}`}
function addOpt(sel,val){if(!val||[...sel.options].some(o=>o.value===val))return;sel.add(new Option(val,val))}
function syncFilters(){const shot=$("#shot"),city=$("#city"),sv=shot.value,cv=city.value;board().forEach(c=>{c.tags.forEach(t=>{if(!["Sound","Hands"].includes(t))addOpt(shot,t)});addOpt(city,c.city)});shot.value=sv;city.value=cv}
const shots=[...new Set(board().flatMap(c=>c.tags))].filter(t=>!["Sound","Hands"].includes(t));
shots.forEach(t=>$("#shot").add(new Option(t,t)));[...new Set(board().map(c=>c.city))].forEach(t=>$("#city").add(new Option(t,t)));
const DEMO=new URLSearchParams(location.search).has("demo");
function status(){if(!DEMO){$("#status").innerHTML="";return}const u=me();$("#status").innerHTML=`<b>Demo profile</b> · recent scores: ${u.scores.slice(-2).join(", ")||"none"} · accepted files: ${u.accepted} · ${qualifies()?'<span style="color:var(--ok)">Invite calls unlocked</span>':"Invite calls locked"}
<div class="row"><button data-a="score">Add a 4.8 score</button><button data-a="acc">Add accepted file</button><button data-a="reset">Reset demo</button></div>`}
function postedLabel(ts){const hrs=Math.max(0,Math.round((Date.now()-(ts||Date.now()))/36e5));return LANG==="es"?`Publicado hace ${hrs} h`:`Posted ${hrs}h ago`}
function dur(sec){sec=Number(sec)||0;if(sec<60)return sec+"s";const m=sec/60;return (Number.isInteger(m)?String(m):m.toFixed(1))+" "+t("min")}
function render(){syncFilters();status();renderWork();renderProfile();renderBuyer();renderAlerts();badge();alertBadge();const q=$("#q").value.toLowerCase(),sh=$("#shot").value,ci=$("#city").value,so=$("#sort").value;
let L=board().filter(c=>matchCall(c,{q,shot:sh,city:ci}));
if(so==="pay")L=[...L].sort((a,b)=>b.pay-a.pay);else if(so==="due")L=[...L].sort((a,b)=>a.dueH-b.dueH);else L=[...L].sort((a,b)=>(b.postedAt||0)-(a.postedAt||0));
const cl=claims(),ok=qualifies();
$("#list").innerHTML=L.map(c=>{const mine=cl[c.id];const locked=c.invite&&!ok;
let act;if(locked)act=`<div class="note">🔒 Invite only. Opens after two recent scores at 4.5, or five accepted files. Upload is locked.</div>`;
else if(mine)act=`<span>${t("your_slot")} · <span class="timer" role="timer" data-exp="${mine}" data-id="${c.id}">${fmt(mine-Date.now())}</span> ${t("left")}</span><button data-a="rel" data-id="${c.id}">${t("release")}</button><button class="pri" data-a="up" data-id="${c.id}">${t("upload")}</button>`;
else act=taken(c.id)>=c.slots?`<span class="mute">${t("full")}</span>`:`<button class="pri" data-a="claim" data-id="${c.id}">${t("claim")}</button>`;
return `<article class="card"><div class="top"><div><div class="mute">${esc(c.city)} · ${c.you?esc(t("posted_by_you")):esc(c.buyer)}</div><h3 style="margin:4px 0">${esc(c.title)}</h3></div><div class="pay">$${c.pay}</div></div>
<p>${esc(c.desc)}</p>${c.night?`<div class="note">⚠️ Night shoot: stay somewhere public and well lit, don't trespass, and don't film anyone who objects. <a href="#safety">Safety tips</a></div>`:""}<div class="mute" style="font-size:13px">${t("file")}: ${dur(c.spec.minSec)} ${t("to")} ${dur(c.spec.maxSec)}, ${c.spec.orientation==="any"?t("orient_any"):c.spec.orientation}, ${t("up_to")} ${size(c.spec.maxMB)}</div><div class="mute" style="font-size:13px">${esc(c.license)}</div><div class="mute" style="font-size:13px">${esc(postedLabel(c.postedAt))}</div><div>${c.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join("")}${c.invite?`<span class="tag inv">${esc(t("invite"))}</span>`:""}<span class="tag">${esc(t("funded"))}</span><span class="tag">${esc(c.gear)}</span>${c.decision?`<span class="tag">${esc(t("decision"))} ${esc(c.decision)}</span>`:""}</div>
<div class="row mute" style="font-size:14px">★ ${esc(c.rating)} ${t("from")} ${esc(c.ratings)} · ${due(c.dueH)} · <b class="slots">${taken(c.id)} ${t("of")} ${c.slots}</b>${c.mount?" · "+esc(c.mount):""}</div><div class="row">${act}</div></article>`}).join("")||`<p class="mute">${t("no_match")}</p>`}
document.addEventListener("click",e=>{const b=e.target.closest("[data-a]");if(!b)return;const a=b.dataset.a,id=b.dataset.id,cl=claims(),u=me();
if(a==="claim"){const c=findCall(id);if(c.invite&&!qualifies())return;if(taken(id)>=c.slots){alert(t("full"));return}cl[id]=Date.now()+CLAIM_MS;ls.set("pv_claims",cl)}
if(a==="up"){openUpload(findCall(id));return}
if(a==="rel"){delete cl[id];ls.set("pv_claims",cl)}
if(!DEMO&&["score","acc","reset"].includes(a))return;if(a==="score"){u.scores.push(4.8);ls.set("pv_user",u)}if(a==="acc"){u.accepted++;ls.set("pv_user",u)}
if(a==="reset"){if(!confirm("Reset the demo? This erases your claims, scores and My Work history."))return;["pv_user","pv_claims","pv_subs"].forEach(k=>localStorage.removeItem(k))}render()});
["#q","#sort","#shot","#city"].forEach(s=>$(s).addEventListener("input",render));
setInterval(()=>{let expired=false;document.querySelectorAll(".timer").forEach(t=>{const left=+t.dataset.exp-Date.now();t.textContent=fmt(left);if(left>0&&Math.floor(left/1000)%300===0)$("#live").textContent=`${fmt(left)} left on your slot.`;if(left<=0){$("#live").textContent="Your slot timed out and was released.";const cl=claims();delete cl[t.dataset.id];ls.set("pv_claims",cl);expired=true}});if(expired)render()},1000);
$("#cf").addEventListener("submit",async e=>{e.preventDefault();const f=e.target,ticket="PV-"+Date.now().toString(36).toUpperCase().slice(-6);const fd=new FormData(f);fd.append("ticket",ticket);fd.append("_subject",`[${ticket}] ${fd.get("type")}`);
const m=$("#cfmsg");m.textContent="Sending…";let sent=false;if(!CONTACT_ENDPOINT.includes("YOUR_FORM_ID")){try{const r=await fetch(CONTACT_ENDPOINT,{method:"POST",body:fd,headers:{Accept:"application/json"}});sent=r.ok}catch{}}
m.innerHTML=sent?`Sent. Your ticket number is <b>${ticket}</b>.`:(CONTACT_ENDPOINT.includes("YOUR_FORM_ID")?`<b style="color:#e66">Not sent.</b> The contact form isn't connected yet, so nobody received this. For safety issues, please email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.`:`<b style="color:#e66">Not sent.</b> Something went wrong, so nobody received this. Please try again.`);if(sent)f.reset()});
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
if(ls.get("pv_how",false))$("#how").hidden=true;
$("#howdismiss").addEventListener("click",()=>{ls.set("pv_how",true);$("#how").hidden=true});

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
let consentOpener=null;
function openUpload(c){if(!c||c.invite&&!qualifies())return;upCall=c;const f=$("#cform");f.reset();$("#cerr").textContent="";$("#clic").textContent=c.license;$("#cspec").textContent=`${c.title}: ${dur(c.spec.minSec)} ${t("to")} ${dur(c.spec.maxSec)}, ${c.spec.orientation==="any"?t("orient_any"):c.spec.orientation}, ${t("up_to")} ${size(c.spec.maxMB)}.`;consentOpener=document.activeElement;const dlg=$("#consent");dlg.showModal();const first=dlg.querySelector("input,button");if(first)first.focus()}
function probe(file){return new Promise(res=>{const v=document.createElement("video");v.preload="metadata";v.onloadedmetadata=()=>{res({dur:v.duration,w:v.videoWidth,h:v.videoHeight});URL.revokeObjectURL(v.src)};v.onerror=()=>res(null);v.src=URL.createObjectURL(file)})}
async function checkFile(c,file){const s=c.spec,e=[];if(!file.type.startsWith("video/"))e.push("That isn't a video file.");if(file.size>s.maxMB*1e6)e.push(`It's ${(file.size/1e9).toFixed(1)} GB; the limit is ${size(s.maxMB)}.`);
const m=e.length?null:await probe(file);if(!e.length&&!m)return{errs:[],manual:true};
if(m){if(m.dur<s.minSec)e.push(`It's ${Math.round(m.dur)}s; the call needs at least ${s.minSec}s.`);if(m.dur>s.maxSec)e.push(`It's ${Math.round(m.dur/60)} min; the limit is ${s.maxSec/60} min.`);if(s.orientation==="landscape"&&m.h>m.w)e.push("It's vertical; this call needs a landscape (sideways) video.");if(s.orientation==="vertical"&&m.w>m.h)e.push("It's sideways; this call needs a vertical video.")}return{errs:e,manual:false}}
$("#cgo").addEventListener("click",async e=>{e.preventDefault();const f=$("#cform");if(!f.reportValidity())return;const file=$("#cfile").files[0];$("#cerr").textContent="Checking…";const chk=await checkFile(upCall,file),errs=chk.errs;if(errs.length){$("#cerr").textContent=errs.join(" ");return}
$("#consent").close();addSub(upCall,file.name,{license:upCall.license,consentAt:Date.now()},chk.manual);render();location.hash="work";$("#live").textContent=`Uploaded ${file.name} for ${upCall.title}. It's in review.`});

// ---- Contributor profile: level, stats, specialties ----
function level(u){const sc=u.scores,avg=sc.length?sc.reduce((x,y)=>x+y,0)/sc.length:0;const since=Date.now()-90*864e5,recent=subs().filter(x=>x.status==="Paid"&&x.steps.some(([n,t])=>n==="Accepted"&&t>=since)),paid=recent.reduce((t,x)=>t+x.pay,0);if(recent.length>=20&&paid>=3000&&avg>=4.7)return["Pro","20+ accepted files and $3,000+ in the last 90 days, with a 4.7+ average"];if(qualifies())return["Rated","Unlocks invite-only calls"];return["New","Two scores of 4.5+ or five accepted files moves you to Rated"]}
function renderProfile(){const u=me(),s=subs(),sc=u.scores,avg=sc.length?(sc.reduce((x,y)=>x+y,0)/sc.length).toFixed(1):"none yet";const[lv,why]=level(u);
const tags={};s.filter(x=>x.status==="Paid").forEach(x=>{const c=findCall(x.callId);c&&c.tags.filter(t=>!["Sound","Hands"].includes(t)).forEach(t=>tags[t]=(tags[t]||0)+1)});
const spec=Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([t])=>`<span class="tag">${esc(t)}</span>`).join("")||'<span class="mute">Shows up after your first accepted file</span>';
const earned=s.filter(x=>x.status==="Paid").reduce((t,x)=>t+x.pay,0);
$("#prof").innerHTML=`<div class="row"><span class="tag inv" style="font-size:15px">${lv}</span><span class="mute">${why}</span></div>
<div class="row" style="gap:24px"><div><b>${avg}</b><div class="mute">avg score</div></div><div><b>${u.accepted}</b><div class="mute">accepted files</div></div><div><b>${s.filter(x=>x.status==="In review"||x.status==="Appealed").length}</b><div class="mute">pending</div></div><div><b>$${earned}</b><div class="mute">earned (demo)</div></div></div>
<div>Specialties: ${spec}</div><p class="mute" style="font-size:12px">Demo note: badges and stats are worked out in this browser and can be edited. In the real product they have to come from the server.</p>
<div class="card" id="payoutbox"><h3>${t("pay_h")}</h3><p class="note">${t("pay_note")}</p>
<form id="payform"><label><input type="radio" name="pkind" value="paypal" ${u.payoutKind==="paypal"?"checked":""}> ${t("paypal")}</label>
<label><input type="radio" name="pkind" value="bank" ${u.payoutKind==="bank"?"checked":""}> ${t("bank")}</label>
<label>${t("last4")}<input id="plast4" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="1234"></label>
<p id="payerr" role="alert" style="color:#e66"></p><button class="pri" type="submit">${t("pay_save")}</button></form>
<p class="mute">${t("pay_now")}: ${esc(u.payout||t("pay_none"))}</p></div>`}

// ---- Buyer review screen ----
function renderBuyer(){const flag=$("#buyerflag");if(!DEMO){flag.innerHTML="";$("#buyer").innerHTML='<p class="mute">Buyers sign in to review files. Sign-in isn\'t built yet, so this screen is only available in the demo.</p>';return}flag.innerHTML='<div class="buyer-only" role="status">🧪 Buyer-only demo. Without a sign-in, anyone with the demo link could score their own files. Not for real use.</div>';const s=subs().filter(x=>x.status==="In review"||x.status==="Appealed");
$("#buyer").innerHTML=(s.length?s.map(x=>{const c=findCall(x.callId)||{spec:{minSec:0,maxSec:0,orientation:""}};
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
function badge(){const n=subs().filter(x=>x.unread).length;$("#worknav").innerHTML=t("nav_work")+(n?` <span class="tag inv" aria-label="${n}">${n}</span>`:"")}
function seen(force){if(!force&&location.hash!=="#work")return;const s=subs();if(s.some(x=>x.unread)){s.forEach(x=>x.unread=false);saveSubs(s);badge()}}
window.addEventListener("hashchange",()=>{seen();renderAlerts();alertBadge()});document.addEventListener("click",e=>{if(e.target.closest("#worknav"))seen(true)});
new IntersectionObserver(es=>{if(es.some(x=>x.isIntersecting))setTimeout(()=>seen(true),1500)}).observe(document.getElementById("worklist"));
document.addEventListener("click",e=>{if(e.target.closest("[data-x=export]")){const blob=new Blob([JSON.stringify({exported:new Date().toISOString(),profile:me(),submissions:subs()},null,1)],{type:"application/json"});const l=document.createElement("a");l.href=URL.createObjectURL(blob);l.download="pulsevault-history.json";l.click()}});
const I18N={en:{
how_title:"How it works",dismiss:"Dismiss",how_1:"Claim a slot",how_2:"Upload within 30 minutes",how_3:"Get paid after review",
c_title:"Before you upload",c_lic:"I agree to the license on this call:",c_faces:"Everyone who can be recognized in this video agreed to be filmed, or their faces are out of frame or blurred.",c_own:"I shot this myself and I own it.",cancel:"Cancel",check:"Check and upload",
posted_by_you:"Posted by you (demo)",claim:"Claim a slot",upload:"Upload file",release:"Release",full:"Full",funded:"Funded",invite:"Invite",your_slot:"Your slot",left:"left",file:"File",to:"to",min:"min",of:"of",from:"from",up_to:"up to",decision:"Decision in",no_match:"No calls match.",
nav_calls:"Calls",nav_alerts:"Alerts",nav_post:"Post",nav_profile:"Profile",nav_work:"My Work",nav_help:"Help",nav_contact:"Contact",calls_h:"Open calls",calls_sub:"Browse. Send a file. Get paid.",
alerts_h:"Saved searches",search_name:"Name this search",search_ph:"Name this search",save_search:"Save search",delete:"Delete",no_searches:"No saved searches yet.",any:"Any text",any_shot:"Any shot",any_city:"Any city",need_name:"Name this search first.",saved:"Saved in this browser.",
post_h:"Post a call",post_note:"Demo only. This call stays in this browser. Nothing is sent or paid.",f_title:"Title",f_pay:"Pay (USD, minimum $20)",f_city:"City",f_min:"Min seconds",f_max:"Max seconds",f_orient:"Orientation",f_mb:"Max MB",f_lic:"License",f_slots:"Slots",f_add:"Add to the board",orient_any:"Any",orient_v:"Vertical",orient_l:"Landscape",
post_bad_pay:"Pay must be at least $20.",post_bad_spec:"Check the seconds, file size, and slots.",post_ok:"Added to the board in this browser.",
pay_h:"Payout settings",pay_note:"Demo only. Nothing is stored on a server or sent. This choice stays in this browser. We never ask for or save a full account number.",paypal:"PayPal",bank:"Bank",last4:"Last 4 digits only (optional)",pay_save:"Save in this browser",pay_now:"Saved choice",pay_none:"None yet",pay_bad:"Enter only the last 4 digits, or leave this blank. Full account numbers are not saved.",pay_pick:"Choose PayPal or bank."
},es:{
how_title:"Cómo funciona",dismiss:"Cerrar",how_1:"Reclama un cupo",how_2:"Sube el archivo en 30 minutos",how_3:"Te pagan después de la revisión",
c_title:"Antes de subir",c_lic:"Acepto la licencia de este llamado:",c_faces:"Quien se pueda reconocer en este video aceptó ser filmado, o su cara está fuera de cuadro o borrosa.",c_own:"Lo grabé yo y es mío.",cancel:"Cancelar",check:"Revisar y subir",
posted_by_you:"Publicado por ti (demo)",claim:"Reclama un cupo",upload:"Sube el archivo",release:"Liberar",full:"Lleno",funded:"Con fondos",invite:"Invitación",your_slot:"Tu cupo",left:"restantes",file:"Archivo",to:"a",min:"min",of:"de",from:"de",up_to:"hasta",decision:"Decisión en",no_match:"Ningún llamado coincide.",
nav_calls:"Llamados",nav_alerts:"Alertas",nav_post:"Publicar",nav_profile:"Perfil",nav_work:"Mi trabajo",nav_help:"Ayuda",nav_contact:"Contacto",calls_h:"Llamados abiertos",calls_sub:"Mira. Envía un archivo. Te pagan.",
alerts_h:"Búsquedas guardadas",search_name:"Nombre de esta búsqueda",search_ph:"Nombre de esta búsqueda",save_search:"Guardar búsqueda",delete:"Borrar",no_searches:"Todavía no hay búsquedas guardadas.",any:"Cualquier texto",any_shot:"Cualquier plano",any_city:"Cualquier ciudad",need_name:"Primero ponle un nombre a la búsqueda.",saved:"Guardado en este navegador.",
post_h:"Publicar un llamado",post_note:"Solo demo. Este llamado se queda en este navegador. No se envía ni se paga.",f_title:"Título",f_pay:"Pago (USD, mínimo $20)",f_city:"Ciudad",f_min:"Mínimo de segundos",f_max:"Máximo de segundos",f_orient:"Orientación",f_mb:"MB máx.",f_lic:"Licencia",f_slots:"Cupos",f_add:"Agregar al tablero",orient_any:"Cualquiera",orient_v:"Vertical",orient_l:"Horizontal",
post_bad_pay:"El pago tiene que ser de al menos $20.",post_bad_spec:"Revisa los segundos, el tamaño y los cupos.",post_ok:"Agregado al tablero en este navegador.",
pay_h:"Datos de pago",pay_note:"Solo demo. Nada se guarda en un servidor ni se envía. Esta elección se queda en este navegador. Nunca pedimos ni guardamos un número de cuenta completo.",paypal:"PayPal",bank:"Banco",last4:"Solo los últimos 4 dígitos (opcional)",pay_save:"Guardar en este navegador",pay_now:"Elección guardada",pay_none:"Todavía ninguna",pay_bad:"Escribe solo los últimos 4 dígitos, o déjalo en blanco. No se guardan números de cuenta completos.",pay_pick:"Elige PayPal o banco."
}};
function t(k){return (I18N[LANG]&&I18N[LANG][k])||I18N.en[k]||k}
function applyStatic(){document.documentElement.lang=LANG;document.querySelectorAll("[data-i]").forEach(el=>{el.textContent=t(el.dataset.i)});const b=$("#langbtn");b.textContent=LANG==="es"?"EN":"ES";b.setAttribute("aria-pressed",LANG==="es"?"true":"false");b.setAttribute("aria-label",LANG==="es"?"Cambiar a inglés":"Switch to Spanish");$("#savename").placeholder=t("search_ph")}
const searches=()=>ls.get("pv_searches",[]);
function matchCall(c,f){const q=(f.q||"").toLowerCase();return (!q||(c.title+" "+c.desc+" "+c.buyer).toLowerCase().includes(q))&&(!f.shot||(c.tags||[]).includes(f.shot))&&(!f.city||c.city===f.city)}
function alertCount(){return searches().reduce((n,f)=>n+board().filter(c=>matchCall(c,f)&&c.postedAt>f.seenAt).length,0)}
function alertBadge(){const n=alertCount();$("#alertsnav").innerHTML=t("nav_alerts")+(n?` <span class="tag inv" aria-label="${n}">${n}</span>`:"")}
function renderAlerts(){const s=searches();const rows=s.map(f=>({f,fresh:board().filter(c=>matchCall(c,f)&&c.postedAt>f.seenAt)}));
$("#alertlist").innerHTML=rows.length?rows.map(({f,fresh})=>`<div class="row"><b>${esc(f.name)}</b><span class="mute">${esc(f.q||t("any"))} · ${esc(f.shot||t("any_shot"))} · ${esc(f.city||t("any_city"))}${fresh.length?` · ${fresh.length}`:""}</span><button type="button" data-s="del" data-id="${esc(f.id)}">${t("delete")}</button></div>`).join(""):`<p class="mute">${t("no_searches")}</p>`;
if(location.hash==="#alerts"&&rows.some(r=>r.fresh.length)){s.forEach(f=>f.seenAt=Date.now());ls.set("pv_searches",s);alertBadge()}}
$("#savesearch").addEventListener("click",()=>{const name=$("#savename").value.trim();const msg=$("#savemsg");if(!name){msg.textContent=t("need_name");return}const s=searches();s.unshift({id:"Q"+Date.now().toString(36),name,q:$("#q").value,shot:$("#shot").value,city:$("#city").value,seenAt:Date.now()});ls.set("pv_searches",s);$("#savename").value="";msg.textContent=t("saved");render()});
document.addEventListener("click",e=>{const b=e.target.closest("[data-s=del]");if(!b)return;ls.set("pv_searches",searches().filter(f=>f.id!==b.dataset.id));render()});
$("#postform").addEventListener("submit",e=>{e.preventDefault();const err=$("#posterr");err.textContent="";const title=$("#ptitle").value.trim(),pay=Number($("#ppay").value),city=$("#pcity").value.trim(),min=Number($("#pmin").value),max=Number($("#pmax").value),mb=Number($("#pmb").value),slots=Number($("#pslots").value),orientation=$("#porient").value,license=$("#plic").value.trim();
if(!Number.isFinite(pay)||pay<20){err.textContent=t("post_bad_pay");return}if(!(max>min)||min<1||mb<1||!Number.isInteger(slots)||slots<1){err.textContent=t("post_bad_spec");return}
const call={id:"p"+Date.now().toString(36),you:true,buyer:"You",title,desc:t("post_note"),license,tags:["Phone"],city,pay,mount:"",rating:"—",ratings:0,dueH:72,slots,gear:"Phone only",decision:"",invite:false,setting:"",spec:{minSec:min,maxSec:max,orientation,maxMB:mb},night:false,postedAt:Date.now()};
const all=posts();all.unshift(call);ls.set("pv_posts",all);e.target.reset();$("#live").textContent=t("post_ok");location.hash="calls";render()});
document.addEventListener("submit",e=>{if(e.target.id!=="payform")return;e.preventDefault();const u=me(),kind=(new FormData(e.target).get("pkind")||"");const raw=$("#plast4").value.trim();const box=$("#payerr");
if(kind!=="paypal"&&kind!=="bank"){box.textContent=t("pay_pick");return}
if(raw&&!/^\d{4}$/.test(raw)){box.textContent=t("pay_bad");$("#plast4").value="";return}
u.payoutKind=kind;u.payout=kind==="paypal"?"PayPal":(raw?"Bank ••••"+raw:"Bank");delete u.account;delete u.accountNumber;delete u.routing;delete u.email;ls.set("pv_user",u);$("#plast4").value="";render()});
$("#langbtn").addEventListener("click",()=>{LANG=LANG==="es"?"en":"es";ls.set("pv_lang",LANG);applyStatic();render()});
const consentDlg=$("#consent");
consentDlg.addEventListener("close",()=>{if(consentOpener&&consentOpener.focus)consentOpener.focus()});
consentDlg.addEventListener("keydown",e=>{if(e.key==="Escape"){e.preventDefault();consentDlg.close();return}if(e.key!=="Tab")return;const f=[...consentDlg.querySelectorAll("button,input,select,textarea")].filter(el=>!el.disabled);if(!f.length)return;const i=f.indexOf(document.activeElement);if(e.shiftKey&&i<=0){e.preventDefault();f[f.length-1].focus()}else if(!e.shiftKey&&i===f.length-1){e.preventDefault();f[0].focus()}});
applyStatic();
render();
