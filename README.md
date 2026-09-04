# CivicPulse

**AI-Powered Crowdsourced Civic Issue Intelligence & Resolution Platform**
Smart India Hackathon · Problem statement **SIH25031** · Theme: Clean & Green Technology · Team **Infinity Force**

> From *"I reported it"* → to *"We resolved it."*

A citizen photographs a civic problem from a few angles. CivicPulse reads the image with computer
vision, pins the location from the photo's own GPS, and pushes a live alert to the department that
owns that category — with an SLA clock, contractor liability lookup from open data, and
photographic proof of closure that the AI itself verifies.

---

## Two ways to run it

| | What it is | How to open |
|---|---|---|
| **Live demo (GitHub Pages)** | The whole platform running **in your browser** — AI, routing, SLA clock, evidence checks and contractor matching all execute locally. No server needed. | **https://snischayprasad.github.io/civicpulse/** |
| **Full stack (Node + Express + Socket.IO)** | The real backend: JWT auth, file uploads, server-side CivicVision, live Socket.IO alerts, REST API. | `npm install && npm start` → http://localhost:4000 — or open the repo in **GitHub Codespaces** (port 4000 auto-forwards, publicly) |

GitHub Pages can only serve static files, so the Pages build swaps the Express server for an
equivalent in-page engine. **The classification taxonomy and the NLP layer are literally the same
source files** in both builds, and the vision maths is identical — only the decode step differs
(`jpeg-js` on the server, `<canvas>` in the browser).

### Run locally in VS Code

```bash
git clone https://github.com/SNischayPrasad/civicpulse.git
cd civicpulse
npm install
npm start
```

Open <http://localhost:4000>. First boot seeds 8 departments, 6 contractors and 9 demo accounts, and
downloads the CLIP vision model (~50 MB) and the Tesseract OCR data (~15 MB) once — both are cached
afterwards and everything then runs offline. No API key is needed.

On the GitHub Pages build the same models download into the browser the first time you submit a
report, and are cached by the browser after that.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Citizen | `citizen@demo.in` | `Citizen@123` |
| Field worker (Roads) | `worker.roads@city.gov.in` | `Worker@123` |
| Supervisor (Roads) | `supervisor.roads@city.gov.in` | `Super@123` |
| Control room | `admin@city.gov.in` | `Admin@123` |

Sign in as the citizen in one tab and the worker in another — alerts move between them in real time.

---

## The pipeline

```
 photo(s) ──► CLIP vision model ──► NLP ──► fusion ──► severity ──► department
     │              (zero-shot)      (text)                            │
     └──► OCR + EXIF GPS ──► street address (OpenStreetMap)            ▼
                                                                 SLA clock
 citizen verifies ◄── AI closure check ◄── before/after ◄── + escalation
                                            │
                                 contractor liability (open data)
```

### 1 · Authentication gates everything
JWT + bcrypt, four roles (`citizen`, `worker`, `supervisor`, `admin`). Nothing is reachable without
a token; department staff can only touch issues routed to their own department.

### 2 · Multi-angle capture
1–4 photos per issue, camera capture on mobile. Perceptual hashing (aHash + dHash) enforces that the
photos are **genuinely different viewpoints** rather than the same frame uploaded twice.

### 3 · The AI layer
`server/services/ai/` — independent signals fused into one auditable verdict:

