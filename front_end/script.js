
const API_BASE = "https://bmtc-transit.onrender.com";
const map = L.map('map', { zoomControl: true }).setView([12.97, 77.59], 12);

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
        
        console.log(`Search results for ${q}:`, data);
        renderDropdown(type, data);
    } catch (err) {
        console.error("Fetch failed:", err);
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

    stops.forEach(s => {
        const el = document.createElement('div');
        el.className = 'dropdown-item';
        el.textContent = s.name;
        el.onclick = () => selectStop(type, s.id, s.name);
        list.appendChild(el);
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

// ── ROUTING LOGIC ──────────────────────────────────────────────────────────
async function run() {
    if (!sId || !eId) {
        alert("Please select both stops from the dropdown lists.");
        return;
    }

    const btn = document.getElementById('find-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Finding route…';
    document.getElementById('out').innerHTML = '';

    clearMapLayers();

    try {
        const res = await fetch(`${API_BASE}/route?start=${encodeURIComponent(sId)}&end=${encodeURIComponent(eId)}`);
        const data = await res.json();

        if (data.error) {
            renderError(data.error, data.suggestions);
        } else {
            renderResult(data);
            drawRoute(data.legs);
        }
    } catch (err) {
        renderError('Could not reach the server. Is the backend running on Render?');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Find Route';
    }
}

function clearMapLayers() {
    routeLayers.forEach(l => map.removeLayer(l));
    routeLayers = [];
}

function drawRoute(legs) {
    const allCoords = [];

    legs.forEach(leg => {
        const coords = leg.stops.map(s => [s.lat, s.lng]);
        allCoords.push(...coords);

        const isBus = leg.type === 'bus';
        const line = L.polyline(coords, {
            color: isBus ? '#22c55e' : '#f59e0b',
            weight: isBus ? 6 : 4,
            opacity: 0.9,
            dashArray: isBus ? null : '8 12',
        }).addTo(map);
        routeLayers.push(line);

        leg.stops.forEach((s, i) => {
            const isTerminal = (i === 0 || i === leg.stops.length - 1);
            const m = L.circleMarker([s.lat, s.lng], {
                radius: isTerminal ? 7 : 4,
                color: isBus ? '#22c55e' : '#f59e0b',
                weight: 2,
                fillColor: isTerminal ? '#fff' : (isBus ? '#22c55e' : '#f59e0b'),
                fillOpacity: 1,
            }).addTo(map);
            m.bindTooltip(s.name);
            routeLayers.push(m);
        });
    });

    if (allCoords.length) {
        map.fitBounds(L.latLngBounds(allCoords), { padding: [50, 50] });
    }
}

// ── UI RENDERING ──────────────────────────────────────────────────────────
function renderError(msg, suggestions) {
    let html = `<div class="error-msg">${escHtml(msg)}</div>`;
    if (suggestions && suggestions.length) {
        html += `<div style="font-size:12px;color:#888;margin-bottom:8px;">Try searching for:</div>`;
        html += suggestions.map(s =>
            `<div class="dropdown-item" style="border:1px solid #333; border-radius:8px; margin-bottom:5px;"
                  onclick="prefillStop('${escAttr(s.id)}','${escAttr(s.name)}')">${escHtml(s.name)}</div>`
        ).join('');
    }
    document.getElementById('out').innerHTML = html;
}

function renderResult(data) {
    const summaryHtml = `
        <div class="summary">
            <div class="stat-card">
                <div class="stat-value">${Math.round(data.total_time)}</div>
                <div class="stat-label">Mins</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${data.total_stops}</div>
                <div class="stat-label">Stops</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${data.transfers || 0}</div>
                <div class="stat-label">Changes</div>
            </div>
        </div>`;

    const legsHtml = data.legs.map((leg, idx) => {
        const isLast = idx === data.legs.length - 1;
        const isBus = leg.type === 'bus';
        const dotColor = isLast ? 'dot-dest' : (isBus ? 'dot-bus' : 'dot-walk');
        
        return `
            <div class="leg-card">
                <div class="leg-dot ${dotColor}"></div>
                <div class="leg-body">
                    <div class="leg-from">${escHtml(leg.stops[0].name)}</div>
                    <div class="leg-meta">
                        <span class="${isBus ? 'route-badge' : 'walk-badge'}">
                            ${isBus ? '🚌 ' + escHtml(leg.route_short_name || 'Bus') : '🚶 Walk'}
                        </span>
                        <span style="font-size:12px; color:#666">${leg.stops.length} stops</span>
                    </div>
                    ${!isLast ? `<div style="font-size:12px; color:#555">Get off at ${escHtml(leg.stops[leg.stops.length-1].name)}</div>` : ''}
                </div>
            </div>`;
    }).join('');

    document.getElementById('out').innerHTML = summaryHtml + legsHtml;
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
