// Storage: локально JSON-файл, в AWS — DynamoDB (ленивый импорт SDK).
// Выбор: если задан TABLE_NAME — DynamoDB, иначе файл $DATA_DIR/progress.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProgressEntry } from "./types.ts";

export interface ProgressStore {
  get(date: string): Promise<ProgressEntry | null>;
  put(entry: ProgressEntry): Promise<ProgressEntry>;
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
  async put(entry: ProgressEntry): Promise<ProgressEntry> {
    const file = dataFile();
    mkdirSync(dirname(file), { recursive: true });
    const all = readAll(file);
    all[entry.date] = entry;
    writeFileSync(file, JSON.stringify(all, null, 1));
    return entry;
  }
}

class DynamoStore implements ProgressStore {
  private table: string;
  constructor(table: string) {
    this.table = table;
  }
  private async client(): Promise<{ get: Function; put: Function }> {
    // Ленивый импорт, чтобы локально не тянуть @aws-sdk.
    const lib = await import("@aws-sdk/lib-dynamodb");
    const clientMod = await import("@aws-sdk/client-dynamodb");
    const doc = new (lib as Record<string, new (o: unknown) => { get: Function; put: Function }>).DynamoDBDocumentClient(
      new (clientMod as Record<string, new (o: unknown) => unknown>).DynamoDBClient({}),
    ) as unknown as { get: Function; put: Function };
    void this.table;
    return doc;
  }
  async get(date: string): Promise<ProgressEntry | null> {
    const doc = await this.client();
    const res = (await doc.get({ TableName: this.table, Key: { pk: `day#${date}` } })) as { Item?: ProgressEntry };
    return (res.Item as ProgressEntry) ?? null;
  }
  async put(entry: ProgressEntry): Promise<ProgressEntry> {
    const doc = await this.client();
    await doc.put({ TableName: this.table, Item: { pk: `day#${entry.date}`, ...entry } });
    return entry;
  }
}

export function createStore(): ProgressStore {
  if (process.env.TABLE_NAME) return new DynamoStore(process.env.TABLE_NAME);
  return new FileStore();
}
