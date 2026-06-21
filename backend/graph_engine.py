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

CACHE_FILE = "graph_cache_v_FINAL_PROD.msgpack"
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
        log.info("🔌 Initializing Transit Engine...")
        self.supabase = await acreate_client(self.url, self.key)

        if os.path.exists(CACHE_FILE):  
            try:
                log.info(f"📦 Loading cached graph: {CACHE_FILE}")
                self._load_cache()  
            except Exception as e:
                log.warning(f"Cache failed: {e}. Rebuilding...")
                await self._build()  
                self._save_cache()  
        else:  
            log.info("🏗️ Fresh build: Fetching data from Supabase...")
            await self._build()  
            self._save_cache()  

        self._build_name_index()
        log.info(f"✅ ENGINE READY: {len(self.stop_details)} stops, {self.G.ecount()} edges.")

    async def _build(self):  
        offset = 0  
        while True:  
            res = await self.supabase.table("stops").select("stop_id,stop_name,stop_lat,stop_lon").range(offset, offset + 999).execute()  
            if not res.data: break  
            for s in res.data:
                lat, lon = s.get("stop_lat"), s.get("stop_lon")
                sid = str(s["stop_id"]).strip()
                self.stop_details[sid] = {
                    "name": s["stop_name"], 
                    "lat": float(lat) if (lat and lat != '') else 0.0, 
                    "lng": float(lon) if (lon and lon != '') else 0.0
                }
            offset += len(res.data)

        sids = list(self.stop_details.keys())
        self.G.add_vertices(len(sids))
        self.G.vs["sid"] = sids
        self._node_index = {sid: i for i, sid in enumerate(sids)}

        offset = 0
        while True:
            res = await self.supabase.table("graph_edges").select("*").range(offset, offset + 999).execute()
            if not res.data: break
            edges, weights, routes, names = [], [], [], []
            for e in res.data:
                u, v = self._node_index.get(str(e["source_id"]).strip()), self._node_index.get(str(e["target_id"]).strip())
                if u is not None and v is not None:
                    edges.append((u, v))
                    weights.append(float(e["weight"]))
                    routes.append(e.get("route_id"))
                    names.append(e.get("route_short_name", "Bus"))
            if edges:
                self.G.add_edges(edges)
                n = len(edges)
                self.G.es[-(n):]["weight"], self.G.es[-(n):]["type"] = weights, ["bus"] * n
                self.G.es[-(n):]["route_id"], self.G.es[-(n):]["route_short_name"] = routes, names
            offset += len(res.data)
        self._add_walking_mesh()

    def _add_walking_mesh(self):
        log.info("🚶 Generating walking connections...")
        sids = list(self.stop_details.keys())
        valid = [((self.stop_details[sid]["lat"], self.stop_details[sid]["lng"]), i) 
                 for i, sid in enumerate(sids) if self.stop_details[sid]["lat"] != 0]
        if not valid: return
        tree = KDTree([v[0] for v in valid])
        walk_edges, walk_weights = [], []
        for i, (coord, g_idx) in enumerate(valid):
            dists, idxs = tree.query(coord, k=8)
            for j_local in idxs[1:]:
                real_d = haversine_dist(coord, valid[j_local][0])
                if real_d <= WALK_RADIUS_KM:
                    v_idx = valid[j_local][1]
                    w = real_d / WALK_SPEED_KM_PER_MIN
                    walk_edges += [(g_idx, v_idx), (v_idx, g_idx)]
                    walk_weights += [w, w]
        if walk_edges:
            self.G.add_edges(walk_edges)
            n = len(walk_edges)
            self.G.es[-n:]["weight"], self.G.es[-n:]["type"] = walk_weights, ["walk"] * n
            self.G.es[-n:]["route_id"], self.G.es[-n:]["route_short_name"] = [None]*n, ["Walk"]*n

    # NEW: DBMS Project Enhancement - Expanding intermediate stops via SQL joins
    async def expand_leg(self, route_name, source_id, target_id):
        """Fetches intermediate stops from stop_times for a given bus leg."""
        try:
            # 1. Get route_id from name
            res = await self.supabase.table("graph_edges").select("route_id").eq("route_short_name", route_name).limit(1).execute()
            if not res.data: return []
            rid = res.data[0]["route_id"]

            # 2. Get a representative trip_id for this route
            res = await self.supabase.table("trips").select("trip_id").eq("route_id", rid).limit(1).execute()
            if not res.data: return []
            tid = res.data[0]["trip_id"]

            # 3. Get all stops for this trip
            res = await self.supabase.table("stop_times").select("stop_sequence, stop_id, stops(stop_name, stop_lat, stop_lon)").eq("trip_id", tid).order("stop_sequence").execute()
            rows = res.data
            
            # 4. Find start and end sequences
            start_seq, end_seq = None, None
            for r in rows:
                if str(r["stop_id"]) == str(source_id): start_seq = r["stop_sequence"]
                if str(r["stop_id"]) == str(target_id): end_seq = r["stop_sequence"]

            if start_seq is None or end_seq is None: return []

            # 5. Extract intermediate stops segment
            segment = [r for r in rows if start_seq <= r["stop_sequence"] <= end_seq]
            return [{
                "id": str(r["stop_id"]),
                "name": r["stops"]["stop_name"],
                "lat": float(r["stops"]["stop_lat"]),
                "lng": float(r["stops"]["stop_lon"])
            } for r in segment]
        except Exception as e:
            log.error(f"Expand error: {e}")
            return []

    async def find_route(self, start: str, end: str):
        if start not in self._node_index or end not in self._node_index:
            return {"error": "Stops not found."}
        si, ei = self._node_index[start], self._node_index[end]
        queue, visited = [(0.0, 0.0, si, None, [])], {}
        while queue:
            priority, cost, u, prev_r, path = heapq.heappop(queue)
            if u == ei: return await self._format(path + [u], cost) # Await the async format
            state = (u, prev_r)
            if visited.get(state, float('inf')) <= cost: continue
            visited[state] = cost
            for eid in self.G.incident(u, mode="out"):
                edge = self.G.es[eid]
                v, w, r = edge.target, edge["weight"], edge["route_id"]
                new_c = cost + w + (TRANSFER_PENALTY if edge["type"] == "bus" and prev_r and r != prev_r else 0)
                h = haversine_dist((self.stop_details[self.G.vs[v]['sid']]['lat'], self.stop_details[self.G.vs[v]['sid']]['lng']), 
                                   (self.stop_details[self.G.vs[ei]['sid']]['lat'], self.stop_details[self.G.vs[ei]['sid']]['lng'])) / 0.8
                heapq.heappush(queue, (new_c + h, new_c, v, r if edge["type"] == "bus" else prev_r, path + [u]))
        return {"error": "No reachable path found."}

    async def _format(self, path, total):
        legs = []
        curr = {"type": None, "route": None, "stops": []}
        for i in range(len(path)):
            sid = self.G.vs[path[i]]["sid"]
            if i < len(path) - 1:
                edge = self.G.es[self.G.get_eid(path[i], path[i+1])]
                if edge["type"] != curr["type"] or edge["route_short_name"] != curr["route"]:
                    if curr["stops"]: 
                        # Attempt to expand bus legs before adding them
                        if curr["type"] == "bus":
                            expanded = await self.expand_leg(curr["route"], curr["stops"][0]["id"], curr["stops"][-1]["id"])
                            if expanded: curr["stops"] = expanded
                        legs.append(curr)
                    curr = {"type": edge["type"], "route": edge["route_short_name"], "stops": []}
            curr["stops"].append({**self.stop_details[sid], "id": sid})
        
        # Final leg expansion
        if curr["type"] == "bus":
            expanded = await self.expand_leg(curr["route"], curr["stops"][0]["id"], curr["stops"][-1]["id"])
            if expanded: curr["stops"] = expanded
        legs.append(curr)
        
        bus_legs = [l for l in legs if l["type"] == "bus"]
        return {"legs": legs, "total_time": round(total, 1), "total_stops": sum(len(l["stops"]) for l in legs), "transfers": max(0, len(bus_legs)-1)}

    def search_stops(self, q: str):
        query = q.lower().strip()
        results = []
        for name in self.stop_names_list:
            if query in name.lower():
                for sid in self.name_to_ids[name]: results.append({"id": sid, "name": name})
        results.sort(key=lambda x: (not x["name"].lower().startswith(query), x["name"]))
        return results[:20]

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
        self.stop_details, self.G.vs["sid"] = data["stop_details"], data["sids"]
        self.G.add_vertices(len(data["sids"]))
        self._node_index = {sid: i for i, sid in enumerate(data["sids"])}
        if data["edges"]:
            self.G.add_edges([(e[0], e[1]) for e in data["edges"]])
            (self.G.es["weight"], self.G.es["type"], self.G.es["route_id"], self.G.es["route_short_name"]) = zip(*[e[2:] for e in data["edges"]])