#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  // Types below are only for stronger return typing
  // and do not affect runtime behavior
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  CallToolResult,
  Tool,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Add Node.js process declaration
declare const process: {
  env: Record<string, string | undefined>;
  exit: (code?: number) => never;
};

const PackageDocSearchArgsSchema = z.object({
  package_name: z.string().describe("Name of the package or service to search documentation for (e.g. 'react', 'aws-s3', 'docker')"),
  query: z.string().describe("Search term to find specific information within the package/service documentation (e.g. 'file upload example', 'authentication methods')"),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

/**
 * Client for interacting with the UseKeen API
 * Handles authentication and making requests to the API
 */
class UseKeenClient {
  private apiKey: string;
  private baseUrl: string;

  /**
   * Create a new UseKeenClient
   * @param apiKey - The API key for authenticating with the UseKeen API
   */
  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = "https://usekeen-api-283956349806.us-central1.run.app";
  }

  /**
   * Search for documentation of a package
   * @param packageName - The name of the package to search for
   * @param query - Optional search term to find specific information
   * @returns The search results from the UseKeen API
   */
  async searchPackageDocumentation(packageName: string, query?: string): Promise<any> {
    try {
      // Create URL with query parameters for the API key
      const url = new URL(`${this.baseUrl}/tools/package_doc_search`);
      url.searchParams.append('api_key', this.apiKey);
      
      // Log the request details for debugging
      console.error(`API Request URL: ${url.toString()}`);
      
      // Create the request body with direct parameters
      const requestBody = {
        package_name: packageName,
        query: query || ""
      };
      
      console.error(`API Request Body: ${JSON.stringify(requestBody)}`);
      
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${errorText}`);
      }

      return response.json();
    } catch (error) {
      console.error("Error calling UseKeen API:", error);
      throw error;
    }
  }
}

// Format a safe MCP-compliant tool result from arbitrary data
// If the payload looks like UseKeen { result: { results: [...] } },
// map each item to a text content block. Always include structuredContent passthrough.
function formatToolSuccess(data: unknown): { content: { type: "text"; text: string }[]; structuredContent?: unknown } {
  try {
    if (
      data &&
      typeof data === "object" &&
      // @ts-ignore dynamic inspection
      "result" in (data as any) &&
      // @ts-ignore dynamic inspection
      (data as any).result && typeof (data as any).result === "object" &&
      // @ts-ignore dynamic inspection
      Array.isArray((data as any).result.results)
    ) {
      // @ts-ignore dynamic shape
      const results = (data as any).result.results as unknown[];
      const content = results
        .map((item) => {
          // Prefer well-known fields. Use string content as-is.
          const textCandidate =
            typeof (item as any)?.content === "string"
              ? (item as any).content
              : typeof (item as any)?.text === "string"
              ? (item as any).text
              : undefined;
          if (typeof textCandidate === "string" && textCandidate.trim().length > 0) {
            return { type: "text" as const, text: textCandidate };
          }
          // Fallback: compact JSON of the item
          let fallback = "";
          try {
            fallback = JSON.stringify(item, null, 2);
          } catch {
            fallback = String(item);
          }
          return { type: "text" as const, text: fallback };
        });

      if (content.length > 0) {
        return { content, structuredContent: data };
      }
    }
  } catch {
    // ignore and fall back below
  }

  // Fallback: pretty print whatever we got as a single text block
  let text: string;
  try {
    text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  } catch {
    text = String(data);
  }
  return { content: [{ type: "text", text }], structuredContent: data };
}

function formatToolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  const details = err instanceof Error && err.stack ? `\n\nStack:\n${err.stack}` : "";
  return {
    content: [
      {
        type: "text",
        text: `Tool call failed: ${message}${details}`,
      },
    ],
    isError: true as const,
  };
}

/**
 * Main function to start the MCP server
 * Sets up the server, registers request handlers, and connects to the transport
 */
async function main(): Promise<void> {
  const apiKey = process.env.USEKEEN_API_KEY;

  if (!apiKey) {
    console.error("Please set USEKEEN_API_KEY environment variable");
    process.exit(1);
  }

  console.error("Starting UseKeen MCP Server...");
  console.error(`Using API Key: ${apiKey}`);
  
  const server = new Server(
    {
      name: "UseKeen MCP Server",
      version: "1.3.2",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "usekeen_package_doc_search",
          description: "Search documentation of packages and services to find implementation details, examples, and specifications. The user's query should be as specific as possible to get the best results.",
          inputSchema: zodToJsonSchema(PackageDocSearchArgsSchema) as ToolInput,
        },
      ],
    };
  });

  const useKeenClient = new UseKeenClient(apiKey);

  // Handle tool calls
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      console.error("Received CallToolRequest:", JSON.stringify(request, null, 2));
      try {
        if (request.params.name === "usekeen_package_doc_search") {
          const args = PackageDocSearchArgsSchema.parse(request.params.arguments);
          const response = await useKeenClient.searchPackageDocumentation(
            args.package_name,
            args.query
          );
          // Always return spec-compliant content blocks; include structuredContent for clients that support it
          return formatToolSuccess(response) as unknown as CallToolResult;
        } else {
          throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        console.error("Error executing tool:", error);
        // Mark as error using the MCP-compatible flag so clients render it correctly
        return formatToolError(error) as unknown as CallToolResult;
      }
    }
  );

  const transport = new StdioServerTransport();
  console.error("Connecting server to transport...");
  await server.connect(transport);

  console.error("UseKeen MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
