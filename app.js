(function(){
"use strict";
const $=id=>document.getElementById(id);
const WX=["sonnig","klar","leicht bewölkt","bewölkt","Nebel","Nieselregen","Regen","Schnee","Gewitter"];
const ROAD=["trocken","nass","Schneefahrbahn","eisglatt"];
const HOME={lat:47.41,lon:9.74}; // Vorarlberg: Ersatzwert, falls gar kein Standort da ist
const LS="l17-fahrtenbuch-v1";
let state={settings:{name:"",phone:"",birth:"",plate:""},trips:[],active:null};
let draftStart=null,draftEnd=null;

/* ---------------- Hilfsfunktionen ---------------- */
const pad=n=>String(n).padStart(2,"0");
const fmtKm=n=>(n||0).toLocaleString("de-DE")+" km";
const fmtDate=d=>pad(d.getDate())+"."+pad(d.getMonth()+1)+"."+d.getFullYear();
const fmtTime=d=>pad(d.getHours())+":"+pad(d.getMinutes());
const parseKm=v=>{const n=parseInt(String(v==null?"":v).replace(/[^\d]/g,""),10);return isFinite(n)?n:null};
function toast(msg){const t=$("toast");t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,3500)}
function setStatus(el,txt,cls){el.textContent=txt;el.className="status"+(cls?" "+cls:"")}

/* ---------------- Speicher (nur dieses Gerät) ---------------- */
function save(){try{localStorage.setItem(LS,JSON.stringify(state))}catch(e){toast("Speichern fehlgeschlagen – ist der Speicher voll?")}}
function load(){try{const s=JSON.parse(localStorage.getItem(LS)||"null");if(s){state.settings={...state.settings,...s.settings};state.trips=s.trips||[];state.active=s.active||null}}catch(e){}}
if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{});

/* ---------------- Sonnenstand → Tageszeit ---------------- */
function sunElevation(date,lat,lon){
  const rad=Math.PI/180,d=date.getTime()/86400000-10957.5;
  const g=(357.529+0.98560028*d)*rad,q=280.459+0.98564736*d;
  const L=(q+1.915*Math.sin(g)+0.020*Math.sin(2*g))*rad,e=(23.439-0.00000036*d)*rad;
  const ra=Math.atan2(Math.cos(e)*Math.sin(L),Math.cos(L)),dec=Math.asin(Math.sin(e)*Math.sin(L));
  const gmst=(18.697374558+24.06570982441908*d)%24,ha=(gmst*15+lon)*rad-ra;
  return Math.asin(Math.sin(lat*rad)*Math.sin(dec)+Math.cos(lat*rad)*Math.cos(dec)*Math.cos(ha))/rad;
}
function daytime(date,gps){const p=gps||HOME;const el=sunElevation(date,p.lat,p.lon);return el>0?"Tag":el>-6?"Dämmerung":"Nacht"}

/* ---------------- GPS ---------------- */
function getPosition(){
  return new Promise(res=>{
    if(!navigator.geolocation)return res(null);
    navigator.geolocation.getCurrentPosition(
      p=>res({lat:p.coords.latitude,lon:p.coords.longitude,acc:Math.round(p.coords.accuracy)}),
      ()=>res(null),{enableHighAccuracy:true,timeout:20000,maximumAge:5000});
  });
}
async function placeName(gps){
  if(!gps)return null;
  try{
    const r=await fetch("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=de&lat="+gps.lat.toFixed(5)+"&lon="+gps.lon.toFixed(5));
    if(!r.ok)return null;const j=await r.json(),a=j.address||{};
    return a.village||a.town||a.city||a.municipality||a.suburb||a.hamlet||a.county||null;
  }catch(e){return null}
}

