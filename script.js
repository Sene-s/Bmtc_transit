const API_BASE = "https://bmtc-transit.onrender.com"; 
const map = L.map('map', { zoomControl: false }).setView([12.97, 77.59], 13);  
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
}).addTo(map);

let sId = null, eId = null;
let routeLayers = [];
const searchTimers = {};

function onSearch(type) {
    const q = document.getElementById(type + 'In').value.trim();
    const list = document.getElementById(type + 'List');
    if (q.length < 2) { list.classList.remove('open'); return; }

    clearTimeout(searchTimers[type]);
    searchTimers[type] = setTimeout(async () => {
        try {
            const res = await fetch(`${API_BASE}/stops/search?q=${encodeURIComponent(q)}`);
            const data = await res.json();
            list.innerHTML = '';
            data.forEach(s => {
                const item = document.createElement('div');
                item.className = 'dropdown-item';
                const name = document.createElement('span');
                name.textContent = s.name;
                name.onclick = () => {
                    if (type === 's') sId = s.id; else eId = s.id;
                    document.getElementById(type + 'In').value = s.name;
                    list.classList.remove('open');
                };
                const fav = document.createElement('button');
                fav.className = 'mini-fav-btn';
                fav.textContent = '⭐';
                fav.onclick = (e) => { e.stopPropagation(); addFav(s.id, s.name); };
                item.append(name, fav);
                list.appendChild(item);
            });
            list.classList.add('open');
        } catch(e) { console.error(e); }
    }, 300);
}

async function run() {
    if (!sId || !eId) return alert("Select stops!");
    const out = document.getElementById('out');
    out.innerHTML = '<div style="padding:20px;">Finding optimal route...</div>';
    try {
        const res = await fetch(`${API_BASE}/route?start=${sId}&end=${eId}`);
        const data = await res.json();
        if (data.error) { out.innerHTML = `<div style="padding:20px; color:red;">${data.error}</div>`; return; }

        out.innerHTML = `
            <div class="route-header">
                <div class="route-number">${data.legs[0].route || 'Bus'}</div>
                <div class="route-title">${data.legs[0].stops[0].name} ⇌ ${data.legs.at(-1).stops.at(-1).name}</div>
            </div>
            <div class="summary-bar">
                <div class="stat-card"><div class="stat-value">${data.total_time}</div><div class="stat-label">Mins</div></div>
                <div class="stat-card"><div class="stat-value">${data.total_stops}</div><div class="stat-label">Stops</div></div>
                <div class="stat-card"><div class="stat-value">${data.transfers}</div><div class="stat-label">Transfers</div></div>
            </div>
            <div class="timeline-container">
                ${data.legs.flatMap(l => l.stops.map((s, i) => `
                    <div class="stop-row" style="${i===0?'font-weight:bold;color:#fff':''}">
                        ${s.name}
                        ${i===0?`<br><span class="route-badge" style="background:${l.type==='bus'?'#22c55e':'#f97316'}">${l.type.toUpperCase()} ${l.route||''}</span>`:''}
                    </div>
                `)).join('')}
            </div>
        `;

        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];
        const stops = data.legs.flatMap(l => l.stops);
        for (const leg of data.legs) {
            let pts = leg.stops;
            if (pts.length > 20) pts = pts.filter((_, i) => i % Math.ceil(pts.length/15) === 0 || i === pts.length-1);
            const url = `https://router.project-osrm.org/route/v1/driving/${pts.map(p => `${p.lng},${p.lat}`).join(';')}?overview=full&geometries=geojson`;
            try {
                const r = await fetch(url);
                const d = await r.json();
                const poly = L.polyline(d.routes[0].geometry.coordinates.map(c => [c[1], c[0]]), { color: leg.type==='bus'?'#22c55e':'#ffc107', weight: 6 }).addTo(map);
                routeLayers.push(poly);
            } catch(e) {
                const poly = L.polyline(leg.stops.map(s => [s.lat, s.lng]), { color: '#666', dashArray: '5,5' }).addTo(map);
                routeLayers.push(poly);
            }
        }
        stops.forEach((s, i) => {
            const m = L.circleMarker([s.lat, s.lng], { radius: 5, color: '#000', fillColor: i === 0 ? '#22c55e' : '#fff', fillOpacity: 1 }).addTo(map);
            m.bindTooltip(s.name);
            routeLayers.push(m);
        });
        map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [40, 40] });
    } catch(e) { out.innerHTML = "Error loading journey."; }
}

async function loadFavs() {
    try {
        const res = await fetch(`${API_BASE}/favorites`);
        const data = await res.json();
        const list = document.getElementById('favorites-list');
        list.innerHTML = '';
        data.forEach(f => {
            const item = document.createElement('div');
            item.className = 'fav-item';
            const info = document.createElement('div');
            info.className = 'fav-info';
            info.onclick = () => {
                if (!sId) { sId = f.stop_id; document.getElementById('sIn').value = f.stops.stop_name; }
                else { eId = f.stop_id; document.getElementById('eIn').value = f.stops.stop_name; }
            };
            const nick = document.createElement('div');
            nick.className = 'fav-nickname';
            nick.textContent = f.nickname || 'Saved Spot';
            const sname = document.createElement('div');
            sname.className = 'fav-stopname';
            sname.textContent = f.stops.stop_name;
            info.append(nick, sname);

            const acts = document.createElement('div');
            const edit = document.createElement('button');
            edit.className = 'fav-btn';
            edit.textContent = '✎';
            edit.onclick = (e) => { e.stopPropagation(); editFav(f.stop_id, f.nickname); };
            const del = document.createElement('button');
            del.className = 'fav-btn';
            del.textContent = '×';
            del.style.color = '#ff4d4d';
            del.onclick = (e) => { e.stopPropagation(); delFav(f.stop_id); };
            acts.append(edit, del);
            item.append(info, acts);
            list.appendChild(item);
        });
    } catch(e) { console.error("Favs load error:", e); }
}

async function addFav(sid, name) {
    const nick = prompt(`Label for ${name}:`);
    if (nick === null) return;
    await fetch(`${API_BASE}/favorites/${sid}?nickname=${encodeURIComponent(nick)}`, { method: 'POST' });
    loadFavs();
}

async function editFav(sid, old) {
    const nick = prompt("New label:", old || "");
    if (nick === null) return;
    await fetch(`${API_BASE}/favorites/${sid}?nickname=${encodeURIComponent(nick)}`, { method: 'PUT' });
    loadFavs();
}

async function delFav(sid) {
    if (confirm("Remove bookmark?")) {
        await fetch(`${API_BASE}/favorites/${sid}`, { method: 'DELETE' });
        loadFavs();
    }
}

window.onload = loadFavs;