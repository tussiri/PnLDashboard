"""Response envelopes, validation errors, paging, ordering and filtering.

Mirrors the shapes documented in WinTeamAPI.txt:

* paged OK:   {"data": [{"pageNumber", "pageSize", "totalPages", "totalCount", "results": [...]}],
               "success": true, "serverResponse": "OK."}
* empty:      204 No Content
* validation: {"errors": [{"attemptedValue", "fieldName", "errorMessage"}],
               "success": false, "serverResponse": "Operation failed! See the Errors for more information."}
"""

from __future__ import annotations

import math
import re
import uuid
from datetime import date, datetime
from typing import Any, Callable, Iterable, Mapping, Sequence

from fastapi import Request, Response
from fastapi.responses import JSONResponse

OK_RESPONSE = "OK."
FAILED_RESPONSE = "Operation failed! See the Errors for more information."
DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 1000

_GUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class ApiError(Exception):
    """Raised by handlers; rendered as the documented error envelope."""

    def __init__(self, status: int, field_name: str, message: str, attempted: Any = None,
                 server_response: str = FAILED_RESPONSE) -> None:
        super().__init__(message)
        self.status = status
        self.errors = [{"attemptedValue": attempted, "fieldName": field_name, "errorMessage": message}]
        self.server_response = server_response

    def response(self) -> JSONResponse:
        return JSONResponse(status_code=self.status, content={
            "errors": self.errors, "success": False, "serverResponse": self.server_response,
        })


def error_response(status: int, field_name: str, message: str, attempted: Any = None) -> JSONResponse:
    return ApiError(status, field_name, message, attempted).response()


def is_guid(value: str) -> bool:
    if not _GUID_RE.match(value.strip()):
        return False
    try:
        uuid.UUID(value.strip())
        return True
    except ValueError:
        return False


# --------------------------------------------------------------------------- #
# Query parameter access (ASP.NET binding is case-insensitive, so are we)
# --------------------------------------------------------------------------- #


class Query:
    def __init__(self, request: Request) -> None:
        self._raw: dict[str, str] = {}
        for k, v in request.query_params.multi_items():
            self._raw.setdefault(k.lower(), v)

    def raw(self, name: str) -> str | None:
        v = self._raw.get(name.lower())
        return v if v is not None and v != "" else None

    def string(self, name: str, required: bool = False) -> str | None:
        v = self.raw(name)
        if v is None and required:
            raise ApiError(400, _pascal(name), f"'{_pascal(name)}' must not be empty.", None)
        return v

    def integer(self, name: str, default: int | None = None, required: bool = False) -> int | None:
        v = self.raw(name)
        if v is None:
            if required:
                raise ApiError(400, _pascal(name), f"'{_pascal(name)}' must not be empty.", None)
            return default
        try:
            return int(v)
        except ValueError:
            raise ApiError(422, _pascal(name), f"The value '{v}' is not valid for {_pascal(name)}.", v)

    def boolean(self, name: str, default: bool | None = None) -> bool | None:
        v = self.raw(name)
        if v is None:
            return default
        lowered = v.strip().lower()
        if lowered in ("true", "1", "yes"):
            return True
        if lowered in ("false", "0", "no"):
            return False
        raise ApiError(422, _pascal(name), f"The value '{v}' is not valid for {_pascal(name)}.", v)

    def date(self, name: str, required: bool = False) -> date | None:
        v = self.raw(name)
        if v is None:
            if required:
                raise ApiError(400, _pascal(name), f"'{_pascal(name)}' must not be empty.", None)
            return None
        parsed = parse_date(v)
        if parsed is None:
            raise ApiError(422, _pascal(name), "Could not convert string to DateTime.", v)
        return parsed

    def paging(self) -> tuple[int, int]:
        page_number = self.integer("pageNumber", 1) or 1
        page_size = self.integer("pageSize", DEFAULT_PAGE_SIZE) or DEFAULT_PAGE_SIZE
        if page_number < 1:
            raise ApiError(422, "PageNumber", "'PageNumber' must be greater than '0'.", str(page_number))
        if page_size < 1:
            raise ApiError(422, "PageSize", "'PageSize' must be greater than '0'.", str(page_size))
        return page_number, min(page_size, MAX_PAGE_SIZE)


def _pascal(name: str) -> str:
    return name[:1].upper() + name[1:]


def parse_date(value: str) -> date | None:
    """Accept RFC3339 / ISO-8601 timestamps or bare dates; only the date part matters."""
    v = value.strip()
    if not v:
        return None
    candidate = v.replace("Z", "+00:00") if v.endswith("Z") else v
    try:
        return datetime.fromisoformat(candidate).date()
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%Y %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------- #
# Ordering / searching
# --------------------------------------------------------------------------- #

Getter = Callable[[Any], Any]


def _sort_key(value: Any) -> tuple:
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (1, value)
    return (2, str(value).lower())


def apply_order(rows: Sequence[Any], fields: Mapping[str, Getter], query: Query) -> list[Any]:
    order_by = query.raw("orderBy")
    ascending = query.boolean("ascending", True)
    if order_by is None:
        return list(rows) if ascending else list(reversed(rows))
    getter = fields.get(order_by.lower())
    if getter is None:
        raise ApiError(400, "OrderBy", f"'{order_by}' is not a valid value for OrderBy. Possible values are: "
                       + ", ".join(sorted(fields)), order_by)
    return sorted(rows, key=lambda r: _sort_key(getter(r)), reverse=not ascending)


def apply_search(rows: Iterable[Any], fields: Mapping[str, Getter], query: Query,
                 exact_default: bool = False) -> list[Any]:
    field_name = query.raw("searchFieldName")
    text = query.raw("searchText")
    exact = query.boolean("exactMatch", exact_default)
    if field_name is None and text is None:
        return list(rows)
    if field_name is None or text is None:
        raise ApiError(400, "SearchFieldName" if field_name is None else "SearchText",
                       "SearchFieldName and SearchText must be provided together.", field_name or text)
    getter = fields.get(field_name.lower())
    if getter is None:
        raise ApiError(400, "SearchFieldName", f"'{field_name}' is not a valid value for SearchFieldName. "
                       "Possible values are: " + ", ".join(sorted(fields)), field_name)
    needle = text.lower()

    def matches(row: Any) -> bool:
        value = getter(row)
        if value is None:
            return False
        if isinstance(value, bool):
            hay = "true" if value else "false"
        else:
            hay = str(value).lower()
        return hay == needle if exact else needle in hay

    return [r for r in rows if matches(r)]


# --------------------------------------------------------------------------- #
# Envelopes
# --------------------------------------------------------------------------- #


def paged_response(rows: Sequence[Any], page_number: int, page_size: int,
                   render: Callable[[Any], Any] | None = None) -> Response:
    total = len(rows)
    total_pages = math.ceil(total / page_size) if total else 0
    start = (page_number - 1) * page_size
    page = rows[start:start + page_size]
    if not page:
        return Response(status_code=204)
    results = [render(r) for r in page] if render else list(page)
    return JSONResponse(status_code=200, content={
        "data": [{
            "pageNumber": page_number,
            "pageSize": page_size,
            "totalPages": total_pages,
            "totalCount": total,
            "results": results,
        }],
        "success": True,
        "serverResponse": OK_RESPONSE,
    })


def data_response(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status, content={"data": data, "success": True, "serverResponse": OK_RESPONSE})


def plain_failure(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"success": False, "serverResponse": message})