/* ---------------- EXIF (Zeit + GPS aus dem Foto, als Reserve) ---------------- */
function parseExif(buf){
  const v=new DataView(buf),none={when:null,gps:null};
  if(v.byteLength<4||v.getUint16(0)!==0xFFD8)return none;
  let o=2;while(o<v.byteLength-10){const mk=v.getUint16(o),len=v.getUint16(o+2);
    if(mk===0xFFE1&&v.getUint32(o+4)===0x45786966)return readTiff(o+10);
    if((mk&0xFF00)!==0xFF00)break;o+=2+len}
  return none;
  function readTiff(t){const le=v.getUint16(t)===0x4949,u16=x=>v.getUint16(x,le),u32=x=>v.getUint32(x,le);
    const ifd=x=>{const n=u16(t+x),e={};for(let i=0;i<n;i++){const a=t+x+2+i*12;e[u16(a)]={type:u16(a+2),count:u32(a+4),off:a+8}}return e};
    const val=en=>{if(!en)return null;const sz={2:1,5:8}[en.type]||4,p=en.count*sz>4?t+u32(en.off):en.off;
      if(en.type===2){let s="";for(let i=0;i<en.count-1;i++)s+=String.fromCharCode(v.getUint8(p+i));return s}
      if(en.type===5){const r=[];for(let i=0;i<en.count;i++)r.push(u32(p+i*8)/u32(p+i*8+4));return r}
      return en.type===3?u16(en.off):u32(en.off)};
    const out={when:null,gps:null},ifd0=ifd(u32(t+4));
    if(ifd0[0x8769]){const ex=ifd(val(ifd0[0x8769])),s=val(ex[0x9003])||val(ex[0x9004]);
      const m=s&&s.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);if(m)out.when=new Date(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6])}
    if(ifd0[0x8825]){const g=ifd(val(ifd0[0x8825])),la=val(g[2]),lo=val(g[4]);
      if(la&&lo){const dms=a=>a[0]+a[1]/60+a[2]/3600;let lat=dms(la),lon=dms(lo);if(val(g[1])==="S")lat=-lat;if(val(g[3])==="W")lon=-lon;if(lat||lon)out.gps={lat,lon}}}
    return out}
}
async function readPhoto(file){
  let ex={when:null,gps:null};
  try{ex=parseExif(await file.slice(0,262144).arrayBuffer())}catch(e){}
  let when=ex.when;
  // Frisch aufgenommen → jetzt; aus der Galerie → Aufnahmezeit aus dem Foto
  if(!(when instanceof Date)||isNaN(when)||Math.abs(Date.now()-when)>3*86400000)when=new Date();
  return {when,exifGps:ex.gps,url:URL.createObjectURL(file)};
}

