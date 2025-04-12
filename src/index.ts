// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AnalyticsAdminServiceClient } from "@google-analytics/admin";

// Check if colors should be disabled
const useColors = !process.env.NO_COLOR;

// Helper function for logging that respects NO_COLOR
function log(message: string): void {
    // Remove emoji and color codes if NO_COLOR is set
    if (!useColors) {
        // Replace emoji and other special characters with plain text
        message = message
            .replace(/✅/g, 'SUCCESS:')
            .replace(/❌/g, 'ERROR:')
            .replace(/ℹ️/g, 'INFO:')
            .replace(/\u2139\ufe0f/g, 'INFO:');
    }
    console.error(message);
}
import dotenv from "dotenv";
import { GoogleAuth } from 'google-auth-library'; // Needed for error type checking
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as fs from 'fs';
import * as path from 'path';

// Load environment variables from .env file if it exists
try {
    dotenv.config({ path: process.env.ENV_FILE || '.env' });
} catch (error) {
    console.error("Note: No .env file found, using environment variables directly.");
}

// --- Configuration ---
const MCP_PROTOCOL_VERSION = "1.0"; // Can also come from the SDK

// --- Initialize Google Analytics Admin Client ---
let analyticsAdminClient: AnalyticsAdminServiceClient | null = null;
try {
    // The client automatically uses the credentials from the
    // GOOGLE_APPLICATION_CREDENTIALS environment variable.
    analyticsAdminClient = new AnalyticsAdminServiceClient();
    console.error("Google Analytics Admin Client initialized."); // Log to stderr
} catch (error) {
    console.error("Error initializing Google Client:", error);
    // Stop the process if the client cannot be initialized
    process.exit(1);
}

// Lees de versie uit package.json
let packageVersion = "1.0.0"; // Standaard versie als fallback
try {
    const packageJsonPath = path.resolve(__dirname, '../package.json');
    if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        packageVersion = packageJson.version || packageVersion;
    }
} catch (error) {
    console.error("Kon package.json niet lezen, gebruik standaard versie:", error);
}

// --- Create MCP Server Instance ---
const server = new McpServer({
    name: "google-analytics-admin",
    version: packageVersion,
    protocolVersion: MCP_PROTOCOL_VERSION, // Specify protocol version
    // descriptions and other metadata can be added here
});

// --- Helper function for error messages ---
function createErrorResponse(message: string, error?: any): CallToolResult {
    let detailedMessage = message;
    if (error) {
        // Try to recognize specific Google API errors
        if (error.code && error.details) { // Standard gRPC error structure
             detailedMessage = `${message}: Google API Error ${error.code} - ${error.details}`;
        } else if (error instanceof Error) {
            detailedMessage = `${message}: ${error.message}`;
        } else {
            detailedMessage = `${message}: ${String(error)}`;
        }
    }
     console.error("MCP Tool Error:", detailedMessage); // Log errors to stderr
    return {
        isError: true,
        content: [{ type: "text", text: detailedMessage }],
    };
}

// --- Helper function to obtain an access token for the Google API ---
async function getAccessToken(): Promise<string> {
    try {
        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/analytics.edit"],
        });
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        return token.token || "";
    } catch (error) {
        console.error("Error getting access token:", error);
        throw error;
    }
}

