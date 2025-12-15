const $ = id => document.getElementById(id);
let shape = "square";
let map, routeLayer;

const milesToMeters = mi => mi * 1609.34;

function shapePoints(type) {
  if (type === "square") {
    return [
      [-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]
    ];
  }
  if (type === "heart") {
    const pts=[];
    for (let t=0;t<=Math.PI*2;t+=0.15) {
      pts.push([
        16*Math.sin(t)**3/18,
        (13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t))/18
      ]);
    }
    pts.push(pts[0]);
    return pts;
  }
  // "hi"
  return [
    [-2,-1],[-2,1],[-2,0],[-1,0],[-1,1],[-1,-1],
    [1,-1],[1,1],[1,-1],[-2,-1]
  ];
}

function scalePath(path, meters) {
  let len=0;
  for (let i=1;i<path.length;i++) {
    const dx=path[i][0]-path[i-1][0];
    const dy=path[i][1]-path[i-1][1];
    len+=Math.hypot(dx,dy);
  }
  const s=meters/len;
  return path.map(p=>[p[0]*s,p[1]*s]);
}

function offset(lat,lng,x,y) {
  const mLat=111320;
  const mLng=111320*Math.cos(lat*Math.PI/180);
  return [lat+y/mLat, lng+x/mLng];
}

async function getLocation() {
  return new Promise((res,rej)=>{
    navigator.geolocation.getCurrentPosition(
      p=>res([p.coords.latitude,p.coords.longitude]),
      rej,
      {enableHighAccuracy:true}
    );
  });
}

async function buildRoute() {
  $("status").textContent="Getting location…";
  const miles=+$("miles").value;
  const meters=milesToMeters(miles);

  const [lat,lng]=await getLocation();
  if (!map) {
    map=L.map("map").setView([lat,lng],15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);
  }

  const pts=scalePath(shapePoints(shape),meters);
  const waypoints=pts.map(p=>offset(lat,lng,p[0],p[1]));

  const coords=waypoints.map(p=>`${p[1]},${p[0]}`).join(";");
  const url=`https://router.project-osrm.org/route/v1/foot/${coords}?overview=full&steps=true&geometries=geojson`;

  $("status").textContent="Routing…";
  const res=await fetch(url);
  const data=await res.json();

  if (routeLayer) routeLayer.remove();
  routeLayer=L.geoJSON(data.routes[0].geometry).addTo(map);
  map.fitBounds(routeLayer.getBounds());

  const steps=data.routes[0].legs[0].steps;
  $("steps").innerHTML="";
  steps.forEach(s=>{
    const div=document.createElement("div");
    div.className="step";
    div.innerHTML=s.maneuver.instruction;
    $("steps").appendChild(div);
  });

  $("status").textContent="Route ready ✅";
}

$("shapes").onclick=e=>{
  if (!e.target.dataset.shape) return;
  document.querySelectorAll(".pill").forEach(b=>b.classList.remove("selected"));
  e.target.classList.add("selected");
  shape=e.target.dataset.shape;
};

$("build").onclick=buildRoute;
