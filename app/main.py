import io
import json
import os
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GridSearchCV, KFold, cross_val_predict
from sklearn.linear_model import LinearRegression
from sklearn.neighbors import KNeighborsRegressor
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import MinMaxScaler
from app.graficos import grafico_teste, grafico_treino
from app.cripto import criptografar, descriptografar

app = FastAPI(title="Trabalho PI - Regressão com KNN (e regressão linear para comparar)")

# CORS: permite que um front em outra origem (outra porta, domínio ou file://) chame a API.
# Usamos "*" (qualquer origem) porque a API não usa cookies nem login
# e os arquivos já trafegam criptografados.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
    expose_headers=["Content-Disposition"],  # deixa o front ler o nome do arquivo no /download
)

# O front (pasta frontend/) é servido pela própria API em /site.
# html=True faz /site/ abrir o index.html automaticamente.
PASTA_FRONT = Path(__file__).parent.parent / "frontend"
app.mount("/site", StaticFiles(directory=PASTA_FRONT, html=True), name="site")


@app.get("/")
def inicio():
    # Quem abre http://localhost:8000 cai direto no front
    return RedirectResponse("/site/")


# Onde o modelo fica salvo (vamos ligar essa pasta a um volume do Docker)
PASTA_MODELOS = Path("/code/modelos")
PASTA_MODELOS.mkdir(parents=True, exist_ok=True)
ARQ_MODELO = PASTA_MODELOS / "modelo.joblib"
ARQ_MODELO_LINEAR = PASTA_MODELOS / "modelo_linear.joblib"
ARQ_METRICAS = PASTA_MODELOS / "metricas.json"
ARQ_PREVISOES = PASTA_MODELOS / "previsoes.csv"
ARQ_GRAFICO_TREINO = PASTA_MODELOS / "grafico_treino.png"
ARQ_GRAFICO_TESTE = PASTA_MODELOS / "grafico_teste.png"

FEATURES = ["time-5", "time-4", "time-3", "time-2", "time-1"]
ALVO = "time"


def pegar_senha() -> str:
    """A senha vem da variável de ambiente SENHA_PI (nunca fica no código)."""
    senha = os.environ.get("SENHA_PI")
    if not senha:
        raise HTTPException(500, "Servidor sem senha: defina a variável de ambiente SENHA_PI.")
    return senha


async def ler_arquivo_criptografado(arquivo: UploadFile) -> bytes:
    """Lê o arquivo enviado (criptografado) e devolve o conteúdo original."""
    senha = pegar_senha()
    try:
        return descriptografar(await arquivo.read(), senha)
    except ValueError as erro:
        raise HTTPException(400, str(erro))


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
        # Com menos de 2 linhas o R² não existe, então devolvemos None (vira null no JSON)
        "r2": round(float(r2_score(y, y_prev)), 4) if len(y) >= 2 else None,
    }


@app.post("/train")
async def train(arquivo: UploadFile = File(...)):
    df = ler_csv(await ler_arquivo_criptografado(arquivo), FEATURES + [ALVO])
    if len(df) < 20:
        raise HTTPException(400, "Poucas linhas para treinar (mínimo 20).")
    if df[ALVO].nunique() < 2:
        raise HTTPException(400, "A coluna 'time' tem um valor só: não há o que aprender.")

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

    # ---- REGRESSÃO LINEAR (só para comparar com o KNN) ----
    # Mesma receita: min-max + modelo, avaliado com a mesma validação cruzada 10-fold
    linear = Pipeline([
        ("minmax", MinMaxScaler()),
        ("regressao", LinearRegression()),
    ])
    y_prev_linear = cross_val_predict(linear, X, y, cv=KFold(n_splits=10, shuffle=True, random_state=42))
    metricas_linear = calcular_metricas(y, y_prev_linear)
    linear.fit(X, y)  # treino final com todos os dados
    joblib.dump(linear, ARQ_MODELO_LINEAR)

    metricas["linhas_treino"] = len(df)
    metricas["melhor_k"] = int(melhor_k)
    metricas["insights"] = insights_treino(X, y, y_prev, faixas, melhor_k, metricas)
    metricas["insights"].append(
        f"Comparação: o KNN erra em média {metricas['mae']:.1f} e a regressão linear "
        f"erra {metricas_linear['mae']:.1f}."
    )
    metricas["regressao_linear"] = metricas_linear

    # Base nova = começa do zero: apaga o teste e as previsões do modelo antigo
    ARQ_GRAFICO_TESTE.unlink(missing_ok=True)
    ARQ_PREVISOES.unlink(missing_ok=True)

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
    if not ARQ_MODELO.exists() or not ARQ_MODELO_LINEAR.exists():
        raise HTTPException(400, "Nenhum modelo treinado. Use /train primeiro.")
    modelo = joblib.load(ARQ_MODELO)

    # Se o CSV tiver a coluna 'time' preenchida, é teste (avaliamos);
    # se não tiver (ou estiver vazia), é aplicação (só prevemos)
    conteudo = await ler_arquivo_criptografado(arquivo)
    try:
        bruto = pd.read_csv(io.BytesIO(conteudo))
    except Exception:
        raise HTTPException(400, "Não consegui ler o arquivo como CSV.")
    tem_rotulo = ALVO in bruto.columns and bruto[ALVO].notna().any()
    colunas = FEATURES + [ALVO] if tem_rotulo else FEATURES
    df = ler_csv(conteudo, colunas)

    # Previsão (o pipeline aplica o min-max do treino automaticamente).
    # O modelo usa SÓ as 5 colunas de entrada; o 'time' do teste é só gabarito.
    df["time_previsto_knn"] = modelo.predict(df[FEATURES]).round(4)
    # Previsão da regressão linear, numa coluna separada (só para comparar)
    linear = joblib.load(ARQ_MODELO_LINEAR)
    df["time_previsto_regressao_linear"] = linear.predict(df[FEATURES]).round(4)
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
        real = calcular_metricas(df[ALVO], df["time_previsto_knn"])
        grafico_teste(df[ALVO], df["time_previsto_knn"], esperado, real, ARQ_GRAFICO_TESTE)

        resposta["mensagem"] += " e veja os gráficos em /graficos/teste"
        resposta["desempenho_real"] = real
        resposta["desempenho_esperado"] = {k: esperado[k] for k in ["rmse", "mae", "r2"]}
        resposta["insights"] = insights_teste(esperado, real, int(fora.values.sum()))

        # Mesma comparação para a regressão linear
        real_linear = calcular_metricas(df[ALVO], df["time_previsto_regressao_linear"])
        resposta["regressao_linear"] = {
            "desempenho_real": real_linear,
            "desempenho_esperado": esperado["regressao_linear"],
        }
        resposta["insights"].append(
            f"Comparação no teste: o KNN errou em média {real['mae']:.1f} "
            f"e a regressão linear errou {real_linear['mae']:.1f}."
        )

    else:
        # Aplicação (sem rótulo): não há teste novo, então some o gráfico de teste antigo
        ARQ_GRAFICO_TESTE.unlink(missing_ok=True)

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
    # No servidor o CSV fica normal; ele só é criptografado na hora de enviar
    cifrado = criptografar(ARQ_PREVISOES.read_bytes(), pegar_senha())
    return Response(
        cifrado,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="previsoes.cripto"'},
    )