// --- Tool: List Accounts ---
server.tool(
    "ga4_admin_api_list_accounts",
    "List all Google Analytics 4 accounts accessible by the service account.",
    {}, // No input parameters needed
    async (): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        console.error("Running tool: list_ga4_accounts"); // Log to stderr

        try {
            const [accounts] = await analyticsAdminClient.listAccounts(); // Get only the list

            if (!accounts || accounts.length === 0) {
                return {
                    content: [{ type: "text", text: "No accessible GA4 accounts found." }],
                };
            }

            // Format for readability (optional, could also be raw JSON)
            const formattedAccounts = accounts.map(acc => ({
                name: acc.name,
                displayName: acc.displayName,
                createTime: acc.createTime?.toString(), // Convert Timestamp if needed
                updateTime: acc.updateTime?.toString(),
                regionCode: acc.regionCode,
                deleted: acc.deleted,
            }));

            return {
                content: [
                    {
                        type: "text",
                        // Return JSON as in the Python example
                        text: JSON.stringify({ accounts: formattedAccounts }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            return createErrorResponse("Error listing GA4 accounts", error);
        }
    }
);

// --- Tool: Get Property Details ---
server.tool(
    "ga4_admin_api_get_property_details",
    "Get details for a specific Google Analytics 4 property.",
    // Input schema with Zod
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
    },
    async ({ property_id }): Promise<CallToolResult> => {
         if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: get_ga4_property_details for ${propertyName}`); // Log to stderr

        try {
            const [property] = await analyticsAdminClient.getProperty({ // Get only the property object
                name: propertyName,
            });

            if (!property) {
                 // This should not happen if the API call succeeds, but just to be safe
                 return createErrorResponse(`Property ${propertyName} not found (unexpected API response).`);
            }

             // Convert any Timestamp objects to ISO strings for JSON serialization
             // The Node.js library might already do this, but being explicit is safer.
             const propertyJsonFriendly = JSON.parse(JSON.stringify(property));


            return {
                content: [
                    {
                        type: "text",
                        // Return JSON as in the Python example
                        text: JSON.stringify({ property: propertyJsonFriendly }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
             // Specific error handling
            if (error.code === 5) { // gRPC code 5 = NOT_FOUND
                return createErrorResponse(`Property '${propertyName}' not found.`, error);
            }
             if (error.code === 7) { // gRPC code 7 = PERMISSION_DENIED
                 return createErrorResponse(`Permission denied to access property '${propertyName}'. Check Service Account permissions in GA4.`, error);
             }
             if (error.code === 3) { // gRPC code 3 = INVALID_ARGUMENT
                return createErrorResponse(`Invalid argument provided for property '${propertyName}'. Check the ID format.`, error);
             }
            // Algemene fout
            return createErrorResponse(`Error getting GA4 property details for '${propertyName}'`, error);
        }
    }
);

// --- Tool: List Properties ---
server.tool(
    "ga4_admin_api_list_properties",
    "List all Google Analytics 4 properties within a specific account.",
    {
        account_id: z.string().describe("The account ID (numeric part of the account name, e.g., '123456' from 'accounts/123456')"),
    },
    async ({ account_id }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        console.error(`Running tool: list_ga4_properties for account ${account_id}`); // Log to stderr

        try {
            const accountName = `accounts/${account_id}`;
            const [properties] = await analyticsAdminClient.listProperties({
                filter: `parent:${accountName}`,
            });

            if (!properties || properties.length === 0) {
                return {
                    content: [{ type: "text", text: `No GA4 properties found for account ${account_id}.` }],
                };
            }

            // Format for readability
            const formattedProperties = properties.map((prop: any) => ({
                name: prop.name,
                displayName: prop.displayName,
                propertyType: prop.propertyType,
                createTime: prop.createTime?.toString(),
                updateTime: prop.updateTime?.toString(),
                parent: prop.parent,
                serviceLevel: prop.serviceLevel,
                currencyCode: prop.currencyCode,
                timeZone: prop.timeZone,
                deleted: prop.deleted,
            }));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ properties: formattedProperties }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.code === 5) { // gRPC code 5 = NOT_FOUND
                return createErrorResponse(`Account '${account_id}' not found.`, error);
            }
            if (error.code === 7) { // gRPC code 7 = PERMISSION_DENIED
                return createErrorResponse(`Permission denied to access account '${account_id}'. Check Service Account permissions in GA4.`, error);
            }
            return createErrorResponse(`Error listing GA4 properties for account '${account_id}'`, error);
        }
    }
);

// --- Tool: List Data Streams ---
server.tool(
    "ga4_admin_api_list_data_streams",
    "List all data streams for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
    },
    async ({ property_id }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: list_data_streams for ${propertyName}`); // Log to stderr

        try {
            // Get all datastreams
            const [dataStreams] = await analyticsAdminClient.listDataStreams({
                parent: propertyName,
            });

            if (!dataStreams || dataStreams.length === 0) {
                return {
                    content: [{ type: "text", text: `No data streams found for property ${property_id}.` }],
                };
            }

            // Format for readability
            const formattedDataStreams = dataStreams.map((stream: any) => ({
                name: stream.name,
                type: stream.type,
                displayName: stream.displayName,
                createTime: stream.createTime?.toString(),
                updateTime: stream.updateTime?.toString(),
                // Specific fields per datastream type
                webStreamData: stream.webStreamData,
                androidAppStreamData: stream.androidAppStreamData,
                iosAppStreamData: stream.iosAppStreamData,
            }));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ dataStreams: formattedDataStreams }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.code === 5) { // gRPC code 5 = NOT_FOUND
                return createErrorResponse(`Property '${propertyName}' not found.`, error);
            }
            if (error.code === 7) { // gRPC code 7 = PERMISSION_DENIED
                return createErrorResponse(`Permission denied to access property '${propertyName}'. Check Service Account permissions in GA4.`, error);
            }
            return createErrorResponse(`Error listing data streams for property '${propertyName}'`, error);
        }
    }
);

