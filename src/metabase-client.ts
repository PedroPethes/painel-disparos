import { MetabaseConfig, MetabaseRow } from './types';

export class MetabaseClient {
  private config: MetabaseConfig;
  private token: string | null = null;
  private tokenExpiry: number = 0;

  constructor(config: MetabaseConfig) {
    this.config = config;
  }

  /** fetch com algumas tentativas para tolerar blips de rede (ex.: cold start). */
  private async fetchRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, init);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 300 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async ensureSession(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiry) return;

    const res = await this.fetchRetry(`${this.config.url}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.config.user,
        password: this.config.pass,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metabase login failed (${res.status}): ${text}`);
    }

    const data: any = await res.json();
    this.token = data.id;
    // Token válido por ~10h, renovar 5 min antes
    this.tokenExpiry = Date.now() + 10 * 60 * 60 * 1000 - 5 * 60 * 1000;
  }

  private async dataset(body: Record<string, any>): Promise<MetabaseRow> {
    await this.ensureSession();

    const res = await this.fetchRetry(`${this.config.url}/api/dataset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Metabase-Session': this.token!,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Metabase query failed (${res.status}): ${text}`);
    }

    const data: any = await res.json();

    if (data.status === 'failed' || data.error) {
      throw new Error(`Metabase query error: ${data.error || JSON.stringify(data)}`);
    }

    return { rows: data.data.rows, cols: data.data.cols };
  }

  /**
   * Query MongoDB via aggregation pipeline.
   * O Metabase espera o pipeline como string JSON no campo `query`.
   */
  async queryMongo(collection: string, pipeline: any[], db: number): Promise<MetabaseRow> {
    return this.dataset({
      database: db,
      type: 'native',
      native: { query: JSON.stringify(pipeline), collection },
    });
  }

  /** Igual a queryMongo, mas já retorna array de objetos. */
  async queryMongoAsObjects<T = Record<string, any>>(
    collection: string,
    pipeline: any[],
    db: number,
  ): Promise<T[]> {
    const { rows, cols } = await this.queryMongo(collection, pipeline, db);
    return this.toObjects<T>(rows, cols);
  }

  /**
   * Query SQL nativo (ex.: PostgreSQL de produção). Usada pelo ingestor para os leads.
   * O Mongo dos disparos usa outro database — por isso o `db` é explícito.
   */
  async querySql(sql: string, db: number): Promise<MetabaseRow> {
    return this.dataset({ database: db, type: 'native', native: { query: sql } });
  }

  /** Igual a querySql, mas já retorna array de objetos. */
  async querySqlAsObjects<T = Record<string, any>>(sql: string, db: number): Promise<T[]> {
    const { rows, cols } = await this.querySql(sql, db);
    return this.toObjects<T>(rows, cols);
  }

  private toObjects<T>(rows: any[][], cols: { name: string }[]): T[] {
    const names = cols.map((c) => c.name);
    return rows.map((row) => {
      const obj: Record<string, any> = {};
      names.forEach((n, i) => { obj[n] = row[i]; });
      return obj as T;
    });
  }
}