/* ---------------- Kilometerstand lesen (Texterkennung auf dem Handy) ---------------- */
let ocrWorker=null;
async function getWorker(){
  if(ocrWorker)return ocrWorker;
  if(!window.Tesseract)throw new Error("no-ocr");
  ocrWorker=await Tesseract.createWorker("eng");
  await ocrWorker.setParameters({tessedit_char_whitelist:"0123456789 ",tessedit_pageseg_mode:"11"});
  return ocrWorker;
}
function prepImage(url,invert){
  return new Promise((res,rej)=>{const im=new Image();im.onload=()=>{
    const s=Math.min(1,1400/Math.max(im.width,im.height)),c=document.createElement("canvas");
    c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);const x=c.getContext("2d");x.drawImage(im,0,0,c.width,c.height);
    const d=x.getImageData(0,0,c.width,c.height),p=d.data;let sum=0;
    for(let i=0;i<p.length;i+=4){const g=0.299*p[i]+0.587*p[i+1]+0.114*p[i+2];p[i]=p[i+1]=p[i+2]=g;sum+=g}
    const mean=sum/(p.length/4),inv=invert==null?mean<110:invert;
    for(let i=0;i<p.length;i+=4){let g=p[i];g=(g-mean)*1.8+128;if(inv)g=255-g;g=g<0?0:g>255?255:g;p[i]=p[i+1]=p[i+2]=g}
    x.putImageData(d,0,0);res({canvas:c,inverted:inv})};im.onerror=rej;im.src=url});
}
function pickKm(texts,ref){
  const cands=new Set();
  for(const t of texts){
    (t.match(/\d{4,7}/g)||[]).forEach(n=>cands.add(+n));
    (t.match(/\d{1,3}[ .]\d{3}/g)||[]).forEach(n=>cands.add(+n.replace(/\D/g,"")));
  }
  let list=[...cands].filter(n=>n>=100);
  if(!list.length)return null;
  if(ref!=null){
    const ok=list.filter(n=>n>=ref&&n-ref<2000).sort((a,b)=>a-b);
    if(ok.length)return {km:ok[0],sure:true};
    return {km:list.sort((a,b)=>Math.abs(a-ref)-Math.abs(b-ref))[0],sure:false};
  }
  return {km:list.sort((a,b)=>String(b).length-String(a).length||b-a)[0],sure:false};
}
async function ocrKm(url,statusEl,inputEl,ref){
  setStatus(statusEl,"Lese Kilometerstand vom Foto…");
  try{
    const w=await getWorker();
    const a=await prepImage(url,null),r1=await w.recognize(a.canvas);
    const texts=[r1.data.text];
    let hit=pickKm(texts,ref);
    if(!hit||!hit.sure){const b=await prepImage(url,!a.inverted),r2=await w.recognize(b.canvas);texts.push(r2.data.text);hit=pickKm(texts,ref)}
    if(hit&&!inputEl.value){inputEl.value=hit.km;inputEl.dispatchEvent(new Event("input"))}
    if(hit)setStatus(statusEl,(hit.sure?"Erkannt: ":"Vermutlich: ")+fmtKm(hit.km)+" – bitte mit dem Foto vergleichen.",hit.sure?"ok":"warn");
    else setStatus(statusEl,"Nicht lesbar. Bitte eintippen (Foto antippen zum Vergrößern).","warn");
  }catch(e){setStatus(statusEl,"Texterkennung nicht verfügbar. Bitte eintippen.","warn")}
}
function lastKm(plate){const t=state.trips.filter(x=>x.plate===plate);return t.length?Math.max(...t.map(x=>x.kmTo)):null}

/* ---------------- Wetter (Open-Meteo) ---------------- */
function wmo(code,isDay){
  if(code==null)return null;
  if(code>=95)return "Gewitter";
  if((code>=71&&code<=77)||code===85||code===86)return "Schnee";
  if((code>=61&&code<=67)||(code>=80&&code<=82))return "Regen";
  if(code>=51&&code<=57)return "Nieselregen";
  if(code===45||code===48)return "Nebel";
  if(code===3)return "bewölkt";
  if(code===2)return "leicht bewölkt";
  return isDay?"sonnig":"klar";
}
const WX_RANK={"Gewitter":8,"Schnee":7,"Regen":6,"Nieselregen":5,"Nebel":4,"bewölkt":3,"leicht bewölkt":2,"sonnig":1,"klar":1};
async function fetchWeather(points,startMs,endMs){
  const pts=points.filter(Boolean);if(!pts.length)return null;
  const url="https://api.open-meteo.com/v1/forecast?latitude="+pts.map(p=>p.lat.toFixed(3)).join(",")+"&longitude="+pts.map(p=>p.lon.toFixed(3)).join(",")+
    "&hourly=weather_code,temperature_2m,precipitation,snowfall,snow_depth,is_day&past_days=1&forecast_days=1&timezone=GMT&timeformat=unixtime";
  const r=await fetch(url);if(!r.ok)throw new Error("wx");let j=await r.json();if(!Array.isArray(j))j=[j];
  const from=startMs-2*3600e3,to=endMs+3600e3; // 2 Stunden vorher zählen für nasse Fahrbahn mit
  let wx=null,precip=0,snow=0,depth=0,tmin=99,tnow=null,hours=0;
  j.forEach(loc=>{const h=loc.hourly;h.time.forEach((t,i)=>{const ms=t*1000;if(ms<from||ms>to)return;
    const inTrip=ms>=startMs-3600e3;
    if(inTrip){const w=wmo(h.weather_code[i],h.is_day[i]);if(w&&(!wx||WX_RANK[w]>WX_RANK[wx]))wx=w;tnow=h.temperature_2m[i];hours++}
    precip+=h.precipitation[i]||0;snow+=h.snowfall[i]||0;depth=Math.max(depth,h.snow_depth[i]||0);tmin=Math.min(tmin,h.temperature_2m[i]);
  })});
  if(!hours)return null;
  let road="trocken";
  if(snow>0.2||(depth>0.02&&tmin<=1))road="Schneefahrbahn";
  else if(precip>0.2)road=tmin<=0?"eisglatt":"nass";
  return {wx,road,temp:tnow,tmin,precip};
}