// --- Tool: List Annotations ---
server.tool(
    "ga4_admin_api_list_annotations",
    "List all annotations for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
    },
    async ({ property_id }): Promise<CallToolResult> => {
        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: list_annotations for ${propertyName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use the REST API directly via axios
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${propertyName}/reportingDataAnnotations`;
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            // Log de volledige response om te zien wat er precies wordt geretourneerd
            console.error('API Response:', JSON.stringify(response.data, null, 2));

            const annotations = response.data.reportingDataAnnotations || [];

            if (annotations.length === 0) {
                return {
                    content: [{ type: "text", text: `Geen annotaties gevonden voor property ${property_id}.` }],
                };
            }

            // Format for readability according to the documentation
            const formattedAnnotations = annotations.map((annotation: any) => {
                const formattedAnnotation: any = {
                    name: annotation.name,
                    title: annotation.title,
                    description: annotation.description,
                    color: annotation.color,
                    systemGenerated: annotation.systemGenerated || false
                };
                
                // Add date information
                if (annotation.annotationDate) {
                    formattedAnnotation.annotationDate = annotation.annotationDate;
                }
                
                if (annotation.annotationDateRange) {
                    formattedAnnotation.annotationDateRange = annotation.annotationDateRange;
                }
                
                return formattedAnnotation;
            });

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ annotations: formattedAnnotations }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            // Handle API-specific errors
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Property '${propertyName}' not found.`, data);
                }
                if (status === 403) {
                    return createErrorResponse(`No access to property '${propertyName}'. Check the permissions of the Service Account in GA4.`, data);
                }
                return createErrorResponse(`API error retrieving annotations for property '${propertyName}': ${status}`, data);
            }
            
            return createErrorResponse(`Error retrieving annotations for property '${propertyName}'`, error);
        }
    }
);

