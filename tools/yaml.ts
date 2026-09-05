/**
 * Минимальный парсер подмножества YAML, которое генерирует tools/md2yaml.ts
 * и хранится в days/*.yaml. Без внешних зависимостей.
 *
 * Поддерживается ровно:
 * - скаляры: `key: value` (plain), `key: 'quoted'` ('' = апостроф),
 *   `key: null`, `key: 123`
 * - `key:` + вложенный список `- ...` (отступ 2 / ключи мапа 4)
 * - `key: |` literal-блок (содержимое с отступом 6)
 * Отступы строго 0/2/4/6. Всё остальное — ошибка (файл править руками проще,
 * чем чинить молчаливое неверное чтение плана тренировок).
 */

export type Scalar = string | number | null;
export type YamlMap = Record<string, Scalar | YamlItem[] | string[]>;
export interface YamlItem extends YamlMap {}

function parseScalar(raw: string): Scalar {
  const v = raw.trim();
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"')) throw new Error(`двойные кавычки не поддерживаются: ${raw}`);
  return v;
}

function indentOf(line: string): number {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

export function parseDayYaml(text: string, name: string): YamlMap {
  const fail = (msg: string): never => {
    throw new Error(`${name}: ${msg}`);
  };
  const doc: YamlMap = {};
  let curList: YamlItem[] | null = null;
  let curItem: YamlItem | null = null;
  let literalKey: string | null = null;
  let literalBuf: string[] = [];

  const flushLiteral = (): void => {
    if (literalKey === null || curItem === null) return;
    // Убрать технические отступы и пустые строки по краям literal-блока.
    const body = literalBuf.join("\n").replace(/\s+$/, "");
    curItem[literalKey] = body;
    literalKey = null;
    literalBuf = [];
  };

  const lines = text.split("\n");
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    if (/^\s*(#.*)?$/.test(raw)) {
      if (literalKey !== null && raw.trim() === "") literalBuf.push("");
      continue;
    }
    const ind = indentOf(raw);
    const line = raw.trim();

    if (literalKey !== null) {
      if (ind >= 6) {
        literalBuf.push(raw.slice(6).replace(/\s+$/, ""));
        continue;
      }
      flushLiteral();
    }

    if (ind === 0) {
      const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) fail(`строка ${ln + 1}: жду 'key: value'`);
      const [, key, rest] = m;
      if (rest === "" || rest === "|" || rest === "[]") {
        if (rest === "|") fail(`строка ${ln + 1}: literal только внутри элементов списка`);
        curList = [];
        doc[key] = curList;
        curItem = null;
      } else {
        doc[key] = parseScalar(rest);
        curList = null;
        curItem = null;
      }
      continue;
    }

    if (ind === 2) {
      if (curList === null) fail(`строка ${ln + 1}: '- ' вне списка`);
      const m = line.match(/^-\s+([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m) fail(`строка ${ln + 1}: жду '- key: value'`);
      curItem = {};
      curList.push(curItem);
      const [, key, rest] = m;
      if (rest === "|") literalKey = key;
      else curItem[key] = parseScalar(rest);
      continue;
    }

    if (ind === 4) {
      if (curItem === null) fail(`строка ${ln + 1}: ключ вне элемента списка`);
      const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (!m || m[1] === undefined) fail(`строка ${ln + 1}: жду 'key: value'`);
      const key = m[1];
      const rest = m[2] ?? "";
      if (rest === "|") literalKey = key;
      else curItem[key] = parseScalar(rest);
      continue;
    }

    fail(`строка ${ln + 1}: неверный отступ ${ind}`);
  }
  flushLiteral();
  return doc;
}
