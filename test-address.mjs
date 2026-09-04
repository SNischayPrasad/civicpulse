/**
 * Address-AI test: can the platform read a location out of the photograph?
 *
 * Each case supplies a photo containing visible signage and a GPS fix, then
 * checks that OCR + OpenStreetMap geocoding produce a specific street address
 * rather than bare coordinates.
 *
 * Usage: node test-address.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveAddress, readSignage } from './server/services/ai/address.js';
import { reverseGeocode } from './server/services/geo.js';

const DIR = path.join(process.cwd(), 'test-fixtures', 'signage');

const CASES = [
  { file: 'sign-01.jpg', point: { lat: 13.0128, lng: 77.6503, source: 'device' }, note: 'Banaswadi, Bengaluru - street name board' },
  { file: 'sign-02.jpg', point: { lat: 13.0128, lng: 77.6503, source: 'exif' }, note: 'same street, second angle' },
  { file: 'sign-06.jpg', point: { lat: 10.5276, lng: 76.2144, source: 'device' }, note: 'Kerala MDR name board' },
  { file: 'sign-07.jpg', point: { lat: 51.5487, lng: -0.2137, source: 'device' }, note: 'London street name plate' },
  { file: 'sign-08.jpg', point: { lat: 51.5074, lng: -0.1278, source: 'device' }, note: 'old UK street plate' }
];

const line = (s) => console.log(s);

const main = async () => {
  if (!fs.existsSync(DIR)) { console.error(`No signage fixtures at ${DIR}`); process.exit(2); }

  let readable = 0, specific = 0, total = 0;

  for (const c of CASES) {
    const p = path.join(DIR, c.file);
    if (!fs.existsSync(p)) continue;
    total++;
    const buf = fs.readFileSync(p);

    const place = await reverseGeocode(c.point);
    const out = await resolveAddress({ buffers: [buf], point: c.point, description: '', place });

    const gotText = out.ocr.lines.length > 0;
    if (gotText) readable++;
    // "specific" = the final address is more than the reverse-geocoded fallback
    const isSpecific = Boolean(out.osmMatch || out.hints.roadNames.length || out.hints.houseNumbers.length || out.pincode);
    if (isSpecific) specific++;

    line('');
    line(`--- ${c.file}  (${c.note})`);
    line(`  GPS in       : ${c.point.lat}, ${c.point.lng}  [${c.point.source}]`);
    line(`  OCR read     : ${out.ocr.lines.slice(0, 4).map((l) => `"${l.text}" (${l.confidence}%)`).join('  ') || '(nothing legible)'}`);
    line(`  Road hints   : ${out.hints.roadNames.join(' | ') || '-'}`);
    line(`  Place hints  : ${out.hints.placeNames.slice(0, 3).join(' | ') || '-'}`);
    line(`  PIN / house  : ${out.pincode || '-'} / ${out.hints.houseNumbers.join(', ') || '-'}`);
    line(`  OSM match    : ${out.osmMatch ? `${out.osmMatch.name.slice(0, 70)} (${out.osmMatch.distanceM} m)` : '-'}`);
    line(`  ADDRESS      : ${out.formatted}`);
    line(`  confidence   : ${out.confidence}   snapped=${out.snapped}   ${out.ms} ms`);
    line(`  signals      : ${out.signals.join(' | ')}`);
  }

  line('');
  line(`Photos with legible signage : ${readable}/${total}`);
  line(`Addresses enriched by photo : ${specific}/${total}`);
  process.exit(0);
};

main();