// --- Tool: Create Annotation ---
server.tool(
    "ga4_admin_api_create_annotation",
    "Create a new annotation for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        description: z.string().describe("Description of the annotation"),
        start_time: z.string().describe("Start time of the annotation in ISO 8601 format (e.g., '2023-04-01T00:00:00Z')"),
        end_time: z.string().optional().describe("Optional end time of the annotation in ISO 8601 format (e.g., '2023-04-02T00:00:00Z')"),
        annotation_type: z.enum(["ANNOTATION_TYPE_UNSPECIFIED", "GOOGLE_DEFINED", "USER_DEFINED"]).default("USER_DEFINED").describe("Type of the annotation"),
        category: z.enum(["ANNOTATION_CATEGORY_UNSPECIFIED", "ANALYTICS_AUTOMATIC", "ANALYTICS_MANUAL", "GOOGLE_ADS", "OTHER"]).default("ANALYTICS_MANUAL").describe("Category of the annotation"),
    },
    async ({ property_id, description, start_time, end_time, annotation_type, category }): Promise<CallToolResult> => {
        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: create_annotation for ${propertyName}`); // Log naar stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Create a new annotation according to the documentation
            const annotationData: any = {
                // Required fields according to documentation
                title: description, // Use description as title (required field)
                description: description,
                color: "BLUE", // Required field according to documentation
                
                // Date field - use annotationDate or annotationDateRange
                annotationDate: {
                    // Convert ISO string to Date object with year, month, day
                    year: parseInt(start_time.substring(0, 4)),
                    month: parseInt(start_time.substring(5, 7)),
                    day: parseInt(start_time.substring(8, 10))
                }
            };
            
            // If end time is provided, use annotationDateRange instead of annotationDate
            if (end_time) {
                // Remove annotationDate
                delete annotationData.annotationDate;
                
                // Add annotationDateRange
                annotationData.annotationDateRange = {
                    startDate: {
                        year: parseInt(start_time.substring(0, 4)),
                        month: parseInt(start_time.substring(5, 7)),
                        day: parseInt(start_time.substring(8, 10))
                    },
                    endDate: {
                        year: parseInt(end_time.substring(0, 4)),
                        month: parseInt(end_time.substring(5, 7)),
                        day: parseInt(end_time.substring(8, 10))
                    }
                };
            }
            
            // Log the request data
            console.error('API Request (create_annotation):', JSON.stringify(annotationData, null, 2));

            // Uses the REST API directly via axios
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${propertyName}/reportingDataAnnotations`;
            
            const response = await axios.post(apiUrl, annotationData, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            // Log the full response to see what is returned
            console.error('API Response (create_annotation):', JSON.stringify(response.data, null, 2));

            const annotation = response.data;

            // Prepare the response with the correct fields according to the documentation
            const responseData: any = {
                message: "Annotation successfully created",
                annotation: {
                    name: annotation.name,
                    title: annotation.title,
                    description: annotation.description,
                    color: annotation.color,
                    systemGenerated: annotation.systemGenerated || false
                }
            };
            
            // Add date information
            if (annotation.annotationDate) {
                responseData.annotation.annotationDate = annotation.annotationDate;
            }
            
            if (annotation.annotationDateRange) {
                responseData.annotation.annotationDateRange = annotation.annotationDateRange;
            }
            
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            // Handle API-specific errors
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Property '${propertyName}' not found.`, data);
                }
                if (status === 403) {
                    return createErrorResponse(`No access to create annotation for property '${propertyName}'. Check the Service Account permissions in GA4.`, data);
                }
                if (status === 400) {
                    return createErrorResponse(`Invalid data for creating annotation in property '${propertyName}'.`, data);
                }
                return createErrorResponse(`API error creating annotation for property '${propertyName}': ${status}`, data);
            }
            
            return createErrorResponse(`Error creating annotation for property '${propertyName}'`, error);
        }
    }
);

// --- Tool: Get Annotation ---
server.tool(
    "ga4_admin_api_get_annotation",
    "Get details of a specific annotation in a Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        annotation_id: z.string().describe("The ID of the annotation"),
    },
    async ({ property_id, annotation_id }): Promise<CallToolResult> => {
        const annotationName = `properties/${property_id}/reportingDataAnnotations/${annotation_id}`;
        console.error(`Running tool: get_annotation for ${annotationName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use the REST API directly via axios
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${annotationName}`;
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            // Log the full response to see what is returned
            console.error('API Response (get_annotation):', JSON.stringify(response.data, null, 2));

            const annotation = response.data;

            // Prepare the response with the correct fields according to the documentation
            const responseData: any = {
                annotation: {
                    name: annotation.name,
                    title: annotation.title,
                    description: annotation.description,
                    color: annotation.color,
                    systemGenerated: annotation.systemGenerated || false
                }
            };
            
            // Add date information
            if (annotation.annotationDate) {
                responseData.annotation.annotationDate = annotation.annotationDate;
            }
            
            if (annotation.annotationDateRange) {
                responseData.annotation.annotationDateRange = annotation.annotationDateRange;
            }
            
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            // Handle API-specific errors
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Annotation '${annotationName}' not found.`, data);
                }
                if (status === 403) {
                    return createErrorResponse(`No access to annotation '${annotationName}'. Check the permissions of the Service Account in GA4.`, data);
                }
                return createErrorResponse(`API error retrieving annotation '${annotationName}': ${status}`, data);
            }
            
            return createErrorResponse(`Error retrieving annotation '${annotationName}'`, error);
        }
    }
);

