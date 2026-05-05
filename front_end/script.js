
    const API_BASE = "https://bmtc-transit.onrender.com"   ; 
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
        if (q.length < 2) { list.classList.remove('open'); return; }

        try {
            
            const res  = await fetch(`${API_BASE}/stops/search?q=${encodeURIComponent(q)}`);
            const data = await res.json();

            console.log(`Search results for ${q}:`, data);
        
        if (data.length === 0) {
            console.warn("Backend returned ZERO results. Check your Python search score.");
        }
            renderDropdown(type, data);
    } catch (err) {
        console.error("Fetch failed:", err);
    }

    function renderDropdown(type, stops) {
    const list = document.getElementById(type + 'List');
    
    if (!stops || stops.length === 0) {
        list.innerHTML = '<div class="dropdown-item" style="color:red">No stops found</div>';
        list.classList.add('open');
        return;
    }

    list.innerHTML = '';
    stops.forEach(s => {
        const el = document.createElement('div');
        el.className = 'dropdown-item';
        el.textContent = s.name;
        el.onclick = () => selectStop(type, s.id, s.name);
        list.appendChild(el);
    });
    list.classList.add('open');
}
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
        if (!sId || !eId) return;

        const btn = document.getElementById('find-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>Finding route…';
        document.getElementById('out').innerHTML = '';

        clearMapLayers();

        try {
            const res  = await fetch(`${API_BASE}/route?start=${encodeURIComponent(sId)}&end=${encodeURIComponent(eId)}`);
            const data = await res.json();

            if (data.error) {
                renderError(data.error, data.suggestions);
            } else {
                renderResult(data);
                drawRoute(data.legs);
            }
        } catch (err) {
            renderError('Could not reach the server. Is the backend running?');
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
            const coords  = leg.stops.map(s => [s.lat, s.lng]);
            allCoords.push(...coords);

            
            const isBus  = leg.type === 'bus';
            const line   = L.polyline(coords, {
                color:     isBus ? '#22c55e' : '#f59e0b',
                weight:    isBus ? 5 : 3,
                opacity:   0.9,
                dashArray: isBus ? null : '6 8',
            }).addTo(map);
            routeLayers.push(line);

            
            leg.stops.forEach((s, i) => {
                const isTerminal = (i === 0 || i === leg.stops.length - 1);
                const m = L.circleMarker([s.lat, s.lng], {
                    radius:      isTerminal ? 6 : 3,
                    color:       isBus ? '#22c55e' : '#f59e0b',
                    weight:      2,
                    fillColor:   isTerminal ? '#fff' : (isBus ? '#22c55e' : '#f59e0b'),
                    fillOpacity: 1,
                }).addTo(map);
                m.bindTooltip(s.name, { direction: 'top', offset: [0, -6] });
                routeLayers.push(m);
            });
        });

        if (allCoords.length) {
            map.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] });
        }
    }

    
    function renderError(msg, suggestions) {
        let html = `<div class="error-msg">${escHtml(msg)}</div>`;
        if (suggestions && suggestions.length) {
            html += `<div style="font-size:13px;color:#666;margin-bottom:8px;">Did you mean:</div>`;
            html += suggestions.map(s =>
                `<div class="dropdown-item" style="border-radius:8px;margin-bottom:4px;cursor:pointer"
                      onclick="prefillStop('${escAttr(s.id)}','${escAttr(s.name)}')">${escHtml(s.name)}</div>`
            ).join('');
        }
        document.getElementById('out').innerHTML = html;
    }

    function renderResult(data) {
        const transfers = data.transfers ?? 0;

        const summaryHtml = `
            <div class="summary">
                <div class="stat-card">
                    <div class="stat-value">${Math.round(data.total_time)}</div>
                    <div class="stat-label">Minutes</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${data.total_stops}</div>
                    <div class="stat-label">Stops</div>
                </div>
                <div class="stat-card">
                    <div class="stat-value">${transfers}</div>
                    <div class="stat-label">Transfers</div>
                </div>
            </div>`;

        const legsHtml = data.legs.map((leg, idx) => {
            const isLast    = idx === data.legs.length - 1;
            const isBus     = leg.type === 'bus';
            const dotClass  = isLast ? 'dot-dest' : (isBus ? 'dot-bus' : 'dot-walk');
            const lineClass = isBus ? 'leg-line-bus' : 'leg-line-walk';
            const lineExtra = isLast ? 'leg-line-last' : '';
            const from      = leg.stops[0].name;
            const to        = leg.stops[leg.stops.length - 1].name;
            const count     = leg.stops.length;

            const modeBadge = isBus
                ? `<span class="route-badge">&#9650; ${escHtml(leg.route_short_name || leg.route || 'Bus')}</span>`
                : `<span class="walk-badge">&#128694; Walk</span>`;

            
            const transferRow = (!isLast && isBus && idx > 0 && data.legs[idx - 1]?.type === 'bus')
                ? `<div class="transfer-row">&#8646; Transfer at ${escHtml(from)}</div>`
                : '';

            return `${transferRow}<div class="leg-card">
                <div class="leg-dot ${dotClass}"></div>
                ${!isLast ? `<div class="leg-line ${lineClass} ${lineExtra}"></div>` : ''}
                <div class="leg-body">
                    <div class="leg-from">${escHtml(from)}</div>
                    <div class="leg-meta">
                        ${modeBadge}
                        <span class="leg-stops-count">${count} stop${count !== 1 ? 's' : ''}</span>
                    </div>
                    ${!isLast ? `<div class="leg-alight">Alight at <span>${escHtml(to)}</span></div>` : ''}
                </div>
            </div>`;
        }).join('');

        document.getElementById('out').innerHTML = summaryHtml + legsHtml;
    }

    function prefillStop(id, name) {
        if (!sId) { sId = id; document.getElementById('sIn').value = name; }
        else       { eId = id; document.getElementById('eIn').value = name; }
    }

    function escHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function escAttr(str) {
        return String(str ?? '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    }