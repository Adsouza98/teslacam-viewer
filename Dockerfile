FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    gosu \
    && rm -rf /var/lib/apt/lists/* \
    && gosu nobody true

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh \
    && mkdir -p /cache /media

ENV MEDIA_PATH=/media \
    CACHE_PATH=/cache \
    TZ=America/Toronto \
    PORT=8000 \
    PUID=568 \
    PGID=568

EXPOSE 8000

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
