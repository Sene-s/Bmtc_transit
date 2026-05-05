from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from backend.graph_engine import TransitEngine
from contextlib import asynccontextmanager
import os
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
async def root():
    return {
        "status": "online",
        "stops_loaded": len(engine.stop_details),
        "edges_loaded": engine.G.ecount()
    }

@app.get("/stops/search")
async def search(q: str):
    return engine.search_stops(q)

@app.get("/route")
async def route(start: str, end: str):
    return engine.find_route(start, end)