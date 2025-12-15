console.log("new version")
const $ = (id) => document.getElementById(id);

let selectedShape = "square";
let map;

// Leaflet layers
let routeLayer = null;       // full route (connectors + shape)
let shapeLayer = null;       // on-road “shape” segments only
let connectorLayer = null;   // on-road connectors only
let idealLayer = null;       // dashed “ideal” drawing

const milesToMeters = (mi) => mi * 1609.34;

// -------- Geometry helpers (in meters space) --------
function dist2(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

function polylineLength(pts) {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += dist2(pts[i - 1], pts[i]);
  return sum;
}

function resamplePolyline(pts, n) {
  // Return ~n points equally spaced along the polyline length
  if (pts.length < 2) return pts;
  const total = polylineLength(pts);
  if (total <= 1e-9) return pts;

  const targetStep = total / (n - 1);
  const out = [pts[0].slice()];
  let carried = 0;
  let i = 1;
  let prev = pts[0];

  while (out.length < n && i < pts.length) {
    const cur = pts[i];
    const segLen = dist2(prev, cur);

    if (carried + segLen >= targetStep) {
      const remain = targetStep - carried;
      const t = remain / segLen;
      const nx = prev[0] + t * (cur[0] - prev[0]);
      const ny = prev[1] + t * (cur[1] - prev[1]);
      const np = [nx, ny];
      out.push(np);
      prev = np;
      carried = 0;
    } else {
      carried += segLen;
      prev = cur;
      i++;
    }
  }

  if (out.length < n) out.push(pts[pts.length - 1].slice());
  return out;
}

function scaleStrokesToDistance(strokes, targetMeters) {
  // Scale all strokes together so total drawn length ~ targetMeters
  const totalLen = strokes.reduce((acc, s) => acc + polylineLength(s), 0);
  const scale = targetMeters / Math.max(totalLen, 1e-9);
  return strokes.map(st => st.map(([x, y]) => [x * scale, y * scale]));
}

// Convert local meters offsets (x east, y north) -> latlng near origin
function offsetToLatLng(originLat, originLng, xMetersEast, yMetersNorth) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180);

  return [
    originLat + (yMetersNorth / metersPerDegLat),
    originLng + (xMetersEast / metersPerDegLng)
  ];
}

async function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 3000 }
    );
  });
}

// -------- Shape definition as STROKES --------
// Each stroke is a polyline in normalized meter space.
// For square/heart: one stroke.
// For "hi": multiple strokes. Connectors between strokes are NOT part of the shape.
function getStrokes(shape) {
  if (shape === "square") {
    return [
      [
        [-0.5, -0.5],
        [ 0.5, -0.5],
        [ 0.5,  0.5],
        [-0.5,  0.5],
        [-0.5, -0.5]
      ]
    ];
  }

  if (shape === "heart") {
    const pts = [];
    const n = 120;
    for (let i = 0; i <= n; i++) {
      const t = (i / n) * 2 * Math.PI;
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y =
        13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t);
      pts.push([x / 18, y / 18]);
    }
    pts.push(pts[0]);
    return [pts];
  }

  // "hi" as strokes:
  // h: left vertical, cross, right vertical
  const h = [
    [-1.3, -0.8],
    [-1.3,  0.9],
    [-1.3,  0.1],
    [-0.7,  0.1],
    [-0.7,  0.9],
    [-0.7, -0.8]
  ];

  // i stem
  const iStem = [
    [0.4, -0.8],
    [0.4,  0.9]
  ];

  // dot as a tiny loop stroke
  const dot = [
    [0.4, 1.15],
    [0.48, 1.15],
    [0.48, 1.07],
    [0.4, 1.07],
    [0.4, 1.15]
  ];

  return [h, iStem, dot];
}

// -------- OSRM routing --------
// We route each piece separately and then draw as separate layers (shape vs connector).
// OSRM endpoint: router.project-osrm.org
async function osrmRouteFoot(latlngs, steps = true) {
  // latlngs: [[lat,lng], ...] (must be 2+)
  const coords = latlngs.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url =
    `https://router.project-osrm.org/route/v1/foot/${coords}` +
    `?overview=full&geometries=geojson&steps=${steps ? "true" : "false"}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OSRM request failed (${res.status})`);
  const data = await res.json();
  if (!data.routes?.length) throw new Error("No route found in this area.");
  return data.routes[0];
}

function geojsonToLatLngs(geojsonLine) {
  // geojsonLine.coordinates is [lng,lat]
  return geojsonLine.coordinates.map(([lng, lat]) => [lat, lng]);
}

function clearLayers() {
  [routeLayer, shapeLayer, connectorLayer, idealLayer].forEach(l => {
    if (l) l.remove();
  });
  routeLayer = shapeLayer = connectorLayer = idealLayer = null;
}

function setStatus(msg) {
  $("status").textContent = msg;
}

function renderSteps(allSteps) {
  const root = $("steps");
  root.innerHTML = "";
  allSteps.forEach((s, idx) => {
    const div = document.createElement("div");
    div.className = "step";
    div.innerHTML = `<div><strong>Step ${idx + 1}</strong> · <span style="opacity:.7">${s.distance}</span></div>
                     <div style="margin-top:6px">${s.instruction}</div>`;
    root.appendChild(div);
  });
}