/* ---------------- Anzeige ---------------- */
function odo(el,km){el.innerHTML="";String(km).padStart(6,"0").split("").forEach(c=>{const s=document.createElement("span");s.textContent=c;el.append(s)});const u=document.createElement("span");u.className="unit";u.textContent="km";el.append(u)}
function chips(el,list,sel,onPick){el.innerHTML="";list.forEach(v=>{const b=document.createElement("button");b.type="button";b.className="chip";b.textContent=v;b.setAttribute("aria-pressed",String(sel.includes(v)));b.onclick=()=>onPick(v);el.append(b)})}
document.querySelectorAll(".photo img").forEach(im=>im.onclick=()=>im.classList.toggle("big"));

function render(){
  const total=state.trips.reduce((s,t)=>s+(t.kmTo-t.kmFrom),0);
  $("totalKm").textContent=fmtKm(total);
  $("totalMeta").textContent=state.trips.length+" Fahrten · "+(total>=3000?"3.000 km erreicht":"noch "+fmtKm(3000-total)+" bis 3.000");
  $("barFill").style.width=Math.min(100,total/30)+"%";$("bar").setAttribute("aria-valuenow",total);
  $("chipStd").textContent=state.settings.plate?"Standard · "+state.settings.plate:"Standard (noch nicht festgelegt)";
  const act=state.active;$("startCard").hidden=!!act;$("activeCard").hidden=!act;
  if(act){odo($("odoActive"),act.kmFrom);const d=new Date(act.start);$("actTime").textContent=fmtDate(d)+", "+fmtTime(d)+" · "+act.daytime;$("actPlate").textContent=act.plate||"–";$("actPlace").textContent=act.placeFrom||"unbekannt"}
  const log=$("log");log.innerHTML="";
  if(!state.trips.length){const e=document.createElement("div");e.className="empty";e.textContent="Noch keine Fahrten. Starte oben mit einem Foto vom Kilometerstand – jede gespeicherte Fahrt wird eine Zeile im Fahrtenprotokoll.";log.append(e);return}
  [...state.trips].reverse().forEach(t=>{
    const d=new Date(t.start),it=document.createElement("div");it.className="item";
    it.innerHTML='<div class="date"></div><div class="main"><div class="route"></div><div class="muted small meta"></div></div><div class="km"></div><button class="linkish edit" type="button">Bearbeiten</button>';
    it.querySelector(".date").innerHTML=pad(d.getDate())+"."+pad(d.getMonth()+1)+".<small>"+d.getFullYear()+"</small>";
    it.querySelector(".route").textContent=t.route||"(Strecke fehlt)";
    it.querySelector(".meta").textContent=[t.plate,t.daytime,t.weather,t.kmFrom+"–"+t.kmTo].filter(Boolean).join(" · ");
    it.querySelector(".km").textContent=(t.kmTo-t.kmFrom)+" km";
    it.querySelector(".edit").onclick=()=>editTrip(t,it);
    log.append(it);
  });
}
function editTrip(t,it){
  const f=document.createElement("div");f.className="edit stack";f.style.paddingTop="8px";
  const fld=(k,lab)=>'<div class="field"><label class="label" for="e_'+k+'">'+lab+'</label><input id="e_'+k+'"></div>';
  f.innerHTML='<div class="row">'+fld("from","km von")+fld("to","km bis")+'</div><div class="row">'+fld("date","Datum")+fld("dt","Tageszeit")+'</div>'+fld("pl","Kennzeichen")+fld("rt","Fahrtstrecke / -ziel")+fld("wx","Straßenzustand, Witterung")+
    '<div class="row"><button class="btn primary" type="button">Speichern</button><button class="btn danger" type="button">Fahrt löschen</button></div>';
  it.querySelector(".edit").replaceWith(f);
  const q=k=>f.querySelector("#e_"+k);
  q("from").value=t.kmFrom;q("to").value=t.kmTo;q("date").value=fmtDate(new Date(t.start));q("dt").value=t.daytime||"";q("pl").value=t.plate||"";q("rt").value=t.route||"";q("wx").value=t.weather||"";
  const [bSave,bDel]=f.querySelectorAll("button");
  bSave.onclick=()=>{const a=parseKm(q("from").value),b=parseKm(q("to").value);if(a==null||b==null||b<=a){toast("„km bis“ muss größer als „km von“ sein.");return}
    const m=q("date").value.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);if(m){const d=new Date(t.start);d.setFullYear(+m[3],m[2]-1,+m[1]);t.start=d.getTime()}
    Object.assign(t,{kmFrom:a,kmTo:b,daytime:q("dt").value.trim(),plate:q("pl").value.trim().toUpperCase(),route:q("rt").value.trim(),weather:q("wx").value.trim()});
    state.trips.sort((x,y)=>x.start-y.start);save();render();toast("Gespeichert")};
  let armed=false;bDel.onclick=()=>{if(!armed){armed=true;bDel.textContent="Wirklich löschen?";return}
    state.trips=state.trips.filter(x=>x!==t);save();render();toast("Fahrt gelöscht")};
}

