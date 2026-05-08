// ── CONFIGURATION ──────────────────────────────────────────────────────────
const API_BASE = "https://bmtc-transit.onrender.com"; // Your Render URL
const map = L.map('map', { zoomControl: false }).setView([12.97, 77.59], 13);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 19,
}).addTo(map);

let sId = null, eId = null;
let routeLayers = []; 

const debounceTimers = {};
function debounce(key, fn, delay = 300) {
    clearTimeout(debounceTimers[key]);
    debounceTimers[key] = setTimeout(fn, delay);
}

function onSearch(type) {
    debounce(type, () => search(type));
}

async function search(type) {
    const q = document.getElementById(type + 'In').value.trim();
    const list = document.getElementById(type + 'List');
    
    if (q.length < 2) { 
        list.classList.remove('open'); 
        return; 
    }

    try {
        const res = await fetch(`${API_BASE}/stops/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        renderDropdown(type, data);
    } catch (err) {
        console.error("Search fetch failed:", err);
    }
}

function renderDropdown(type, stops) {
    const list = document.getElementById(type + 'List');
    list.innerHTML = '';

    if (!stops || stops.length === 0) {
        list.innerHTML = '<div class="dropdown-item" style="color:#ff4d4d">No stops found</div>';
        list.classList.add('open');
        return;
    }

    const seen = new Set();
    stops.forEach(s => {
        if (!seen.has(s.name)) {
            const el = document.createElement('div');
            el.className = 'dropdown-item';
            el.textContent = s.name;
            el.onclick = () => selectStop(type, s.id, s.name);
            list.appendChild(el);
            seen.add(s.name);
        }
    });
    list.classList.add('open');
}

function selectStop(type, id, name) {
    if (type === 's') sId = id; else eId = id;
    document.getElementById(type + 'In').value = name;
    document.getElementById(type + 'List').classList.remove('open');
}

document.addEventListener('click', e => {
    if (!e.target.closest('#sidebar')) {
        document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
    }
});

async function run() {
    if (!sId || !eId) return alert("Select stops from dropdown first!");
    
    const outDiv = document.getElementById('out');
    outDiv.innerHTML = '<div style="padding:20px; color:#aaa;">Calculating fastest path...</div>';

    try {
        // FIXED: Now uses API_BASE instead of localhost
        const res = await fetch(`${API_BASE}/route?start=${sId}&end=${eId}`);
        const data = await res.json();

        if (data.error) {
            outDiv.innerHTML = `<div style="padding:20px; color:#ff4d4d; font-weight:bold;">❌ ${data.error}</div>`;
            return; 
        }

        renderResult(data);
        drawRoute(data);

    } catch (e) {
        console.error("Routing failed:", e);
        outDiv.innerHTML = `<div style="padding:20px; color:red;">❌ Server unreachable. Checking connection...</div>`;
    }
}

function renderResult(data) {
    const out = document.getElementById('out');
    const firstLeg = data.legs[0];
    const lastLeg = data.legs[data.legs.length - 1];

    let html = `
        <div class="route-header">
            <div class="route-number">${firstLeg.route || 'Bus'}</div>
            <div class="route-title">
                ${firstLeg.stops[0].name} ⇌ <br>
                ${lastLeg.stops[lastLeg.stops.length-1].name}
            </div>
        </div>
        <div class="summary-bar">
            <div class="stat-card"><div class="stat-value">${data.total_time}</div><div class="stat-label">Mins</div></div>
            <div class="stat-card"><div class="stat-value">${data.total_stops}</div><div class="stat-label">Stops</div></div>
            <div class="stat-card"><div class="stat-value">${data.transfers || 0}</div><div class="stat-label">Transfers</div></div>
        </div>
        <div class="timeline-container">
    `;

    data.legs.forEach(leg => {
        leg.stops.forEach((stop, i) => {
            const isFirst = i === 0;
            html += `
                <div class="stop-row">
                    <div style="font-weight:${isFirst ? 'bold' : 'normal'}; color:${isFirst ? '#fff' : '#ccc'}">
                        ${stop.name}
                        ${isFirst && leg.type === 'bus' ? `<br><span class="route-badge">BUS ${leg.route}</span>` : ''}
                        ${isFirst && leg.type === 'walk' ? `<br><span class="route-badge" style="background:#ffc107">🚶 Walk</span>` : ''}
                    </div>
                </div>`;
        });
    });

    html += `</div>`;
    out.innerHTML = html;
}

async function drawRoute(data) {
    routeLayers.forEach(layer => map.removeLayer(layer));
    routeLayers = [];

    const allStops = data.legs.flatMap(leg => leg.stops);
    
    for (const leg of data.legs) {
        const color = leg.type === 'bus' ? '#22c55e' : '#ffc107';
        
        const coordsStr = leg.stops.map(s => `${s.lng},${s.lat}`).join(';');
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;

        try {
            const res = await fetch(osrmUrl);
            const rData = await res.json();
            const coords = rData.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
            const poly = L.polyline(coords, { color: color, weight: 6, opacity: 0.8 }).addTo(map);
            routeLayers.push(poly);
        } catch (e) {

            const line = L.polyline(leg.stops.map(s => [s.lat, s.lng]), { color: color, weight: 4, dashArray: '5,10' }).addTo(map);
            routeLayers.push(line);
        }
    }

    allStops.forEach((stop, i) => {
        const isEnd = i === 0 || i === allStops.length - 1;
        const m = L.circleMarker([stop.lat, stop.lng], {
            radius: isEnd ? 7 : 4,
            fillColor: i === 0 ? '#22c55e' : (i === allStops.length - 1 ? '#f97316' : '#fff'),
            color: '#000', weight: 2, fillOpacity: 1
        }).addTo(map);
        m.bindTooltip(stop.name);
        routeLayers.push(m);
    });

    map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [40, 40] });
}

function prefillStop(id, name) {
    if (!sId) { sId = id; document.getElementById('sIn').value = name; }
    else { eId = id; document.getElementById('eIn').value = name; }
}

function escHtml(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
    return String(str ?? '').replace(/"/g, '&quot;');
}