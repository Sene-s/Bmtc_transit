from fastapi import FastAPI, Depends, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from backend.graph_engine import TransitEngine
from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()

engine = TransitEngine(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

# ── SECURITY: Verify Token ──
async def verify_admin(x_admin_token: str = Header(None)):
    if x_admin_token != os.getenv("ADMIN_SECRET_KEY"):
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid Admin Token")
    return True

@asynccontextmanager
async def lifespan(app: FastAPI):
    await engine.initialize()
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class StopModel(BaseModel):
    stop_id: str
    stop_name: str
    stop_lat: float
    stop_lon: float

# ── PUBLIC ROUTES ──
@app.get("/")
async def root():
    return {"status": "online", "stops": len(engine.stop_details)}

@app.get("/stops/search")
async def search(q: str):
    return engine.search_stops(q)

@app.get("/route")
async def route(start: str, end: str):
    return engine.find_route(start, end)

# ── FAVORITES ROUTES ──

@app.get("/favorites")
async def get_favorites():
    # Join with stops table to get the names/coords of favorites
    res = engine.supabase.table("user_favorites") \
        .select("id, stop_id, stops(stop_name, stop_lat, stop_lon)") \
        .execute()
    return res.data

@app.post("/favorites/{sid}")
async def add_favorite(sid: str):

    check = engine.supabase.table("user_favorites").select("*").eq("stop_id", sid).execute()
    if check.data:
        return {"message": "Already in favorites"}
        
    res = engine.supabase.table("user_favorites").insert({"stop_id": sid}).execute()
    return {"message": "Added to favorites", "data": res.data}

@app.delete("/favorites/{sid}")
async def remove_favorite(sid: str):
    res = engine.supabase.table("user_favorites").delete().eq("stop_id", sid).execute()
    return {"message": "Removed from favorites"}