/* ---------------- Einstellungen + Sicherung ---------------- */
$("btnSettings").onclick=()=>{const s=state.settings;$("sName").value=s.name;$("sPhone").value=s.phone;$("sBirth").value=s.birth;$("sPlate").value=s.plate;$("settings").hidden=false;$("settings").scrollIntoView({behavior:"smooth"})};
$("btnCloseSettings").onclick=()=>$("settings").hidden=true;
$("btnSaveSettings").onclick=()=>{state.settings={name:$("sName").value.trim(),phone:$("sPhone").value.trim(),birth:$("sBirth").value.trim(),plate:$("sPlate").value.trim().toUpperCase()};save();$("settings").hidden=true;render();toast("Daten gespeichert")};
$("btnBackup").onclick=()=>deliver(new Blob([JSON.stringify(state,null,1)],{type:"application/json"}),"L17-Sicherung-"+fmtDate(new Date()).replace(/\./g,"-")+".json");
$("btnRestore").onclick=()=>$("fileRestore").click();
$("fileRestore").onchange=async e=>{const f=e.target.files[0];e.target.value="";if(!f)return;
  try{const s=JSON.parse(await f.text());if(!Array.isArray(s.trips))throw 0;state={settings:{...state.settings,...s.settings},trips:s.trips,active:s.active||null};save();render();toast(s.trips.length+" Fahrten geladen")}
  catch(err){toast("Diese Datei ist keine gültige Sicherung.")}};

async function deliver(blob,name){
  const file=new File([blob],name,{type:blob.type});
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    try{await navigator.share({files:[file],title:name});return}catch(e){if(e&&e.name==="AbortError")return}
  }
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),10000);
}

