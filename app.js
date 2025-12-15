const $ = (id) => document.getElementById(id);

let selectedShape = "hi";
let map;

// Layers
let idealLayer, shapeLayer, connectorLayer, fullLayer;

const OSRM = "https://router.project-osrm.org";

// ---------- Utilities ----------
const milesToMeters = (mi) => mi * 1609.34;

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

// meters (east, north) -> [lat,lng]
function offsetToLatLng(originLat, originLng, xE, yN) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);
  return [
    originLat + (yN / metersPerDegLat),
    originLng + (xE / metersPerDegLng)
  ];
}

function rotatePts(pts, angleRad) {
  const c = Math.cos(angleRad), s = Math.sin(angleRad);
  return pts.map(([x,y]) => [x*c - y*s, x*s + y*c]);
}

function polyLen(pts) {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i-1][0];
    const dy = pts[i][1] - pts[i-1][1];
    sum += Math.hypot(dx, dy);
  }
  return sum;
}

function scaleStrokes(strokes, targetMeters) {
  const total = strokes.reduce((acc, st) => acc + polyLen(st), 0);
  const k = targetMeters / Math.max(total, 1e-9);
  return strokes.map(st => st.map(([x,y]) => [x*k, y*k]));
}

// resample to N evenly-spaced points along polyline
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
      const nx = prev[0] + t * (cur[0] - prev[0]);
      const ny = prev[1] + t * (cur[1] - prev[1]);
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

  if (out.length < N) out.push(pts[pts.length - 1].slice());
  return out;
}

// distance from point to polyline (latlng space)
function pointToSegmentDist(p, a, b) {
  const px = p[0], py = p[1];
  const ax = a[0], ay = a[1];
  const bx = b[0], by = b[1];
  const vx = bx-ax, vy = by-ay;
  const wx = px-ax, wy = py-ay;
  const c1 = vx*wx + vy*wy;
  if (c1 <= 0) return Math.hypot(px-ax, py-ay);
  const c2 = vx*vx + vy*vy;
  if (c2 <= c1) return Math.hypot(px-bx, py-by);
  const t = c1 / c2;
  const proj = [ax + t*vx, ay + t*vy];
  return Math.hypot(px-proj[0], py-proj[1]);
}

function meanDistance(idealPts, snappedPts) {
  // crude but effective: average distance from each ideal point to snapped polyline
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

// ---------- Shape strokes (meter space, normalized) ----------
function getStrokes(shape) {
  if (shape === "square") {
    return [[
      [-0.6,-0.6],[0.6,-0.6],[0.6,0.6],[-0.6,0.6],[-0.6,-0.6]
    ]];
  }

  if (shape === "heart") {
    const pts = [];
    const n = 140;
    for (let i = 0; i <= n; i++) {
      const t = (i/n) * 2*Math.PI;
      const x = 16*Math.pow(Math.sin(t),3) / 18;
      const y = (13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t)) / 18;
      pts.push([x,y]);
    }
    pts.push(pts[0]);
    return [pts];
  }

  // “hi” = 3 strokes (h, i-stem, dot)
  const h = [
    [-1.4,-0.8],[-1.4,0.9],[-1.4,0.1],[-0.8,0.1],[-0.8,0.9],[-0.8,-0.8]
  ];
  const iStem = [[0.5,-0.8],[0.5,0.9]];
  const dot = [[0.45,1.15],[0.55,1.15],[0.55,1.05],[0.45,1.05],[0.45,1.15]];
  return [h, iStem, dot];
}

// ---------- OSRM calls ----------
async function osrmMatchFoot(latlngs) {
  // OSRM expects lon,lat pairs
  const coords = latlngs.map(([lat,lng]) => `${lng},${lat}`).join(";");
  const url = `${OSRM}/match/v1/foot/${coords}?geometries=geojson&overview=full&steps=true`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== "Ok") throw new Error(data.message || "OSRM match failed");
  // Take the best matching
  const m = data.matchings?.[0];
  if (!m?.geometry) throw new Error("No matching geometry returned");
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

function geojsonToLatLngs(geo) {
  return geo.coordinates.map(([lng,lat]) => [lat,lng]);
}

function clearLayers() {
  [idealLayer, shapeLayer, connectorLayer, fullLayer].forEach(l => l && l.remove());
  idealLayer = shapeLayer = connectorLayer = fullLayer = null;
}

