const $ = (id) => document.getElementById(id);

let selectedShape = "hi";
let map;
let idealLayer, shapeLayer, connectorLayer, fullLayer;

const OSRM = "https://router.project-osrm.org";

// -------------------- helpers --------------------
const milesToMeters = (mi) => mi * 1609.34;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function setStatus(msg) { $("status").textContent = msg; }

async function getLocation() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve([p.coords.latitude, p.coords.longitude]),
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  });
}

// meters east/north -> [lat,lng] at a given center
function offsetToLatLng(centerLat, centerLng, xE, yN) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return [
    centerLat + (yN / metersPerDegLat),
    centerLng + (xE / metersPerDegLng)
  ];
}

// shift center by meters (east, north)
function shiftCenter([lat,lng], xE, yN) {
  return offsetToLatLng(lat, lng, xE, yN);
}

function rotatePts(pts, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
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

// resample polyline in meter space to N points
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

// distance point->segment in lat/lng space (approx; good enough for scoring)
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

// -------------- shape strokes --------------
function getStrokes(shape) {
  if (shape === "square") {
    return [[[-0.6,-0.6],[0.6,-0.6],[0.6,0.6],[-0.6,0.6],[-0.6,-0.6]]];
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
  // "hi"
  const h = [[-1.4,-0.8],[-1.4,0.9],[-1.4,0.1],[-0.8,0.1],[-0.8,0.9],[-0.8,-0.8]];
  const iStem = [[0.5,-0.8],[0.5,0.9]];
  const dot = [[0.45,1.15],[0.55,1.15],[0.55,1.05],[0.45,1.05],[0.45,1.15]];
  return [h, iStem, dot];
}

// -------------- OSRM calls --------------
// Match snaps a whole trace to roads. That’s the key.
async function osrmMatchFoot(latlngs) {
  const coords = latlngs.map(([lat,lng]) => `${lng},${lat}`).join(";");
  const url = `${OSRM}/match/v1/foot/${coords}?geometries=geojson&overview=full&steps=true`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== "Ok") throw new Error(data.message || "OSRM match failed");
  const m = data.matchings?.[0];
  if (!m?.geometry) throw new Error("No matching geometry");
  return m;
}

async function osrmRouteFoot(a, b) {
  const coords = `${a[1]},${a[0]};${b[1]},${b[0]}`;
  const url = `${OSRM}/route/v1/foot/${coords}?geometries=geojson&overview=full&steps=true`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== "Ok") throw new Error(data.message || "OSRM route failed");
  return data.routes[0];
}

function geoToLatLngs(geo) {
  return geo.coordinates.map(([lng,lat]) => [lat,lng]);
}

function clearLayers() {
  [idealLayer, shapeLayer, connectorLayer, fullLayer].forEach(l => l && l.remove());
  idealLayer = shapeLayer = connectorLayer = fullLayer = null;
}

// -------------- candidate search --------------
function candidateCenters(base, stepM, rings) {
  // small grid: (2*rings+1)^2
  const out = [];
  for (let dx = -rings; dx <= rings; dx++) {
    for (let dy = -rings; dy <= rings; dy++) {
      out.push({ xE: dx*stepM, yN: dy*stepM, center: shiftCenter(base, dx*stepM, dy*stepM) });
    }
  }
  return out;
}

async function evaluateCandidate(baseOrigin, center, strokesMeters, anglesDeg, matchPts, idealPts) {
  // Return best rotation for this center with score + segments
  let best = null;

  for (const deg of anglesDeg) {
    const ang = deg * Math.PI / 180;

    const idealStrokesLatLng = [];
    const matchedStrokesLatLng = [];
    const connectorSegs = [];
    const fullSegs = [];
    let totalSimilarity = 0;
    let totalMatchedMeters = 0;

    let current = baseOrigin;

    // Each stroke: rotate -> sample -> match -> score
    for (const stroke of strokesMeters) {
      const rotated = rotatePts(stroke, ang);

      const idealDense = resample(rotated, idealPts).map(([x,y]) => offsetToLatLng(center[0], center[1], x, y));
      const trace = resample(rotated, matchPts).map(([x,y]) => offsetToLatLng(center[0], center[1], x, y));

      let match;
      try {
        match = await osrmMatchFoot(trace); // snaps the stroke to roads :contentReference[oaicite:2]{index=2}
      } catch {
        return null; // this center/angle is not feasible
      }

      const snapped = geoToLatLngs(match.geometry);
      idealStrokesLatLng.push(idealDense);
      matchedStrokesLatLng.push(snapped);

      // connector from current -> stroke start
      const start = snapped[0];
      const conn = await osrmRouteFoot(current, start);
      const connLatLngs = geoToLatLngs(conn.geometry);
      connectorSegs.push(connLatLngs);
      fullSegs.push(connLatLngs);
      fullSegs.push(snapped);

      // similarity
      totalSimilarity += meanDistance(idealDense, snapped);

      // matched length in meters from OSRM
      totalMatchedMeters += match.distance || 0;

      current = snapped[snapped.length - 1];

      // be nice to demo server: tiny pause if doing many calls
      await sleep(40);
    }

    // back to origin connector
    const back = await osrmRouteFoot(current, baseOrigin);
    const backLatLngs = geoToLatLngs(back.geometry);
    connectorSegs.push(backLatLngs);
    fullSegs.push(backLatLngs);

    const avgSimilarity = totalSimilarity / strokesMeters.length;

    // Objective: shape similarity dominates, but also keep distance near target.
    const result = {
      center, deg,
      avgSimilarity,
      matchedMeters: totalMatchedMeters,
      idealStrokesLatLng,
      matchedStrokesLatLng,
      connectorSegs,
      fullSegs
    };

    if (!best || result.avgSimilarity < best.avgSimilarity) best = result;
  }

  return best;
}

