const KEY = "steps-demo-v1";

const $ = (id) => document.getElementById(id);

const fmtDate = (d) => {
  // yyyy-mm-dd local
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const parseDate = (s) => {
  // interpret yyyy-mm-dd as local date
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

function loadMap() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function saveMap(map) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

function getLastNDays(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(d);
  }
  return out.reverse(); // oldest -> newest
}

function computeStats(map) {
  const days14 = getLastNDays(14).map(fmtDate);
  const values14 = days14.map((k) => Number(map[k] || 0));

  const todayKey = fmtDate(new Date());
  const todaySteps = Number(map[todayKey] || 0);

  const last7 = values14.slice(-7);
  const avg7 = last7.reduce((a, b) => a + b, 0) / 7;

  const total14 = values14.reduce((a, b) => a + b, 0);

  return { days14, values14, todaySteps, avg7, total14 };
}

function render() {
  const map = loadMap();
  const { days14, values14, todaySteps, avg7, total14 } = computeStats(map);

  $("todaySteps").textContent = String(Math.round(todaySteps));
  $("avg7").textContent = String(Math.round(avg7));
  $("total14").textContent = String(Math.round(total14));

  const list = $("list");
  list.innerHTML = "";

  for (let i = days14.length - 1; i >= 0; i--) {
    const dateKey = days14[i];
    const steps = Math.round(values14[i]);

    const row = document.createElement("div");
    row.className = "item";

    const left = document.createElement("div");
    left.className = "date";
    // display like "Dec 15, 2025"
    const d = parseDate(dateKey);
    left.textContent = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

    const right = document.createElement("div");
    right.className = "steps";
    right.textContent = steps.toLocaleString();

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);
  }
}

function setStatus(msg) {
  $("status").textContent = msg;
  if (msg) setTimeout(() => ($("status").textContent = ""), 2200);
}

$("logForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const date = $("dateInput").value;
  const steps = $("stepsInput").value;

  if (!date) return;

  const map = loadMap();
  map[date] = Number(steps || 0);
  saveMap(map);

  setStatus("Saved ✅");
  render();
});

$("seedBtn").addEventListener("click", () => {
  const map = loadMap();
  const days = getLastNDays(14);
  for (const d of days) {
    const k = fmtDate(d);
    if (map[k] == null) {
      // generate plausible sample steps
      const base = 6000 + Math.floor(Math.random() * 6000);
      map[k] = base;
    }
  }
  saveMap(map);
  setStatus("Sample data filled ✅");
  render();
});

$("clearBtn").addEventListener("click", () => {
  localStorage.removeItem(KEY);
  setStatus("Cleared.");
  render();
});

// default date input = today
$("dateInput").value = fmtDate(new Date());

render();
