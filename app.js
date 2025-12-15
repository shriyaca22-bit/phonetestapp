// Route Sketch Runner — FAST version
// - Leaflet map
// - Overpass (1 call) to detect dominant street bearing
// - OSRM /route with via anchors to force strokes
// - small search over (center shift × 2 rotations) for best fit
//
// Notes:
// - OSRM public demo is rate-limited; keep effort modest.
// - Overpass can be slow sometimes, but it's one call.

const $ = (id) => document.getElementById(id);

let selectedShape = "hi";
let map;

// Layers
let idealLayer, shapeLayer, connectorLayer, fullLayer;

const OSRM = "https://router.project-osrm.org/route/v1/foot";

// ---------- UI helpers ----------
function setStatus(msg) { $("status").textContent = msg; }
function clearSteps() { $("steps").innerHTML = ""; }
function addStep(text) {
  const d = document.createElement("div");
  d.className = "step";
  d.textContent = text;
  $("steps").appendChild(d);
}

// ---------- geo helpers ----------
const milesToMeters = (mi) => mi * 1609.344;

function offsetToLatLng(centerLat, centerLng, xE, yN) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return [
    centerLat + (yN / metersPerDegLat),
    centerLng + (xE / metersPerDegLng)
  ];
}

async function getLocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.latitude, p.coords.longitude]),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  });
}

// Approx bearing (degrees) from [lat,lng] to [lat,lng]
function bearingDeg(a, b) {
  const [lat1, lon1] = a.map(x => x * Math.PI/180);
  const [lat2, lon2] = b.map(x => x * Math.PI/180);
  const y = Math.sin(lon2-lon1) * Math.cos(lat2);
  const x = Math.cos(lat1)*Math.sin(lat2) - Math.sin(lat1)*Math.cos(lat2)*Math.cos(lon2-lon1);
  const brng = Math.atan2(y, x) * 180/Math.PI;
  return (brng + 360) % 360;
}

// ---------- geometry in meters-space ----------
function rotatePts(pts, angleRad) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return pts.map(([x,y]) => [x*c - y*s, x*s + y*c]);
}

function polyLen(pts) {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0]-pts[i-1][0];
    const dy = pts[i][1]-pts[i-1][1];
    sum += Math.hypot(dx, dy);
  }
  return sum;
}

function scaleStrokes(strokes, targetMeters) {
  const total = strokes.reduce((a, st) => a + polyLen(st), 0);
  const k = targetMeters / Math.max(total, 1e-9);
  return strokes.map(st => st.map(([x,y]) => [x*k, y*k]));
}

// resample meters-polyline into N evenly spaced points
function resample(pts, N) {
  if (pts.length < 2) return pts;
  const total = polyLen(pts);
  if (total < 1e-9) return pts;

  const step = total / (N - 1);
  const out = [pts[0].slice()];
  let i = 1;
  let prev = pts[0].slice();
  let carried = 0;

  while (out.length < N && i < pts.length) {
    const cur = pts[i];
    const seg = Math.hypot(cur[0]-prev[0], cur[1]-prev[1]);
    if (carried + seg >= step) {
      const need = step - carried;
      const t = need / seg;
      const nx = prev[0] + t*(cur[0]-prev[0]);
      const ny = prev[1] + t*(cur[1]-prev[1]);
      const np = [nx, ny];
      out.push(np);
      prev = np;
      carried = 0;
    } else {
      carried += seg;
      prev = cur;
      i++;
    }
  }
  if (out.length < N) out.push(pts[pts.length-1].slice());
  return out;
}

// distance point->segment (in lat/lng degrees; for *relative scoring* only)
function pointToSegmentDist(p, a, b) {
  const px=p[0], py=p[1], ax=a[0], ay=a[1], bx=b[0], by=b[1];
  const vx=bx-ax, vy=by-ay;
  const wx=px-ax, wy=py-ay;
  const c1 = vx*wx + vy*wy;
  if (c1 <= 0) return Math.hypot(px-ax, py-ay);
  const c2 = vx*vx + vy*vy;
  if (c2 <= c1) return Math.hypot(px-bx, py-by);
  const t = c1 / c2;
  return Math.hypot(px-(ax+t*vx), py-(ay+t*vy));
}