// -------- Build route with “shape segments” and “connectors” --------
async function buildRoute() {
  try {
    setStatus("Getting your location…");
    const miles = Number($("miles").value || 0);
    if (!Number.isFinite(miles) || miles <= 0) throw new Error("Enter a valid miles value.");

    const [lat, lng] = await getLocation();

    if (!map) {
      map = L.map("map").setView([lat, lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19
      }).addTo(map);
    }

    clearLayers();
    $("steps").innerHTML = "";

    // 1) Build ideal strokes in meters, scale to target distance
    const targetMeters = milesToMeters(miles);
    let strokes = getStrokes(selectedShape);
    strokes = scaleStrokesToDistance(strokes, targetMeters);

    // 2) Create "ideal dashed outline" (not road-snapped)
    const idealLatLngStrokes = strokes.map(st =>
      st.map(([x, y]) => offsetToLatLng(lat, lng, x, y))
    );

    idealLayer = L.layerGroup(
      idealLatLngStrokes.map(st =>
        L.polyline(st, { color: "#f97316", weight: 4, dashArray: "6 8", opacity: 0.9 })
      )
    ).addTo(map);

    // 3) Create anchor points for routing:
    //    More anchors => better resemblance, but too many = slower/more requests.
    const ANCHORS_PER_STROKE = 18;

    const strokeAnchors = strokes.map(st => resamplePolyline(st, ANCHORS_PER_STROKE))
      .map(st => st.map(([x, y]) => offsetToLatLng(lat, lng, x, y)));

    // 4) Plan pieces:
    //    - connector: origin -> start of stroke 1
    //    - shape: each stroke routed through its anchors
    //    - connector: end stroke k -> start stroke k+1
    //    - connector: end last stroke -> origin
    const origin = [lat, lng];

    const pieces = [];

    // connector to first stroke
    pieces.push({ kind: "connector", from: origin, toPolyline: [origin, strokeAnchors[0][0]] });

    // each stroke as a "shape" piece
    for (let i = 0; i < strokeAnchors.length; i++) {
      pieces.push({ kind: "shape", from: strokeAnchors[i][0], toPolyline: strokeAnchors[i] });

      // connector to next stroke start (if exists)
      if (i < strokeAnchors.length - 1) {
        const end = strokeAnchors[i][strokeAnchors[i].length - 1];
        const nextStart = strokeAnchors[i + 1][0];
        pieces.push({ kind: "connector", from: end, toPolyline: [end, nextStart] });
      }
    }

    // connector back to origin
    {
      const lastStroke = strokeAnchors[strokeAnchors.length - 1];
      const end = lastStroke[lastStroke.length - 1];
      pieces.push({ kind: "connector", from: end, toPolyline: [end, origin] });
    }

    setStatus("Routing on roads… (this may take a few seconds)");

    // 5) Route each piece with OSRM and collect:
    const fullLatLngs = [];
    const shapeLatLngs = [];
    const connectorLatLngs = [];
    const allSteps = [];

    for (const piece of pieces) {
      // For a shape piece, we route through many anchors to “force” the geometry.
      // OSRM supports multiple coords in one route request.
      const route = await osrmRouteFoot(piece.toPolyline, true);

      const line = geojsonToLatLngs(route.geometry);

      // Append without duplicating the joint point
      if (fullLatLngs.length > 0 && line.length > 0) line.shift();
      fullLatLngs.push(...line);

      if (piece.kind === "shape") {
        shapeLatLngs.push(line);
      } else {
        connectorLatLngs.push(line);
      }

      // Collect turn steps (for MVP we just concatenate; you could later label “connector vs shape”)
      route.legs.forEach(leg => {
        leg.steps.forEach(st => {
          allSteps.push({
            instruction: st.maneuver.instruction,
            distance: st.distance?.toFixed ? `${Math.round(st.distance)} m` : ""
          });
        });
      });
    }

    // 6) Draw layers:
    // Full route (base)
    routeLayer = L.polyline(fullLatLngs, { color: "#60a5fa", weight: 6, opacity: 0.75 }).addTo(map);

    // Connector segments (distinct)
    connectorLayer = L.layerGroup(
      connectorLatLngs.map(seg => L.polyline(seg, { color: "#a3a3a3", weight: 6, opacity: 0.85 }))
    ).addTo(map);

    // Shape segments highlighted on top
    shapeLayer = L.layerGroup(
      shapeLatLngs.map(seg => L.polyline(seg, { color: "#22c55e", weight: 7, opacity: 0.95 }))
    ).addTo(map);

    map.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });

    // 7) Render turn-by-turn
    renderSteps(allSteps);

    setStatus("Route ready ✅  (Green = drawing, Gray = connector, Orange dashed = ideal shape)");
  } catch (err) {
    console.error(err);
    setStatus(err?.message || String(err));
  }
}

// -------- UI wiring --------
$("shapes").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-shape]");
  if (!btn) return;
  selectedShape = btn.dataset.shape;
  [...$("shapes").querySelectorAll(".pill")].forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
});

$("build").addEventListener("click", buildRoute);
