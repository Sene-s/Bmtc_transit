from fastapi import FastAPI, Depends, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from backend.graph_engine import TransitEngine
from contextlib import asynccontextmanager
import os
import logging
from typing import Optional
from dotenv import load_dotenv

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"GLOBAL CRASH: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"message": "Internal Server Error", "detail": str(exc)},
        headers={"Access-Control-Allow-Origin": "*"}
    )

def get_db():
    if engine.supabase is None: raise HTTPException(status_code=503)
    return engine.supabase

@app.get("/")
async def root():
    return {"status": "online", "stops": len(engine.stop_details)}

@app.get("/stops/search")
async def search(q: str):
    return engine.search_stops(q)

@app.get("/route")
async def route(start: str, end: str):
    return await engine.find_route(start, end)

@app.get("/favorites")
async def get_favorites(db = Depends(get_db)):
    res = await db.table("user_favorites").select("id, stop_id, nickname, stops(stop_name)").execute()
    return res.data

@app.post("/favorites/{sid}")
async def add_favorite(sid: str, nickname: Optional[str] = Query(None), db = Depends(get_db)):
    check = await db.table("user_favorites").select("*").eq("stop_id", sid).execute()
    if check.data: return {"message": "Exists"}
    payload = {"stop_id": sid}
    if nickname: payload["nickname"] = nickname.strip()[:30]
    await db.table("user_favorites").insert(payload).execute()
    return {"message": "Saved"}

@app.delete("/favorites/{sid}")
async def remove_favorite(sid: str, db = Depends(get_db)):
    await db.table("user_favorites").delete().eq("stop_id", sid).execute()
    return {"message": "Deleted"}