/* ---------------- Fahrt starten ---------------- */
let plateMode="std";
$("plateChips").onclick=e=>{const b=e.target.closest(".chip");if(!b)return;plateMode=b.dataset.p;
  [...$("plateChips").children].forEach(c=>c.setAttribute("aria-pressed",String(c===b)));$("plateOther").hidden=plateMode!=="other";if(plateMode==="other")$("plateOther").focus()};
let gpsStartP=null;
$("btnPhotoStart").onclick=()=>{$("fileStart").click();gpsStartP=getPosition()};
$("fileStart").onchange=async e=>{const f=e.target.files[0];e.target.value="";if(!f)return;
  const ph=await readPhoto(f);draftStart={...ph,gps:null,place:null};
  $("imgStart").src=ph.url;$("imgStart").classList.remove("big");$("kmStart").value="";
  $("factWhen").textContent=fmtDate(ph.when)+", "+fmtTime(ph.when);$("factDaytime").textContent=daytime(ph.when,null);$("factPlace").textContent="wird ermittelt…";
  $("startForm").hidden=false;$("btnPhotoStart").textContent="Anderes Foto aufnehmen";$("btnPhotoStart").className="btn ghost";
  const plate=plateMode==="std"?state.settings.plate:"";
  ocrKm(ph.url,$("ocrStart"),$("kmStart"),plate?lastKm(plate):null);
  const my=draftStart;
  const gps=(await (gpsStartP||getPosition()))||ph.exifGps;if(draftStart!==my)return;
  my.gps=gps;$("factDaytime").textContent=daytime(ph.when,gps);
  if(!gps){$("factPlace").textContent="kein Standort (Ortungsdienste erlauben)";return}
  my.place=await placeName(gps);if(draftStart===my)$("factPlace").textContent=my.place||"Ort nicht gefunden";
};
function resetStart(){draftStart=null;$("startForm").hidden=true;$("btnPhotoStart").textContent="Foto Kilometerstand (Start)";$("btnPhotoStart").className="btn primary"}
$("btnCancelStart").onclick=resetStart;
$("btnBeginTrip").onclick=()=>{
  const km=parseKm($("kmStart").value);if(km==null){toast("Bitte den Kilometerstand eintragen.");$("kmStart").focus();return}
  const plate=plateMode==="std"?state.settings.plate:$("plateOther").value.trim().toUpperCase();
  if(!plate){toast(plateMode==="std"?"Bitte zuerst unter „Daten“ das Standard-Kennzeichen eintragen.":"Bitte das Kennzeichen eingeben.");return}
  const d=draftStart;
  state.active={start:d.when.getTime(),kmFrom:km,plate,daytime:daytime(d.when,d.gps),gpsFrom:d.gps||null,placeFrom:d.place||null};
  save();resetStart();render();toast("Gute Fahrt!");
};

