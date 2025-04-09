# Google Analytics 4 Admin MCP

A Model Context Protocol (MCP) server for managing Google Analytics 4 properties and annotations.

## Installation

```bash
npm install -g mcp-ga4-admin
```

Or use it directly via npx:

```bash
npx mcp-ga4-admin
```

## Requirements

1. A Google Cloud project with the Google Analytics Admin API enabled
2. A service account with appropriate permissions for Google Analytics
3. A credentials.json file for the service account

## Configuration

You need to provide the path to your Google service account credentials file. There are two ways to do this:

### Option 1: Environment Variable

Set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable directly:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=path/to/your/credentials.json
```

### Option 2: .env File (Optional)

Alternatively, you can create a `.env` file in the directory where you want to use the MCP with the following content:

```
GOOGLE_APPLICATION_CREDENTIALS=path/to/your/credentials.json
```

Note: The `.env` file is completely optional. The package will work fine with just the environment variable set.

## Available Functions

The MCP provides the following functions:

### Account and Property Management
- `list_ga4_accounts` - List all GA4 accounts
- `list_ga4_properties` - List all GA4 properties within an account
- `get_ga4_property_details` - Get details of a specific GA4 property
- `list_data_streams` - List all data streams for a specific GA4 property

### Annotations Management
- `list_annotations` - List all annotations for a GA4 property
- `get_annotation` - Get details of a specific annotation
- `create_annotation` - Create a new annotation
- `update_annotation` - Update an existing annotation
- `delete_annotation` - Delete an annotation

## Usage with Claude

This MCP is designed to work with Claude or other MCP Clients. To use it with Claude, create a `claude-mcp-config.json` file with the following content:

```json
{
  "mcpServers": {
    "google-analytics-admin": {
      "command": "npx",
      "args": ["mcp-ga4-admin"],
      "cwd": "/tmp",
      "env": {
        "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/your/credentials.json"
      }
    }
  }
}
```

Replace `/path/to/your/credentials.json` with the actual path to your Google service account credentials file.

### Important Notes for Claude Configuration

1. The `cwd` parameter is important - it ensures the MCP runs in a clean directory
2. No `.env` file is needed when using this configuration with Claude
3. The `NO_COLOR` environment variable prevents color codes in the output, which can cause JSON parsing errors in Claude
4. Upload the `claude-mcp-config.json` file to Claude when starting a new conversation

## License

ISC
