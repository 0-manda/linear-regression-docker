# Imagem base: um Linux enxuto já com Python 3.12
FROM python:3.12-slim

# Pasta de trabalho dentro do container
WORKDIR /code

# Copia só o requirements primeiro (aproveita o cache do Docker)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Depois copia o código da API e o front (servido em /site)
COPY app/ ./app/
COPY frontend/ ./frontend/

# Porta em que a API vai escutar
EXPOSE 8000

# Comando executado quando o container sobe
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]