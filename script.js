const API_BASE = "https://bmtc-transit.onrender.com"; 
const map = L.map('map', { zoomControl: false }).setView([12.97, 77.59], 13);  
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    attribution: '© OpenStreetMap contributors' 
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
    if (!sId || !eId) return alert("Select both stops!");
    const out = document.getElementById('out');
    out.innerHTML = '<div style="padding:20px; color:#aaa;">Calculating journey...</div>';
    
    try {
        const res = await fetch(`${API_BASE}/route?start=${sId}&end=${eId}`);
        const data = await res.json();
        if (data.error) { out.innerHTML = `<div style="padding:20px; color:red;">${data.error}</div>`; return; }

        out.innerHTML = `
            <div class="summary-bar">
                <div class="stat-card"><b>${data.total_time}</b><br>Mins</div>
                <div class="stat-card"><b>${data.total_stops}</b><br>Stops</div>
                <div class="stat-card"><b>${data.transfers}</b><br>Transfers</div>
            </div>
            <div class="timeline-container">
                ${data.legs.flatMap(l => l.stops.map((s, i) => `
                    <div class="stop-row" style="${i===0?'font-weight:bold;color:#fff':''}">
                        ${s.name} ${i===0?`<span class="route-badge" style="background:${l.type==='bus'?'#22c55e':'#f97316'}">${l.type.toUpperCase()} ${l.route||''}</span>`:''}
                    </div>
                `)).join('')}
            </div>
        `;

        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];
        const seen = new Set();

        // Use sequential drawing to ensure the line segments connect perfectly
        for (const leg of data.legs) {
            let pts = leg.stops.filter(s => s.lat !== 0);
            if (pts.length < 2) continue;

            const color = leg.type === 'bus' ? '#22c55e' : '#ffc107';
            
            // For longer routes, we sample points to prevent URL limit errors
            let queryPts = pts;
            if (pts.length > 15) queryPts = pts.filter((_, i) => i % Math.ceil(pts.length/10) === 0 || i === pts.length-1);
            
            const url = `https://router.project-osrm.org/route/v1/driving/${queryPts.map(p => `${p.lng},${p.lat}`).join(';')}?overview=full&geometries=geojson`;
            
            try {
                const r = await fetch(url);
                const d = await r.json();
                const coords = d.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
                
                // BRIDGE THE GAP: Add the exact marker location to the start and end of the road path
                const poly = L.polyline([[pts[0].lat, pts[0].lng], ...coords, [pts.at(-1).lat, pts.at(-1).lng]], { color, weight: 6 }).addTo(map);
                routeLayers.push(poly);
            } catch(e) {
                // Fallback to straight line if OSRM is down
                const poly = L.polyline(pts.map(p => [p.lat, p.lng]), { color, weight: 4, dashArray: '5,5' }).addTo(map);
                routeLayers.push(poly);
            }

            leg.stops.forEach((s, idx) => {
                if (seen.has(s.id) || s.lat === 0) return;
                seen.add(s.id);
                const m = L.circleMarker([s.lat, s.lng], { radius: 5, color: '#000', fillColor: idx === 0 ? '#22c55e' : '#fff', fillOpacity: 1 }).addTo(map);
                m.bindTooltip(s.name);
                routeLayers.push(m);
            });
        }
        
        if (routeLayers.length > 0) map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [40, 40] });

    } catch(e) { out.innerHTML = "Server connection failed."; }
}

async function loadFavs() {
    try {
        const res = await fetch(`${API_BASE}/favorites`);
        const data = await res.json();
        const list = document.getElementById('favorites-list');
        list.innerHTML = '';
        if (!data.length) { list.innerHTML = '<div style="color:#444; font-size:12px; padding:20px; text-align:center;">No bookmarks yet</div>'; return; }

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
            nick.textContent = f.nickname || 'Saved Stop';
            const sname = document.createElement('div');
            sname.className = 'fav-stopname';
            sname.textContent = f.stops.stop_name;
            info.append(nick, sname);

            const acts = document.createElement('div');
            acts.className = 'fav-actions';
            const edit = document.createElement('button');
            edit.textContent = '✎';
            edit.className = 'fav-btn';
            edit.onclick = (e) => { e.stopPropagation(); editFav(f.stop_id, f.nickname); };
            const del = document.createElement('button');
            del.textContent = '×';
            del.className = 'fav-btn';
            del.style.color = '#ff4d4d';
            del.onclick = (e) => { e.stopPropagation(); delFav(f.stop_id); };
            
            acts.append(edit, del);
            item.append(info, acts);
            list.appendChild(item);
        });
    } catch(e) { console.error(e); }
}

async function addFav(sid, name) {
    const nick = prompt(`Label for ${name}:`);
    if (nick === null) return;
    await fetch(`${API_BASE}/favorites/${sid}?nickname=${encodeURIComponent(nick)}`, { method: 'POST' });
    loadFavs();
}

async function editFav(sid, old) {
    const nick = prompt("Update label:", old || "");
    if (nick === null) return;
    await fetch(`${API_BASE}/favorites/${sid}?nickname=${encodeURIComponent(nick)}`, { method: 'PUT' });
    loadFavs();
}

async function delFav(sid) {
    if (confirm("Delete bookmark?")) { await fetch(`${API_BASE}/favorites/${sid}`, { method: 'DELETE' }); loadFavs(); }
}

window.onload = loadFavs;