// --- Tool: Update Annotation ---
server.tool(
    "ga4_admin_api_update_annotation",
    "Update an existing annotation in a Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        annotation_id: z.string().describe("The ID of the annotation to update"),
        description: z.string().optional().describe("New description of the annotation"),
        start_time: z.string().optional().describe("New start time of the annotation in ISO 8601 format (e.g., '2023-04-01T00:00:00Z')"),
        end_time: z.string().optional().describe("New end time of the annotation in ISO 8601 format (e.g., '2023-04-02T00:00:00Z')"),
        category: z.enum(["ANNOTATION_CATEGORY_UNSPECIFIED", "ANALYTICS_AUTOMATIC", "ANALYTICS_MANUAL", "GOOGLE_ADS", "OTHER"]).optional().describe("New category of the annotation"),
    },
    async ({ property_id, annotation_id, description, start_time, end_time, category }): Promise<CallToolResult> => {
        const annotationName = `properties/${property_id}/reportingDataAnnotations/${annotation_id}`;
        console.error(`Running tool: update_annotation for ${annotationName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Get the existing annotation to know what needs to be updated
            const getApiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${annotationName}`;
            
            const getResponse = await axios.get(getApiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            const existingAnnotation = getResponse.data;
            
            // Prepare the update according to the documentation
            const annotationData: any = {
                // Required fields from existing annotation
                name: annotationName,
                title: existingAnnotation.title,
                color: existingAnnotation.color
            };
            
            // Add description if provided
            if (description !== undefined) {
                annotationData.description = description;
            } else if (existingAnnotation.description) {
                annotationData.description = existingAnnotation.description;
            }
            
            // Determine which date fields need to be updated
            if (start_time !== undefined || end_time !== undefined) {
                // If we have a date range or are creating one
                if ((existingAnnotation.annotationDateRange) || end_time) {
                    annotationData.annotationDateRange = {
                        startDate: {
                            year: start_time ? parseInt(start_time.substring(0, 4)) : 
                                  existingAnnotation.annotationDateRange?.startDate.year,
                            month: start_time ? parseInt(start_time.substring(5, 7)) : 
                                   existingAnnotation.annotationDateRange?.startDate.month,
                            day: start_time ? parseInt(start_time.substring(8, 10)) : 
                                 existingAnnotation.annotationDateRange?.startDate.day
                        },
                        endDate: {
                            year: end_time ? parseInt(end_time.substring(0, 4)) : 
                                  existingAnnotation.annotationDateRange?.endDate.year,
                            month: end_time ? parseInt(end_time.substring(5, 7)) : 
                                   existingAnnotation.annotationDateRange?.endDate.month,
                            day: end_time ? parseInt(end_time.substring(8, 10)) : 
                                 existingAnnotation.annotationDateRange?.endDate.day
                        }
                    };
                } else {
                    // If we have a single date or are creating one
                    annotationData.annotationDate = {
                        year: start_time ? parseInt(start_time.substring(0, 4)) : 
                              existingAnnotation.annotationDate?.year,
                        month: start_time ? parseInt(start_time.substring(5, 7)) : 
                               existingAnnotation.annotationDate?.month,
                        day: start_time ? parseInt(start_time.substring(8, 10)) : 
                             existingAnnotation.annotationDate?.day
                    };
                }
            } else {
                // Keep the existing date fields
                if (existingAnnotation.annotationDate) {
                    annotationData.annotationDate = existingAnnotation.annotationDate;
                } else if (existingAnnotation.annotationDateRange) {
                    annotationData.annotationDateRange = existingAnnotation.annotationDateRange;
                }
            }
            
            // Determine the update mask (which fields are being updated)
            const updateMask = [];
            
            if (description !== undefined) updateMask.push('description');
            if (start_time !== undefined || end_time !== undefined) {
                if (annotationData.annotationDate) {
                    updateMask.push('annotationDate');
                } else if (annotationData.annotationDateRange) {
                    updateMask.push('annotationDateRange');
                }
            }
            
            // If no fields are specified to update, return a message
            if (updateMask.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "Geen velden opgegeven om bij te werken. Annotatie blijft ongewijzigd.",
                        },
                    ],
                };
            }
            
            // Use the REST API directly via axios for the update
            const updateApiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${annotationName}?updateMask=${updateMask.join(',')}`;
            
            console.error('API Request (update_annotation):', JSON.stringify(annotationData, null, 2));
            
            const updateResponse = await axios.patch(updateApiUrl, annotationData, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.error('API Response (update_annotation):', JSON.stringify(updateResponse.data, null, 2));
            
            const updatedAnnotation = updateResponse.data;

            // Prepare the response with the correct fields according to the documentation
            const responseData: any = {
                message: "Annotation successfully updated",
                annotation: {
                    name: updatedAnnotation.name,
                    title: updatedAnnotation.title,
                    description: updatedAnnotation.description,
                    color: updatedAnnotation.color,
                    systemGenerated: updatedAnnotation.systemGenerated || false
                }
            };
            
            // Add date information
            if (updatedAnnotation.annotationDate) {
                responseData.annotation.annotationDate = updatedAnnotation.annotationDate;
            }
            
            if (updatedAnnotation.annotationDateRange) {
                responseData.annotation.annotationDateRange = updatedAnnotation.annotationDateRange;
            }
            
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(responseData, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.code === 5) { // gRPC code 5 = NOT_FOUND
                return createErrorResponse(`Annotation '${annotationName}' not found.`, error);
            }
            if (error.code === 7) { // gRPC code 7 = PERMISSION_DENIED
                return createErrorResponse(`Permission denied to update annotation '${annotationName}'. Check Service Account permissions in GA4.`, error);
            }
            return createErrorResponse(`Error updating annotation '${annotationName}'`, error);
        }
    }
);

// --- Tool: Delete Annotation ---
server.tool(
    "ga4_admin_api_delete_annotation",
    "Delete an annotation from a Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        annotation_id: z.string().describe("The ID of the annotation to delete"),
    },
    async ({ property_id, annotation_id }): Promise<CallToolResult> => {
        const annotationName = `properties/${property_id}/reportingDataAnnotations/${annotation_id}`;
        console.error(`Running tool: delete_annotation for ${annotationName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use the REST API directly via axios
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${annotationName}`;
            
            await axios.delete(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            message: `Annotatie '${annotation_id}' succesvol verwijderd uit property '${property_id}'.`
                        }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            // Handle API-specific errors
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Annotation '${annotationName}' not found.`, data);
                }
                if (status === 403) {
                    return createErrorResponse(`No access to delete annotation '${annotationName}'. Check the permissions of the Service Account in GA4.`, data);
                }
                return createErrorResponse(`API error deleting annotation '${annotationName}': ${status}`, data);
            }
            
            return createErrorResponse(`Error deleting annotation '${annotationName}'`, error);
        }
    }
);

