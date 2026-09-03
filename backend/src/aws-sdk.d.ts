// Ленивый DynamoDB-клиент: типы-заглушки, чтобы локально не тянуть @aws-sdk.
// Реальный SDK подхватывается в Lambda через dependencies при деплое (см. infra/).
declare module "@aws-sdk/client-dynamodb" {
  export class DynamoDBClient {
    constructor(config?: unknown);
  }
}
declare module "@aws-sdk/lib-dynamodb" {
  export class DynamoDBDocumentClient {
    constructor(client: unknown);
    get(input: unknown): Promise<unknown>;
    put(input: unknown): Promise<unknown>;
  }
  export function from(client: unknown): DynamoDBDocumentClient;
}
