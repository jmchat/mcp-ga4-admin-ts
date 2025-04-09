#!/usr/bin/env node

/**
 * CLI script for starting the Google Analytics 4 Admin MCP server
 */

// Check if .env file exists and load it, but don't require it
const fs = require('fs');
const path = require('path');
const envPath = path.resolve(process.cwd(), '.env');

// Check if colors should be disabled
const useColors = !process.env.NO_COLOR;

if (!fs.existsSync(envPath)) {
  // .env file is optional, silently continue using environment variables
}

// Start the MCP server
// Gebruik console.error zodat het bericht naar stderr gaat en niet de JSON communicatie verstoort
console.error('Starting Google Analytics 4 Admin MCP Server...');
require('../dist/index.js');
