FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY sim ./sim

RUN groupadd --system sim && useradd --system --gid sim --no-create-home sim \
    && chown -R sim:sim /app
USER sim

EXPOSE 8081

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8081/__sim/health', timeout=2)"

CMD ["uvicorn", "sim.app:app", "--host", "0.0.0.0", "--port", "8081"]
