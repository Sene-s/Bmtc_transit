const API_BASE = "https://bmtc-transit.onrender.com"; 
const map = L.map('map', { zoomControl: false }).setView([12.97, 77.59], 13);  
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(map);

let sId = null, eId = null;
let routeLayers = [];

function showToast(msg, isError = false) {
    const t = document.createElement('div');
    t.className = `toast ${isError ? 'err' : ''}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 100);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 500); }, 3000);
}

function nicePrompt(title, desc, isInput = false, initialVal = "") {
    return new Promise((resolve) => {
        const overlay = document.getElementById('modal-overlay');
        const input = document.getElementById('modal-input');
        const confirmBtn = document.getElementById('modal-confirm');
        const cancelBtn = document.getElementById('modal-cancel');
        
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-desc').textContent = desc;
        
        input.style.display = isInput ? 'block' : 'none';
        input.value = initialVal;
        overlay.classList.add('show');
        if(isInput) setTimeout(() => input.focus(), 100);

        function cleanup(val) {
            overlay.classList.remove('show');
            confirmBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(val);
        }

        confirmBtn.onclick = () => cleanup(isInput ? input.value : true);
        cancelBtn.onclick = () => cleanup(null);
    });
}


function onSearch(type) {
    const q = document.getElementById(type + 'In').value.trim();
    const list = document.getElementById(type + 'List');
    if (q.length < 2) { list.classList.remove('open'); return; }

    clearTimeout(window.searchT);
    window.searchT = setTimeout(async () => {
        const res = await fetch(`${API_BASE}/stops/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        list.innerHTML = '';
        data.forEach(s => {
            const row = document.createElement('div');
            row.className = 'dropdown-item';
            const span = document.createElement('span');
            span.textContent = s.name;
            span.onclick = () => {
                if (type === 's') sId = s.id; else eId = s.id;
                document.getElementById(type + 'In').value = s.name;
                list.classList.remove('open');
            };
            const fav = document.createElement('button');
            fav.className = 'mini-fav-btn';
            fav.textContent = '⭐';
            fav.onclick = (e) => { e.stopPropagation(); addFav(s.id, s.name); };
            row.append(span, fav);
            list.appendChild(row);
        });
        list.classList.add('open');
    }, 300);
}

async function run() {
    if (!sId || !eId) return showToast("Select both stops first!", true);
    const out = document.getElementById('out');
    out.innerHTML = '<div style="padding:20px; color:#aaa;">Routing...</div>';
    try {
        const res = await fetch(`${API_BASE}/route?start=${sId}&end=${eId}`);
        const data = await res.json();
        if (data.error) { out.innerHTML = `<div style="padding:20px; color:red;">${data.error}</div>`; return; }

        out.innerHTML = `
            <div class="summary-bar">
                <div class="stat-card"><b>${data.total_time}</b><br>Mins</div>
                <div class="stat-card"><b>${data.total_stops}</b><br>Stops</div>
                <div class="stat-card"><b>${data.transfers}</b><br>X-fers</div>
            </div>
            <div class="timeline-container">
                ${data.legs.flatMap(l => l.stops.map((s, i) => `
                    <div class="stop-row" style="${i===0?'font-weight:bold;color:#fff':''}">
                        ${s.name} ${i===0?`<span class="route-badge">${l.route || 'WALK'}</span>`:''}
                    </div>
                `)).join('')}
            </div>
        `;

        routeLayers.forEach(l => map.removeLayer(l));
        routeLayers = [];
        const seen = new Set();
        for (const leg of data.legs) {
            let pts = leg.stops;
            if (pts.length > 15) pts = pts.filter((_, i) => i % Math.ceil(pts.length/12) === 0 || i === pts.length-1);
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
            leg.stops.forEach((s, idx) => {
                if (seen.has(s.id)) return;
                seen.add(s.id);
                const m = L.circleMarker([s.lat, s.lng], { radius: 5, color: '#000', fillColor: idx === 0 ? '#22c55e' : '#fff', fillOpacity: 1 }).addTo(map);
                m.bindTooltip(s.name);
                routeLayers.push(m);
            });
        }
        setTimeout(() => map.fitBounds(L.featureGroup(routeLayers).getBounds(), { padding: [40, 40] }), 500);
    } catch(e) { out.innerHTML = "Backend connection failed."; }
}

async function loadFavs() {
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
        nick.textContent = f.nickname || 'Saved Stop';
        const sname = document.createElement('div');
        sname.className = 'fav-stopname';
        sname.textContent = f.stops.stop_name;
        info.append(nick, sname);

        const acts = document.createElement('div');
        acts.className = 'fav-actions';
        const sBtn = document.createElement('button'); sBtn.textContent = 'S'; sBtn.onclick = () => { sId = f.stop_id; document.getElementById('sIn').value = f.stops.stop_name; };
        const eBtn = document.createElement('button'); eBtn.textContent = 'E'; eBtn.onclick = () => { eId = f.stop_id; document.getElementById('eIn').value = f.stops.stop_name; };
        const edit = document.createElement('button'); edit.textContent = '✎'; edit.onclick = (e) => { e.stopPropagation(); editFav(f.stop_id, f.nickname); };
        const del = document.createElement('button'); del.textContent = '×'; del.style.color='red'; del.onclick = (e) => { e.stopPropagation(); delFav(f.stop_id); };
        acts.append(sBtn, eBtn, edit, del);
        item.append(info, acts);
        list.appendChild(item);
    });
}


async function addFav(sid, stopName) {
    const nick = await nicePrompt("Save Bookmark", `Enter a label for ${stopName}`, true);
    if (nick === null) return;

    const res = await fetch(`${API_BASE}/favorites/${sid}?nickname=${encodeURIComponent(nick || "Saved Stop")}`, { method: 'POST' });
    const data = await res.json();
    showToast(data.message);
    loadFavs();
}

async function editFav(sid, currentNick) {
    const nick = await nicePrompt("Update Label", "Choose a new name for this stop", true, currentNick);
    if (nick === null) return;

    await fetch(`${API_BASE}/favorites/${sid}?nickname=${encodeURIComponent(nick || "Saved Stop")}`, { method: 'PUT' });
    showToast("Bookmark updated");
    loadFavs();
}

async function delFav(sid) {
    const confirmed = await nicePrompt("Delete Bookmark?", "Are you sure you want to remove this stop from your favorites?");
    if (!confirmed) return;

    await fetch(`${API_BASE}/favorites/${sid}`, { method: 'DELETE' });
    showToast("Bookmark deleted", true);
    loadFavs();
}
window.onload = loadFavs;