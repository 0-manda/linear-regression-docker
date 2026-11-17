import io
import json
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GridSearchCV, KFold, cross_val_predict
from sklearn.neighbors import KNeighborsRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import MinMaxScaler
from app.graficos import grafico_teste, grafico_treino

app = FastAPI(title="Trabalho PI - Regressão com KNN")

# Onde o modelo fica salvo (vamos ligar essa pasta a um volume do Docker)
PASTA_MODELOS = Path("/code/modelos")
PASTA_MODELOS.mkdir(exist_ok=True)
ARQ_MODELO = PASTA_MODELOS / "modelo.joblib"
ARQ_METRICAS = PASTA_MODELOS / "metricas.json"
ARQ_PREVISOES = PASTA_MODELOS / "previsoes.csv"
ARQ_GRAFICO_TREINO = PASTA_MODELOS / "grafico_treino.png"
ARQ_GRAFICO_TESTE = PASTA_MODELOS / "grafico_teste.png"

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


def calcular_metricas(y, y_prev):
    """RMSE, MAE e R² arredondados (usado no treino e no teste)."""
    return {
        "rmse": round(float(mean_squared_error(y, y_prev) ** 0.5), 4),
        "mae": round(float(mean_absolute_error(y, y_prev)), 4),
        "r2": round(float(r2_score(y, y_prev)), 4),
    }


