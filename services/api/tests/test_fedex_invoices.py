"""FedEx invoices from Relay for a date range (app/fedex_invoices.py)."""
from __future__ import annotations

from datetime import date

import pytest
from app import fedex_invoices as fi
from app import permissions


def inv(number: str, job: str = "4801", revenue: float = 1000.0, **kw) -> dict:
    return {"invoice_number": number, "invoice_date": date(2026, 10, 5), "service_month": date(2026, 9, 1),
            "winteam_job_number": job, "site_name": f"Station {job}", "revenue_before_tax": revenue, "tax": 82.5,
            "invoice_total": str(revenue + 82.5), "customer_number": "FDX", "portal_state": "approved", **kw}


def pay(ar: str, amount: float, vendor: str = "Acme Janitorial", **kw) -> dict:
    return {"ar_invoice_number": ar, "station": "ABC", "vendor_number": "V1", "vendor_name": vendor,
            "vendor_invoice_number": f"A-{ar}", "work_order_number": "WO1", "amount": amount, "in_winteam": True,
            "payment_status": None, "paid_amount": None, "paid_date": None, "check_number": None, "self_perform": False, **kw}


@pytest.mark.parametrize("number, keys", [
    ("164301", ["164301"]),
    ("164301DOC", ["164301DOC", "164301"]),
    ("163622OFFa", ["163622OFFa", "163622"]),
    ("164448a", ["164448a", "164448"]),
    ("165121ADHOC", ["165121ADHOC", "165121"]),
    ("CINV0863160A", ["CINV0863160A"]),
])
def test_invoice_keys_follow_relay(number, keys):
    assert fi.invoice_keys(number) == keys


def test_one_row_per_invoice_with_its_legs_summed():
    out = fi.build([inv("164301"), inv("164302", revenue=500)],
                   [pay("164301DOC", 400), pay("164301OFF", 200, vendor="Acme Janitorial", vendor_invoice_number="A-2"),
                    pay("999999", 50)], [])
    first, second = out["rows"]
    assert (first["payables"], first["vendor_cost"], first["margin"], first["margin_pct"]) == (2, 600.0, 400.0, 0.4)
    assert first["vendors"] == "Acme Janitorial" and first["vendor_invoices"] == "A-164301DOC, A-2"
    assert first["invoice_total"] == 1082.5 and first["delivery"] == "Subcontracted"
    assert (second["payables"], second["vendor_cost"], second["margin"]) == (0, None, None)
    t = out["totals"]
    assert (t["invoices"], t["revenue"], t["vendor_cost"], t["margin"], t["without_payable"]) == (2, 1500.0, 600.0, 400.0, 1)


def test_crane_own_work_is_flagged_and_not_a_cost():
    out = fi.build([inv("1"), inv("2")],
                   [pay("1", 700, vendor="Martin Building Solutions"), pay("2", 300, self_perform=True)], [])
    for row in out["rows"]:
        assert row["delivery"] == "Self-perform" and row["vendor_cost"] is None and row["crane_payables"] == 1
    assert out["totals"]["vendor_cost"] == 0 and out["totals"]["crane_payables"] == 2 and out["totals"]["without_payable"] == 0


def test_a_self_perform_station_without_payables_reads_self_perform():
    out = fi.build([inv("1", job="77")], [], [{"winteam_job_number": "77", "station": "XYZ", "self_perform": True, "subcontractor": None}])
    assert out["rows"][0]["delivery"] == "Self-perform" and out["rows"][0]["stations"] == "XYZ"


def test_contract_subcontractor_fills_in_when_no_payable_yet():
    out = fi.build([inv("1", job="77")], [], [{"winteam_job_number": "77", "station": "XYZ", "self_perform": False, "subcontractor": "Bright Co"}])
    assert out["rows"][0]["vendors"] == "Bright Co" and out["rows"][0]["delivery"] == "Subcontracted"


def test_vendor_payment_fields():
    out = fi.build([inv("1")], [pay("1", 400, payment_status="paid", paid_amount=400, paid_date=date(2026, 10, 20), check_number="5521"),
                                pay("1", 100, vendor_invoice_number="B", payment_status="open", in_winteam=False)], [])
    row = out["rows"][0]
    assert (row["vendor_paid"], row["vendor_paid_date"], row["check_numbers"], row["not_in_winteam"]) == (400.0, "2026-10-20", "5521", 1)
    assert row["vendor_payment"] == "paid; open"


def test_range_rules():
    fi.validate_range(date(2026, 1, 1), date(2026, 12, 31))
    with pytest.raises(ValueError):
        fi.validate_range(date(2026, 2, 1), date(2026, 1, 1))
    with pytest.raises(ValueError):
        fi.validate_range(date(2024, 1, 1), date(2026, 12, 31))


def test_route_refuses_a_bad_basis_and_range():
    from fastapi import HTTPException

    from app.routers.leadership import leadership_fedex_invoices

    for kw in ({"basis": "week", "date_to": date(2026, 10, 31)}, {"basis": "invoice", "date_to": date(2026, 9, 1)}):
        with pytest.raises(HTTPException) as err:
            leadership_fedex_invoices(account="fedex", date_from=date(2026, 10, 1), **kw)
        assert err.value.status_code == 422


def test_the_tab_is_open_to_the_shipped_roles():
    for role in ("admin", "executive", "analyst"):
        assert permissions.effective(role, None)["tab.invoices"]
    assert not permissions.effective("analyst", {"tab.invoices": False})["tab.invoices"]
