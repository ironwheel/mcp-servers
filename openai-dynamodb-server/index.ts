/**
 * index.ts - MCP DynamoDB Server
 *
 * Copyright (c) 2025 Robert E. Taylor, Extropic Systems
 * Licensed under the MIT License.
 *
 * This server implements a Model Context Protocol (MCP) tool that allows an AI agent
 * to perform natural language queries over one or more DynamoDB tables using the AWS SDK v3.
 *
 * Features:
 * - Loads data from configured DynamoDB tables into memory
 * - Infers schemas from sample records
 * - Supports filtering, sorting, limiting, and listing of results
 * - Uses OpenAI to convert user prompts into structured queries
 * - Communicates with the MCP client via stdio
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';
import { CognitoIdentityClient } from '@aws-sdk/client-cognito-identity';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import OpenAI from 'openai';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * .env connecton with reach-up to parent folder
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
dotenv.config({ path: envPath });

/**
 * config.json load with reach-up to parent folder
 */
const configPath = path.join(__dirname, '..', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const TABLE_CONFIG = config.ddb_defs || [];

/**
 * AWS DDB interface setup
 */
const REGION = process.env.AWS_REGION!;
const IDENTITY_POOL_ID = process.env.AWS_IDENTITY_POOL_ID!;
const cognitoIdentityClient = new CognitoIdentityClient({ region: REGION });
const credentials = fromCognitoIdentityPool({
  client: cognitoIdentityClient,
  identityPoolId: IDENTITY_POOL_ID
});
const dynamoClient = new DynamoDBClient({ region: REGION, credentials });

/**
 * OpenAI interface config
 */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * DDB housekeeping machinery
 */
interface SchemaMap { [tableName: string]: any }
interface RecordMap { [tableName: string]: any[] }
const schemas: SchemaMap = {};
const records: RecordMap = {};
const descriptionToName: { [desc: string]: string } = {};

/**
 * Loads data from configured DynamoDB tables and infers schemas.
 * Applies memory limit if specified.
 *
 * @param transport - Optional MCP transport for status notifications
 */
async function initialize(transport?: any) {
  const maxMemoryBytes = parseInt(process.env.MAX_RECORD_MEMORY_BYTES || '0');
  let totalSize = 0;

  for (const table of TABLE_CONFIG) {
    if (transport) sendNotification(transport, 'info', `Loading table: ${table.name}`);
    const { name, description } = table;
    descriptionToName[description] = name;
    const allItems: any[] = [];
    let ExclusiveStartKey = undefined;
    do {
      const result: any = await dynamoClient.send(new ScanCommand({ TableName: name, ExclusiveStartKey }));
      const items = result.Items?.map((item: any) => unmarshall(item)) || [];
      allItems.push(...items);
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const estimatedSize = Buffer.byteLength(JSON.stringify(allItems), 'utf8');
    totalSize += estimatedSize;
    if (maxMemoryBytes && totalSize > maxMemoryBytes) {
      const errorMsg = `Memory limit exceeded while loading table '${name}'. Current: ${totalSize}, Limit: ${maxMemoryBytes}`;
      if (transport) sendNotification(transport, 'error', errorMsg);
      throw new Error(errorMsg);
    }
    records[name] = allItems;
    schemas[name] = inferSchema(allItems.slice(0, 5));
  }
  if (transport) sendNotification(transport, 'success', `Initialization complete. Tables loaded: ${Object.keys(records).join(', ')}`);
}

/**
 * Infers a unified schema from sample records.
 *
 * @param data - Sample records to infer from
 * @returns The inferred schema object
 */
function inferSchema(data: any[]): any {
  const merge = (a: any, b: any): any => {
    if (typeof a !== 'object' || typeof b !== 'object') return typeof a;
    const result: any = { ...a };
    for (const key of Object.keys(b)) {
      result[key] = merge(a[key], b[key]);
    }
    return result;
  };
  return data.reduce((acc, item) => merge(acc, item), {});
}

/**
 * Constructs an augmented prompt including table and schema metadata.
 *
 * @param userPrompt - The original user query
 * @returns The fully augmented prompt for OpenAI
 */
function buildAugmentedPrompt(userPrompt: string): string {
  return `Translate the following user prompt into a structured query.

User prompt: "${userPrompt}"

Available tables:
${JSON.stringify(TABLE_CONFIG, null, 2)}

Schemas:
${JSON.stringify(schemas, null, 2)}

Return a JSON object with the following fields:
- result: "OK" or "error"
- errorMessage: if result is "error"
- tableName: string
- filterList: [{ field: string, matchValue: string, operator: "equals" | "notEquals" | "greaterThan" | "lessThan" }]
- sortList: list of field names
- fieldList: list of fields to include in the output
- queryType: "count" | "list"
- limitCount: optional number to limit the number of records returned
`;
}

/**
 * Applies filter conditions to a dataset.
 *
 * @param data - Records to filter
 * @param filters - Conditions to apply
 * @returns Filtered records
 */
function applyFilters(data: any[], filters: any[]) {
  return data.filter(item => {
    return filters.every((f: any) => {
      const val = item[f.field];
      switch (f.operator) {
        case 'equals': return val == f.matchValue;
        case 'notEquals': return val != f.matchValue;
        case 'greaterThan': return val > f.matchValue;
        case 'lessThan': return val < f.matchValue;
        default: return true;
      }
    });
  });
}

/**
 * Sends a structured notification to the MCP client.
 *
 * @param transport - The transport used to send the message
 * @param type - Notification type ('info', 'success', 'error')
 * @param message - The message to send
 */
function sendNotification(transport: any, type: string, message: string) {
  const notification = {
    jsonrpc: "2.0",
    method: "notify",
    params: {
      type,
      message
    }
  };
  transport.send(notification);
}

/**
 * Instantiate MCP server
 */
const server = new Server({
  name: "mcp-dynamodb-server",
  version: "1.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

/**
 * Register MCP List tools command handler
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query_table",
        description: "Run a natural language query over a configured DynamoDB table",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string" }
          },
          required: ["prompt"]
        },
        outputSchema: {
          type: "object",
          properties: {
            content: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  text: { type: "string" }
                },
                required: ["type", "text"]
              }
            }
          },
          required: ["content"]
        }
      }
    ]
  };
});

/**
 * Register MCP Call tools command handler
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (!args || name !== "query_table") {
    throw new Error("Tool not found or missing arguments");
  }

  const { prompt } = args as { prompt: string };
  const augmented = buildAugmentedPrompt(prompt);

  const aiResponse = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: augmented }],
    temperature: 0
  });

  const structured = JSON.parse(aiResponse.choices[0].message?.content || '{}');

  if (structured.result !== 'OK') {
    return { content: [{ type: 'text', text: `AI error: ${structured.errorMessage}` }] };
  }

  const { tableName, filterList, sortList, fieldList, queryType, limitCount } = structured;
  if (!records[tableName]) {
    return { content: [{ type: 'text', text: 'Table not found' }] };
  }

  let data = applyFilters(records[tableName], filterList || []);
  if (sortList?.length) {
    data.sort((a, b) => {
      for (const key of sortList) {
        if (a[key] < b[key]) return -1;
        if (a[key] > b[key]) return 1;
      }
      return 0;
    });
  }

  if (queryType === 'count') {
    return { content: [{ type: 'text', text: `Found ${data.length} matching records.` }] };
  } else {
    const results = data.map(d => {
      const out: any = {};
      for (const f of fieldList) out[f] = d[f];
      return out;
    }).slice(0, limitCount || data.length);
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  }
});

/**
 * Establish transport for server, conduct DDB table load and schema determination
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await initialize(transport);
  sendNotification(transport, 'info', 'MCP DynamoDB server running on stdio');
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
