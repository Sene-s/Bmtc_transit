const API_BASE = "https://bmtc-transit.onrender.com"; 
const map = L.map('map', { zoomControl: false }).setView([12.97, 77.59], 13);  
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
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
        } catch(e) { console.error("Search error:", e); }
    }, 300);
}

async function run() {
    if (!sId || !eId) return alert("Please select both stops from the list!");
    const out = document.getElementById('out');
    out.innerHTML = '<div style="padding:20px; color:#aaa;">Calculating best path...</div>';
    try {
        const res = await fetch(`${API_BASE}/route?start=${sId}&end=${eId}`);
        const data = await res.json();
        if (data.error) { out.innerHTML = `<div style="padding:20px; color:red;">❌ ${data.error}</div>`; return; }

        out.innerHTML = `
            <div class="summary-bar">
                <div class="stat-card"><b>${data.total_time}</b><br>Mins</div>
                <div class="stat-card"><b>${data.total_stops}</b><br>Stops</div>
                <div class="stat-card"><b>${data.transfers}</b><br>X-fers</div>
            </div>
            <div class="timeline-container">
                ${data.legs.flatMap(l => l.stops.map((s, i) => `
                    <div class="stop-row" style="${i===0?'font-weight:bold;color:#fff':''}">
                        ${s.name} ${i===0?`<span class="route-badge">${l.route||l.type}</span>`:''}
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
            const poly = L.polyline(pts.map(p => [p.lat, p.lng]), { color: leg.type==='bus'?'#22c55e':'#ffc107', weight: 5 }).addTo(map);
            routeLayers.push(poly);
        }
        stops.forEach((s, i) => {
            const m = L.circleMarker([s.lat, s.lng], { radius: 5, color: '#000', fillColor: i === 0 ? '#22c55e' : '#fff', fillOpacity: 1 }).addTo(map);
            m.bindTooltip(s.name);
            routeLayers.push(m);
        });
        map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [40, 40] });
    } catch(e) { out.innerHTML = "Backend error. Try again."; }
}

// ── FAVORITES (FULL INTERACTIVE CRUD) ──

async function loadFavs() {
    try {
        const res = await fetch(`${API_BASE}/favorites`);
        const data = await res.json();
        const list = document.getElementById('favorites-list');
        list.innerHTML = '';

        if (data.length === 0) {
            list.innerHTML = '<div style="color:#444; font-size:12px; padding:20px; text-align:center;">No bookmarks yet</div>';
            return;
        }

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

            const stop = document.createElement('div');
            stop.className = 'fav-stopname';
            stop.textContent = f.stops.stop_name;

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

            info.append(nick, stop);
            acts.append(edit, del);
            item.append(info, acts);
            list.appendChild(item);
        });
    } catch(e) { console.error("Favs failed to load."); }
}

async function addFav(sid, name) {
    const nick = prompt(`Label for ${name} (e.g. Home, Work):`);
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
    if (confirm("Delete this bookmark?")) {
        await fetch(`${API_BASE}/favorites/${sid}`, { method: 'DELETE' });
        loadFavs();
    }
}

window.onload = loadFavs;