async function buildRoute() {
  try {
    setStatus("Getting location…");
    const miles = Number($("miles").value || 0);
    if (!Number.isFinite(miles) || miles <= 0) throw new Error("Enter miles > 0");

    const targetMeters = milesToMeters(miles);
    const origin = await getLocation();

    if (!map) {
      map = L.map("map").setView(origin, 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    }

    clearLayers();
    $("steps").innerHTML = "";

    // strokes in meter space scaled to distance
    let strokes = getStrokes(selectedShape);
    strokes = scaleStrokes(strokes, targetMeters);

    // search parameters (kept modest to avoid demo abuse) :contentReference[oaicite:3]{index=3}
    const anglesDeg = (selectedShape === "hi")
      ? [0,15,30,45,60,75,90,105,120,135,150,165]
      : [0,30,60,90,120,150];

    // center shifts: try a 3x3 grid (rings=1) at 250m spacing
    // increase rings to 2 for more search if needed (but more OSRM calls)
    const centers = candidateCenters(origin, 250, 1);

    // sampling counts
    const matchPts = 35;  // keep < ~100 to avoid TooBig on match :contentReference[oaicite:4]{index=4}
    const idealPts = 70;

    setStatus("Searching nearby placements/orientations…");

    let bestOverall = null;
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i].center;
      setStatus(`Testing placement ${i+1}/${centers.length}…`);

      const bestAtCenter = await evaluateCandidate(origin, c, strokes, anglesDeg, matchPts, idealPts);
      if (!bestAtCenter) continue;

      // Incorporate distance error lightly
      const distanceError = Math.abs(bestAtCenter.matchedMeters - targetMeters) / targetMeters;
      const score = bestAtCenter.avgSimilarity * (1 + 0.35 * distanceError);

      if (!bestOverall || score < bestOverall.score) {
        bestOverall = { ...bestAtCenter, score };
      }
    }

    if (!bestOverall) {
      throw new Error("Couldn’t fit this figure nearby. Try more miles, or move to a more grid-like area.");
    }

    // Draw layers
    idealLayer = L.layerGroup(
      bestOverall.idealStrokesLatLng.map(st =>
        L.polyline(st, { color: "#f97316", weight: 3, dashArray: "6 8", opacity: 0.85 })
      )
    ).addTo(map);

    fullLayer = L.layerGroup(
      bestOverall.fullSegs.map(seg =>
        L.polyline(seg, { color: "#60a5fa", weight: 6, opacity: 0.45 })
      )
    ).addTo(map);

    connectorLayer = L.layerGroup(
      bestOverall.connectorSegs.map(seg =>
        L.polyline(seg, { color: "#d4d4d8", weight: 3, opacity: 0.30 })
      )
    ).addTo(map);

    shapeLayer = L.layerGroup(
      bestOverall.matchedStrokesLatLng.map(seg =>
        L.polyline(seg, { color: "#22c55e", weight: 8, opacity: 1.0 })
      )
    ).addTo(map);

    map.fitBounds(shapeLayer.getBounds(), { padding: [20, 20] });

    setStatus(`Ready ✅ (shifted center + rotated ${bestOverall.deg}° for best fit)`);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e));
  }
}

// UI
$("shapes").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-shape]");
  if (!btn) return;
  selectedShape = btn.dataset.shape;
  [...$("shapes").querySelectorAll(".pill")].forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
});

$("build").addEventListener("click", buildRoute);
