// Do random / non-civic photos get rejected, while civic ones still file?
import fs from 'node:fs';
const BASE='http://localhost:4000';
const UA={'User-Agent':'CivicPulse-test/1.0'};
const login=async()=> (await (await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'citizen@demo.in',password:'Citizen@123'})})).json()).token;

async function commons(title){
  const u='https://commons.wikimedia.org/w/api.php?action=query&format=json&titles='+encodeURIComponent(title)+'&prop=imageinfo&iiprop=url&iiurlwidth=900';
  const j=await (await fetch(u,{headers:UA})).json();
  const url=Object.values(j.query.pages)[0]?.imageinfo?.[0]?.thumburl;
  if(!url) return null;
  return Buffer.from(await (await fetch(url,{headers:UA})).arrayBuffer());
}

const NON_CIVIC=[
 ['a cat','File:Cat November 2010-1a.jpg'],
 ['a laptop keyboard','File:Qwerty.svg.jpg'],
 ['a plate of food','File:Good Food Display - NCI Visuals Online.jpg'],
 ['a person portrait','File:Portrait Placeholder.png'],
 ['a flower','File:Sunflower sky backdrop.jpg'],
];
const CIVIC=[
 ['pothole','test-fixtures/pothole-02.jpg'],
 ['garbage','test-fixtures/garbage-11.jpg'],
 ['streetlight','test-fixtures/streetlight-18.jpg'],
];

const token=await login();
let rejected=0,nonTotal=0,filed=0,civTotal=0;

console.log('\n--- NON-CIVIC photos (should be REJECTED) ---');
for(const [label,title] of NON_CIVIC){
  const buf=await commons(title);
  if(!buf){console.log(`  skip ${label} (no image)`);continue;}
  nonTotal++;
  const fd=new FormData();
  fd.append('photos',new Blob([buf],{type:'image/jpeg'}),'x.jpg');
  fd.append('lat','12.9352');fd.append('lng','77.6245');
  const res=await fetch(BASE+'/api/issues',{method:'POST',headers:{Authorization:'Bearer '+token},body:fd});
  const j=await res.json();
  const ok=res.status===422&&j.notCivicIssue;
  if(ok)rejected++;
  console.log(`  ${ok?'REJECTED ':'FILED !! '} ${label.padEnd(22)} ${ok?`(closest: ${j.ai.closestCategory})`:`-> ${j.issue?.categoryLabel}`}`);
}

console.log('\n--- CIVIC photos (should still be FILED) ---');
for(const [label,path] of CIVIC){
  if(!fs.existsSync(path)){console.log(`  skip ${label}`);continue;}
  civTotal++;
  const fd=new FormData();
  fd.append('photos',new Blob([fs.readFileSync(path)],{type:'image/jpeg'}),'x.jpg');
  fd.append('lat',String(12.9+Math.round(civTotal)*0.05));fd.append('lng','77.62');
  const res=await fetch(BASE+'/api/issues',{method:'POST',headers:{Authorization:'Bearer '+token},body:fd});
  const j=await res.json();
  const ok=res.status===201;
  if(ok)filed++;
  console.log(`  ${ok?'FILED    ':'REJECTED!'} ${label.padEnd(22)} ${ok?`-> ${j.ai.categoryLabel} (${j.ai.confidence})`:j.error?.slice(0,60)}`);
}

console.log(`\nnon-civic rejected: ${rejected}/${nonTotal}   civic still filed: ${filed}/${civTotal}`);
process.exit(rejected===nonTotal&&filed===civTotal?0:1);