// ---------- Main build ----------
async function buildRoute() {
  try {
    setStatus("Getting location…");
    const miles = Number($("miles").value || 0);
    if (!Number.isFinite(miles) || miles <= 0) throw new Error("Enter miles > 0");

    const targetMeters = milesToMeters(miles);
    const [olat, olng] = await getLocation();

    if (!map) {
      map = L.map("map").setView([olat, olng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
    }
    clearLayers();
    $("steps").innerHTML = "";

    // Build strokes scaled to distance
    let strokes = getStrokes(selectedShape);
    strokes = scaleStrokes(strokes, targetMeters);

    // Rotate search (critical for letters)
    const anglesDeg = selectedShape === "hi"
      ? [0,15,30,45,60,75,90,105,120,135,150,165]
      : [0,30,60,90,120,150];

    setStatus("Finding best orientation…");

    // For each stroke, pick best rotation independently (works well for letters)
    const chosen = [];
    const allIdealLatLngStrokes = [];
    const allMatchedLatLngStrokes = [];
    const allConnectorLatLngs = [];
    const allFullLatLngs = [];
    const allSteps = [];

    let currentPos = [olat, olng];

    for (let si = 0; si < strokes.length; si++) {
      const stroke = strokes[si];

      let best = { score: Infinity, angle: 0, idealLatLngs: null, matchedLatLngs: null, matchObj: null };

      for (const deg of anglesDeg) {
        const rad = (deg * Math.PI) / 180;
        const rotated = rotatePts(stroke, rad);

        // Ideal latlngs (for scoring + dashed overlay)
        // Use ~60 points for overlay; use fewer for match due to OSRM limits.
        const idealDense = resample(rotated, 60).map(([x,y]) => offsetToLatLng(olat, olng, x, y));
        const idealForMatch = resample(rotated, 40).map(([x,y]) => offsetToLatLng(olat, olng, x, y));

        // OSRM match can fail if too many points; we keep it conservative.
        let match;
        try {
          match = await osrmMatchFoot(idealForMatch);
        } catch {
          continue;
        }

        const snapped = geojsonToLatLngs(match.geometry);
        const score = meanDistance(idealDense, snapped);

        if (score < best.score) {
          best = { score, angle: deg, idealLatLngs: idealDense, matchedLatLngs: snapped, matchObj: match };
        }
      }

      if (!best.idealLatLngs) throw new Error("Couldn’t match the shape to roads here. Try more miles or move location.");

      // Connector from currentPos to start of matched stroke (gray)
      const start = best.matchedLatLngs[0];
      const conn = await osrmRouteFoot(currentPos, start);
      const connLatLngs = geojsonToLatLngs(conn.geometry);

      allConnectorLatLngs.push(connLatLngs);
      allFullLatLngs.push(connLatLngs);

      conn.legs.forEach(leg => leg.steps.forEach(st => allSteps.push(st.maneuver.instruction)));

      // Stroke itself (green)
      allIdealLatLngStrokes.push(best.idealLatLngs);
      allMatchedLatLngStrokes.push(best.matchedLatLngs);
      allFullLatLngs.push(best.matchedLatLngs);

      // Steps from match: OSRM match returns legs like route objects in practice; if missing, we just show route steps.
      best.matchObj.legs?.forEach(leg => leg.steps?.forEach(st => allSteps.push(st.maneuver.instruction)));

      currentPos = best.matchedLatLngs[best.matchedLatLngs.length - 1];
      chosen.push(best);
    }

    // Connector back to origin (gray)
    const back = await osrmRouteFoot(currentPos, [olat, olng]);
    const backLatLngs = geojsonToLatLngs(back.geometry);
    allConnectorLatLngs.push(backLatLngs);
    allFullLatLngs.push(backLatLngs);
    back.legs.forEach(leg => leg.steps.forEach(st => allSteps.push(st.maneuver.instruction)));

    // Draw: ideal dashed (orange)
    idealLayer = L.layerGroup(
      allIdealLatLngStrokes.map(st => L.polyline(st, { color: "#f97316", weight: 3, dashArray: "6 8", opacity: 0.85 }))
    ).addTo(map);

    // Full route base (blue)
    fullLayer = L.layerGroup(
      allFullLatLngs.map(seg => L.polyline(seg, { color: "#60a5fa", weight: 6, opacity: 0.55 }))
    ).addTo(map);

    // Connectors (gray, thin)
    connectorLayer = L.layerGroup(
      allConnectorLatLngs.map(seg => L.polyline(seg, { color: "#d4d4d8", weight: 3, opacity: 0.35 }))
    ).addTo(map);

    // Shape strokes snapped (green, thick)
    shapeLayer = L.layerGroup(
      allMatchedLatLngStrokes.map(seg => L.polyline(seg, { color: "#22c55e", weight: 8, opacity: 1.0 }))
    ).addTo(map);

    // Fit bounds
    const bounds = shapeLayer.getBounds();
    map.fitBounds(bounds, { padding: [20, 20] });

    // Render instructions
    const root = $("steps");
    allSteps.forEach((txt, i) => {
      const d = document.createElement("div");
      d.className = "step";
      d.textContent = `${i + 1}. ${txt}`;
      root.appendChild(d);
    });

    setStatus("Ready ✅ Green=drawing, Gray=connector, Orange dashed=ideal.");
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