// --- Start the server with Stdio Transport ---
async function main() {
    try {
        // Use StdioServerTransport like in the example
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("Google Analytics Admin MCP Server running on stdio"); // Log to stderr
    } catch (error) {
        console.error("Fatal error connecting MCP server:", error);
        process.exit(1);
    }
}

// --- Tool: List Audiences ---
server.tool(
    "ga4_admin_api_list_audiences",
    "List all audiences for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
    },
    async ({ property_id }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: list_audiences for ${propertyName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use axios to call the API directly since the Node.js client library doesn't support audiences yet
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${propertyName}/audiences`;
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const audiences = response.data.audiences || [];

            if (audiences.length === 0) {
                return {
                    content: [{ type: "text", text: `No audiences found for property ${property_id}.` }],
                };
            }

            // Format for readability
            const formattedAudiences = audiences.map((audience: any) => ({
                name: audience.name,
                displayName: audience.displayName,
                description: audience.description,
                membershipDurationDays: audience.membershipDurationDays,
                adsPersonalizationEnabled: audience.adsPersonalizationEnabled,
                createTime: audience.createTime,
            }));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ audiences: formattedAudiences }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Property '${propertyName}' not found.`);
                }
                if (status === 403) {
                    return createErrorResponse(`Permission denied to access property '${propertyName}'. Check Service Account permissions in GA4.`);
                }
                return createErrorResponse(`Error listing audiences for property '${propertyName}': ${data.error?.message || JSON.stringify(data)}`);
            }
            return createErrorResponse(`Error listing audiences for property '${propertyName}'`, error);
        }
    }
);

