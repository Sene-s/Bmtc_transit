import asyncio, heapq, logging, os
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

CACHE_FILE = "graph_cache_v_STABLE.msgpack"
TRANSFER_PENALTY = 10
WALK_RADIUS_KM = 1.2

class TransitEngine:
    def __init__(self, url, key):
        self.url, self.key = url, key
        self.G = ig.Graph(directed=True)
        self.stop_details, self.name_to_ids, self.stop_names_list, self._node_index = {}, {}, [], {}
        self.supabase = None

    async def initialize(self):
        self.supabase = await acreate_client(self.url, self.key)
        if os.path.exists(CACHE_FILE):
            try: self._load_cache()
            except: await self._build(); self._save_cache()
        else: await self._build(); self._save_cache()
        self._build_name_index()

    async def _build(self):
        offset = 0
        while True:
            res = await self.supabase.table("stops").select("stop_id,stop_name,stop_lat,stop_lon").range(offset, offset+999).execute()
            if not res.data: break
            for s in res.data:
                lat, lon = s.get("stop_lat"), s.get("stop_lon")
                sid = str(s["stop_id"]).strip()
                self.stop_details[sid] = {"name": s["stop_name"], "lat": float(lat) if lat else 0.0, "lng": float(lon) if lon else 0.0}
            offset += len(res.data) # Correct Pagination

        sids = list(self.stop_details.keys())
        self.G = ig.Graph(directed=True)
        self.G.add_vertices(len(sids))
        self.G.vs["sid"] = sids
        self._node_index = {sid: i for i, sid in enumerate(sids)}

        offset = 0
        while True:
            res = await self.supabase.table("graph_edges").select("*").range(offset, offset+999).execute()
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
        valid = [((self.stop_details[sid]["lat"], self.stop_details[sid]["lng"]), i) for i, sid in enumerate(list(self.stop_details.keys())) if self.stop_details[sid]["lat"] != 0]
        if not valid: return
        tree = KDTree([v[0] for v in valid])
        walk_edges, walk_weights = [], []
        for i, (coord, g_idx) in enumerate(valid):
            dists, idxs = tree.query(coord, k=8)
            for j_local in idxs[1:]:
                real_d = haversine_dist(coord, valid[j_local][0])
                if real_d <= WALK_RADIUS_KM:
                    v_idx = valid[j_local][1]
                    walk_edges += [(g_idx, v_idx), (v_idx, g_idx)]
                    walk_weights += [real_d/0.08 + 2, real_d/0.08 + 2]
        if walk_edges:
            self.G.add_edges(walk_edges)
            n = len(walk_edges)
            self.G.es[-n:]["weight"], self.G.es[-n:]["type"] = walk_weights, ["walk"] * n

    async def find_route(self, start, end):
        if start not in self._node_index or end not in self._node_index: return {"error": "Stop not found"}
        si, ei = self._node_index[start], self._node_index[end]
        queue, visited = [(0.0, 0.0, si, None, [])], {}
        while queue:
            p, cost, u, prev_r, path = heapq.heappop(queue)
            if u == ei: return self._format(path + [u], cost)
            state = (u, prev_r)
            if visited.get(state, float('inf')) <= cost: continue
            visited[state] = cost
            for eid in self.G.incident(u, mode="out"):
                edge = self.G.es[eid]
                v, w, r = edge.target, edge["weight"], edge["route_id"]
                new_c = cost + w + (TRANSFER_PENALTY if edge["type"] == "bus" and prev_r and r != prev_r else 0)
                h = haversine_dist((self.stop_details[self.G.vs[v]['sid']]['lat'], self.stop_details[self.G.vs[v]['sid']]['lng']), (self.stop_details[self.G.vs[ei]['sid']]['lat'], self.stop_details[self.G.vs[ei]['sid']]['lng'])) / 0.8
                heapq.heappush(queue, (new_c + h, new_c, v, r if edge["type"] == "bus" else prev_r, path + [u]))
        return {"error": "No route found"}

    def _format(self, path, total):
        legs = []
        curr = {"type": None, "route": None, "stops": []}
        for i in range(len(path)):
            sid = self.G.vs[path[i]]["sid"]
            if i < len(path)-1:
                edge = self.G.es[self.G.get_eid(path[i], path[i+1])]
                if edge["type"] != curr["type"] or (edge["type"] == "bus" and edge["route_short_name"] != curr["route"]):
                    if curr["stops"]: legs.append(curr.copy())
                    curr = {"type": edge["type"], "route": edge["route_short_name"], "stops": []}
            curr["stops"].append({**self.stop_details[sid], "id": sid})
        legs.append(curr)
        bus_legs = [l for l in legs if l["type"] == "bus"]
        return {"legs": legs, "total_time": round(total, 1), "total_stops": sum(len(l["stops"]) for l in legs), "transfers": max(0, len(bus_legs)-1)}

    def search_stops(self, q):
        query = q.lower().strip()
        res = []
        for name in self.stop_names_list:
            if query in name.lower():
                for sid in self.name_to_ids[name]: res.append({"id": sid, "name": name})
        res.sort(key=lambda x: (not x["name"].lower().startswith(query), x["name"]))
        return res[:20]

    def _build_name_index(self):
        self.name_to_ids = {}
        for sid, v in self.stop_details.items(): self.name_to_ids.setdefault(v["name"], []).append(sid)
        self.stop_names_list = list(self.name_to_ids.keys())

    def _save_cache(self):
        data = {"stop_details": self.stop_details, "sids": self.G.vs["sid"], "edges": [(e.source, e.target, e["weight"], e["type"], e["route_id"], e["route_short_name"]) for e in self.G.es]}
        with open(CACHE_FILE, "wb") as f: f.write(msgpack.packb(data, use_bin_type=True))

    def _load_cache(self):
        with open(CACHE_FILE, "rb") as f: data = msgpack.unpackb(f.read(), raw=False)
        self.stop_details = data["stop_details"]
        self.G = ig.Graph(directed=True)
        self.G.add_vertices(len(data["sids"]))
        self.G.vs["sid"] = data["sids"]
        self._node_index = {sid: i for i, sid in enumerate(data["sids"])}
        if data["edges"]:
            self.G.add_edges([(e[0], e[1]) for e in data["edges"]])
            self.G.es["weight"], self.G.es["type"], self.G.es["route_id"], self.G.es["route_short_name"] = zip(*[e[2:] for e in data["edges"]])