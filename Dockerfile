FROM python:3.12-slim

# Install ffmpeg for optional thumbnail generation (lightweight)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Create non-root user for better security (optional but good practice)
RUN useradd -m -u 1000 viewer && chown -R viewer:viewer /app
USER viewer

ENV MEDIA_PATH=/media
ENV TZ=America/Toronto
ENV PORT=8000

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
