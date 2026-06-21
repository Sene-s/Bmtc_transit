from fastapi import FastAPI, Depends, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from backend.graph_engine import TransitEngine
from contextlib import asynccontextmanager
import os
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

engine = TransitEngine(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

@asynccontextmanager
async def lifespan(app: FastAPI):
    await engine.initialize()
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── DIAGNOSTIC ENDPOINTS ──

@app.get("/debug/memory-search/{q}")
async def debug_memory(q: str):
    """Bypasses ranking and limits to see exactly what is in the engine memory"""
    matches = []
    q_low = q.lower()
    for sid, details in engine.stop_details.items():
        if q_low in details["name"].lower():
            matches.append({"id": sid, "name": details["name"], "coords": f"{details['lat']},{details['lng']}"})
    return {"count": len(matches), "results": matches[:100]}

@app.get("/debug/connectivity/{sid}")
async def debug_conn(sid: str):
    if sid not in engine._node_index: return {"error": "Stop ID not in memory"}
    idx = engine._node_index[sid]
    outgoing = engine.G.incident(idx, mode="out")
    return {
        "name": engine.stop_details[sid]["name"],
        "bus_paths": len([e for e in outgoing if engine.G.es[e]["type"] == "bus"]),
        "walk_paths": len([e for e in outgoing if engine.G.es[e]["type"] == "walk"])
    }

# ── STANDARD ROUTES ──

@app.get("/")
async def root():
    return {"status": "online", "stops_in_memory": len(engine.stop_details)}

@app.get("/stops/search")
async def search(q: str):
    return engine.search_stops(q)

@app.get("/route")
async def route(start: str, end: str):
    return engine.find_route(start, end)

# ── FAVORITES (CRUD) ──

@app.get("/favorites")
async def get_favorites():
    if not engine.supabase: raise HTTPException(503, "DB busy")
    res = await engine.supabase.table("user_favorites").select("id, stop_id, nickname, stops(stop_name)").execute()
    return res.data

@app.post("/favorites/{sid}")
async def add_favorite(sid: str, nickname: Optional[str] = Query(None)):
    payload = {"stop_id": sid}
    if nickname: payload["nickname"] = nickname.strip()[:30]
    await engine.supabase.table("user_favorites").insert(payload).execute()
    return {"message": "Added"}

@app.delete("/favorites/{sid}")
async def remove_favorite(sid: str):
    await engine.supabase.table("user_favorites").delete().eq("stop_id", sid).execute()
    return {"message": "Deleted"}