function meanDistance(idealPts, snappedPts) {
  if (snappedPts.length < 2) return 1e9;
  let sum = 0;
  for (const p of idealPts) {
    let best = Infinity;
    for (let i = 1; i < snappedPts.length; i++) {
      best = Math.min(best, pointToSegmentDist(p, snappedPts[i-1], snappedPts[i]));
    }
    sum += best;
  }
  return sum / idealPts.length;
}

// ---------- shape strokes (meters-space, normalized) ----------
function getStrokes(shape) {
  if (shape === "square") {
    return [[
      [-0.6,-0.6],[0.6,-0.6],[0.6,0.6],[-0.6,0.6],[-0.6,-0.6]
    ]];
  }
  if (shape === "heart") {
    const pts = [];
    const n = 140;
    for (let i=0;i<=n;i++) {
      const t=(i/n)*2*Math.PI;
      const x = 16*Math.sin(t)**3 / 18;
      const y = (13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t))/18;
      pts.push([x,y]);
    }
    pts.push(pts[0]);
    return [pts];
  }
  // "hi" = strokes: h, i stem, dot
  const h = [[-1.4,-0.8],[-1.4,0.9],[-1.4,0.1],[-0.8,0.1],[-0.8,0.9],[-0.8,-0.8]];
  const iStem = [[0.5,-0.8],[0.5,0.9]];
  const dot = [[0.45,1.15],[0.55,1.15],[0.55,1.05],[0.45,1.05],[0.45,1.15]];
  return [h, iStem, dot];
}

// ---------- OSRM routing ----------
async function osrmRoute(latlngs) {
  // latlngs: [[lat,lng], ...] 2+ points
  const coords = latlngs.map(([lat,lng]) => `${lng},${lat}`).join(";");
  const url = `${OSRM}/${coords}?overview=full&steps=true&geometries=geojson&continue_straight=true`;

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== "Ok") {
    throw new Error(data.message || "OSRM route failed");
  }
  return data.routes[0];
}

function geoToLatLngs(geojsonLine) {
  return geojsonLine.coordinates.map(([lng,lat]) => [lat,lng]);
}

// ---------- Overpass: detect dominant local bearing ----------
async function getDominantBearing(origin, radiusM = 900) {
  // Query ways (highways) around origin. One request.
  const [lat, lng] = origin;

  const query = `
[out:json][timeout:25];
(
  way(around:${radiusM},${lat},${lng})["highway"];
);
out geom;
  `.trim();

  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });

  if (!res.ok) throw new Error("Overpass failed");

  const data = await res.json();
  const bins = new Array(18).fill(0); // 10° bins, but for grid we fold 180°
  let totalSegs = 0;

  for (const el of data.elements || []) {
    if (!el.geometry || el.geometry.length < 2) continue;
    const g = el.geometry;
    for (let i=1;i<g.length;i++) {
      const a = [g[i-1].lat, g[i-1].lon];
      const b = [g[i].lat, g[i].lon];
      let br = bearingDeg(a, b);
      // fold to [0,180)
      if (br >= 180) br -= 180;
      const bin = Math.max(0, Math.min(17, Math.floor(br / 10)));
      bins[bin] += 1;
      totalSegs++;
    }
  }

  if (totalSegs < 50) {
    // not enough info; fallback to 0°
    return 0;
  }

  // pick top bin; then refine by averaging nearby bins
  let bestBin = 0;
  for (let i=1;i<bins.length;i++) if (bins[i] > bins[bestBin]) bestBin = i;

  const centerDeg = bestBin * 10 + 5;
  return centerDeg;
}