- **CLIP zero-shot vision (primary).** A real trained vision-language model
  (`Xenova/clip-vit-base-patch32`) runs locally through Transformers.js + ONNX —
  no API key, no per-request cost, no training data. Each photo is scored against
  a bank of natural-language prompts per civic category (`prompts.js`), and the
  prompt scores are summed per category. A `_NONE` distractor bucket ("a portrait
  of a person", "a clean empty road") means a non-civic photo is flagged for human
  review instead of being forced into some category.
- **Text NLP.** Keyword and phrase matching over the citizen's description, plus
  hazard-cue detection ("child", "accident", "live wire", "two months") that feeds
  the severity model.
- **CivicVision colour/texture engine.** 18 normalised scene descriptors (asphalt
  ratio, dark-cavity blob area and circularity, hue entropy, specular ratio,
  vertical pole structure…). It supplies severity cues and the perceptual hashes,
  and takes over classification entirely if the model cannot be loaded.
- **Hosted vision model (optional).** Point `AI_PROVIDER` / `AI_BASE_URL` /
  `AI_MODEL` at any Anthropic, OpenAI-compatible or Gemini vision endpoint and it
  joins the fusion as an additional signal.

**Measured accuracy** on 33 real photographs from Wikimedia Commons:

| Engine | Top-1 category | Potholes |
|---|---|---|
| Colour statistics alone (v1) | 24% | 0 / 8 |
| CLIP zero-shot | 91% | 7 / 8 |
| CLIP + text NLP (as shipped) | **100%** | **8 / 8** |

**Photos that are not civic issues are refused, not routed.** The prompt bank
includes a `_NONE` bucket of everyday scenes — screenshots, documents, pets,
food, portraits, clean roads — and a photo is only filed if the winning civic
category both beats that bucket and clears an absolute floor of 35% of the
probability mass. Measured separation: civic photos score 0.61–0.99, non-civic
photos 0.000–0.007. On the fixture set, 14/14 non-civic photos (including five
real application screenshots) are rejected while 3/3 civic photos still file at
0.99 confidence.

Every verdict carries **why**: the prompt matches, the visual features, the text
signals that agreed, the alternates considered, and a confidence. Below
`AI_CONFIDENCE_THRESHOLD` the issue goes to **human review** rather than being
silently auto-routed.

12 categories → 8 departments, each with its own SLA (manhole 6 h, water leak 8 h,
sewage 12 h, garbage 24 h, pothole 48 h …).

### 4 · Location, and an address read out of the photo
GPS alone gives a dot, not an address. `services/ai/address.js` combines four
signals and records which one produced each part of the result:

1. **EXIF GPS** parsed straight out of the JPEG (no dependencies). It **outranks**
   the browser's own fix, because a photo carrying its own coordinates is far
   harder to fake.
2. **Device GPS** from the browser.
3. **OCR over the photograph** (Tesseract). Street name boards, shop names, house
   numbers and PIN codes physically present at the site are read out of the image.
   Scene text is small and low-contrast, so photos are greyscaled, contrast-stretched
   between the 5th and 95th percentile and upscaled first; split sign lines are
   rejoined and common OCR damage is repaired (`ROY` → `ROAD`).
4. **The citizen's description** — landmarks they typed.

The extracted text is then geocoded against **OpenStreetMap Nominatim**, bounded to
a box around the GPS fix, turning `12.9352, 77.6245` into
`Mahayogi Vemana Road, Koramangala East, Bengaluru, Karnataka 560095` — and when a
signboard is legible, snapping the pin to the actual premises.

A road name physically painted on a sign beats the road the geocoder guessed from a
GPS dot that may be 200 m off. When nothing is legible the platform says so plainly
rather than claiming the photo contributed.

### 5 · Crowd intelligence
A new report within 70 m of an open issue of the same category **merges into that cluster** instead of
creating a duplicate: report count rises, severity escalates, and the department gets a "N citizens
now reporting this" alert. Repeat grid cells surface as **hotspots** for planned prevention work.

### 6 · Contractor accountability from open data
`server/services/contractors.js` answers *"who built this, and are they still liable?"*

- A local **open-contracts registry** shaped like public works disclosures — licence number, work
  order, agency, ward, contract value, and the **Defect Liability Period (DLP)**.
- Live **OpenStreetMap / Overpass** queries for construction and roadworks near the issue, reading
  the open `operator`, `contractor` and `construction` tags.

If an issue lands inside a contractor's zone, matches their scope of work, and falls inside an active
DLP, CivicPulse marks them **liable**, alerts the department that rectification is recoverable at
contractor cost, and records the full reasoning in the audit trail. Supervisors can issue a formal
defect notice, which lowers the contractor's rating.

### 7 · Closure the AI actually checks
Workers upload **before** and **after** photos, minimum two angles each. CivicVision then:

- rejects **recycled evidence** — an "after" photo perceptually near-identical to a "before" one is a
  fake closure and is blocked outright;
- re-runs **the vision model on the "after" photos** and checks the defect is no longer
  recognisable — on a genuine pothole repair the model's pothole score falls from `0.96` to
  `0.15`, and a closure where it stays high is flagged;
- measures **category-aware improvement** (dark cavity area for potholes, clutter and colour
  dispersion for garbage, standing water for sewage, illumination for street lights …) and reports a
  score with per-metric before/after numbers;
- hands the final call to the **citizen**, who closes it or re-opens it with an escalated 24 h SLA.

### 8 · SLA, escalation and audit
Every issue gets a due date on creation. A background sweep escalates breaches, alerts the supervisor
and notifies the citizen. Every state change — AI routing, contractor identification, assignment,
closure rejection, human override — lands in an immutable audit trail.

---

## Verification

Three suites, all driving the real HTTP API with **real photographs** (fetch them
with `npm run fixtures`, then start the server and run):

```bash
npm run fixtures     # download the Wikimedia Commons test photos
npm test             # 50 end-to-end checks
npm run test:vision  # classification accuracy across 33 real photos
npm run test:address # address resolution from street signage
```

```
npm test             -> 50 passed, 0 failed
npm run test:vision  -> Category accuracy 33/33 (100%) · Department routing 29/29 (100%)
```

The end-to-end suite walks a real pothole photo from a citizen's camera to a
verified closure: auth and role isolation, classification and routing, AI address
resolution, input guards, duplicate clustering, the department workflow,
angle-diversity enforcement, fake-closure rejection, citizen sign-off, contractor
liability and analytics. The closure check is the interesting one — the vision
model's pothole score on the evidence drops from `0.96` to `0.15` once the road is
repaired, which is what "verified" actually means here.

The browser build has an equivalent in-page suite exercising the same logic through
the static engine.

## Architecture

```
server/
  index.js                 Express + Socket.IO, static hosting, SLA sweeper
  config.js  db.js         env config, JSON document store (Mongo-shaped API)
  seed.js                  departments, contractors, demo accounts
  middleware/auth.js       JWT, roles, department scoping
  routes/                  auth · issues · departments · contractors · analytics
  services/
    ai/clip.js             CLIP zero-shot vision model (primary classifier)
    ai/prompts.js          natural-language prompt bank + _NONE distractors
    ai/taxonomy.js         12 categories → department, SLA, keywords, visual signature
    ai/heuristic.js        CivicVision: descriptors, fallback classifier, perceptual hashes
    ai/nlp.js              text classification + hazard cues
    ai/address.js          OCR signage reading + address geocoding
    ai/address-core.js     address parsing rules (shared with the browser build)
    ai/remote.js           Anthropic / OpenAI-compatible / Gemini connector
    ai/index.js            fusion, severity, closure verification
    exif.js                dependency-free EXIF GPS reader
    geo.js                 haversine, reverse geocoding, clustering, hotspots
    contractors.js         open-contracts registry + Overpass lookup
    notify.js              real-time alert bus, notifications, audit
public/                    citizen app · department console · control room
scripts/                   test-fixture downloader
docs/                      the GitHub Pages build - same model, prompts, taxonomy,
                           NLP and address rules, running fully in the browser
```

**Stack:** Node.js · Express · Socket.IO · JWT · Multer · Transformers.js (CLIP) · Tesseract.js ·
vanilla ES-module frontend · Leaflet · OpenStreetMap. The datastore is a JSON document store with a Mongo-shaped API so it runs with
`npm install` alone — swapping in MongoDB is a drop-in change to `server/db.js`.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default; the interesting knobs:

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `auto` | optional hosted model: `auto` · `local` · `anthropic` · `openai` · `gemini` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | — | only for a hosted model. **Not required** — CLIP runs locally |
| `AI_CONFIDENCE_THRESHOLD` | `0.55` | below this, an issue goes to human review |
| `DUPLICATE_RADIUS_M` | `70` | crowd-cluster merge radius |
| `MAX_PHOTOS` | `4` | photos per issue |
| `ENABLE_REVERSE_GEOCODE` / `ENABLE_OSM_CONTRACTORS` | `true` | set `false` for a fully offline demo |

## References

Open311 · UN SDG 11 · OpenStreetMap / Nominatim / Overpass · SIH25031

## License

MIT
