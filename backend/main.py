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

def get_db():
    if engine.supabase is None:
        raise HTTPException(status_code=503, detail="Database initializing...")
    return engine.supabase

@app.get("/")
async def root():
    return {"status": "online", "stops_loaded": len(engine.stop_details)}

@app.get("/stops/search")
async def search(q: str):
    return engine.search_stops(q)

@app.get("/route")
async def route(start: str, end: str):
    return engine.find_route(start, end)

# ── FAVORITES (FULL CRUD FOR DBMS PROJECT) ──

@app.get("/favorites")
async def get_favorites(db = Depends(get_db)):
    # Read: Get all favorites with stop details
    res = await db.table("user_favorites") \
        .select("id, stop_id, nickname, stops(stop_name)") \
        .execute()
    return res.data

@app.post("/favorites/{sid}", status_code=201)
async def add_favorite(sid: str, nickname: Optional[str] = Query(None), db = Depends(get_db)):
    # Create: Validate stop existence before adding
    if sid not in engine.stop_details:
        raise HTTPException(404, "Stop ID not found in current dataset")
    
    check = await db.table("user_favorites").select("*").eq("stop_id", sid).execute()
    if check.data:
        return {"message": "Already in favorites"}

    payload = {"stop_id": sid}
    if nickname:
        payload["nickname"] = nickname.strip()[:30]
    
    await db.table("user_favorites").insert(payload).execute()
    return {"message": "Created"}

@app.put("/favorites/{sid}")
async def update_favorite(sid: str, nickname: str = Query(...), db = Depends(get_db)):
    # Update: Modify the nickname of an existing favorite
    if not nickname.strip():
        raise HTTPException(400, "Nickname cannot be empty")
        
    await db.table("user_favorites") \
        .update({"nickname": nickname.strip()[:30]}) \
        .eq("stop_id", sid) \
        .execute()
    return {"message": "Updated"}

@app.delete("/favorites/{sid}")
async def remove_favorite(sid: str, db = Depends(get_db)):
    # Delete: Remove favorite record
    await db.table("user_favorites").delete().eq("stop_id", sid).execute()
    return {"message": "Deleted"}