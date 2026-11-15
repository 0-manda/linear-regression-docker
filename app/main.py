import io
import json
from pathlib import Path

import joblib
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.linear_model import LinearRegression
from sklearn.model_selection import KFold, cross_validate
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import MinMaxScaler

app = FastAPI(title="Trabalho PI - Regressão Linear")

# Onde o modelo fica salvo (vamos ligar essa pasta a um volume do Docker)
PASTA_MODELOS = Path("/code/modelos")
PASTA_MODELOS.mkdir(exist_ok=True)
ARQ_MODELO = PASTA_MODELOS / "modelo.joblib"
ARQ_METRICAS = PASTA_MODELOS / "metricas.json"
ARQ_PREVISOES = PASTA_MODELOS / "previsoes.csv"

FEATURES = ["time-5", "time-4", "time-3", "time-2", "time-1"]
ALVO = "time"


def ler_csv(conteudo: bytes, colunas_obrigatorias: list[str]) -> pd.DataFrame:
    """Lê o CSV, confere as colunas e remove linhas inválidas."""
    try:
        df = pd.read_csv(io.BytesIO(conteudo))
    except Exception:
        raise HTTPException(400, "Não consegui ler o arquivo como CSV.")

    faltando = [c for c in colunas_obrigatorias if c not in df.columns]
    if faltando:
        raise HTTPException(400, f"Colunas faltando no CSV: {faltando}")

    # Converte para número (texto vira NaN) e descarta linhas com problema
    df = df[colunas_obrigatorias].apply(pd.to_numeric, errors="coerce").dropna()
    if df.empty:
        raise HTTPException(400, "O CSV não tem linhas válidas.")
    return df


@app.get("/status")
def status():
    treinado = ARQ_MODELO.exists()
    resposta = {"modelo_treinado": treinado}
    if treinado:
        resposta["desempenho_esperado"] = json.loads(ARQ_METRICAS.read_text())
    return resposta


@app.post("/train")
async def train(arquivo: UploadFile = File(...)):
    df = ler_csv(await arquivo.read(), FEATURES + [ALVO])
    if len(df) < 20:
        raise HTTPException(400, "Poucas linhas para treinar (mínimo 20).")

    X, y = df[FEATURES], df[ALVO]

    # Pipeline = normalização min-max + regressão, sempre juntas
    modelo = Pipeline([
        ("minmax", MinMaxScaler()),
        ("regressao", LinearRegression()),
    ])

    # Desempenho esperado: validação cruzada 10-fold
    cv = cross_validate(
        modelo, X, y,
        cv=KFold(n_splits=10, shuffle=True, random_state=42),
        scoring={
            "rmse": "neg_root_mean_squared_error",
            "mae": "neg_mean_absolute_error",
            "r2": "r2",
        },
    )
    metricas = {
        "rmse": round(float(-cv["test_rmse"].mean()), 4),
        "mae": round(float(-cv["test_mae"].mean()), 4),
        "r2": round(float(cv["test_r2"].mean()), 4),
        "linhas_treino": len(df),
    }

    # Treino final com TODOS os dados, depois salva em disco
    modelo.fit(X, y)
    joblib.dump(modelo, ARQ_MODELO)
    ARQ_METRICAS.write_text(json.dumps(metricas))

    return {"mensagem": "Modelo treinado!", "desempenho_esperado": metricas}


@app.post("/reset")
def reset():
    ARQ_MODELO.unlink(missing_ok=True)
    ARQ_METRICAS.unlink(missing_ok=True)
    ARQ_PREVISOES.unlink(missing_ok=True)
    return {"mensagem": "Modelo apagado. Pronto para treinar em outra base."}


@app.post("/predict")
async def predict(arquivo: UploadFile = File(...)):
    if not ARQ_MODELO.exists():
        raise HTTPException(400, "Nenhum modelo treinado. Use /train primeiro.")
    modelo = joblib.load(ARQ_MODELO)

    # Se o CSV tiver a coluna 'time', é teste (avaliamos); senão, é aplicação
    conteudo = await arquivo.read()
    tem_rotulo = ALVO in pd.read_csv(io.BytesIO(conteudo), nrows=0).columns
    colunas = FEATURES + [ALVO] if tem_rotulo else FEATURES
    df = ler_csv(conteudo, colunas)

    # Previsão (o pipeline aplica o min-max do treino automaticamente)
    df["time_previsto"] = modelo.predict(df[FEATURES]).round(4)
    df.to_csv(ARQ_PREVISOES, index=False)

    # Alerta: quantos valores ficaram fora da faixa (mín/máx) vista no treino
    scaler = modelo.named_steps["minmax"]
    fora = (df[FEATURES] < scaler.data_min_) | (df[FEATURES] > scaler.data_max_)

    resposta = {
        "mensagem": "Previsões feitas! Baixe o CSV em /download",
        "linhas_previstas": len(df),
        "valores_fora_da_faixa_do_treino": int(fora.values.sum()),
    }

    if tem_rotulo:
        y, y_prev = df[ALVO], df["time_previsto"]
        resposta["desempenho_real"] = {
            "rmse": round(float(mean_squared_error(y, y_prev) ** 0.5), 4),
            "mae": round(float(mean_absolute_error(y, y_prev)), 4),
            "r2": round(float(r2_score(y, y_prev)), 4),
        }
        resposta["desempenho_esperado"] = json.loads(ARQ_METRICAS.read_text())

    return resposta


@app.get("/download")
def download():
    if not ARQ_PREVISOES.exists():
        raise HTTPException(404, "Nenhuma previsão feita ainda. Use /predict primeiro.")
    return FileResponse(ARQ_PREVISOES, media_type="text/csv", filename="previsoes.csv")
