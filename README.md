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

Open <http://localhost:4000>. First boot seeds 8 departments, 6 contractors and 9 demo accounts.

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
 photo(s) + GPS ──► CivicVision ──► NLP ──► fusion ──► severity ──► department
                     (vision)      (text)                             │
                                                                      ▼
 citizen verifies ◄── AI closure check ◄── before/after ◄── SLA clock + escalation
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
`server/services/ai/` — three independent signals fused into one auditable verdict:

- **CivicVision (on-board)** — decodes each photo, resamples to a 96×96 lattice and extracts 18
  normalised scene descriptors (asphalt ratio, dark-cavity blob area and circularity, hue entropy /
  texture chaos, specular ratio, vertical pole structure, night ratio, colour variance …), then scores
  them against a weighted visual signature per category and softmaxes the result. Runs offline, in
  ~100–200 ms, and always available.
- **Hosted vision model (optional)** — point `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL` at any
  Anthropic, OpenAI-compatible or Gemini vision endpoint and it becomes the primary classifier, with
  CivicVision as the cross-check and automatic fallback.
- **Text NLP** — keyword and phrase matching over the citizen's description, plus hazard-cue
  detection ("child", "accident", "live wire", "two months") that feeds the severity model.

Every verdict carries **why**: the specific visual features that drove it, the text signals that
agreed, the alternates considered, and a confidence. Below `AI_CONFIDENCE_THRESHOLD` the issue is
flagged for **human review** instead of being silently auto-routed.

12 categories → 8 departments, each with its own SLA (manhole 6 h, water leak 8 h, sewage 12 h,
garbage 24 h, pothole 48 h …).

### 4 · Location you can trust
EXIF GPS is parsed straight out of the JPEG (no dependencies) and **outranks** the browser's own fix,
because a photo carrying its own coordinates is far harder to fake. Each issue records its location
trust level. Reverse geocoding to a ward name uses OpenStreetMap Nominatim, with a deterministic
grid-cell fallback so routing never blocks when offline.

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

The backend ships with an end-to-end suite that drives the real HTTP API with synthetically generated
imagery (pothole, garbage, night-time street light, repaired road):

```
43 passed, 0 failed
```

It covers auth and role isolation, classification and routing per category, input guards, duplicate
clustering, the full workflow, angle-diversity enforcement, fake-closure rejection, citizen
verification, contractor liability and analytics. The browser build has an equivalent in-page suite
(24 checks) exercising the same logic through the static engine.

---

## Architecture

```
server/
  index.js                 Express + Socket.IO, static hosting, SLA sweeper
  config.js  db.js         env config, JSON document store (Mongo-shaped API)
  seed.js                  departments, contractors, demo accounts
  middleware/auth.js       JWT, roles, department scoping
  routes/                  auth · issues · departments · contractors · analytics
  services/
    ai/taxonomy.js         12 categories → department, SLA, keywords, visual signature
    ai/heuristic.js        CivicVision: descriptors, classifier, perceptual hashes
    ai/nlp.js              text classification + hazard cues
    ai/remote.js           Anthropic / OpenAI-compatible / Gemini connector
    ai/index.js            fusion, severity, closure verification
    exif.js                dependency-free EXIF GPS reader
    geo.js                 haversine, reverse geocoding, clustering, hotspots
    contractors.js         open-contracts registry + Overpass lookup
    notify.js              real-time alert bus, notifications, audit
public/                    citizen app · department console · control room
docs/                      the GitHub Pages build (same taxonomy + NLP, canvas vision)
```

**Stack:** Node.js · Express · Socket.IO · JWT · Multer · vanilla ES-module frontend · Leaflet ·
OpenStreetMap. The datastore is a JSON document store with a Mongo-shaped API so it runs with
`npm install` alone — swapping in MongoDB is a drop-in change to `server/db.js`.

## Configuration

Copy `.env.example` to `.env`. Everything has a working default; the interesting knobs:

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `auto` | `auto` · `local` · `anthropic` · `openai` · `gemini` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` | — | hosted vision model; unset ⇒ on-board CivicVision |
| `AI_CONFIDENCE_THRESHOLD` | `0.55` | below this, an issue goes to human review |
| `DUPLICATE_RADIUS_M` | `70` | crowd-cluster merge radius |
| `MAX_PHOTOS` | `4` | photos per issue |
| `ENABLE_REVERSE_GEOCODE` / `ENABLE_OSM_CONTRACTORS` | `true` | set `false` for a fully offline demo |

## References

Open311 · UN SDG 11 · OpenStreetMap / Nominatim / Overpass · SIH25031

## License

MIT