@app.post("/train")
async def train(arquivo: UploadFile = File(...)):
    df = ler_csv(await arquivo.read(), FEATURES + [ALVO])
    if len(df) < 20:
        raise HTTPException(400, "Poucas linhas para treinar (mínimo 20).")

    X, y = df[FEATURES], df[ALVO]

    # Pipeline = normalização min-max + KNN, sempre juntas.
    # O min-max é essencial no KNN: ele mede distâncias, então todas as
    # colunas precisam estar na mesma escala (0 a 1).
    pipeline = Pipeline([
        ("minmax", MinMaxScaler()),
        ("regressao", KNeighborsRegressor()),
    ])

    # O modelo escolhe sozinho o melhor k (número de vizinhos),
    # testando cada valor com validação cruzada de 5 partes
    valores_k = [k for k in [3, 5, 7, 9, 11, 15, 21, 31, 41] if k <= len(df) // 2]
    busca = GridSearchCV(
        pipeline,
        {"regressao__n_neighbors": valores_k},
        cv=KFold(n_splits=5, shuffle=True, random_state=42),
        scoring="neg_mean_absolute_error",
    )

    # DESEMPENHO ESPERADO: validação cruzada 10-fold.
    # Cada linha é prevista por um modelo que NÃO a viu no treino, e o k é
    # escolhido de novo dentro de cada parte. Assim a estimativa é honesta.
    y_prev = cross_val_predict(busca, X, y, cv=KFold(n_splits=10, shuffle=True, random_state=42))
    metricas = calcular_metricas(y, y_prev)

    # Treino final com TODOS os dados (aqui o k definitivo é escolhido)
    busca.fit(X, y)
    melhor_k = busca.best_params_["regressao__n_neighbors"]
    erros_por_k = dict(zip(valores_k, (-busca.cv_results_["mean_test_score"]).round(2)))

    # Divide os valores reais em 3 faixas (baixos, médios, altos) para ver onde o modelo erra mais
    faixas = pd.qcut(y.rank(method="first"), 3, labels=["valores baixos", "valores médios", "valores altos"])

    metricas["linhas_treino"] = len(df)
    metricas["melhor_k"] = int(melhor_k)
    metricas["insights"] = insights_treino(X, y, y_prev, faixas, melhor_k, metricas)

    grafico_treino(y, y_prev, faixas, erros_por_k, melhor_k, ARQ_GRAFICO_TREINO)
    joblib.dump(busca.best_estimator_, ARQ_MODELO)
    ARQ_METRICAS.write_text(json.dumps(metricas, ensure_ascii=False))

    return {
        "mensagem": "Modelo treinado! Veja os gráficos em /graficos/treino",
        "desempenho_esperado": metricas,
    }


def insights_treino(X, y, y_prev, faixas, melhor_k, metricas):
    """Frases simples explicando o resultado do treino."""
    erro_abs = np.abs(y_prev - y)

    # Comparação com dois "chutes" simples, para mostrar que o modelo vale a pena
    mae_chute_media = mean_absolute_error(y, np.full(len(y), y.mean()))
    mae_chute_ultimo = mean_absolute_error(y, X["time-1"])
    ganho_media = (1 - metricas["mae"] / mae_chute_media) * 100
    ganho_ultimo = (1 - metricas["mae"] / mae_chute_ultimo) * 100

    erro_por_faixa = erro_abs.groupby(faixas, observed=True).mean()
    pior_faixa = erro_por_faixa.idxmax()

    return [
        f"O modelo testou vários números de vizinhos e escolheu k = {melhor_k}.",
        f"Em média, o modelo erra {metricas['mae']:.1f} unidades por previsão.",
        f"Em 80% dos casos o erro foi menor que {np.percentile(erro_abs, 80):.1f}.",
        f"O modelo explica {metricas['r2'] * 100:.0f}% da variação dos dados (R²).",
        f"O modelo erra {ganho_media:.0f}% menos que chutar sempre a média ({mae_chute_media:.1f}).",
        f"O modelo erra {ganho_ultimo:.0f}% menos que repetir o último valor observado ({mae_chute_ultimo:.1f}).",
        f"O modelo erra mais nos {pior_faixa} (MAE {erro_por_faixa.max():.1f}) "
        f"e menos nos {erro_por_faixa.idxmin()} (MAE {erro_por_faixa.min():.1f}).",
    ]


@app.post("/reset")
def reset():
    # Apaga tudo o que foi gerado: modelo, métricas, previsões e gráficos
    for arquivo in PASTA_MODELOS.glob("*"):
        arquivo.unlink()
    return {"mensagem": "Modelo apagado. Pronto para treinar em outra base."}


@app.post("/predict")
async def predict(arquivo: UploadFile = File(...)):
    if not ARQ_MODELO.exists():
        raise HTTPException(400, "Nenhum modelo treinado. Use /train primeiro.")
    modelo = joblib.load(ARQ_MODELO)

    # Se o CSV tiver a coluna 'time' preenchida, é teste (avaliamos);
    # se não tiver (ou estiver vazia), é aplicação (só prevemos)
    conteudo = await arquivo.read()
    bruto = pd.read_csv(io.BytesIO(conteudo))
    tem_rotulo = ALVO in bruto.columns and bruto[ALVO].notna().any()
    colunas = FEATURES + [ALVO] if tem_rotulo else FEATURES
    df = ler_csv(conteudo, colunas)

    # Previsão (o pipeline aplica o min-max do treino automaticamente).
    # O modelo usa SÓ as 5 colunas de entrada; o 'time' do teste é só gabarito.
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
        esperado = json.loads(ARQ_METRICAS.read_text())
        real = calcular_metricas(df[ALVO], df["time_previsto"])
        grafico_teste(df[ALVO], df["time_previsto"], esperado, real, ARQ_GRAFICO_TESTE)

        resposta["mensagem"] += " e veja os gráficos em /graficos/teste"
        resposta["desempenho_real"] = real
        resposta["desempenho_esperado"] = {k: esperado[k] for k in ["rmse", "mae", "r2"]}
        resposta["insights"] = insights_teste(esperado, real, int(fora.values.sum()))

    return resposta


def insights_teste(esperado, real, qtd_fora):
    """Compara o desempenho real (teste) com o esperado (treino)."""
    diferenca = (real["mae"] / esperado["mae"] - 1) * 100
    if abs(diferenca) <= 15:
        conclusao = "O resultado real ficou próximo do esperado: a estimativa do treino foi confiável."
    elif diferenca < 0:
        conclusao = "O modelo foi melhor no teste do que o esperado."
    else:
        conclusao = "O modelo foi pior no teste do que o esperado: a base de teste pode ser diferente da de treino."

    frases = [
        f"Erro médio esperado: {esperado['mae']:.1f} | erro médio real: {real['mae']:.1f} "
        f"({diferenca:+.0f}%).",
        conclusao,
    ]
    if qtd_fora > 0:
        frases.append(f"Atenção: {qtd_fora} valor(es) do teste fora da faixa vista no treino.")
    return frases


@app.get("/graficos/treino")
def ver_grafico_treino():
    if not ARQ_GRAFICO_TREINO.exists():
        raise HTTPException(404, "Treine o modelo primeiro.")
    return FileResponse(ARQ_GRAFICO_TREINO, media_type="image/png")


@app.get("/graficos/teste")
def ver_grafico_teste():
    if not ARQ_GRAFICO_TESTE.exists():
        raise HTTPException(404, "Faça uma previsão com um CSV que tenha a coluna 'time' primeiro.")
    return FileResponse(ARQ_GRAFICO_TESTE, media_type="image/png")


@app.get("/download")
def download():
    if not ARQ_PREVISOES.exists():
        raise HTTPException(404, "Nenhuma previsão feita ainda. Use /predict primeiro.")
    return FileResponse(ARQ_PREVISOES, media_type="text/csv", filename="previsoes.csv")
