"""FastAPI application exposing the simulated wtnextgen endpoints."""

from __future__ import annotations

import itertools
import logging
import threading
import time
from datetime import date
from typing import Any, Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from .data import Dataset, SimConfig, __name__ as _data_module  # noqa: F401
from .envelope import (
    ApiError, Query, apply_order, apply_search, data_response, error_response, is_guid, paged_response,
    plain_failure, parse_date,
)

log = logging.getLogger("winteam-sim")

EXEMPT_PREFIXES = ("/__sim", "/docs", "/openapi.json", "/redoc")


def create_app(config: SimConfig | None = None) -> FastAPI:
    cfg = config or SimConfig.from_env()
    started = time.perf_counter()
    ds = Dataset(cfg)
    log.info("winteam-sim dataset built in %.1fs: %s", time.perf_counter() - started, ds.summary()["counts"])

    app = FastAPI(title="WinTeam wtnextgen simulator (NOT WinTeam)", version="0.1.0", redirect_slashes=False)
    app.state.dataset = ds
    app.state.config = cfg
    counter = itertools.count(1)
    lock = threading.Lock()

    # ------------------------------------------------------------ middleware
    @app.middleware("http")
    async def gate(request: Request, call_next: Callable) -> Response:
        path = request.url.path
        if path.startswith(EXEMPT_PREFIXES):
            return await call_next(request)
        if cfg.rate_limit_every:
            with lock:
                n = next(counter)
            if n % cfg.rate_limit_every == 0:
                return JSONResponse(status_code=429, headers={"Retry-After": "1"}, content={
                    "statusCode": 429, "message": "Rate limit is exceeded. Try again in 1 seconds."})
        if cfg.subscription_key is not None:
            supplied = request.headers.get("Ocp-Apim-Subscription-Key")
            if supplied is None:
                return JSONResponse(status_code=401, content={
                    "statusCode": 401,
                    "message": "Access denied due to missing subscription key. Make sure to include "
                               "subscription key when making requests to an API."})
            if supplied != cfg.subscription_key:
                return JSONResponse(status_code=401, content={
                    "statusCode": 401, "message": "Access denied due to invalid subscription key. Make sure to "
                                                  "provide a valid key for an active subscription."})
        tenant = request.headers.get("tenantId")
        if tenant is None or tenant.strip() == "":
            return error_response(400, "TenantId", "TenantId must be a GUID.", None)
        if not is_guid(tenant):
            return error_response(422, "TenantId", "TenantId must be a GUID.", tenant)
        if tenant.strip().lower() != cfg.tenant_id.lower():
            return plain_failure(401, "Unknown tenant. The simulator only accepts SIM_TENANT_ID.")
        return await call_next(request)

    @app.exception_handler(ApiError)
    async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
        return exc.response()

    @app.exception_handler(404)
    async def not_found(_: Request, __: Exception) -> JSONResponse:
        return JSONResponse(status_code=404, content={"statusCode": 404, "message": "Resource not found"})

    @app.exception_handler(405)
    async def method_not_allowed(_: Request, __: Exception) -> JSONResponse:
        return JSONResponse(status_code=405, content={"statusCode": 405, "message": "Method not allowed"})

    def route(path: str, methods: list[str]) -> Callable:
        """Register a handler under both the slash and slash-less form of ``path``."""

        def decorator(fn: Callable) -> Callable:
            for p in {path.rstrip("/"), path.rstrip("/") + "/"}:
                app.add_api_route(p, fn, methods=methods, include_in_schema=(p == path))
            return fn

        return decorator

    # ------------------------------------------------------------ operator
    @app.get("/__sim/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "timekeepingRows": len(ds.tk), "jobs": len(ds.jobs)}

    @app.get("/__sim/summary")
    async def summary() -> dict[str, Any]:
        return ds.summary()

    # ------------------------------------------------------------ timekeeping
    TK_ORDER = {
        "timekeepingid": lambda r: r[ds.TK_ID], "employeenumber": lambda r: r[ds.TK_EMP],
        "jobnumber": lambda r: ds.jobs[r[ds.TK_JOB]].job_number, "workdate": lambda r: r[ds.TK_ORD],
        "hours": lambda r: r[ds.TK_HOURS], "categorydetailid": lambda r: r[ds.TK_CAT],
        "rate": lambda r: r[ds.TK_RATE], "workticketnumber": lambda r: None,
    }

    @route("/timekeeping/v2/api/timekeeping", ["GET"])
    async def get_timekeeping(request: Request) -> Response:
        q = Query(request)
        d0 = q.date("dateFrom", required=True)
        d1 = q.date("dateTo", required=True)
        if d0 > d1:  # type: ignore[operator]
            raise ApiError(422, "DateTo", "'DateTo' must be greater than or equal to 'DateFrom'.", q.raw("dateTo"))
        page_number, page_size = q.paging()
        rows = ds.timekeeping_between(d0, d1)  # type: ignore[arg-type]
        rows = apply_order(rows, TK_ORDER, q)
        return paged_response(rows, page_number, page_size, ds.tk_to_dict)

    # ------------------------------------------------------------ jobs
    JOB_FIELDS = {
        "jobnumber": lambda j: j["jobNumber"], "parentjobnumber": lambda j: j["parentJobNumber"],
        "jobid": lambda j: j["jobId"], "jobdescription": lambda j: j["jobDescription"],
        "companynumber": lambda j: j["companyNumber"], "lighthouseapplication": lambda j: j["lighthouseApplication"],
        "hoursruleid": lambda j: j["hoursRuleId"], "jobjoineddescription": lambda j: j["jobJoinedDescription"],
    }

    @route("/jobs/v2/api/jobs", ["GET"])
    async def get_jobs(request: Request) -> Response:
        q = Query(request)
        page_number, page_size = q.paging()
        location_id = q.integer("locationId")
        rows = ds.job_records()
        if location_id is not None:
            rows = [j for j in rows if j["locationId"] == location_id]
        rows = apply_search(rows, JOB_FIELDS, q)
        rows = apply_order(rows, JOB_FIELDS, q)
        return paged_response(rows, page_number, page_size)

    def require_job(job_key: str):
        job = ds.job_by_key(job_key)
        if job is None:
            raise _NotFound()
        return job

    class _NotFound(Exception):
        pass

    @app.exception_handler(_NotFound)
    async def job_not_found(_: Request, __: Exception) -> JSONResponse:
        return JSONResponse(status_code=404, content={"success": False, "serverResponse": "Job not found."})

    @route("/jobs/v2/api/jobs/{job_key}/gl-budgets", ["GET"])
    async def get_gl_budgets(job_key: str, request: Request) -> Response:
        q = Query(request)
        job = require_job(job_key)
        fiscal_year = q.integer("fiscalYear")
        fs = q.boolean("financialStatement", True)
        jca = q.boolean("jobCostAnalysis", True)
        return data_response(ds.gl_budgets_for(job, fiscal_year, bool(fs), bool(jca)))

    @route("/jobs/v2/api/jobs/{job_key}/budgets", ["POST"])
    async def post_budgets(job_key: str, request: Request) -> Response:
        require_job(job_key)
        try:
            body = await request.json()
        except Exception:
            raise ApiError(400, "Body", "Request body must be valid JSON.", None)
        if not isinstance(body, dict):
            raise ApiError(422, "Body", "Request body must be a PostBudget object.", None)
        effective = body.get("effectiveDate")
        if effective is not None and parse_date(str(effective)) is None:
            raise ApiError(422, "EffectiveDate", "Could not convert string to DateTime.", str(effective))
        details = body.get("details")
        if details is not None and not isinstance(details, list):
            raise ApiError(422, "Details", "'Details' must be an array.", None)
        # Echo per the documented 201 sample (the body itself, not an envelope).
        return JSONResponse(status_code=201, content=body)

    SCHED_FIELDS = {
        "id": lambda r: r["id"], "scheduledetailsid": lambda r: r["scheduleDetailsID"],
        "jobnumber": lambda r: r["jobNumber"], "employeenumber": lambda r: r["employeeNumber"],
        "jobpostdetailid": lambda r: r["jobPostDetailID"], "hours": lambda r: r["hours"],
        "lunch": lambda r: r["lunch"],
    }
    SCHED_ORDER = {**SCHED_FIELDS, "workdate": lambda r: r["workDate"], "intime": lambda r: r["inTime"],
                   "outtime": lambda r: r["outTime"]}

    @route("/jobs/v2/api/jobs/{job_key}/schedules", ["GET"])
    async def get_schedules(job_key: str, request: Request) -> Response:
        q = Query(request)
        job = require_job(job_key)
        d0 = q.date("dateFrom", required=True)
        d1 = q.date("dateTo", required=True)
        if d0 > d1:  # type: ignore[operator]
            raise ApiError(422, "DateTo", "'DateTo' must be greater than or equal to 'DateFrom'.", q.raw("dateTo"))
        page_number, page_size = q.paging()
        rows = ds.schedules(job, d0, d1)  # type: ignore[arg-type]
        rows = apply_search(rows, SCHED_FIELDS, q)
        rows = apply_order(rows, SCHED_ORDER, q)
        return paged_response(rows, page_number, page_size)

    # ------------------------------------------------------------ accounts
    AP_FIELDS = {
        "invoicenumber": lambda r: r["invoiceNumber"], "ponumber": lambda r: r["poNumber"],
        "vendornumber": lambda r: r["vendorNumber"], "companynumber": lambda r: r["companyNumber"],
        "memoline1": lambda r: r["memoLine1"], "memoline2": lambda r: r["memoLine2"],
    }

    @route("/accounts/v1/api/payables/invoices", ["GET"])
    async def get_ap_invoices(request: Request) -> Response:
        q = Query(request)
        d0 = q.date("dateFrom", required=True)
        d1 = q.date("dateTo", required=True)
        if d0 > d1:  # type: ignore[operator]
            raise ApiError(422, "DateTo", "'DateTo' must be greater than or equal to 'DateFrom'.", q.raw("dateTo"))
        page_number, page_size = q.paging()
        rows = [r for r in ds.ap_invoices if d0 <= date.fromisoformat(r["invoiceDate"][:10]) <= d1]  # type: ignore[operator]
        rows = apply_search(rows, AP_FIELDS, q)
        rows = apply_order(rows, AP_FIELDS, q)
        return paged_response(rows, page_number, page_size)

    AR_FIELDS = {
        "invoicenumber": lambda r: r["invoiceNumber"], "ponumber": lambda r: r["poNumber"],
        "terms": lambda r: r["terms"], "salesrep": lambda r: r["salesRep"], "reason": lambda r: r["reason"],
        "jobnumber": lambda r: r["jobNumber"],
    }

    @route("/accounts/v1/api/receivables/invoices", ["GET"])
    async def get_ar_invoices(request: Request) -> Response:
        q = Query(request)
        customer = q.string("customerNumber", required=True)
        page_number, page_size = q.paging()
        rows = [r for r in ds.ar_invoices if r["customerNumber"] == customer.strip()]  # type: ignore[union-attr]
        rows = apply_search(rows, AR_FIELDS, q)
        rows = apply_order(rows, AR_FIELDS, q)
        return paged_response(rows, page_number, page_size)

    PAY_FIELDS = {
        "paymentid": lambda r: r["paymentId"], "paymentmethodid": lambda r: r["paymentMethodId"],
        "checknumber": lambda r: r["checkNumber"], "companynumber": lambda r: r["companyNumber"],
        "payeetypeid": lambda r: r["payeeTypeId"], "vendornumber": lambda r: r["vendorNumber"],
        "othervendorid": lambda r: r["otherVendorId"], "externalsystemid": lambda r: r["externalSystemId"],
    }

    @route("/accounts/v1/api/payables/payments", ["GET"])
    async def get_ap_payments(request: Request) -> Response:
        q = Query(request)
        d0 = q.date("startDate", required=True)
        d1 = q.date("endDate", required=True)
        if d0 > d1:  # type: ignore[operator]
            raise ApiError(422, "EndDate", "'EndDate' must be greater than or equal to 'StartDate'.", q.raw("endDate"))
        page_number, page_size = q.paging()

        def when(r: dict[str, Any]) -> date:
            stamp = r["checkDate"] or r["paymentDateAdded"]
            return date.fromisoformat(stamp[:10])

        rows = [r for r in ds.ap_payments if d0 <= when(r) <= d1]  # type: ignore[operator]
        rows = apply_search(rows, PAY_FIELDS, q)
        rows = apply_order(rows, PAY_FIELDS, q)
        return paged_response(rows, page_number, page_size)

    # ------------------------------------------------------------ vendors
    VENDOR_FIELDS = {
        "vendornumber": lambda v: v["vendorNumber"], "vendortypeid": lambda v: v["vendorTypeId"],
        "vendorname": lambda v: v["vendorName"], "vendorstatus": lambda v: v["vendorStatus"],
        "phone": lambda v: v["phone"], "accountnumber": lambda v: v["accountNumber"],
        "parentvendornumber": lambda v: v["parentVendorNumber"], "address1": lambda v: v["address"]["address1"],
        "address2": lambda v: v["address"]["address2"], "city": lambda v: v["address"]["city"],
        "state": lambda v: v["address"]["state"], "zip": lambda v: v["address"]["zip"],
    }

    @route("/vendors/v1/api/vendors", ["GET"])
    async def get_vendors(request: Request) -> Response:
        q = Query(request)
        page_number, page_size = q.paging()
        vendor_number = q.integer("vendorNumber")
        rows = ds.vendors
        if vendor_number is not None:
            rows = [v for v in rows if v["vendorNumber"] == vendor_number]
        rows = apply_search(rows, VENDOR_FIELDS, q)
        rows = apply_order(rows, VENDOR_FIELDS, q)
        return paged_response(rows, page_number, page_size)

    return app


app = create_app()
