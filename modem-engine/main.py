"""
NgaboPay USSD Engine — FastAPI service that drives a GSM modem.

Accepts payout requests from the NgaboPay Node.js server,
executes interactive USSD flows via AT commands, and reports
results back to NgaboPay via callback endpoints.

Architecture (engine on Windows laptop via Tailscale):
  NgaboPay VPS (:3000) ──Tailscale──→ this engine (:7001) → COM port → USB GSM Modem
  this engine ──HTTPS──→ NgaboPay VPS (callbacks + heartbeats)

Architecture (engine on VPS directly):
  NgaboPay VPS (:3000) → localhost → this engine (:7001) → /dev/ttyUSB0 → GSM Modem
"""

import asyncio
import logging
import threading
import time

import httpx
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel

from config import Config
from modem import GSMModem, ModemError
from providers import get_provider_flow

# ─── Logging ──────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("engine")

# ─── App Setup ────────────────────────────────────────────

config = Config()
modem = GSMModem(port=config.modem_port, baud=config.modem_baud)

app = FastAPI(title="NgaboPay USSD Engine", version="1.0.0")

# ─── Job Tracking ─────────────────────────────────────────

current_job: int | None = None
job_lock = threading.Lock()
completed_count = 0
last_error: str | None = None


# ─── Request / Response Models ────────────────────────────

class PayoutRequest(BaseModel):
    transaction_id: int
    phone: str
    amount: int
    provider: str = "airtel_ug"


class UssdTestRequest(BaseModel):
    code: str


# ─── Lifecycle ────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    """Connect modem and start heartbeat on engine startup."""
    try:
        modem.connect()
    except Exception as e:
        logger.error(f"Modem not available at startup: {e}")
        logger.info("Engine running without modem — use POST /api/reconnect to retry")

    # Start heartbeat loop
    asyncio.create_task(_heartbeat_loop())


@app.on_event("shutdown")
async def shutdown():
    modem.disconnect()


# ─── Endpoints ────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "modem_connected": modem.is_connected()}


@app.get("/api/status")
async def status():
    return {
        **modem.get_status(),
        "busy": current_job is not None,
        "current_payout": current_job,
        "completed_count": completed_count,
        "last_error": last_error,
    }


@app.post("/api/payout")
async def send_payout(req: PayoutRequest, background_tasks: BackgroundTasks):
    """
    Accept a payout job. Returns immediately.
    The USSD flow runs in a background thread; results are reported
    back to NgaboPay via /api/payout/complete or /api/payout/failed.
    """
    global current_job

    if not modem.is_connected():
        raise HTTPException(status_code=503, detail="Modem not connected")

    with job_lock:
        if current_job is not None:
            raise HTTPException(
                status_code=409,
                detail=f"Modem busy processing payout #{current_job}",
            )
        current_job = req.transaction_id

    logger.info(
        f"Payout accepted: #{req.transaction_id} | "
        f"{req.amount} to {req.phone} via {req.provider}"
    )

    # Run in background (serial I/O blocks)
    background_tasks.add_task(_execute_payout, req)

    return {"accepted": True, "transaction_id": req.transaction_id}


@app.post("/api/reconnect")
async def reconnect():
    """Disconnect and reconnect to the modem."""
    try:
        modem.disconnect()
        time.sleep(1)
        modem.connect()
        return {"success": True, **modem.get_status()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/test-ussd")
async def test_ussd(req: UssdTestRequest):
    """Send a raw USSD code for testing (e.g. *185*5# for balance check)."""
    if not modem.is_connected():
        raise HTTPException(status_code=503, detail="Modem not connected")
    if current_job is not None:
        raise HTTPException(status_code=409, detail="Modem busy with a payout")

    try:
        resp = modem.send_ussd(req.code, timeout=30)
        return {"response": resp["text"], "status": resp["status"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ─── Background Payout Execution ─────────────────────────

async def _execute_payout(req: PayoutRequest):
    """Execute the full USSD payout flow and report back to NgaboPay."""
    global current_job, completed_count, last_error

    try:
        flow = get_provider_flow(req.provider)
        result = flow.send_money(modem, req.phone, req.amount, config.mm_pin)

        # Log all USSD step responses
        for i, step in enumerate(result.get("steps", [])):
            logger.info(f"  Step {i}: [{step.get('status')}] {step.get('text', '')[:100]}")

        # Report back to NgaboPay
        if result["success"]:
            logger.info(
                f"Payout SUCCESS #{req.transaction_id} | Ref: {result.get('reference')}"
            )
            completed_count += 1
            last_error = None
            await _callback_ngabopay("complete", {
                "transaction_id": req.transaction_id,
                "reference": result.get("reference", "USSD"),
            })
        else:
            reason = result.get("reason", "USSD flow failed")
            logger.error(f"Payout FAILED #{req.transaction_id} | Reason: {reason}")
            last_error = reason
            await _callback_ngabopay("failed", {
                "transaction_id": req.transaction_id,
                "reason": reason,
            })

    except Exception as e:
        logger.exception(f"Payout error #{req.transaction_id}: {e}")
        last_error = str(e)
        await _callback_ngabopay("failed", {
            "transaction_id": req.transaction_id,
            "reason": f"Engine error: {e}",
        })

    finally:
        with job_lock:
            current_job = None


async def _callback_ngabopay(action: str, payload: dict):
    """
    Report payout result back to NgaboPay.
    Retries up to 3 times with exponential backoff.
    """
    url = f"{config.ngabopay_url}/api/payout/{action}"
    headers = {"X-API-Key": config.api_key, "Content-Type": "application/json"}

    for attempt in range(4):
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(url, json=payload, headers=headers)
                if resp.status_code < 500:
                    logger.info(f"Callback {action} → HTTP {resp.status_code}")
                    return
                logger.warning(f"Callback {action} → HTTP {resp.status_code}, retrying...")
        except Exception as e:
            logger.warning(f"Callback {action} failed (attempt {attempt + 1}): {e}")

        if attempt < 3:
            await asyncio.sleep(2 ** attempt * 2)  # 2s, 4s, 8s

    logger.error(f"CRITICAL: Failed to report {action} for payout #{payload.get('transaction_id')} after 4 attempts")


# ─── Heartbeat ────────────────────────────────────────────

async def _heartbeat_loop():
    """Send heartbeat to NgaboPay every 30 seconds so the dashboard shows modem status."""
    while True:
        try:
            status = modem.get_status()
            device = f"GSM Modem ({status['operator'] or 'Unknown'})"

            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{config.ngabopay_url}/api/phone/heartbeat",
                    json={
                        "device": device,
                        "is_polling": status["connected"],
                        "payouts_completed": completed_count,
                        "operator": status.get("operator"),
                        "signal_percent": status.get("signal_percent"),
                        "modem_port": config.modem_port,
                    },
                    headers={
                        "X-API-Key": config.api_key,
                        "Content-Type": "application/json",
                    },
                )
        except Exception as e:
            logger.debug(f"Heartbeat failed: {e}")

        await asyncio.sleep(30)


# ─── Entry Point ──────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn

    logger.info(f"Starting USSD Engine on {config.engine_host}:{config.engine_port}")
    logger.info(f"Modem port: {config.modem_port} @ {config.modem_baud}")
    logger.info(f"NgaboPay URL: {config.ngabopay_url}")

    uvicorn.run(app, host=config.engine_host, port=config.engine_port)
