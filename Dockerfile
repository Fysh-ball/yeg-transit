FROM python:3.14-slim
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt \
 && mkdir /data && chown nobody:nogroup /data
COPY server /app/server
COPY web /app/web
ENV DATA_DIR=/data PORT=8792 PYTHONUNBUFFERED=1
USER nobody
EXPOSE 8792
CMD ["python", "-I", "/app/server/app.py"]