// ---------- scoring + candidate search ----------
function candidateCenters(origin, effort) {
  // small spiral of centers around user.
  // Normal: 9 centers. Max: 13. Lite: 5.
  const step = effort === "lite" ? 220 : effort === "max" ? 260 : 240;

  const deltas = [
    [0,0],
    [ step,0], [-step,0], [0, step], [0,-step],
    [ step, step], [ step,-step], [-step, step], [-step,-step],
    [2*step,0], [0,2*step], [-2*step,0], [0,-2*step]
  ];

  const count = effort === "lite" ? 5 : effort === "max" ? 13 : 9;
  return deltas.slice(0, count).map(([xE,yN]) => ({
    center: offsetToLatLng(origin[0], origin[1], xE, yN),
    xE, yN
  }));
}

function clearLayers() {
  [idealLayer, shapeLayer, connectorLayer, fullLayer].forEach(l => l && l.remove());
  idealLayer = shapeLayer = connectorLayer = fullLayer = null;
}

async function evaluateCandidate({ origin, center, strokesMeters, angleRad, anchorCount }) {
  // Returns: score + segments + steps + overlays
  // Build:
  // - ideal overlay (orange dashed) from center
  // - shape routes (green) by routing via anchors along each stroke
  // - connectors (gray) between strokes + back to origin

  const idealStrokesLatLng = [];
  const shapeSegs = [];
  const connectorSegs = [];
  const fullSegs = [];
  const allSteps = [];

  let current = origin;

  let similaritySum = 0;
  let totalShapeMeters = 0;

  for (const stroke of strokesMeters) {
    // rotate and create ideal dense polyline for scoring/overlay
    const rotated = rotatePts(stroke, angleRad);

    const idealDenseM = resample(rotated, Math.max(60, anchorCount * 2));
    const idealDenseLL = idealDenseM.map(([x,y]) => offsetToLatLng(center[0], center[1], x, y));
    idealStrokesLatLng.push(idealDenseLL);

    // anchors for OSRM route (forces the stroke)
    const anchorsM = resample(rotated, anchorCount);
    const anchorsLL = anchorsM.map(([x,y]) => offsetToLatLng(center[0], center[1], x, y));

    // connector current -> stroke start
    const strokeStart = anchorsLL[0];
    const conn1 = await osrmRoute([current, strokeStart]);
    const connLL = geoToLatLngs(conn1.geometry);
    connectorSegs.push(connLL);
    fullSegs.push(connLL);
    conn1.legs.forEach(leg => leg.steps.forEach(st => allSteps.push(st.maneuver.instruction)));

    // stroke route through via anchors
    const strokeRoute = await osrmRoute(anchorsLL);
    const strokeLL = geoToLatLngs(strokeRoute.geometry);
    shapeSegs.push(strokeLL);
    fullSegs.push(strokeLL);

    totalShapeMeters += (strokeRoute.distance || 0);
    similaritySum += meanDistance(idealDenseLL, strokeLL);

    strokeRoute.legs.forEach(leg => leg.steps.forEach(st => allSteps.push(st.maneuver.instruction)));

    current = strokeLL[strokeLL.length - 1];
  }

  // connector back to origin
  const connBack = await osrmRoute([current, origin]);
  const backLL = geoToLatLngs(connBack.geometry);
  connectorSegs.push(backLL);
  fullSegs.push(backLL);
  connBack.legs.forEach(leg => leg.steps.forEach(st => allSteps.push(st.maneuver.instruction)));

  const avgSimilarity = similaritySum / strokesMeters.length;

  // score: similarity dominates; lightly penalize huge connector distance
  const connMeters = (connBack.distance || 0); // partial; acceptable
  const score = avgSimilarity * (1 + Math.min(0.35, connMeters / 5000));

  return {
    score,
    idealStrokesLatLng,
    shapeSegs,
    connectorSegs,
    fullSegs,
    allSteps,
    totalShapeMeters
  };
}

