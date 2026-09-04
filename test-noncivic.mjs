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

// Local fixtures, including screenshots. This is the case that actually shipped
// broken: a screenshot of a code repository was filed as a water pipeline leak
// because nothing in the distractor prompts described a screenshot.
console.log('\n--- LOCAL non-civic fixtures (should be REJECTED) ---');
const LOCAL='test-fixtures/noncivic';
if(fs.existsSync(LOCAL)){
  for(const f of fs.readdirSync(LOCAL).filter(x=>/\.(jpe?g|png)$/i.test(x))){
    nonTotal++;
    const fd=new FormData();
    fd.append('photos',new Blob([fs.readFileSync(`${LOCAL}/${f}`)],{type:/png$/i.test(f)?'image/png':'image/jpeg'}),f);
    fd.append('lat','12.9352');fd.append('lng','77.6245');
    const res=await fetch(BASE+'/api/issues',{method:'POST',headers:{Authorization:'Bearer '+token},body:fd});
    const j=await res.json();
    const ok=res.status===422&&j.notCivicIssue;
    if(ok)rejected++;
    console.log(`  ${ok?'REJECTED ':'FILED !! '} ${f.padEnd(26)} ${ok?`(closest: ${j.ai.closestCategory})`:`-> ${j.issue?.categoryLabel}`}`);
  }
} else console.log('  (no local fixtures - run: npm run fixtures)');

console.log('\n--- CIVIC photos (should still be FILED) ---');
// Spread these far apart, and away from any earlier run, so the duplicate
// clusterer does not merge them and mask a real rejection.
const jitter=Number(process.env.SEED||process.hrtime.bigint()%1000n)/1000;
for(const [label,path] of CIVIC){
  if(!fs.existsSync(path)){console.log(`  skip ${label}`);continue;}
  civTotal++;
  const fd=new FormData();
  fd.append('photos',new Blob([fs.readFileSync(path)],{type:'image/jpeg'}),'x.jpg');
  fd.append('lat',String(20+civTotal*0.7+jitter));fd.append('lng',String(75+civTotal*0.7+jitter));
  const res=await fetch(BASE+'/api/issues',{method:'POST',headers:{Authorization:'Bearer '+token},body:fd});
  const j=await res.json();
  // 201 = newly filed; 200 + duplicate = accepted and merged into a cluster.
  const ok=res.status===201||(res.status===200&&j.duplicate);
  if(ok)filed++;
  console.log(`  ${ok?'FILED    ':'REJECTED!'} ${label.padEnd(22)} ${ok?`-> ${j.ai.categoryLabel} (${j.ai.confidence})`:(j.error||'').slice(0,70)}`);
}

console.log(`\nnon-civic rejected: ${rejected}/${nonTotal}   civic still filed: ${filed}/${civTotal}`);
process.exit(rejected===nonTotal&&filed===civTotal?0:1);
