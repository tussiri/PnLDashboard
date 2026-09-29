from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException

from .common import platform_access, require_role
from .config import settings
from .db import database_ready
from .routers import auth, executive, forecast, labor, leadership, platform, reporting, staffing, users

logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate()
    yield


app = FastAPI(
    title="Crane IFS API",
    version="2.0.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)


@app.get("/health/live", include_in_schema=False)
def live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready", include_in_schema=False)
def ready() -> dict[str, str]:
    if not database_ready():
        raise HTTPException(status_code=503, detail="Database is not ready")
    return {"status": "ready"}


API_PREFIX = "/api/v1"
# Role enforcement lives here so the router modules stay free of session concerns:
#   /auth/*                public
#   platform               /system/status and /dimensions for any signed-in role; other reads analyst/admin;
#                          writes keep X-Admin-Token and also accept an admin session
#   reporting/labor/forecast  analyst or admin
#   executive              any signed-in role
#   leadership             any signed-in role (writes: admin)
#   staffing               analyst or admin (request lines carry pay rates)
analyst_or_admin = require_role("analyst", "admin")
app.include_router(auth.router, prefix=API_PREFIX, tags=["auth"])
app.include_router(users.router, prefix=API_PREFIX, tags=["users"])
app.include_router(platform.router, prefix=API_PREFIX, tags=["platform"], dependencies=[Depends(platform_access)])
app.include_router(reporting.router, prefix=API_PREFIX, tags=["reporting"], dependencies=[Depends(analyst_or_admin)])
app.include_router(labor.router, prefix=API_PREFIX, tags=["labor"], dependencies=[Depends(analyst_or_admin)])
app.include_router(forecast.router, prefix=API_PREFIX, tags=["forecast"], dependencies=[Depends(analyst_or_admin)])
app.include_router(staffing.router, prefix=API_PREFIX, tags=["staffing"], dependencies=[Depends(analyst_or_admin)])
app.include_router(executive.router, prefix=API_PREFIX, tags=["executive"], dependencies=[Depends(require_role("executive", "analyst", "admin"))])
app.include_router(leadership.router, prefix=API_PREFIX, tags=["leadership"], dependencies=[Depends(require_role("executive", "analyst", "admin", scoped=True))])