// ---------- main build ----------
async function buildRoute() {
  try {
    setStatus("Getting location…");
    clearSteps();

    const miles = Number($("miles").value || 0);
    if (!Number.isFinite(miles) || miles <= 0) throw new Error("Enter miles > 0");

    const effort = $("effort").value;
    const origin = await getLocation();

    if (!map) {
      map = L.map("map").setView(origin, 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    }

    clearLayers();

    // 1) Detect dominant street bearing (one Overpass call)
    setStatus("Analyzing nearby street grid…");
    let domDeg = 0;
    try {
      domDeg = await getDominantBearing(origin, 900);
    } catch {
      domDeg = 0; // fallback
    }

    // 2) Choose 2 candidate rotations: grid-aligned + perpendicular
    // For letters, aligning to grid matters most.
    const angles = [];
    angles.push(domDeg);
    angles.push((domDeg + 90) % 180);

    // Convert to radians
    const angleRads = angles.map(d => d * Math.PI/180);

    // 3) Candidate centers near you
    const centers = candidateCenters(origin, effort);

    // 4) Build strokes and scale to target miles
    const targetMeters = milesToMeters(miles);
    let strokes = getStrokes(selectedShape);
    strokes = scaleStrokes(strokes, targetMeters);

    // 5) Anchor count: “hi” needs more forcing
    // Keep anchors modest for speed.
    const anchorCount =
      selectedShape === "hi"
        ? (effort === "lite" ? 14 : effort === "max" ? 22 : 18)
        : (effort === "lite" ? 12 : effort === "max" ? 18 : 15);

    setStatus("Searching placement + orientation (fast)…");

    let best = null;
    let tried = 0;

    for (let ci = 0; ci < centers.length; ci++) {
      for (let ai = 0; ai < angleRads.length; ai++) {
        tried++;
        setStatus(`Trying ${tried}/${centers.length * angleRads.length}…`);

        const center = centers[ci].center;
        const angleRad = angleRads[ai];

        try {
          const result = await evaluateCandidate({
            origin,
            center,
            strokesMeters: strokes,
            angleRad,
            anchorCount
          });

          if (!best || result.score < best.score) {
            best = { ...result, center, angleRad, domDeg };
          }
        } catch {
          // candidate failed; skip
        }
      }
    }

    if (!best) {
      throw new Error("Couldn’t fit the figure here. Try increasing miles or move to a more grid-like area.");
    }

    // 6) Draw layers
    idealLayer = L.layerGroup(
      best.idealStrokesLatLng.map(st =>
        L.polyline(st, { color: "#f97316", weight: 3, dashArray: "6 8", opacity: 0.85 })
      )
    ).addTo(map);

    fullLayer = L.layerGroup(
      best.fullSegs.map(seg =>
        L.polyline(seg, { color: "#60a5fa", weight: 6, opacity: 0.45 })
      )
    ).addTo(map);

    connectorLayer = L.layerGroup(
      best.connectorSegs.map(seg =>
        L.polyline(seg, { color: "#d4d4d8", weight: 3, opacity: 0.30 })
      )
    ).addTo(map);

    shapeLayer = L.layerGroup(
      best.shapeSegs.map(seg =>
        L.polyline(seg, { color: "#22c55e", weight: 8, opacity: 1.0 })
      )
    ).addTo(map);

    map.fitBounds(shapeLayer.getBounds(), { padding: [20, 20] });

    // steps
    best.allSteps.slice(0, 120).forEach((s, i) => addStep(`${i+1}. ${s}`));
    if (best.allSteps.length > 120) addStep(`(Showing first 120 steps of ${best.allSteps.length}.)`);

    const usedDeg = (best.angleRad * 180/Math.PI).toFixed(0);
    setStatus(`Ready ✅ (Used ~${usedDeg}°; grid≈${domDeg.toFixed(0)}°; anchors=${anchorCount})`);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e));
  }
}

// ---------- UI wiring ----------
$("shapes").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-shape]");
  if (!btn) return;
  selectedShape = btn.dataset.shape;
  [...$("shapes").querySelectorAll(".pill")].forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
});

$("build").addEventListener("click", buildRoute);

// Default selection
selectedShape = "hi";
