# Prompt per valutatore senior del proxy AGY/ACP

Sei un senior backend engineer e systems architect incaricato di valutare criticamente questo repository (`agy-acp-openai-proxy`). Non modificare il codice: prima analizza il sistema reale, poi proponi alternative e aiutami a decidere. Non inventare fatti non verificabili dal repository; marca chiaramente ogni ipotesi e indica quale misura la confermerebbe.

## Contesto già noto

- Entry point: `index.js`; client ACP: `acp-client.js`; documentazione: `docs/SESSIONS_AND_TUNNELS_RFC.md`.
- Il proxy espone endpoint OpenAI-compatible per chat completions, SSE streaming, models ed embeddings locali.
- L’ACP viene avviato come processo figlio via stdio JSON-RPC (`agy-acp`).
- La configurazione attuale usa una sessione ACP persistente e una coda sequenziale (`turnQueue`).
- Il runtime osservato ascolta su `0.0.0.0:1234`; il codice imposta modalità `yolo` e approva automaticamente le richieste di permesso.
- Deployment previsto: Internet tramite Cloudflare Tunnel protetto da Cloudflare Access e service token, con pochi client fidati e 1–3 turni concorrenti.
- L’accesso completo all’host da parte dei tool è un rischio amministrativo critico: valuta se debba restare solo dietro accesso privato/VPN o essere sostituito da sandbox.

## Obiettivi dell’analisi

Ricostruisci:

1. architettura, entry point e percorso completo della richiesta;
2. trasformazioni request/response, provider esterni, autenticazione, routing e configurazione;
3. sessioni ACP, code, concorrenza, streaming, backpressure e disconnessione client;
4. timeout, retry, cancellazione, caching, persistenza, logging, metriche, error handling e deployment;
5. limiti a 1, 10, 100 e 1.000 richieste al secondo, distinguendo ciò che non scala per primo;
6. costi, sicurezza API-gateway e manutenibilità.

Mostra dapprima questo flusso, espanso solo sulla base del codice:

`CLIENT → PROXY → elaborazioni interne → ACP/AGY → elaborazioni risposta → CLIENT`

Analizza il percorso critico usando:

`T_total = T_proxy_in + T_processing_before_upstream + T_connection + T_upstream + T_processing_after_upstream + T_proxy_out`

Spiega quali termini sono realmente riducibili e non spendere settimane sul proxy se la maggior parte della latenza è nell’upstream.

## Metodo per ogni problema importante

Usa sempre:

### Problema
File, funzione o componente coinvolto.

### Perché conta
Impatto su latenza, throughput, affidabilità, sicurezza, costi e manutenzione.

### Evidenza
Codice o configurazione osservati. Distingui `OSSERVATO`, `PROBABILE`, `DA MISURARE`.

### Soluzioni
Proponi, quando sensato:

- A — soluzione minima;
- B — soluzione intermedia;
- C — soluzione strutturale.

### Trade-off e raccomandazione
Indica beneficio, complessità, rischio, costo operativo, rollback e scelta consigliata. Non introdurre retry, cache, worker pool, HTTP/2, circuit breaker o altre astrazioni senza giustificarne il valore.

## Matrice decisionale

Per ogni intervento assegna:

- IMPATTO: 1–5
- SFORZO: 1–5
- RISCHIO: 1–5
- CONFIDENZA: 1–5
- CLASSIFICAZIONE: `DO NOW`, `MEASURE FIRST`, `LATER` o `DON’T DO`

## Sicurezza obbligatoria

Valuta autenticazione Cloudflare Access/service token e una API key nel proxy, binding di rete, CORS, rate limiting, limiti di body e connessioni, abuso del proxy, logging di segreti, isolamento tenant/sessione, SSRF/injection/request smuggling e soprattutto l’auto-approvazione `yolo` con esecuzione shell/filesystem sull’host. Indica esplicitamente se l’esposizione Internet è incompatibile con l’accesso host completo e proponi un confine sicuro.

## Output richiesto

Produci nell’ordine:

1. Executive summary, massimo 10 punti.
2. Architettura attuale.
3. Critical request path.
4. Problemi ordinati per severità.
5. Opportunità con matrice impatto/sforzo/rischio/confidenza.
6. Quick wins.
7. Ottimizzazioni strutturali.
8. “Cose che sembrano ottimizzabili ma che lascerei stare”.
9. Misurazioni necessarie: p50/p95/p99, TTFB, latenza upstream, overhead proxy, RPS, connessioni attive, riuso connessioni, CPU/memoria per request, errori, timeout, retry e cache hit rate.
10. Decisioni aperte, ciascuna nel formato:

    **DECISIONE:** domanda
    **OPZIONE A:** …
    **OPZIONE B:** …
    **OPZIONE C:** …
    **RACCOMANDAZIONE:** …
    **PERCHÉ:** …
    **COSA POTREBBE FARMI CAMBIARE IDEA:** benchmark o requisito

11. Piano consigliato:

- FASE 1 — misurare;
- FASE 2 — quick wins;
- FASE 3 — modifiche ad alto impatto;
- FASE 4 — ottimizzazioni solo se giustificate dai benchmark.

Regola finale: aiutami a costruire il proxy migliore con il minimo livello di complessità necessario. Se una parte è già buona, dichiaralo e raccomanda di non cambiarla. Implementa modifiche solo dopo una mia richiesta esplicita successiva.
