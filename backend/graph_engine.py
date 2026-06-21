import asyncio
import heapq
import logging
import os
from math import asin, cos, radians, sin, sqrt
from typing import Optional

import igraph as ig
import msgpack
from scipy.spatial import KDTree
from supabase import AsyncClient, acreate_client

def haversine_dist(p1, p2):
    try:
        lat1, lon1, lat2, lon2 = map(radians, [p1[0], p1[1], p2[0], p2[1]])
        a = sin((lat2 - lat1)/2)**2 + cos(lat1)*cos(lat2)*sin((lon2 - lon1)/2)**2
        return 2 * asin(sqrt(a)) * 6371
    except: return 999

# VERSION BUMP: Forces a clean data sync
CACHE_FILE = "graph_cache_v_DATA_RECOVERY_MAY.msgpack"
TRANSFER_PENALTY = 5
WALK_SPEED_KM_PER_MIN = 0.08
WALK_RADIUS_KM = 1.5 

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

class TransitEngine:
    def __init__(self, url: str, key: str):
        self.url = url
        self.key = key
        self.G = ig.Graph(directed=True)
        self.stop_details = {}
        self.name_to_ids = {}
        self.stop_names_list = []
        self._node_index = {}
        self.supabase: Optional[AsyncClient] = None

    async def initialize(self):  
        log.info("🔌 Connecting to Supabase...")
        self.supabase = await acreate_client(self.url, self.key)

        if os.path.exists(CACHE_FILE):  
            try:
                log.info(f"📦 Loading cache: {CACHE_FILE}")
                self._load_cache()  
            except Exception as e:
                log.warning(f"Cache corrupt ({e}). Rebuilding...")
                await self._build()  
                self._save_cache()  
        else:  
            log.info("🏗️ Starting data ingestion from Supabase...")
            await self._build()  
            self._save_cache()  

        self._build_name_index()
        
        log.info(f"✅ ENGINE READY: {len(self.stop_details)} stops in memory.")
        
        # ── DEEP PROBE ──
        targets = ["kengeri", "kumbalagodu"]
        for t in targets:
            found = [s["name"] for s in self.stop_details.values() if t in s["name"].lower()]
            if found: log.info(f"📍 Probe '{t}': Found {len(found)} variants in memory.")
            else: log.error(f"❌ Probe '{t}': Still missing from search index!")

    async def _build(self):  
        # 1. LOAD ALL STOPS (Even those with missing coords)
        offset = 0  
        while True:  
            res = await self.supabase.table("stops").select("stop_id,stop_name,stop_lat,stop_lon").range(offset, offset + 999).execute()  
            if not res.data: break  
            
            for s in res.data:
                name = s["stop_name"]
                sid = str(s["stop_id"]).strip()
                lat, lon = s.get("stop_lat"), s.get("stop_lon")
                
                # DIAGNOSTIC: Log exact DB state for Kumbalagodu
                if "kumbalagodu" in name.lower():
                    log.info(f"🔎 DB RAW DATA: Found '{name}' (ID: {sid}) Coords: ({lat}, {lon})")

                # Store details (we default to 0,0 if missing so they at least show in search)
                self.stop_details[sid] = {
                    "name": name, 
                    "lat": float(lat) if (lat is not None and lat != '') else 0.0, 
                    "lng": float(lon) if (lon is not None and lon != '') else 0.0
                }

            log.info(f"Stops Batch: Loaded up to index {offset + len(res.data)}")
            offset += 1000

        # Create Graph Vertices
        sids = list(self.stop_details.keys())
        self.G.add_vertices(len(sids))
        self.G.vs["sid"] = sids
        self._node_index = {sid: i for i, sid in enumerate(sids)}

        # 2. LOAD EDGES
        offset = 0
        while True:
            res = await self.supabase.table("graph_edges").select("*").range(offset, offset + 999).execute()
            if not res.data: break
            
            edges, weights, routes, names = [], [], [], []
            for e in res.data:
                u = self._node_index.get(str(e["source_id"]).strip())
                v = self._node_index.get(str(e["target_id"]).strip())
                
                if u is not None and v is not None:
                    edges.append((u, v))
                    weights.append(float(e["weight"]))
                    routes.append(e.get("route_id"))
                    names.append(e.get("route_short_name", "Bus"))
            
            if edges:
                self.G.add_edges(edges)
                n = len(edges)
                self.G.es[-(n):]["weight"] = weights
                self.G.es[-(n):]["type"] = ["bus"] * n
                self.G.es[-(n):]["route_id"] = routes
                self.G.es[-(n):]["route_short_name"] = names
            
            offset += 1000
            
        self._add_walking_mesh()

    def _add_walking_mesh(self):
        log.info("🚶 Building walking mesh...")
        sids = list(self.stop_details.keys())
        # Only create walking mesh for stops that have valid coordinates
        coords_with_idx = []
        for i, sid in enumerate(sids):
            d = self.stop_details[sid]
            if d["lat"] != 0 and d["lng"] != 0:
                coords_with_idx.append(((d["lat"], d["lng"]), i))
        
        if not coords_with_idx: return
        
        coords_only = [c[0] for c in coords_with_idx]
        actual_indices = [c[1] for c in coords_with_idx]
        tree = KDTree(coords_only)
        
        walk_edges, walk_weights = [], []
        for i in range(len(coords_only)):
            dists, idxs = tree.query(coords_only[i], k=6)
            for d, j_local in zip(dists[1:], idxs[1:]):
                real_d = haversine_dist(coords_only[i], coords_only[j_local])
                if real_d <= WALK_RADIUS_KM:
                    u_global = actual_indices[i]
                    v_global = actual_indices[j_local]
                    w = real_d / WALK_SPEED_KM_PER_MIN
                    walk_edges += [(u_global, v_global), (v_global, u_global)]
                    walk_weights += [w, w]

        if walk_edges:
            self.G.add_edges(walk_edges)
            n = len(walk_edges)
            self.G.es[-n:]["weight"] = walk_weights
            self.G.es[-n:]["type"] = ["walk"] * n
            self.G.es[-n:]["route_id"] = [None] * n
            self.G.es[-n:]["route_short_name"] = ["Walk"] * n

    def find_route(self, start: str, end: str):
        if start not in self._node_index or end not in self._node_index:
            return {"error": "Selected stop ID not in graph."}
        
        # Check if stops have coords
        if self.stop_details[start]["lat"] == 0 or self.stop_details[end]["lat"] == 0:
            return {"error": "One of these stops has no coordinates in the database. Routing impossible."}

        si, ei = self._node_index[start], self._node_index[end]
        queue = [(0.0, 0.0, si, None, [])]
        visited = {}
        while queue:
            priority, cost, u, prev_r, path = heapq.heappop(queue)
            if u == ei: return self._format(path + [u], cost)
            state = (u, prev_r)
            if visited.get(state, float('inf')) <= cost: continue
            visited[state] = cost
            for eid in self.G.incident(u, mode="out"):
                edge = self.G.es[eid]
                v, w, r = edge.target, edge["weight"], edge["route_id"]
                new_c = cost + w
                if edge["type"] == "bus" and prev_r and r != prev_r: new_c += TRANSFER_PENALTY
                
                # Heuristic
                h = haversine_dist((self.stop_details[self.G.vs[v]['sid']]['lat'], self.stop_details[self.G.vs[v]['sid']]['lng']), 
                                   (self.stop_details[self.G.vs[ei]['sid']]['lat'], self.stop_details[self.G.vs[ei]['sid']]['lng'])) / 0.8
                heapq.heappush(queue, (new_c + h, new_c, v, r if edge["type"] == "bus" else prev_r, path + [u]))
        
        return {"error": "No reachable path found."}

    def _format(self, path, total):
        legs = []
        curr = {"type": None, "route": None, "stops": []}
        for i in range(len(path)):
            sid = self.G.vs[path[i]]["sid"]
            if i < len(path) - 1:
                edge = self.G.es[self.G.get_eid(path[i], path[i+1])]
                if edge["type"] != curr["type"] or edge["route_short_name"] != curr["route"]:
                    if curr["stops"]: legs.append(curr)
                    curr = {"type": edge["type"], "route": edge["route_short_name"], "stops": []}
            curr["stops"].append({**self.stop_details[sid], "id": sid})
        legs.append(curr)
        bus_legs = [l for l in legs if l["type"] == "bus"]
        return {"legs": legs, "total_time": round(total, 1), "total_stops": len(path), "transfers": max(0, len(bus_legs)-1)}

    def search_stops(self, q: str):
        query = q.lower().strip()
        pfx, sub = [], []
        for name in self.stop_names_list:
            lname = name.lower()
            if lname.startswith(query):
                for sid in self.name_to_ids[name]: pfx.append({"id": sid, "name": name})
            elif query in lname:
                for sid in self.name_to_ids[name]: sub.append({"id": sid, "name": name})
            if len(pfx) + len(sub) >= 40: break
        return (pfx + sub)[:20]

    def _build_name_index(self):
        self.name_to_ids = {}
        for sid, v in self.stop_details.items():
            self.name_to_ids.setdefault(v["name"], []).append(sid)
        self.stop_names_list = list(self.name_to_ids.keys())

    def _save_cache(self):
        edge_data = [(e.source, e.target, e["weight"], e["type"], e["route_id"], e["route_short_name"]) for e in self.G.es]
        data = {"stop_details": self.stop_details, "sids": self.G.vs["sid"], "edges": edge_data}
        with open(CACHE_FILE, "wb") as f: f.write(msgpack.packb(data, use_bin_type=True))

    def _load_cache(self):
        with open(CACHE_FILE, "rb") as f: data = msgpack.unpackb(f.read(), raw=False)
        self.stop_details = data["stop_details"]
        self.G.add_vertices(len(data["sids"]))
        self.G.vs["sid"] = data["sids"]
        self._node_index = {sid: i for i, sid in enumerate(data["sids"])}
        if data["edges"]:
            self.G.add_edges([(e[0], e[1]) for e in data["edges"]])
            (self.G.es["weight"], self.G.es["type"], self.G.es["route_id"], self.G.es["route_short_name"]) = zip(*[e[2:] for e in data["edges"]])