// --- Tool: Get Audience ---
server.tool(
    "ga4_admin_api_get_audience",
    "Get details of a specific audience in a Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        audience_id: z.string().describe("The ID of the audience")
    },
    async ({ property_id, audience_id }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const audienceName = `properties/${property_id}/audiences/${audience_id}`;
        console.error(`Running tool: get_audience for ${audienceName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use axios to call the API directly
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${audienceName}`;
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const audience = response.data;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ audience }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Audience '${audienceName}' not found.`);
                }
                if (status === 403) {
                    return createErrorResponse(`Permission denied to access audience '${audienceName}'. Check Service Account permissions in GA4.`);
                }
                return createErrorResponse(`Error getting audience '${audienceName}': ${data.error?.message || JSON.stringify(data)}`);
            }
            return createErrorResponse(`Error getting audience '${audienceName}'`, error);
        }
    }
);

// --- Tool: Create Audience ---
server.tool(
    "ga4_admin_api_create_audience",
    "Create a new audience for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        display_name: z.string().describe("Display name for the audience"),
        description: z.string().describe("Description of the audience"),
        membership_duration_days: z.number().int().min(1).max(540).describe("The duration a user should stay in the audience (1-540 days)"),
    },
    async ({ property_id, display_name, description, membership_duration_days }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: create_audience for ${propertyName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Create a simple audience with basic required fields
            const audienceData = {
                displayName: display_name,
                description: description,
                membershipDurationDays: membership_duration_days,
                // Add a simple filter clause (required for audience creation)
                filterClauses: [
                    {
                        simpleFilter: {
                            scope: "AUDIENCE_FILTER_SCOPE_ACROSS_ALL_SESSIONS",
                            filterExpression: {
                                dimensionOrMetricFilter: {
                                    dimensionOrMetricName: "eventName",
                                    stringFilter: {
                                        matchType: "EXACT",
                                        value: "page_view"
                                    }
                                }
                            }
                        }
                    }
                ]
            };
            
            // Use axios to call the API directly
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${propertyName}/audiences`;
            
            const response = await axios.post(apiUrl, audienceData, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const audience = response.data;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ audience }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Property '${propertyName}' not found.`);
                }
                if (status === 403) {
                    return createErrorResponse(`Permission denied to create audience in property '${propertyName}'. Check Service Account permissions in GA4.`);
                }
                if (status === 400) {
                    return createErrorResponse(`Invalid audience data: ${data.error?.message || JSON.stringify(data)}`);
                }
                return createErrorResponse(`Error creating audience in property '${propertyName}': ${data.error?.message || JSON.stringify(data)}`);
            }
            return createErrorResponse(`Error creating audience in property '${propertyName}'`, error);
        }
    }
);

// --- Tool: List Custom Dimensions ---
server.tool(
    "ga4_admin_api_list_custom_dimensions",
    "List all custom dimensions for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
    },
    async ({ property_id }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: list_custom_dimensions for ${propertyName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use axios to call the API directly
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${propertyName}/customDimensions`;
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const customDimensions = response.data.customDimensions || [];

            if (customDimensions.length === 0) {
                return {
                    content: [{ type: "text", text: `No custom dimensions found for property ${property_id}.` }],
                };
            }

            // Format for readability
            const formattedDimensions = customDimensions.map((dimension: any) => ({
                name: dimension.name,
                parameterName: dimension.parameterName,
                displayName: dimension.displayName,
                description: dimension.description,
                scope: dimension.scope,
                disallowAdsPersonalization: dimension.disallowAdsPersonalization
            }));

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ customDimensions: formattedDimensions }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Property '${propertyName}' not found.`);
                }
                if (status === 403) {
                    return createErrorResponse(`Permission denied to access property '${propertyName}'. Check Service Account permissions in GA4.`);
                }
                return createErrorResponse(`Error listing custom dimensions for property '${propertyName}': ${data.error?.message || JSON.stringify(data)}`);
            }
            return createErrorResponse(`Error listing custom dimensions for property '${propertyName}'`, error);
        }
    }
);

// --- Tool: Get Custom Dimension ---
server.tool(
    "ga4_admin_api_get_custom_dimension",
    "Get details of a specific custom dimension in a Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        dimension_id: z.string().describe("The ID of the custom dimension")
    },
    async ({ property_id, dimension_id }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const dimensionName = `properties/${property_id}/customDimensions/${dimension_id}`;
        console.error(`Running tool: get_custom_dimension for ${dimensionName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Use axios to call the API directly
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${dimensionName}`;
            
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const customDimension = response.data;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ customDimension }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Custom dimension '${dimensionName}' not found.`);
                }
                if (status === 403) {
                    return createErrorResponse(`Permission denied to access custom dimension '${dimensionName}'. Check Service Account permissions in GA4.`);
                }
                return createErrorResponse(`Error getting custom dimension '${dimensionName}': ${data.error?.message || JSON.stringify(data)}`);
            }
            return createErrorResponse(`Error getting custom dimension '${dimensionName}'`, error);
        }
    }
);

