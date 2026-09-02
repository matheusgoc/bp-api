// Idempotent seeding default categories (safe to re-run)
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME ?? "bp-api-local";
const isLocal = !!process.env.DYNAMODB_ENDPOINT;

const client = new DynamoDBClient({
  ...(isLocal
    ? {
        endpoint: process.env.DYNAMODB_ENDPOINT,
        region: "local",
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : {}),
  requestHandler: { requestTimeout: 10_000 },
});
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const CATEGORIES = [
  {
    name: "Alimentação e Bebidas",
    description:
      "Restaurante, cafeteria, padaria, bar, lanchonete, food truck, sorveteria",
  },
  {
    name: "Varejo e Compras",
    description:
      "Loja de sapatos, loja de roupas, supermercado, loja de eletrônicos, farmácia, livraria",
  },
  {
    name: "Saúde e Bem-estar",
    description:
      "Academia, hospital, clínica, dentista, spa, estúdio de yoga, fisioterapia",
  },
  {
    name: "Beleza e Estética",
    description:
      "Salão de beleza, cabeleireiro, manicure, spa, estúdio de maquiagem, barbearia",
  },
  {
    name: "Entretenimento",
    description:
      "Cinema, teatro, casa de shows, parque de diversões, fliperama, boate, museu",
  },
  {
    name: "Esportes e Fitness",
    description:
      "Clube esportivo, academia, piscina, estádio, quadra de tênis, dojo de artes marciais",
  },
  {
    name: "Automotivo e Reparos",
    description:
      "Oficina mecânica, auto-elétrica, lava-rápido, funilaria/pintura, pneus/bateria",
  },
  {
    name: "Serviços Gerais",
    description: "Lavanderia, elétrica, encanamento, pintor",
  },
  {
    name: "Educação",
    description:
      "Escola, universidade, centro de treinamento, biblioteca, escola de idiomas",
  },
  {
    name: "Profissionais",
    description:
      "Escritório de advocacia, contador, imobiliária, consultoria, agência de marketing",
  },
  {
    name: "Hospitalidade",
    description:
      "Hotel, pousada, camping, aluguel de temporada, salão de festas",
  },
  {
    name: "Transporte",
    description:
      "Posto de gasolina, locadora de carros, ponto de táxi, oficina de bikes, estacionamento",
  },
];

// ASCII-folds accented names into stable, human-readable, kebab-case ids —
// deterministic (not randomUUID) so re-running the seed is naturally idempotent by identity.
const slugify = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// Mirrors src/models/category.ts's categoryOrderSortKey — zero-pads `order` so
// lexicographic (string) comparison on GSI1SK/GSI2SK matches numeric comparison.
const categoryOrderSortKey = (order) => String(order).padStart(15, "0");

let created = 0;
let skipped = 0;

for (const [order, category] of CATEGORIES.entries()) {
  const id = slugify(category.name);
  const createdAt = new Date().toISOString();
  const orderSortKey = categoryOrderSortKey(order);

  const item = {
    PK: `CATEGORY#${id}`,
    SK: "METADATA",
    GSI1PK: "CATEGORY#ENABLED",
    GSI1SK: orderSortKey,
    GSI2PK: "CATEGORY",
    GSI2SK: orderSortKey,
    id,
    name: category.name,
    description: category.description,
    enabled: true,
    order,
    createdAt,
    createdBy: "seed",
    updatedAt: createdAt,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    console.log(`✅ Created category "${category.name}" (${id})`);
    created++;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      console.log(
        `ℹ️  Category "${category.name}" (${id}) already exists — skipped`,
      );
      skipped++;
    } else {
      console.error(
        `❌ Failed to seed category "${category.name}":`,
        error.message,
      );
      process.exit(1);
    }
  }
}

console.log(`\nDone: ${created} created, ${skipped} skipped.`);