/* ---------------- Fahrt beenden ---------------- */
let wxSel=[],roadSel=[];
function drawChips(){
  chips($("wxChips"),WX,wxSel,v=>{wxSel=wxSel.includes(v)?wxSel.filter(x=>x!==v):[...wxSel,v];drawChips()});
  chips($("roadChips"),ROAD,roadSel,v=>{roadSel=[v];drawChips()});
}
let gpsEndP=null;
$("btnPhotoEnd").onclick=()=>{$("fileEnd").click();gpsEndP=getPosition()};
$("fileEnd").onchange=async e=>{const f=e.target.files[0];e.target.value="";if(!f)return;
  const ph=await readPhoto(f),act=state.active;draftEnd={...ph,gps:null};const my=draftEnd;
  $("imgEnd").src=ph.url;$("imgEnd").classList.remove("big");$("kmEnd").value="";$("route").value="";$("diffInfo").textContent="";
  wxSel=[];roadSel=[];drawChips();$("endForm").hidden=false;$("btnPhotoEnd").textContent="Anderes Foto aufnehmen";$("btnPhotoEnd").className="btn ghost";
  ocrKm(ph.url,$("ocrEnd"),$("kmEnd"),act.kmFrom+1);
  setStatus($("routeInfo"),"Ermittle Zielort…");setStatus($("wxInfo"),"Frage Wetter ab…");
  const gps=(await (gpsEndP||getPosition()))||ph.exifGps;if(draftEnd!==my)return;my.gps=gps;
  // Strecke
  (async()=>{
    const to=gps?await placeName(gps):null,from=act.placeFrom||(act.gpsFrom?await placeName(act.gpsFrom):null);
    if(draftEnd!==my)return;
    if(!$("route").value){
      if(from&&to)$("route").value=from===to?from+" (Rundfahrt)":from+" – "+to;
      else if(to||from)$("route").value=to||from;
    }
    if(from&&to)setStatus($("routeInfo"),"Aus deinem Standort ermittelt. Du kannst Zwischenziele ergänzen, z. B. „über Autobahn“.","ok");
    else setStatus($("routeInfo"),gps?"Ort nicht gefunden, bitte eintippen.":"Kein Standort verfügbar. Bitte in den Einstellungen die Ortung für den Browser erlauben.","warn");
  })();
  // Wetter
  try{
    const w=await fetchWeather([act.gpsFrom,gps||(act.gpsFrom?null:HOME)],act.start,ph.when.getTime());
    if(draftEnd!==my)return;
    if(w){if(w.wx&&!wxSel.length)wxSel=[w.wx];if(!roadSel.length)roadSel=[w.road];drawChips();
      setStatus($("wxInfo"),"Wetterdaten: "+(w.wx||"–")+(w.temp!=null?", "+Math.round(w.temp)+" °C":"")+(w.precip>0.05?", "+w.precip.toFixed(1)+" mm Niederschlag":"")+
        (w.tmin<=1&&w.road!=="eisglatt"?". Achtung, um den Gefrierpunkt: auf Glätte achten.":". Bitte kurz prüfen."),w.tmin<=1?"warn":"ok")}
    else setStatus($("wxInfo"),"Keine Wetterdaten gefunden, bitte antippen.","warn");
  }catch(err){if(draftEnd===my)setStatus($("wxInfo"),"Wetter nicht abrufbar (offline?). Bitte antippen.","warn")}
};
$("kmEnd").oninput=()=>{const b=parseKm($("kmEnd").value),a=state.active&&state.active.kmFrom,el=$("diffInfo");
  if(b==null||a==null){el.textContent="";return}
  if(b<=a){setStatus(el,"Der Stand muss größer als "+a+" sein.","warn");return}
  setStatus(el,"Gefahren: "+fmtKm(b-a)+(b-a>400?" – ungewöhnlich viel, bitte prüfen":""),b-a>400?"warn":"ok")};
$("btnCancelEnd").onclick=()=>{draftEnd=null;$("endForm").hidden=true;$("btnPhotoEnd").textContent="Angekommen: Foto Kilometerstand";$("btnPhotoEnd").className="btn primary"};
$("btnFinish").onclick=()=>{
  const a=state.active,b=parseKm($("kmEnd").value);
  if(b==null||b<=a.kmFrom){toast("Bitte einen gültigen Kilometerstand eintragen.");$("kmEnd").focus();return}
  const route=$("route").value.trim();if(!route){toast("Bitte die Fahrtstrecke eintragen.");$("route").focus();return}
  if(!roadSel.length||!wxSel.length){toast("Bitte Witterung und Straßenzustand auswählen.");return}
  const t={id:"trip_"+a.start,start:a.start,end:draftEnd.when.getTime(),kmFrom:a.kmFrom,kmTo:b,plate:a.plate,daytime:a.daytime,route,weather:roadSel.join(", ")+", "+wxSel.join("/")};
  state.trips.push(t);state.trips.sort((x,y)=>x.start-y.start);state.active=null;save();
  $("btnCancelEnd").click();render();toast("Fahrt gespeichert: "+fmtKm(b-a.kmFrom));
};
let abortArmed=false;
$("btnAbort").onclick=()=>{
  if(!abortArmed){abortArmed=true;$("btnAbort").textContent="Wirklich abbrechen? Nochmal tippen";setTimeout(()=>{abortArmed=false;$("btnAbort").textContent="Laufende Fahrt abbrechen"},4000);return}
  abortArmed=false;$("btnAbort").textContent="Laufende Fahrt abbrechen";state.active=null;save();$("btnCancelEnd").click();render();
};

