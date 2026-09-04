// Storage: локально JSON-файл, в AWS — DynamoDB (ленивый импорт SDK).
// Выбор: если задан TABLE_NAME — DynamoDB, иначе файл $DATA_DIR/progress.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgressEntry } from "./types.ts";

export interface ProgressStore {
  get(date: string): Promise<ProgressEntry | null>;
  put(entry: ProgressEntry): Promise<ProgressEntry>;
  /** Пакетное чтение для /api/activity: один проход вместо N отдельных get. */
  getMany(dates: string[]): Promise<Map<string, ProgressEntry>>;
}

function dataFile(): string {
  if (process.env.DATA_DIR) return join(process.env.DATA_DIR, "progress.json");
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "data", "progress.json");
}

function readAll(file: string): Record<string, ProgressEntry> {
  try {
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, ProgressEntry>;
  } catch {
    return {};
  }
}

export class FileStore implements ProgressStore {
  async get(date: string): Promise<ProgressEntry | null> {
    return readAll(dataFile())[date] ?? null;
  }
  async getMany(dates: string[]): Promise<Map<string, ProgressEntry>> {
    const all = readAll(dataFile());
    const out = new Map<string, ProgressEntry>();
    for (const d of dates) {
      const e = all[d];
      if (e) out.set(d, e);
    }
    return out;
  }
  async put(entry: ProgressEntry): Promise<ProgressEntry> {
    const file = dataFile();
    mkdirSync(dirname(file), { recursive: true });
    const all = readAll(file);
    all[entry.date] = entry;
    writeFileSync(file, JSON.stringify(all, null, 1));
    return entry;
  }
}

// Один клиент на весь Lambda-инстанс: раньше каждый get() создавал новый
// DynamoDBClient, и /api/activity открывал 186 клиентов параллельно.
let sharedDocPromise: Promise<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient> | null = null;

async function sharedDoc(): Promise<import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient> {
  if (!sharedDocPromise) {
    sharedDocPromise = (async () => {
      // Ленивый импорт, чтобы локально не тянуть @aws-sdk.
      const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
      const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
      return new DynamoDBDocumentClient(new DynamoDBClient({}));
    })();
    sharedDocPromise.catch(() => {
      sharedDocPromise = null;
    });
  }
  return sharedDocPromise;
}

const GET_MANY_CONCURRENCY = 12;

class DynamoStore implements ProgressStore {
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  async get(date: string): Promise<ProgressEntry | null> {
    const doc = await sharedDoc();
    const res = (await doc.get({ TableName: this.table, Key: { pk: `day#${date}` } })) as { Item?: ProgressEntry };
    return res.Item ?? null;
  }
  async getMany(dates: string[]): Promise<Map<string, ProgressEntry>> {
    const doc = await sharedDoc();
    const out = new Map<string, ProgressEntry>();
    for (let i = 0; i < dates.length; i += GET_MANY_CONCURRENCY) {
      const chunk = dates.slice(i, i + GET_MANY_CONCURRENCY);
      const results = await Promise.all(
        chunk.map(async (d) => {
          const res = (await doc.get({ TableName: this.table, Key: { pk: `day#${d}` } })) as {
            Item?: ProgressEntry;
          };
          return [d, res.Item ?? null] as const;
        }),
      );
      for (const [d, item] of results) {
        if (item) out.set(d, item);
      }
    }
    return out;
  }
  async put(entry: ProgressEntry): Promise<ProgressEntry> {
    const doc = await sharedDoc();
    await doc.put({ TableName: this.table, Item: { pk: `day#${entry.date}`, ...entry } });
    return entry;
  }
}

export function createStore(): ProgressStore {
  if (process.env.TABLE_NAME) return new DynamoStore(process.env.TABLE_NAME);
  return new FileStore();
}
