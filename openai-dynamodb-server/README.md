# MCP AWS DynamoDB Query Server

This is a Model Context Protocol (MCP) server that allows natural language queries against AWS DynamoDB tables. It loads data into memory, infers schemas, and uses an AI model (via OpenAI) to transform user prompts into structured queries.

## Features

- Loads DynamoDB tables into memory
- Infers JSON schema from sample records
- Converts English prompts into structured queries using OpenAI
- Supports filtering, sorting, limiting, and counting records
- Implements `query_table` tool via MCP for interactive use

## Prerequisites

- Node.js (v18+ or v22 preferred for Claude compatibility)
- AWS credentials via Cognito Identity Pool with read access to all relevant tables
- OpenAI API key

## Setup

### Environment Variables (.env)

Create a `.env` file in the parent directory with the following fields.
Note that the Cognito Identity Pool ID must be attached to an IAM policy that allows "dynamodb:Scan" of the tables described in the config.json.

```env
AWS_REGION=us-east-1
AWS_IDENTITY_POOL_ID=us-east-1:xxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-3.5-turbo
MAX_RECORD_MEMORY_BYTES=50000000
```

### Table Configuration (config.json)

This file should be placed in the parent directory. It contains a list of the names and descriptions of the DynamoDB tables the server has access to.

```json
{
  "ddb_defs": [
    { "name": "students", "description": "Student enrollment database" },
    { "name": "courses", "description": "Catalog of course offerings" }
  ]
}
```

## Running

```bash
npm install
npm run build
npm start
```

## Docker Support

```dockerfile
# Dockerfile
FROM node:18
WORKDIR /app
COPY . .
RUN npm install && npm run build
CMD ["node", "dist/index.js"]
```

### Example Docker Run

```bash
docker build -t mcp-dynamodb .
docker run -v $(pwd)/.env:/app/.env -v $(pwd)/config.json:/app/config.json -i mcp-dynamodb
```

## VS Code MCP Support

Add the following to `.vscode/mcp.json`:

```json
{
  "servers": {
    "dynamodb": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

## MCP Tool

### `query_table`
- Input: `{ prompt: string }`
- Examples:
  - "How many students are enrolled in chemistry?"
  - "List the first 10 names from the events table."

The prompt is sent to OpenAI with augmented metadata to return a structured query object, which is then executed against local in-memory data.

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