/* ---------------- PDF ---------------- */
// Zellen der Drexel-Vorlage in pt (von oben gemessen), 18 Zeilen je Seite
const COLS={date:[13,69.4],km:[69.4,127.3],from:[127.3,183.8],to:[183.8,240.2],plate:[240.2,298.1],day:[298.1,356.1],route:[356.1,558.3],wx:[558.3,647.7]};
const ROW0=180.1,ROWH=(545.3-180.1)/18,PH=595.2;
async function makePdf(){
  const {PDFDocument,StandardFonts,rgb}=PDFLib;
  const tpl=await PDFDocument.load(await (await fetch("vorlage.pdf")).arrayBuffer()),out=await PDFDocument.create();
  const font=await out.embedFont(StandardFonts.Helvetica),ink=rgb(0.05,0.15,0.45);
  const fit=(txt,w,size)=>{txt=String(txt||"");let s=size;while(s>5&&font.widthOfTextAtSize(txt,s)>w-6)s-=0.25;
    while(txt.length>1&&font.widthOfTextAtSize(txt,s)>w-6)txt=txt.slice(0,-2)+"…";return [txt,s]};
  const trips=state.trips,pages=Math.max(1,Math.ceil(trips.length/18));
  for(let p=0;p<pages;p++){
    const [pg]=await out.copyPages(tpl,[0]);out.addPage(pg);
    const head=(txt,x,top)=>{if(txt)pg.drawText(txt,{x,y:PH-top,size:10,font,color:ink})};
    head(state.settings.name,612,52);head(state.settings.phone,636,81);head(state.settings.birth,630,110);head((p+1)+" / "+pages,592,140);
    trips.slice(p*18,p*18+18).forEach((t,i)=>{
      const yb=PH-(ROW0+i*ROWH+ROWH/2+3);
      const cell=(k,txt,size,left)=>{const [a,b]=COLS[k],[s,sz]=fit(txt,b-a,size||8.5),w=font.widthOfTextAtSize(s,sz);pg.drawText(s,{x:left?a+3:a+(b-a-w)/2,y:yb,size:sz,font,color:ink})};
      cell("date",fmtDate(new Date(t.start)));cell("km",String(t.kmTo-t.kmFrom));cell("from",String(t.kmFrom));cell("to",String(t.kmTo));
      cell("plate",t.plate);cell("day",t.daytime);cell("route",t.route,8.5,true);cell("wx",t.weather,7.5);
    });
  }
  return out.save();
}
$("btnPdf").onclick=async()=>{
  if(!state.trips.length){toast("Noch keine Fahrten zum Eintragen.");return}
  if(!window.PDFLib){toast("PDF-Funktion lädt noch – bitte mit Internet erneut versuchen.");return}
  const btn=$("btnPdf");btn.disabled=true;btn.textContent="Erstelle PDF…";
  try{const bytes=await makePdf();await deliver(new Blob([bytes],{type:"application/pdf"}),"Fahrtenprotokoll-L17-"+fmtDate(new Date()).replace(/\./g,"-")+".pdf")}
  catch(e){toast("PDF konnte nicht erstellt werden.")}
  finally{btn.disabled=false;btn.textContent="PDF erstellen"}
};

/* ---------------- Start ---------------- */
load();drawChips();render();
if(!state.settings.plate&&!state.trips.length)$("btnSettings").click();
if("serviceWorker" in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