// --- Tool: Create Custom Dimension ---
server.tool(
    "ga4_admin_api_create_custom_dimension",
    "Create a new custom dimension for a specific Google Analytics 4 property.",
    {
        property_id: z.string().regex(/^\d+$/, "Property ID must be numeric").describe("The numeric ID of the GA4 property (e.g., '123456789')"),
        parameter_name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "Parameter name must start with a letter and contain only alphanumeric characters and underscores").describe("The parameter name for the custom dimension"),
        display_name: z.string().max(82).describe("Display name for the custom dimension"),
        description: z.string().max(150).optional().describe("Optional description for the custom dimension"),
        scope: z.enum(["EVENT", "USER", "ITEM"]).describe("The scope of the custom dimension (EVENT, USER, or ITEM)"),
        disallow_ads_personalization: z.boolean().optional().describe("Optional. If true, excludes this dimension from ads personalization")
    },
    async ({ property_id, parameter_name, display_name, description, scope, disallow_ads_personalization }): Promise<CallToolResult> => {
        if (!analyticsAdminClient) {
            return createErrorResponse("GA Admin Client is not initialized.");
        }

        const propertyName = `properties/${property_id}`;
        console.error(`Running tool: create_custom_dimension for ${propertyName}`); // Log to stderr

        try {
            // Obtain an access token
            const accessToken = await getAccessToken();
            
            // Create custom dimension data
            const dimensionData: any = {
                parameterName: parameter_name,
                displayName: display_name,
                scope: scope
            };
            
            // Add optional fields if provided
            if (description) {
                dimensionData.description = description;
            }
            
            if (disallow_ads_personalization !== undefined) {
                dimensionData.disallowAdsPersonalization = disallow_ads_personalization;
            }
            
            // Use axios to call the API directly
            const apiUrl = `https://analyticsadmin.googleapis.com/v1alpha/${propertyName}/customDimensions`;
            
            const response = await axios.post(apiUrl, dimensionData, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const customDimension = response.data;

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ customDimension }, null, 2),
                    },
                ],
            };
        } catch (error: any) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                
                if (status === 404) {
                    return createErrorResponse(`Property '${propertyName}' not found.`);
                }
                if (status === 403) {
                    return createErrorResponse(`Permission denied to create custom dimension in property '${propertyName}'. Check Service Account permissions in GA4.`);
                }
                if (status === 400) {
                    return createErrorResponse(`Invalid custom dimension data: ${data.error?.message || JSON.stringify(data)}`);
                }
                return createErrorResponse(`Error creating custom dimension in property '${propertyName}': ${data.error?.message || JSON.stringify(data)}`);
            }
            return createErrorResponse(`Error creating custom dimension in property '${propertyName}'`, error);
        }
    }
);

// Run main function
main().catch((error) => {
    console.error("Unhandled error in main():", error);
    process.exit(1);
});